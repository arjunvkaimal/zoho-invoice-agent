import { writeFile } from 'node:fs/promises';
import { getContacts, getItems } from './zoho.js';

console.log('Fetching contacts and items from Zoho Books...');
const [contacts, items] = await Promise.all([
  getContacts(),
  getItems(),
]);

const catalog = {
  fetchedAt: new Date().toISOString(),
  customers: contacts.map((c) => ({
    contact_id: c.contact_id,
    name: c.contact_name,
  })),
  items: items.map((i) => ({
    item_id: i.item_id,
    name: i.name,
    sku: i.sku || null,
    rate: i.rate,
  })),
};

const targetPath = new URL('../data/catalog-snapshot.json', import.meta.url);
await writeFile(targetPath, JSON.stringify(catalog, null, 2), 'utf8');

console.log(`Saved catalog snapshot to data/catalog-snapshot.json`);
console.log(`- Customers: ${catalog.customers.length}`);
console.log(`- Items: ${catalog.items.length}`);
