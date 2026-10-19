import { createTelegramBot } from './telegram.js';

console.log('Running Telegram Adapter Unit Test with Stubbed Invoice Creator...\n');

let createdInvoiceCount = 0;
const stubbedCreateFromDecision = async (decision, meta) => {
  createdInvoiceCount++;
  return {
    invoice: {
      invoice_id: 'stub-inv-123',
      invoice_number: 'INV-STUB-001',
      total: 20800,
    },
    pdfBuffer: Buffer.from('%PDF-1.4 mock pdf data'),
  };
};

const fakeToken = '123456789:ABCdefGHIjklMNOpqrSTUvwxYZ';
const bot = createTelegramBot({
  token: fakeToken,
  allowedChatId: '-1001234567890',
  createFromDecision: stubbedCreateFromDecision,
});

bot.botInfo = {
  id: 999999999,
  is_bot: true,
  first_name: 'InvoiceBot',
  username: 'AutoInvoiceBot',
  can_join_groups: true,
  can_read_all_group_messages: true,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
};

const sentCalls = [];
bot.api.config.use(async (prev, method, payload, signal) => {
  sentCalls.push({ method, payload });
  if (method === 'sendMessage' || method === 'sendDocument') {
    return { ok: true, result: { message_id: 999, ...payload } };
  }
  return { ok: true, result: {} };
});

let passed = 0;
let total = 0;

function assert(condition, label) {
  total++;
  if (condition) {
    passed++;
    console.log(`✓ ${label}`);
  } else {
    console.error(`✗ ${label}`);
  }
}

async function sendTestMessage({ text, messageId, chatId = -1001234567890, isBot = false, chatType = 'supergroup' }) {
  sentCalls.length = 0;
  await bot.handleUpdate({
    update_id: messageId,
    message: {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, title: 'Sales Rep Group', type: chatType },
      from: { id: 111, first_name: 'Rajesh', username: 'rajesh_rep', is_bot: isBot },
      text,
    },
  });
  // Wait for sequential queue processing
  await new Promise((r) => setTimeout(r, 4500));
}

const baseId = Math.floor(Date.now() / 1000) % 100000;

console.log('--- Test 1: Ignore slash command ---');
{
  await sendTestMessage({ text: '/help', messageId: baseId + 1 });
  assert(sentCalls.length === 0, 'Slash command /help was ignored without response');
}

console.log('\n--- Test 2: Ignore bot message ---');
{
  await sendTestMessage({ text: 'VK 4 pcs red lenzo 18 5200', messageId: baseId + 2, isBot: true });
  assert(sentCalls.length === 0, 'Bot message was ignored without response');
}

console.log('\n--- Test 3: Ignore private/DM message ---');
{
  await sendTestMessage({ text: 'VK 4 pcs red lenzo 18 5200', messageId: baseId + 3, chatType: 'private' });
  assert(sentCalls.length === 0, 'Direct message (private chat) was ignored');
}

console.log('\n--- Test 4: Casual chatter stays silent ---');
{
  await sendTestMessage({ text: 'ok thanks team', messageId: baseId + 4 });
  assert(sentCalls.filter(c => c.method === 'sendMessage').length === 0, 'Casual chatter was silently ignored');
}

console.log('\n--- Test 5: Ambiguous order triggers clarification quoting original message ---');
{
  await sendTestMessage({ text: 'Sharma / 4 pcs red lenzo alloy 18 inch / rate 5200', messageId: baseId + 5 });
  const reply = sentCalls.find(c => c.method === 'sendMessage');
  assert(reply && reply.payload.text.includes('Which customer did you mean for "Sharma"'), 'Sent clarification for ambiguous customer');
  assert(reply && reply.payload.reply_parameters?.message_id === baseId + 5, 'Quoted original message ID in reply');
}

console.log('\n--- Test 6: Deduplication prevents reprocessing same message ID ---');
{
  await sendTestMessage({ text: 'Sharma / 4 pcs red lenzo alloy 18 inch / rate 5200', messageId: baseId + 5 });
  assert(sentCalls.length === 0, 'Replayed message ID was skipped by deduplication');
}

console.log('\n--- Test 7: Clear order creates stubbed invoice & sends PDF with DRAFT caption ---');
{
  await sendTestMessage({ text: 'VK\nred lenzo alloy 18 inch x 4\nrate 5200', messageId: baseId + 6 });
  const docCall = sentCalls.find(c => c.method === 'sendDocument');
  assert(createdInvoiceCount > 0, 'Called stubbed invoice creator function');
  assert(docCall && docCall.payload.caption.includes('DRAFT'), 'Sent document with DRAFT mentioned in caption');
  assert(docCall && docCall.payload.reply_parameters?.message_id === baseId + 6, 'Document quoted original message ID');
}

console.log(`\nAll adapter tests completed: ${passed}/${total} assertions passed.`);
if (passed === total) {
  console.log('🎉 Telegram Adapter verified successfully!');
} else {
  process.exit(1);
}
