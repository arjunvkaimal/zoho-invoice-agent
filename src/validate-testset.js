import { readFile } from 'node:fs/promises';

const catBuf = await readFile(new URL('../data/catalog-snapshot.json', import.meta.url), 'utf8');
const testBuf = await readFile(new URL('../data/testset.json', import.meta.url), 'utf8');

const catalog = JSON.parse(catBuf);
const testset = JSON.parse(testBuf);

const customerNames = new Set(catalog.customers.map((c) => c.name));
const itemNames = new Set(catalog.items.map((i) => i.name));

let errors = 0;
let devCount = 0;
let holdoutCount = 0;

for (const entry of testset) {
  if (entry.split === 'dev') devCount++;
  else if (entry.split === 'holdout') holdoutCount++;
  else {
    console.error(`[${entry.id}] Invalid split: "${entry.split}"`);
    errors++;
  }

  // Check expected customer
  if (entry.expected.customer) {
    if (!customerNames.has(entry.expected.customer)) {
      console.error(`[${entry.id}] Customer "${entry.expected.customer}" not found in catalog!`);
      errors++;
    }
  }

  // Check expected items
  if (entry.expected.lines && Array.isArray(entry.expected.lines)) {
    for (const line of entry.expected.lines) {
      if (!itemNames.has(line.item)) {
        console.error(`[${entry.id}] Item "${line.item}" not found in catalog!`);
        errors++;
      }
      if (typeof line.quantity !== 'number' || line.quantity <= 0) {
        console.error(`[${entry.id}] Invalid quantity: ${line.quantity}`);
        errors++;
      }
      if (typeof line.rate !== 'number' || line.rate <= 0) {
        console.error(`[${entry.id}] Invalid rate: ${line.rate}`);
        errors++;
      }
    }
  }
}

console.log(`Validation results:`);
console.log(`Total test cases: ${testset.length} (Dev: ${devCount}, Holdout: ${holdoutCount})`);
if (errors > 0) {
  console.error(`❌ Validation failed with ${errors} error(s)!`);
  process.exit(1);
} else {
  console.log(`✅ All ground truth customer and item names match catalog snapshot exactly!`);
}
