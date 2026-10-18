import 'dotenv/config';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { processMessage, createFromDecision } from './pipeline.js';

const ALLOWED_GROUP_JID = process.env.ALLOWED_GROUP_JID;
const SEEN_GROUPS = new Set();
const DEDUPE_FILE = new URL('../data/processed-ids.json', import.meta.url);

// ---------- Deduplication Store ----------
let processedIds = new Set();
try {
  if (existsSync(DEDUPE_FILE)) {
    const raw = await readFile(DEDUPE_FILE, 'utf8');
    processedIds = new Set(JSON.parse(raw));
  }
} catch (e) {
  console.warn('Could not load dedupe file; starting fresh set:', e.message);
}

async function markProcessed(msgId) {
  processedIds.add(msgId);
  try {
    // Keep max 2,000 recent message IDs to prevent unbounded file growth
    const list = Array.from(processedIds).slice(-2000);
    await writeFile(DEDUPE_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to persist processed msg ID:', e.message);
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

// ---------- Extract Text from Baileys Message ----------
function extractText(msg) {
  const m = msg.message;
  if (!m) return null;
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    null
  );
}

// ---------- Main Connection Function ----------
export async function startWhatsAppAgent() {
  await mkdir(new URL('../auth', import.meta.url), { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState('./auth');

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'warn' }),
    printQRInTerminal: false, // We use qrcode-terminal directly on connection.update
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n================ SCAN WHATSAPP QR CODE ================');
      qrcode.generate(qr, { small: true });
      console.log('Open WhatsApp on your phone -> Linked Devices -> Link a Device\n');
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.warn(`[WhatsApp] Connection closed (code: ${statusCode}). Reconnecting: ${shouldReconnect}`);
      if (shouldReconnect) {
        startWhatsAppAgent();
      } else {
        console.error('[WhatsApp] Logged out. Delete auth/ folder and re-scan QR code.');
      }
    } else if (connection === 'open') {
      console.log('✅ [WhatsApp] Connected successfully!');
      if (ALLOWED_GROUP_JID) {
        console.log(`[WhatsApp] Listening exclusively to group: ${ALLOWED_GROUP_JID}`);
      } else {
        console.log('[WhatsApp] WARNING: ALLOWED_GROUP_JID is not configured in .env. Incoming group JIDs will be logged to help you find your test group.');
      }
    }
  });

  // Handle incoming messages
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      // 1. Basic validation & skip bot's own messages
      if (!msg.message || msg.key.fromMe) continue;

      const remoteJid = msg.key.remoteJid;
      const isGroup = remoteJid?.endsWith('@g.us');

      // Only act in groups
      if (!isGroup) continue;

      // Group discovery / restriction
      if (!ALLOWED_GROUP_JID) {
        if (!SEEN_GROUPS.has(remoteJid)) {
          SEEN_GROUPS.add(remoteJid);
          console.log(`\n📢 [Group Discovery] Incoming message from group JID: ${remoteJid}`);
          console.log(`👉 Set ALLOWED_GROUP_JID=${remoteJid} in your .env file to bind the agent to this group.\n`);
        }
        continue;
      }

      if (remoteJid !== ALLOWED_GROUP_JID) {
        if (!SEEN_GROUPS.has(remoteJid)) {
          SEEN_GROUPS.add(remoteJid);
          console.log(`[Group Ignored] Message from non-allowed group: ${remoteJid}`);
        }
        continue;
      }

      // Deduplication by msg.key.id
      const msgId = msg.key.id;
      if (processedIds.has(msgId)) {
        console.log(`[Dedupe] Skipping already processed message ID: ${msgId}`);
        continue;
      }

      const text = extractText(msg);
      if (!text || !text.trim()) continue;

      const senderName = msg.pushName || msg.key.participant || 'Sales Rep';
      const senderJid = msg.key.participant || remoteJid;

      // Queue sequential execution
      enqueue(async () => {
        await markProcessed(msgId);
        console.log(`\n---------------------------------------------------------`);
        console.log(`[INCOMING] From: ${senderName} (${senderJid})`);
        console.log(`[TEXT]: "${text.replace(/\n/g, ' ')}"`);

        try {
          const res = await processMessage(text);
          const decision = res.decision;
          console.log(`[DECISION]: ${decision.action.toUpperCase()} (${res.meta.latencyMs}ms)`);

          // 1. IGNORE
          if (decision.action === 'ignore') {
            console.log(`[IGNORE] Staying silent: ${decision.reason}`);
            return;
          }

          // 2. UNSUPPORTED
          if (decision.action === 'unsupported') {
            const replyText = decision.message || 'This request cannot be processed automatically.';
            console.log(`[UNSUPPORTED] Replying: "${replyText}"`);
            await sock.sendMessage(remoteJid, { text: replyText }, { quoted: msg });
            return;
          }

          // 3. CLARIFY
          if (decision.action === 'clarify') {
            console.log(`[CLARIFY] Asking questions:`, decision.questions);
            const questionText = `❓ *Clarification Needed:*\n` +
              decision.questions.map((q) => `• ${q}`).join('\n');
            await sock.sendMessage(remoteJid, { text: questionText }, { quoted: msg });
            return;
          }

          // 4. CREATE
          if (decision.action === 'create') {
            console.log(`[CREATE] Generating Zoho draft invoice for ${decision.customer.name}...`);
            const { invoice, pdfBuffer } = await createFromDecision(decision, {
              ref: `WA-${msgId.slice(-8)}`,
            });

            console.log(`[CREATED] Invoice: ${invoice.invoice_number} (ID: ${invoice.invoice_id})`);

            // Build human-friendly summary caption
            const linesSummary = decision.lines
              .map((l) => `• ${l.quantity} x ${l.item.name} @ ₹${l.rate.toLocaleString('en-IN')}`)
              .join('\n');

            const caption =
              `✅ *Invoice ${invoice.invoice_number} created for ${decision.customer.name}*\n\n` +
              `${linesSummary}\n\n` +
              `*Total:* ₹${Number(invoice.total || 0).toLocaleString('en-IN')} (Draft created in Zoho Books)`;

            await sock.sendMessage(
              remoteJid,
              {
                document: pdfBuffer,
                mimetype: 'application/pdf',
                fileName: `${invoice.invoice_number}.pdf`,
                caption,
              },
              { quoted: msg }
            );
            console.log(`[SENT] PDF and caption delivered to group.`);
            return;
          }
        } catch (err) {
          // Rule 5: No silent failures
          console.error(`[ERROR] Processing failed for message from ${senderName}:`, err);
          const apology =
            `⚠️ *Error:* Could not process your request due to a system error (${err.message.slice(0, 100)}). Please retry or contact the accounting team.`;
          try {
            await sock.sendMessage(remoteJid, { text: apology }, { quoted: msg });
          } catch (sendErr) {
            console.error('[ERROR] Failed to send error apology to WhatsApp:', sendErr);
          }
        }
      });
    }
  });

  return sock;
}

// Allow direct CLI execution: node src/whatsapp.js
if (process.argv[1] && process.argv[1].endsWith('whatsapp.js')) {
  console.log('Initializing WhatsApp Sales Rep Agent Listener...');
  startWhatsAppAgent();
}
