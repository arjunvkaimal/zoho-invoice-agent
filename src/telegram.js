import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { Bot, InputFile } from 'grammy';
import { processMessage, createFromDecision, loadCatalogAndAliases, startPeriodicCatalogRefresh } from './pipeline.js';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_CHAT_ID = process.env.ALLOWED_CHAT_ID ? String(process.env.ALLOWED_CHAT_ID).trim() : null;

const DEDUPE_FILE = new URL('../data/processed.json', import.meta.url);
const SEEN_CHATS = new Set();

// ---------- Deduplication Store ----------
let processedKeys = new Set();
try {
  if (existsSync(DEDUPE_FILE)) {
    const raw = await readFile(DEDUPE_FILE, 'utf8');
    processedKeys = new Set(JSON.parse(raw));
  }
} catch (e) {
  console.warn('Could not load processed dedupe file, starting fresh set:', e.message);
}

async function markProcessed(key) {
  processedKeys.add(key);
  try {
    const list = Array.from(processedKeys).slice(-3000);
    await writeFile(DEDUPE_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to persist processed key:', e.message);
  }
}

// ---------- Sequential Processing Queue ----------
let queuePromise = Promise.resolve();
function enqueue(task) {
  queuePromise = queuePromise.then(task).catch((err) => {
    console.error('[Queue Error]', err);
  });
  return queuePromise;
}

// Helper to sanitize error logs and prevent secret leakage
function sanitizeError(msg) {
  if (!msg) return 'Unknown error';
  return String(msg)
    .replace(/[A-Za-z0-9_-]{20,}/g, '[REDACTED]')
    .replace(/bot[0-9]+:[A-Za-z0-9_-]+/g, '[REDACTED_TOKEN]');
}

export function createTelegramBot(options = {}) {
  const token = options.token || TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is not configured in environment or options');
  }

  const allowedChatId = options.allowedChatId !== undefined
    ? (options.allowedChatId ? String(options.allowedChatId).trim() : null)
    : ALLOWED_CHAT_ID;

  const bot = new Bot(token);
  const createInvoiceFn = options.createFromDecision || createFromDecision;

  // Handle plain text messages
  bot.on('message:text', async (ctx) => {
    // 1. Ignore edited messages or non-group messages
    if (ctx.editedMessage) return;

    const chatType = ctx.chat?.type;
    const isGroup = chatType === 'group' || chatType === 'supergroup';
    if (!isGroup) return; // Only process group messages

    // 2. Ignore bot messages
    if (ctx.from?.is_bot) return;

    // 3. Ignore slash commands
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;

    const chatIdStr = String(ctx.chat.id);
    const chatTitle = ctx.chat.title || 'Untitled Group';

    // 4. Group discovery & restriction
    if (!allowedChatId) {
      if (!SEEN_CHATS.has(chatIdStr)) {
        SEEN_CHATS.add(chatIdStr);
        console.log(`\n📢 [Group Discovery] Received message in group: "${chatTitle}" (Chat ID: ${chatIdStr})`);
        console.log(`👉 Add ALLOWED_CHAT_ID=${chatIdStr} to your .env file to bind the bot to this group.\n`);
      }
      return;
    }

    if (chatIdStr !== allowedChatId) {
      if (!SEEN_CHATS.has(chatIdStr)) {
        SEEN_CHATS.add(chatIdStr);
        console.log(`[Group Ignored] Message from non-allowed chat "${chatTitle}" (Chat ID: ${chatIdStr})`);
      }
      return;
    }

    // 5. Deduplication by "<chat_id>:<message_id>"
    const messageId = ctx.message.message_id;
    const dedupeKey = `${chatIdStr}:${messageId}`;
    if (processedKeys.has(dedupeKey)) {
      console.log(`[Dedupe] Skipping already processed message ${dedupeKey}`);
      return;
    }

    const sender = ctx.from.username
      ? `@${ctx.from.username}`
      : [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || 'Sales Rep';

    // 6. Sequential Queue execution
    enqueue(async () => {
      await markProcessed(dedupeKey);
      const startTime = Date.now();
      const timeStr = new Date().toISOString();

      console.log(`\n---------------------------------------------------------`);
      console.log(`[${timeStr}] [INCOMING] From: ${sender} (Chat: ${chatTitle})`);
      console.log(`[TEXT]: "${text.replace(/\n/g, ' ')}"`);

      // Send typing chat action while processing
      try {
        await ctx.replyWithChatAction('typing');
      } catch (_) {}

      try {
        const res = await processMessage(text);
        const decision = res.decision;
        const latencyMs = Date.now() - startTime;

        console.log(`[PARSED]: Intent=${res.parsed.intent}, Customer="${res.parsed.customer_text}", Lines=${res.parsed.lines.length}`);
        console.log(`[ACTION]: ${decision.action.toUpperCase()} (${latencyMs}ms)`);

        // Action: IGNORE
        if (decision.action === 'ignore') {
          console.log(`[IGNORE] Staying silent: ${decision.reason}`);
          return;
        }

        // Action: UNSUPPORTED
        if (decision.action === 'unsupported') {
          const replyText = decision.reply || decision.message || 'This request cannot be processed automatically.';
          console.log(`[UNSUPPORTED] Replying: "${replyText}"`);
          await ctx.reply(replyText, {
            reply_parameters: { message_id: messageId },
          });
          return;
        }

        // Action: CLARIFY
        if (decision.action === 'clarify') {
          const replyText = decision.reply || (
            `❓ Clarification needed:\n` + decision.questions.map((q) => `• ${q}`).join('\n')
          );
          console.log(`[CLARIFY] Replying with questions`);
          await ctx.reply(replyText, {
            reply_parameters: { message_id: messageId },
          });
          return;
        }

        // Action: CREATE
        if (decision.action === 'create') {
          console.log(`[CREATE] Creating Zoho Draft Invoice for ${decision.customer.name}...`);
          const { invoice, pdfBuffer } = await createInvoiceFn(decision, {
            ref: `TG-${messageId}`,
          });

          console.log(`[CREATED] Invoice: ${invoice.invoice_number} (ID: ${invoice.invoice_id}) | Latency: ${latencyMs}ms`);

          const linesSummary = decision.lines
            .map((l) => `• ${l.quantity} x ${l.item.name} @ ₹${l.rate.toLocaleString('en-IN')}`)
            .join('\n');

          const caption =
            `✅ *Invoice ${invoice.invoice_number} created for ${decision.customer.name} (DRAFT)*\n\n` +
            `${linesSummary}\n\n` +
            `*Total:* ₹${Number(invoice.total || 0).toLocaleString('en-IN')}\n` +
            `_(Created as Draft in Zoho Books - pending accountant review)_`;

          await ctx.replyWithDocument(
            new InputFile(pdfBuffer, `${invoice.invoice_number}.pdf`),
            {
              caption,
              parse_mode: 'Markdown',
              reply_parameters: { message_id: messageId },
            }
          );
          console.log(`[SENT] PDF document sent to Telegram group.`);
          return;
        }
      } catch (err) {
        // No silent failures
        const cleanErr = sanitizeError(err.message);
        console.error(`[ERROR] Processing failed for message from ${sender}:`, cleanErr);
        const apology = `⚠️ Sorry, I could not process that invoice request right now due to a system error. Please retry or contact the accountant.`;
        try {
          await ctx.reply(apology, {
            reply_parameters: { message_id: messageId },
          });
        } catch (sendErr) {
          console.error('[ERROR] Failed to send error apology to Telegram:', sanitizeError(sendErr.message));
        }
      }
    });
  });

  return bot;
}

// Allow direct CLI execution: node src/telegram.js
import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log('Starting Telegram Sales Rep Bot adapter with long polling...');
  if (!TELEGRAM_BOT_TOKEN) {
    console.error('❌ Error: TELEGRAM_BOT_TOKEN is not set in .env.');
    console.error('Please create a bot with @BotFather on Telegram and add TELEGRAM_BOT_TOKEN to your .env file.');
    process.exit(1);
  }

  // 1. Initial live catalog fetch from Zoho Books with local fallback
  try {
    await loadCatalogAndAliases({ live: true });
    // 2. Start periodic background refresh every 30 minutes
    startPeriodicCatalogRefresh(30 * 60 * 1000);
    console.log('🔄 Periodic catalogue auto-refresh enabled (every 30 mins).');
  } catch (err) {
    console.warn(`[Catalog Warning] Startup sync issue: ${err.message}. Proceeding with cached snapshot.`);
  }

  const bot = createTelegramBot();
  bot.start({
    onStart: (botInfo) => {
      console.log(`✅ Telegram bot @${botInfo.username} is active and listening for group messages!`);
      if (ALLOWED_CHAT_ID) {
        console.log(`[Telegram] Locked to ALLOWED_CHAT_ID: ${ALLOWED_CHAT_ID}`);
      } else {
        console.log(`[Telegram] ALLOWED_CHAT_ID is not set. Add the bot to your group and send any message to discover its Chat ID.`);
      }
    },
  });
}
