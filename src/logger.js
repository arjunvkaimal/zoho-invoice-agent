import { EventEmitter } from 'node:events';

/**
 * Shared in-memory log store and event emitter.
 * Any module can call addLogEntry() and the dashboard picks it up via SSE.
 */

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

const MAX_ENTRIES = 200;
const entries = [];

/**
 * @typedef {Object} LogEntry
 * @property {string} timestamp
 * @property {string} source       - 'telegram' | 'terminal' | 'eval'
 * @property {string} sender       - rep name or username
 * @property {string} text         - raw message text
 * @property {string} intent       - parsed intent from LLM
 * @property {string|null} customer - extracted customer text
 * @property {Array} lines         - parsed line items
 * @property {string} action       - decide() result: create | clarify | ignore | unsupported
 * @property {string|null} reason  - decision reason
 * @property {string|null} invoiceNumber - Zoho invoice number if created
 * @property {number} latencyMs    - total processing time
 */

/**
 * Add a log entry and notify any connected SSE clients.
 * @param {LogEntry} entry
 */
export function addLogEntry(entry) {
  const record = {
    id: entries.length + 1,
    timestamp: entry.timestamp || new Date().toISOString(),
    source: entry.source || 'unknown',
    sender: entry.sender || 'unknown',
    text: entry.text || '',
    intent: entry.intent || '',
    customer: entry.customer || null,
    lines: entry.lines || [],
    action: entry.action || '',
    reason: entry.reason || null,
    invoiceNumber: entry.invoiceNumber || null,
    latencyMs: entry.latencyMs || 0,
  };
  entries.push(record);
  if (entries.length > MAX_ENTRIES) entries.shift();
  emitter.emit('entry', record);
}

/**
 * Get all stored entries.
 * @returns {LogEntry[]}
 */
export function getEntries() {
  return [...entries];
}

/**
 * Subscribe to new entries (for SSE).
 * @param {function} listener
 * @returns {function} unsubscribe function
 */
export function onEntry(listener) {
  emitter.on('entry', listener);
  return () => emitter.off('entry', listener);
}
