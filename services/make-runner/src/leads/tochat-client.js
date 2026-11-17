// ToChat integrations API client for the lead-upload tool.
// Base URL + auth are the ones the existing ToChat module uses in production
// (HTTP Basic: username = tenant id, password = integration API key).
// The key is read only from the environment (Railway variable TOCHAT_API_KEY) and never logged.
const E = process.env;
const base = () => (E.TOCHAT_BASE_URL || 'https://api.tochat.co.il/integrations/v1').replace(/\/$/, '');
const tenant = () => E.TOCHAT_TENANT || 'YahelCommunication';
const enc = encodeURIComponent;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class MissingKeyError extends Error {}
function requireKey() {
  if (!E.TOCHAT_API_KEY) throw new MissingKeyError('חסר משתנה הסביבה TOCHAT_API_KEY. צריך להוסיף אותו ב-Railway: פרויקט yahel-reps-bot ← שירות make-runner ← Variables ← TOCHAT_API_KEY = מפתח האינטגרציה של ToChat.');
}

// One HTTP call with retry on 429 / 5xx / network errors (exponential backoff, honours Retry-After).
// Returns { status, body }. 4xx other than 429 are returned (not thrown) so callers can decide (e.g. 404 = unknown customer).
async function request(path, { method = 'GET', body, qs, retries = 5 } = {}) {
  requireKey();
  const u = new URL(base() + path);
  for (const [k, v] of Object.entries(qs || {})) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
  const headers = { Authorization: 'Basic ' + Buffer.from(`${tenant()}:${E.TOCHAT_API_KEY}`).toString('base64'), Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(u, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000) });
      const txt = await r.text(); let data; try { data = JSON.parse(txt); } catch { data = txt; }
      // Writes are retried only on 429 (request rejected before processing), so a 5xx/timeout never risks a double upload.
      if (r.status === 429 || (r.status >= 500 && method === 'GET')) {
        lastErr = new Error(`ToChat ${r.status}: ${String(txt).slice(0, 300)}`);
        const ra = Number(r.headers.get('retry-after'));
        await sleep(ra > 0 ? ra * 1000 : Math.min(30000, 1000 * 2 ** attempt) + Math.random() * 300);
        continue;
      }
      return { status: r.status, body: data };
    } catch (e) {
      if (method !== 'GET') throw e;
      lastErr = e; await sleep(Math.min(30000, 1000 * 2 ** attempt));
    }
  }
  throw lastErr;
}
async function ok(path, opts) {
  const r = await request(path, opts);
  if (r.status >= 400) throw new Error(`ToChat ${r.status} ${opts && opts.method || 'GET'} ${path}: ${JSON.stringify(r.body).slice(0, 400)}`);
  return r.body;
}

// 972XXXXXXXXX / +972-5X... / 5XXXXXXXX → 05XXXXXXXX. Returns '' for anything that is not an Israeli number.
function normPhone(p) {
  let d = String(p == null ? '' : p).replace(/\D/g, '');
  if (d.startsWith('00972')) d = d.slice(5);
  if (d.startsWith('972')) d = d.slice(3);
  if (!d.startsWith('0')) d = '0' + d;
  return /^0\d{8,9}$/.test(d) ? d : '';
}

// Collect every phone field anywhere in the deny-list payload (shape is not documented; handles arrays, {items}, pagination).
async function denyList() {
  const out = new Set(); let pageToken; let guard = 0;
  do {
    const b = await ok(`/tenants/${enc(tenant())}/deny-list`, { qs: { pageToken } });
    const walk = (x) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === 'object') { for (const [k, v] of Object.entries(x)) { if (/phone/i.test(k) && (typeof v === 'string' || typeof v === 'number')) { const n = normPhone(v); if (n) out.add(n); } else walk(v); } } else if (typeof x === 'string' || typeof x === 'number') { const n = normPhone(x); if (n) out.add(n); } };
    walk(b && typeof b === 'object' && !Array.isArray(b) ? (b.items || b.denyList || b.data || b) : b);
    pageToken = b && !Array.isArray(b) && (b.nextPageToken || b.pageToken) || undefined;
  } while (pageToken && ++guard < 500);
  return out;
}

// { found, activeLeads, inactiveCampaigns }. 404 = customer unknown to ToChat (no history).
async function customerStatus(phone) {
  const r = await request(`/tenants/${enc(tenant())}/customers/${enc(phone)}`);
  if (r.status === 404) return { found: false, activeLeads: [], inactiveCampaigns: [] };
  if (r.status >= 400) throw new Error(`ToChat ${r.status} customer ${phone}: ${JSON.stringify(r.body).slice(0, 300)}`);
  const b = r.body || {};
  return { found: true, activeLeads: b.activeLeads || [], inactiveCampaigns: b.inactiveCampaigns || [] };
}

async function listCampaigns() {
  let r = await request(`/tenants/${enc(tenant())}/campaigns`);
  if (r.status === 404) r = await request('/campaigns');
  if (r.status >= 400) throw new Error(`ToChat ${r.status} campaigns: ${JSON.stringify(r.body).slice(0, 300)}`);
  const arr = Array.isArray(r.body) ? r.body : (r.body.campaigns || r.body.items || r.body.data || []);
  return arr.map((c) => ({ id: String(c.id ?? c._id ?? c.campaignId ?? ''), name: String(c.name ?? c.title ?? c.campaignName ?? '').trim(), raw: c })).filter((c) => c.id);
}

// shouldCheckWithDontCallMe is hard-wired to false: the "don't call me" service is disabled and `true` makes the whole upload fail silently.
// priority stays 20 exactly as in the Make scenarios; its dialing-order semantics are NOT verified against ToChat docs, so nothing here relies on them.
async function addLeads(campaignId, customers, sourceName) {
  const body = {
    customers: customers.map((c) => ({ phone: c.phone, firstName: '', lastName: '', audience: c.audience || '', notes: c.notes || '' })),
    dataSource: { name: sourceName, priority: 20, newCustomersOnly: false, shouldCheckWithDontCallMe: false, shouldOverrideCustomerData: false },
  };
  const r = await request(`/tenants/${enc(tenant())}/campaigns/${enc(campaignId)}/customers`, { method: 'POST', body, retries: 3 });
  return r;
}

module.exports = { request, denyList, customerStatus, listCampaigns, addLeads, normPhone, tenant, requireKey, MissingKeyError };
