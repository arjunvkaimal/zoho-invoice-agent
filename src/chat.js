import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { mkdir, writeFile } from 'node:fs/promises';
import { processMessage, createFromDecision, loadCatalogAndAliases } from './pipeline.js';

const ACTUALLY_CREATE = process.argv.includes('--create');

console.log('===============================================================');
console.log('Sales Rep Invoice Agent Terminal Simulator');
console.log(`Mode: ${ACTUALLY_CREATE ? 'LIVE CREATION (--create: real Zoho draft invoices will be created)' : 'DRY-RUN (Default: no real Zoho invoices will be created)'}`);
console.log('Type any message as a sales rep and press Enter.');
console.log('Type "exit" or "quit" to stop.');
console.log('===============================================================\n');

if (ACTUALLY_CREATE) {
  await loadCatalogAndAliases({ live: true });
}

const rl = readline.createInterface({ input, output });

try {
  while (true) {
    let text;
    try {
      text = await rl.question('Sales Rep > ');
    } catch (err) {
      // Stream closed (EOF or Ctrl+C)
      break;
    }

    if (text === null || text === undefined) break;
    if (!text.trim()) continue;

    const trimmed = text.trim();
    if (trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === 'quit') {
      console.log('Exiting simulator.');
      break;
    }

    const startTime = Date.now();
    try {
      const res = await processMessage(trimmed);
      const decision = res.decision;
      const latency = Date.now() - startTime;

      console.log(`\n[Pipeline: ${res.meta.model} | Latency: ${latency}ms]`);

      if (decision.action === 'ignore') {
        console.log(`Agent > (Deliberately stays silent in chat)`);
        console.log(`        [Audit log: Ignored non-invoice chatter - ${decision.reason}]\n`);
      } else if (decision.action === 'unsupported') {
        console.log(`Agent > ${decision.reply || decision.message}\n`);
      } else if (decision.action === 'clarify') {
        console.log(`Agent > ${decision.reply}\n`);
      } else if (decision.action === 'create') {
        if (!ACTUALLY_CREATE) {
          console.log(`Agent > [DRY RUN - Invoice would be created in Zoho Books]`);
          console.log(`        Customer: ${decision.customer.name}`);
          for (const l of decision.lines) {
            console.log(`        Item: ${l.item.name} | Qty: ${l.quantity} | Rate: ₹${l.rate}`);
          }
          console.log(`        (To create live draft invoices in Zoho, run with: node src/chat.js --create)\n`);
        } else {
          console.log(`Agent > Creating Draft Invoice in Zoho Books...`);
          const { invoice, pdfBuffer } = await createFromDecision(decision, {
            ref: `CLI-${Date.now().toString().slice(-6)}`,
          });

          await mkdir(new URL('../invoices', import.meta.url), { recursive: true });
          const pdfPath = new URL(`../invoices/${invoice.invoice_number}.pdf`, import.meta.url);
          await writeFile(pdfPath, pdfBuffer);

          console.log(`Agent > Invoice ${invoice.invoice_number} created for ${decision.customer.name} (DRAFT)`);
          for (const l of decision.lines) {
            console.log(`        - ${l.quantity} x ${l.item.name} @ ₹${l.rate}`);
          }
          console.log(`        Total: ₹${invoice.total}`);
          console.log(`        Saved PDF to invoices/${invoice.invoice_number}.pdf\n`);
        }
      }
    } catch (err) {
      console.error(`Agent > Error: ${err.message}\n`);
    }
  }
} finally {
  rl.close();
}
