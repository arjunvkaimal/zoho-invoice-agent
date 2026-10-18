import 'dotenv/config';

const {
  ZOHO_CLIENT_ID,
  ZOHO_CLIENT_SECRET,
  ZOHO_REFRESH_TOKEN,
  ZOHO_ORG_ID,
  ZOHO_ACCOUNTS_URL = 'https://accounts.zoho.in',
  ZOHO_API_URL = 'https://www.zohoapis.in/books/v3',
} = process.env;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ZohoError extends Error {
  constructor(message, zohoCode, httpStatus) {
    super(message);
    this.name = 'ZohoError';
    this.zohoCode = zohoCode;
    this.httpStatus = httpStatus;
  }
}

// ---------- Auth: cache the access token, refresh shortly before it expires ----------
let cached = { token: null, expiresAt: 0 };
let refreshing = null; // avoids parallel refresh calls (Zoho limits refreshes)

export async function getAccessToken(force = false) {
  if (!force && cached.token && Date.now() < cached.expiresAt - 60_000) return cached.token;
  if (refreshing) return refreshing;

  refreshing = (async () => {
    const res = await fetch(`${ZOHO_ACCOUNTS_URL}/oauth/v2/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: ZOHO_CLIENT_ID,
        client_secret: ZOHO_CLIENT_SECRET,
        refresh_token: ZOHO_REFRESH_TOKEN,
      }),
    });
    const data = await res.json();
    if (!data.access_token) throw new ZohoError(`Token refresh failed: ${JSON.stringify(data)}`, null, res.status);
    cached = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
    return cached.token;
  })();

  try {
    return await refreshing;
  } finally {
    refreshing = null;
  }
}

// ---------- Low-level request with 401 refresh and 429 backoff ----------
async function request(method, path, { query = {}, body, raw = false } = {}, attempt = 0) {
  const token = await getAccessToken();
  const url = new URL(`${ZOHO_API_URL}${path}`);
  url.searchParams.set('organization_id', ZOHO_ORG_ID);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && attempt < 1) {
    await getAccessToken(true);
    return request(method, path, { query, body, raw }, attempt + 1);
  }
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    await sleep(1500 * (attempt + 1));
    return request(method, path, { query, body, raw }, attempt + 1);
  }

  if (raw) {
    if (!res.ok) throw new ZohoError(`HTTP ${res.status} on ${path}`, null, res.status);
    return Buffer.from(await res.arrayBuffer());
  }

  const data = await res.json();
  if (data.code !== 0) throw new ZohoError(data.message || 'Zoho error', data.code, res.status);
  return data;
}

// Fetch every page of a list endpoint
async function listAll(path, key, query = {}) {
  const out = [];
  for (let page = 1; ; page++) {
    const data = await request('GET', path, { query: { ...query, page, per_page: 200 } });
    out.push(...(data[key] || []));
    if (!data.page_context?.has_more_page) break;
  }
  return out;
}

// ---------- Public API ----------
export const getContacts = () => listAll('/contacts', 'contacts', { contact_type: 'customer' });
export const getItems = () => listAll('/items', 'items');
export const getTaxes = async () => (await request('GET', '/settings/taxes')).taxes || [];

export const createContact = async (payload) => (await request('POST', '/contacts', { body: payload })).contact;
export const createItem = async (payload) => (await request('POST', '/items', { body: payload })).item;

// Previous invoices for a customer (for the "rate same as last time" bonus)
export const getCustomerInvoices = (customerId) =>
  listAll('/invoices', 'invoices', { customer_id: customerId, sort_column: 'date', sort_order: 'D' });

/**
 * lineItems: [{ item_id, quantity, rate }]
 * status: 'draft' (default) leaves the invoice editable and unsent.
 */
export async function createInvoice({ customerId, lineItems, notes, referenceNumber }) {
  const body = {
    customer_id: customerId,
    line_items: lineItems,
    ...(notes ? { notes } : {}),
    ...(referenceNumber ? { reference_number: referenceNumber } : {}),
  };
  return (await request('POST', '/invoices', { body })).invoice;
}

export const getInvoicePdf = (invoiceId) =>
  request('GET', `/invoices/${invoiceId}`, { query: { accept: 'pdf' }, raw: true });

export { sleep };
