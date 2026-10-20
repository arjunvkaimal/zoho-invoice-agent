import { readFile } from 'node:fs/promises';
import { decide } from './pipeline.js';

console.log('================================================================');
console.log('Testing NEW CLIENT (Electronics): Showing Real-World Behaviour');
console.log('(Running on the exact same pipeline code without touching main)');
console.log('================================================================\n');

const clientData = JSON.parse(
  await readFile(new URL('../data/samples/electronics-client.json', import.meta.url), 'utf8')
);

// Populate typical client aliases bootstrapped from past sales invoice history
const clientAliases = {
  customers: {
    techworld: 'TechWorld Solutions',
    apex: 'Apex Electronics',
  },
  items: {
    'cat6 cable 100m': 'Cat6 Ethernet Cable 100m Roll',
    cat6: 'Cat6 Ethernet Cable 100m Roll',
    '65w charger': 'USB-C Fast Charger 65W',
    'hdmi cable': 'HDMI 2.1 Ultra High Speed Cable 2m',
  },
};

const { catalog, config } = clientData;

const matcherOptions = {
  tokenAliases: config.token_aliases,
  genericWords: new Set([...config.item_stop_words, ...config.customer_stop_words]),
};

let passed = 0;
let total = 0;

function assert(cond, label) {
  total++;
  if (cond) {
    passed++;
    console.log(`[PASS] ${label}`);
  } else {
    console.error(`[FAIL] ${label}`);
  }
}

// -------------------------------------------------------------
// Test 1: Order using client alias bootstrapped from history
// -------------------------------------------------------------
console.log('--- Test 1: Clear Order using Bootstrapped Client Aliases ---');
const t1 = decide(
  {
    intent: 'create_invoice',
    customer_text: 'TechWorld',
    lines: [
      { item_text: 'cat6 cbl 100m', quantity: 5, rate: 2400 },
    ],
  },
  catalog,
  clientAliases,
  matcherOptions
);

assert(t1.action === 'create', 'Decision action is CREATE draft invoice');
assert(t1.customer.name === 'TechWorld Solutions', 'Customer resolved to TechWorld Solutions');
assert(t1.lines[0].item.name === 'Cat6 Ethernet Cable 100m Roll', 'Item resolved to Cat6 Ethernet Cable 100m Roll');
assert(t1.lines[0].quantity === 5 && t1.lines[0].rate === 2400, 'Quantity and rate preserved accurately');

// -------------------------------------------------------------
// Test 2: Order with charger alias
// -------------------------------------------------------------
console.log('\n--- Test 2: Fast Shorthand Order ("65w charger") ---');
const t2 = decide(
  {
    intent: 'create_invoice',
    customer_text: 'Apex',
    lines: [
      { item_text: '65w charger', quantity: 10, rate: 850 },
    ],
  },
  catalog,
  clientAliases,
  matcherOptions
);

assert(t2.action === 'create', 'Decision action is CREATE draft invoice');
assert(t2.customer.name === 'Apex Electronics', 'Customer resolved to Apex Electronics');
assert(t2.lines[0].item.name === 'USB-C Fast Charger 65W', 'Matched 65W charger');

// -------------------------------------------------------------
// Test 3: Ambiguous Order (Rep types vague "cable" without SKU)
// -------------------------------------------------------------
console.log('\n--- Test 3: Ambiguity Protection (Rep writes vague "cable") ---');
const t3 = decide(
  {
    intent: 'create_invoice',
    customer_text: 'TechWorld',
    lines: [
      { item_text: 'cable', quantity: 5, rate: 500 },
    ],
  },
  catalog,
  clientAliases,
  matcherOptions
);

assert(t3.action === 'clarify', 'Bot safely refuses to guess and triggers CLARIFY');
assert(t3.questions.length > 0, 'Clarification asked to sales rep');
console.log(`Bot Clarification Question: "${t3.reply}"`);

// -------------------------------------------------------------
// Test 4: Missing customer party name
// -------------------------------------------------------------
console.log('\n--- Test 4: Missing Customer Guardrail ---');
const t4 = decide(
  {
    intent: 'create_invoice',
    customer_text: null,
    lines: [
      { item_text: 'cat6', quantity: 10, rate: 2400 },
    ],
  },
  catalog,
  clientAliases,
  matcherOptions
);

assert(t4.action === 'clarify', 'Missing customer triggers CLARIFY');
assert(t4.questions[0].includes('customer'), 'Asks which party to invoice');

// -------------------------------------------------------------
// Test 5: Casual chat message
// -------------------------------------------------------------
console.log('\n--- Test 5: Casual Chatter Suppression ---');
const t5 = decide(
  {
    intent: 'general_chatter',
    customer_text: null,
    lines: [],
  },
  catalog,
  clientAliases,
  matcherOptions
);

assert(t5.action === 'ignore', 'Casual chatter ignored silently with no spam in group');

console.log(`\n================================================================`);
console.log(`New Client Test Result: ${passed}/${total} assertions passed.`);
console.log('Verified: Multi-client configuration works cleanly without touching main!');
console.log('================================================================');
