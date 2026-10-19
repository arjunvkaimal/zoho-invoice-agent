import express from 'express';
import { getEntries, onEntry } from './logger.js';

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Invoice Agent — Live Log</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; color: #333; padding: 20px; }
  h1 { font-size: 1.3rem; margin-bottom: 6px; }
  .subtitle { color: #777; font-size: 0.85rem; margin-bottom: 16px; }
  .stats { display: flex; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
  .stat-card { background: #fff; border-radius: 8px; padding: 14px 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); min-width: 120px; }
  .stat-card .label { font-size: 0.75rem; color: #999; text-transform: uppercase; letter-spacing: 0.5px; }
  .stat-card .value { font-size: 1.6rem; font-weight: 600; margin-top: 4px; }
  .stat-card.create .value { color: #16a34a; }
  .stat-card.clarify .value { color: #d97706; }
  .stat-card.ignore .value { color: #6b7280; }
  .stat-card.error .value { color: #dc2626; }
  .live-dot { display: inline-block; width: 8px; height: 8px; background: #16a34a; border-radius: 50%; margin-right: 6px; animation: pulse 2s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  th { background: #fafafa; text-align: left; padding: 10px 12px; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.5px; color: #888; border-bottom: 2px solid #eee; position: sticky; top: 0; }
  td { padding: 10px 12px; border-bottom: 1px solid #f0f0f0; font-size: 0.85rem; vertical-align: top; max-width: 280px; word-wrap: break-word; }
  tr:hover { background: #f9fafb; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; }
  .badge-create { background: #dcfce7; color: #166534; }
  .badge-clarify { background: #fef3c7; color: #92400e; }
  .badge-ignore { background: #f3f4f6; color: #6b7280; }
  .badge-unsupported { background: #fce7f3; color: #9d174d; }
  .badge-error { background: #fee2e2; color: #991b1b; }
  .mono { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.78rem; }
  .text-muted { color: #999; font-size: 0.78rem; }
  .lines-detail { font-size: 0.78rem; color: #555; }
  .empty-state { text-align: center; padding: 60px 20px; color: #aaa; }
  .invoice-link { color: #2563eb; font-weight: 600; }
  .timestamp { white-space: nowrap; font-size: 0.78rem; color: #888; }
</style>
</head>
<body>
<h1><span class="live-dot"></span>Invoice Agent — Live Log</h1>
<p class="subtitle">Messages are displayed in real time as they are processed by the bot.</p>

<div class="stats">
  <div class="stat-card"><div class="label">Total</div><div class="value" id="s-total">0</div></div>
  <div class="stat-card create"><div class="label">Created</div><div class="value" id="s-create">0</div></div>
  <div class="stat-card clarify"><div class="label">Clarified</div><div class="value" id="s-clarify">0</div></div>
  <div class="stat-card ignore"><div class="label">Ignored</div><div class="value" id="s-ignore">0</div></div>
</div>

<table>
<thead>
<tr>
  <th>#</th>
  <th>Time</th>
  <th>Source</th>
  <th>Sender</th>
  <th>Message</th>
  <th>Intent</th>
  <th>Customer</th>
  <th>Items</th>
  <th>Action</th>
  <th>Invoice</th>
  <th>Latency</th>
</tr>
</thead>
<tbody id="log-body">
</tbody>
</table>
<div class="empty-state" id="empty-msg">Waiting for messages...</div>

<script>
const tbody = document.getElementById('log-body');
const emptyMsg = document.getElementById('empty-msg');
const counts = { total: 0, create: 0, clarify: 0, ignore: 0 };

function updateStats() {
  document.getElementById('s-total').textContent = counts.total;
  document.getElementById('s-create').textContent = counts.create;
  document.getElementById('s-clarify').textContent = counts.clarify;
  document.getElementById('s-ignore').textContent = counts.ignore;
}

function badgeClass(action) {
  return 'badge badge-' + (action || 'ignore');
}

function formatLines(lines) {
  if (!lines || lines.length === 0) return '<span class="text-muted">—</span>';
  return lines.map(l => {
    const item = l.item_text || l.item?.name || l.item || '?';
    const qty = l.quantity ?? '?';
    const rate = l.rate != null ? '₹' + Number(l.rate).toLocaleString('en-IN') : '?';
    return qty + ' × ' + item + ' @ ' + rate;
  }).join('<br>');
}

function formatTime(ts) {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch { return ts; }
}

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '…' : str;
}

function addRow(entry) {
  emptyMsg.style.display = 'none';
  counts.total++;
  if (entry.action === 'create') counts.create++;
  else if (entry.action === 'clarify') counts.clarify++;
  else counts.ignore++;
  updateStats();

  const tr = document.createElement('tr');
  tr.innerHTML = [
    '<td class="mono">' + entry.id + '</td>',
    '<td class="timestamp">' + formatTime(entry.timestamp) + '</td>',
    '<td>' + (entry.source || '') + '</td>',
    '<td>' + (entry.sender || '') + '</td>',
    '<td>' + truncate(entry.text, 80) + '</td>',
    '<td class="mono">' + (entry.intent || '') + '</td>',
    '<td>' + (entry.customer || '<span class="text-muted">—</span>') + '</td>',
    '<td class="lines-detail">' + formatLines(entry.lines) + '</td>',
    '<td><span class="' + badgeClass(entry.action) + '">' + (entry.action || '') + '</span></td>',
    '<td>' + (entry.invoiceNumber ? '<span class="invoice-link">' + entry.invoiceNumber + '</span>' : '<span class="text-muted">—</span>') + '</td>',
    '<td class="mono">' + (entry.latencyMs ? entry.latencyMs + 'ms' : '') + '</td>',
  ].join('');
  tbody.prepend(tr);
}

// Load existing entries
fetch('/api/entries')
  .then(r => r.json())
  .then(data => { data.forEach(addRow); })
  .catch(() => {});

// Live updates via SSE
const evtSource = new EventSource('/api/stream');
evtSource.onmessage = (e) => {
  try { addRow(JSON.parse(e.data)); } catch {}
};
evtSource.onerror = () => {
  setTimeout(() => location.reload(), 5000);
};
</script>
</body>
</html>`;

/**
 * Start the dashboard HTTP server.
 * @param {number} [port=3000]
 * @returns {import('http').Server}
 */
export function startDashboard(port = 3000) {
  const app = express();

  // Serve the dashboard page
  app.get('/', (_req, res) => {
    res.type('html').send(DASHBOARD_HTML);
  });

  // REST endpoint: all stored entries
  app.get('/api/entries', (_req, res) => {
    res.json(getEntries());
  });

  // SSE endpoint: live stream of new entries
  app.get('/api/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(':\n\n'); // SSE comment to keep connection alive

    const unsub = onEntry((entry) => {
      res.write('data: ' + JSON.stringify(entry) + '\n\n');
    });

    req.on('close', () => {
      unsub();
    });
  });

  const server = app.listen(port, () => {
    console.log(`📊 Dashboard running at http://localhost:${port}`);
  });

  return server;
}
