import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { readFile } from 'node:fs/promises';
import { parseMessage } from './llm.js';
import { decide } from './pipeline.js';

const clientData = JSON.parse(
  await readFile(new URL('../data/samples/electronics-client.json', import.meta.url), 'utf8')
);

const { catalog, config, aliases } = clientData;

// Bootstrapped aliases for common sales shorthand
const clientAliases = {
  customers: aliases.customers || {
    techworld: 'TechWorld Solutions',
    apex: 'Apex Electronics',
  },
  items: {
    'cat6 cable 100m': 'Cat6 Ethernet Cable 100m Roll',
    cat6: 'Cat6 Ethernet Cable 100m Roll',
    '65w charger': 'USB-C Fast Charger 65W',
    'hdmi cable': 'HDMI 2.1 Ultra High Speed Cable 2m',
    ...(aliases.items || {}),
  },
};

const matcherOptions = {
  tokenAliases: config.token_aliases,
  genericWords: new Set([...config.item_stop_words, ...config.customer_stop_words]),
};

console.log('===============================================================');
console.log('Sales Rep Simulator: APEX ELECTRONICS & HARDWARE (NEW CLIENT)');
console.log('Catalogue Loaded:');
console.log('  Customers: ' + catalog.customers.map((c) => c.name).join(', '));
console.log('  Products:');
for (const item of catalog.items) {
  console.log(`   - ${item.name} (Rate: ₹${item.rate})`);
}
console.log('===============================================================');
console.log('Type any message as a sales rep and press Enter.');
console.log('Type "exit" or "quit" to stop.\n');

const rl = readline.createInterface({ input, output });

try {
  while (true) {
    let text;
    try {
      text = await rl.question('Sales Rep > ');
    } catch {
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
      const parseResult = await parseMessage(trimmed);
      const decision = decide(parseResult.parsed, catalog, clientAliases, matcherOptions);
      const latency = Date.now() - startTime;

      console.log(`\n[Pipeline: ${parseResult.model} | Latency: ${latency}ms]`);

      if (decision.action === 'ignore') {
        console.log(`Agent > (Deliberately stays silent in chat)`);
        console.log(`        [Audit log: Ignored non-invoice chatter - ${decision.reason}]\n`);
      } else if (decision.action === 'unsupported') {
        console.log(`Agent > ${decision.reply || decision.message}\n`);
      } else if (decision.action === 'clarify') {
        console.log(`Agent > ${decision.reply}\n`);
      } else if (decision.action === 'create') {
        console.log(`Agent > [Draft Invoice Ready for Zoho Books]`);
        console.log(`        Customer: ${decision.customer.name}`);
        for (const l of decision.lines) {
          console.log(`        Item: ${l.item.name} | Qty: ${l.quantity} | Rate: ₹${l.rate}`);
        }
        const total = decision.lines.reduce((sum, l) => sum + l.quantity * l.rate, 0);
        console.log(`        Total: ₹${total.toLocaleString('en-IN')}\n`);
      }
    } catch (err) {
      console.error(`Agent Error > ${err.message}\n`);
    }
  }
} finally {
  rl.close();
}
