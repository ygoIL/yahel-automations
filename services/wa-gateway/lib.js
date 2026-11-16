const fs = require('fs'), path = require('path'), crypto = require('crypto');
const E = process.env;
const log = (o) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));

async function post(url, body, timeoutMs = 40000, headers = {}) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const txt = await r.text(); let data; try { data = JSON.parse(txt); } catch { data = txt; }
  return { status: r.status, data };
}
async function get(url, timeoutMs = 30000, headers = {}) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  const txt = await r.text(); let data; try { data = JSON.parse(txt); } catch { data = txt; }
  return { status: r.status, data };
}

// ---- tiny JSON store on the volume ----
const DIR = E.DATA_DIR || './data';
fs.mkdirSync(DIR, { recursive: true });
function load(name, def) { try { return JSON.parse(fs.readFileSync(path.join(DIR, name + '.json'), 'utf8')); } catch { return def; } }
function save(name, val) { const f = path.join(DIR, name + '.json'); fs.writeFileSync(f + '.tmp', JSON.stringify(val)); fs.renameSync(f + '.tmp', f); }

// ---- Google Sheets via service account ----
let gtok = { token: '', exp: 0 };
async function gToken() {
  if (gtok.token && Date.now() < gtok.exp - 60000) return gtok.token;
  const sa = JSON.parse(E.GOOGLE_SERVICE_ACCOUNT_JSON);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + sig }) }).then((x) => x.json());
  if (!r.access_token) throw new Error('google token: ' + JSON.stringify(r));
  gtok = { token: r.access_token, exp: Date.now() + r.expires_in * 1000 };
  return gtok.token;
}
// Same shape as Make's google-sheets:makeAPICall: path relative to https://sheets.googleapis.com/v4/
async function sheets(method, rel, body, qs) {
  const u = new URL('https://sheets.googleapis.com/v4/' + encodeURI(rel));
  if (qs) for (const [k, v] of Object.entries(qs)) u.searchParams.set(k, v);
  const r = await fetch(u, { method, headers: { Authorization: 'Bearer ' + (await gToken()), 'Content-Type': 'application/json' }, body: body == null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) log({ ev: 'sheets_err', status: r.status, rel, err: j.error && j.error.message });
  return { status: r.status, body: j };
}

// ---- Make data store bridge (REST API, no credits) ----
async function makeDsAdd(dataStoreId, key, data) {
  if (!E.MAKE_API_TOKEN) return;
  try {
    const r = await post(`https://eu2.make.com/api/v2/data-stores/${dataStoreId}/data`, { key: String(key), data }, 20000, { Authorization: 'Token ' + E.MAKE_API_TOKEN });
    if (r.status >= 300) log({ ev: 'make_ds_err', dataStoreId, status: r.status, data: r.data });
  } catch (e) { log({ ev: 'make_ds_err', dataStoreId, err: String(e) }); }
}

// Israel time helpers
function ilParts(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const g = (t) => (p.find((x) => x.type === t) || {}).value;
  return { wd: g('weekday'), y: +g('year'), mo: +g('month'), d: +g('day'), h: +g('hour') % 24, mi: +g('minute') };
}
const ilStamp = (fmt = 'min') => { const p = ilParts(); const z = (n) => String(n).padStart(2, '0'); return `${p.y}-${z(p.mo)}-${z(p.d)} ${z(p.h)}:${z(p.mi)}`; };

module.exports = { E, log, post, get, load, save, sheets, makeDsAdd, ilParts, ilStamp };
