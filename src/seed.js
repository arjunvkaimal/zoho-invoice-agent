// Usage:
//   node src/seed.js --dry   (show what would be created)
//   node src/seed.js         (create missing customers and items; safe to re-run)
import { readFile } from 'node:fs/promises';
import { getContacts, getItems, getTaxes, createContact, createItem, sleep } from './zoho.js';

const DRY = process.argv.includes('--dry');
const GST_ENABLED = process.env.ZOHO_GST_ENABLED !== 'false'; // set to false for a non-GST org
const GST_PERCENT = Number(process.env.GST_PERCENT || 18);

const data = JSON.parse(await readFile(new URL('../data/master-data.json', import.meta.url), 'utf8'));
const norm = (s) => s.trim().toLowerCase();

// Pick one tax so every item has the same GST rate
let taxId;
try {
  const taxes = await getTaxes();
  const matches = taxes.filter((t) => Number(t.tax_percentage) === GST_PERCENT);
  const pick = matches.find((t) => /gst/i.test(t.tax_name) && !/igst/i.test(t.tax_name)) || matches[0];
  if (pick) {
    taxId = pick.tax_id;
    console.log(`Using tax: ${pick.tax_name} (${pick.tax_percentage}%)`);
  } else {
    console.warn(`No ${GST_PERCENT}% tax found. Items will be created without a tax.`);
  }
} catch (e) {
  console.warn('Could not read taxes:', e.message);
}

const existingCustomers = new Set((await getContacts()).map((c) => norm(c.contact_name)));
const existingItems = new Set((await getItems()).map((i) => norm(i.name)));

let created = 0, skipped = 0, failed = 0;

// ---------- Customers ----------
for (const c of data.customers) {
  if (existingCustomers.has(norm(c.name))) { skipped++; continue; }
  if (DRY) { console.log('[dry] customer:', c.name); continue; }

  const base = { contact_name: c.name, company_name: c.name, contact_type: 'customer' };
  // Try with GST treatment first, then fall back to a plain customer
  const attempts = GST_ENABLED ? [{ ...base, gst_treatment: 'consumer' }, base] : [base];

  let ok = false, lastErr;
  for (const payload of attempts) {
    try {
      await createContact(payload);
      ok = true;
      break;
    } catch (e) {
      lastErr = e;
      if (!/invalid element/i.test(e.message)) break; // only retry on field errors
    }
  }
  if (ok) { created++; console.log('+ customer:', c.name); }
  else { failed++; console.error(`! customer "${c.name}": ${lastErr.message}`); }
  await sleep(300);
}

// ---------- Items ----------
for (const i of data.items) {
  if (existingItems.has(norm(i.name))) { skipped++; continue; }
  if (DRY) { console.log('[dry] item:', i.name, i.rate); continue; }

  const base = {
    name: i.name,
    sku: i.sku,
    rate: i.rate,
    unit: 'pcs',
    product_type: 'goods',
    item_type: 'sales',
    ...(taxId ? { tax_id: taxId } : {}),
  };
  const attempts = GST_ENABLED ? [{ ...base, hsn_or_sac: i.hsn }, base] : [base];

  let ok = false, lastErr;
  for (const payload of attempts) {
    try {
      await createItem(payload);
      ok = true;
      break;
    } catch (e) {
      lastErr = e;
      if (!/invalid element/i.test(e.message)) break;
    }
  }
  if (ok) { created++; console.log('+ item:', i.name); }
  else { failed++; console.error(`! item "${i.name}": ${lastErr.message}`); }
  await sleep(300);
}

console.log(`\nDone. created=${created} skipped(existing)=${skipped} failed=${failed}${DRY ? ' (dry run)' : ''}`);