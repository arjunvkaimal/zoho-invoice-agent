import { processMessage } from './pipeline.js';

const samples = [
  'VK\nred lenzo alloy 18 inch x 4\nrate 5200',
  'black lenzo 17 wheel 2 pcs Sharma motors 4800',
  'Sharma / 4 pcs red lenzo alloy 18 inch / rate 5200',
  'VK / 4 pcs red lenzo alloy 18 inch',
  'VK / 4 pcs red wheel / rate 5200',
  'ok thanks',
  'where is my invoice from yesterday?',
];

console.log('=== Running src/try.js through pipeline ===\n');

for (const msg of samples) {
  console.log('----------------------------------------------------');
  console.log(`INPUT: "${msg.replace(/\n/g, ' ')}"`);
  try {
    const res = await processMessage(msg);
    console.log(`PARSED: intent=${res.parsed.intent}, customer="${res.parsed.customer_text}", lines=${res.parsed.lines.length}`);
    console.log(`ACTION: ${res.decision.action.toUpperCase()}`);
    if (res.decision.action === 'create') {
      console.log(`  Customer: ${res.decision.customer.name}`);
      for (const line of res.decision.lines) {
        console.log(`  Item: ${line.item.name} | Qty: ${line.quantity} | Rate: ${line.rate}`);
      }
    } else if (res.decision.action === 'clarify') {
      console.log(`  Questions:\n    - ${res.decision.questions.join('\n    - ')}`);
    } else if (res.decision.action === 'unsupported') {
      console.log(`  Message: ${res.decision.message}`);
    } else if (res.decision.action === 'ignore') {
      console.log(`  (Deliberately silent / ignored: ${res.decision.reason})`);
    }
    console.log(`LATENCY: ${res.meta.latencyMs}ms | RETRIES: ${res.meta.retries}`);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
  }
}

console.log('----------------------------------------------------');
console.log('Done.');
