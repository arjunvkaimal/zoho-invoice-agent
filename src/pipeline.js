import { readFile } from 'node:fs/promises';
import { parseMessage } from './llm.js';
import { matchCandidate } from './matcher.js';
import { createInvoice, getInvoicePdf, getCustomerInvoices } from './zoho.js';

let defaultCatalog = null;
let defaultAliases = null;

export async function loadCatalogAndAliases() {
  if (!defaultCatalog) {
    try {
      const catBuf = await readFile(new URL('../data/catalog-snapshot.json', import.meta.url), 'utf8');
      defaultCatalog = JSON.parse(catBuf);
    } catch {
      defaultCatalog = { customers: [], items: [] };
    }
  }
  if (!defaultAliases) {
    try {
      const aliasBuf = await readFile(new URL('../data/aliases.json', import.meta.url), 'utf8');
      defaultAliases = JSON.parse(aliasBuf);
    } catch {
      defaultAliases = { customers: {}, items: {} };
    }
  }
  return { catalog: defaultCatalog, aliases: defaultAliases };
}

/**
 * Pure deterministic decision engine.
 * Decides whether to ignore, mark unsupported, clarify, or create an invoice.
 *
 * @param {Object} parsed - Output from LLM { intent, customer_text, lines }
 * @param {Object} catalog - { customers: Array, items: Array }
 * @param {Object} aliases - { customers: Object, items: Object }
 * @returns {{
 *   action: 'ignore' | 'unsupported' | 'clarify' | 'create',
 *   reason?: string,
 *   questions?: string[],
 *   customer?: Object | null,
 *   lines?: Array<{ item: Object, quantity: number, rate: number }>,
 *   unresolved?: Object
 * }}
 */
export function decide(parsed, catalog, aliases = { customers: {}, items: {} }) {
  if (!parsed || !parsed.intent) {
    return { action: 'ignore', reason: 'Unrecognized or empty message structure' };
  }

  // 1. Non-invoice intents
  if (parsed.intent === 'general_chatter') {
    return { action: 'ignore', reason: 'General non-invoice chatter' };
  }

  if (parsed.intent === 'status_query') {
    return {
      action: 'unsupported',
      reason: 'Invoice status query not automated',
      message: 'Status check noted. The accounts team has been alerted and will update you shortly.',
    };
  }

  if (parsed.intent === 'edit_invoice') {
    return {
      action: 'unsupported',
      reason: 'Invoice amendment request not automated',
      message: 'Invoice modification requests require accountant confirmation. Your request has been forwarded.',
    };
  }

  // If intent is not create_invoice, treat as ignore or unsupported
  if (parsed.intent !== 'create_invoice') {
    return { action: 'ignore', reason: `Unhandled intent: ${parsed.intent}` };
  }

  // If no lines were extracted and no customer was extracted
  if ((!parsed.lines || parsed.lines.length === 0) && !parsed.customer_text) {
    return { action: 'ignore', reason: 'No customer and no line items detected' };
  }

  const questions = [];
  let resolvedCustomer = null;

  // 2. Resolve Customer
  if (!parsed.customer_text || !parsed.customer_text.trim()) {
    questions.push('Which customer/party should this invoice be raised for?');
  } else {
    const custMatch = matchCandidate(parsed.customer_text, catalog.customers, {
      aliases: aliases.customers || {},
    });

    if (custMatch.status === 'matched') {
      resolvedCustomer = custMatch.match;
    } else if (custMatch.status === 'ambiguous') {
      const names = custMatch.candidates.map((c) => c.candidate.name).join(' or ');
      questions.push(`Which customer did you mean for "${parsed.customer_text}": ${names}?`);
    } else {
      questions.push(`Could not find customer "${parsed.customer_text}" in Zoho Books records.`);
    }
  }

  // 3. Resolve Lines
  const resolvedLines = [];
  if (!parsed.lines || parsed.lines.length === 0) {
    questions.push('No product or quantity was specified in the request.');
  } else {
    for (let idx = 0; idx < parsed.lines.length; idx++) {
      const line = parsed.lines[idx];
      const lineNum = parsed.lines.length > 1 ? `Line ${idx + 1}: ` : '';

      // Item matching
      let resolvedItem = null;
      if (!line.item_text || !line.item_text.trim()) {
        questions.push(`${lineNum}Missing product name.`);
      } else {
        const itemMatch = matchCandidate(line.item_text, catalog.items, {
          aliases: aliases.items || {},
        });

        if (itemMatch.status === 'matched') {
          resolvedItem = itemMatch.match;
        } else if (itemMatch.status === 'ambiguous') {
          const names = itemMatch.candidates.map((c) => c.candidate.name).join(' or ');
          questions.push(`${lineNum}Which product did you mean for "${line.item_text}": ${names}?`);
        } else {
          questions.push(`${lineNum}Could not find product "${line.item_text}" in catalog.`);
        }
      }

      // Quantity validation
      const qty = Number(line.quantity);
      if (!qty || isNaN(qty) || qty <= 0) {
        const itemDesc = resolvedItem?.name || line.item_text || 'item';
        questions.push(`${lineNum}Please specify a valid quantity for ${itemDesc}.`);
      }

      // Rate validation
      let rate = Number(line.rate);
      if (line.rate_same_as_last) {
        // Will be handled during execution if customer has previous invoice,
        // but if no rate can be resolved deterministically, ask.
        // For pure decide without async DB lookup, flag as unresolved rate.
        rate = null;
      }

      if (rate === null || isNaN(rate) || rate <= 0) {
        const itemDesc = resolvedItem?.name || line.item_text || 'item';
        if (line.rate_same_as_last) {
          questions.push(`${lineNum}Rate requested as "same as last time". Checking prior invoices...`);
        } else {
          questions.push(`${lineNum}Please specify the rate for ${itemDesc}.`);
        }
      }

      if (resolvedItem && qty > 0 && rate > 0) {
        resolvedLines.push({
          item: resolvedItem,
          quantity: qty,
          rate: rate,
        });
      }
    }
  }

  // 4. Decision: Clarify vs Create
  // Rule 3: Never create an invoice unless customer, every item, every quantity and every rate are resolved.
  if (questions.length > 0 || !resolvedCustomer || resolvedLines.length !== (parsed.lines?.length || 0)) {
    return {
      action: 'clarify',
      reason: questions.join(' | '),
      questions,
      customer: resolvedCustomer,
      lines: resolvedLines,
      unresolved: {
        rawCustomer: parsed.customer_text,
        rawLines: parsed.lines,
      },
    };
  }

  return {
    action: 'create',
    customer: resolvedCustomer,
    lines: resolvedLines,
  };
}

/**
 * Process a message: parse text with LLM and pass to deterministic decision engine
 *
 * @param {string} text - Message text
 * @param {Object} [options]
 * @param {Object} [options.catalog]
 * @param {Object} [options.aliases]
 * @param {string} [options.model]
 * @returns {Promise<{ parsed: Object, decision: Object, meta: Object }>}
 */
export async function processMessage(text, options = {}) {
  const { catalog, aliases } = options.catalog && options.aliases
    ? options
    : await loadCatalogAndAliases();

  const parseResult = await parseMessage(text, options);
  const decision = decide(parseResult.parsed, catalog, aliases);

  return {
    parsed: parseResult.parsed,
    decision,
    meta: {
      model: parseResult.model,
      latencyMs: parseResult.latencyMs,
      retries: parseResult.retries,
    },
  };
}

/**
 * Create invoice in Zoho Books from an approved 'create' decision
 * Invoices are created as DRAFT (Zoho Books default)
 *
 * @param {Object} decision - Decision object with action === 'create'
 * @param {Object} [meta] - Optional reference metadata (rep, timestamp)
 * @returns {Promise<{ invoice: Object, pdfBuffer: Buffer }>}
 */
export async function createFromDecision(decision, meta = {}) {
  if (decision.action !== 'create') {
    throw new Error(`Cannot create invoice from decision with action "${decision.action}"`);
  }

  const lineItems = decision.lines.map((l) => ({
    item_id: l.item.item_id,
    quantity: l.quantity,
    rate: l.rate,
  }));

  const invoice = await createInvoice({
    customerId: decision.customer.contact_id,
    lineItems,
    notes: 'Created automatically via WhatsApp Sales Rep Agent',
    referenceNumber: meta.ref || undefined,
  });

  const pdfBuffer = await getInvoicePdf(invoice.invoice_id);

  return { invoice, pdfBuffer };
}
