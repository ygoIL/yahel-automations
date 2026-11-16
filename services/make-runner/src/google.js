// Google APIs via a service account (replaces Make's Google connections).
const crypto = require('crypto');
let tok = { token: '', exp: 0 };
async function token() {
  if (tok.token && Date.now() < tok.exp - 60000) return tok.token;
  const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}');
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + sig }) }).then((x) => x.json());
  if (!r.access_token) throw new Error('Google auth failed: ' + JSON.stringify(r));
  tok = { token: r.access_token, exp: Date.now() + r.expires_in * 1000 };
  return tok.token;
}
function qsToObj(qs) { const o = {}; for (const q of qs || []) { const k = q.key ?? q.name; if (k !== undefined && k !== '') o[k] = q.value; } return o; }
function hdrToObj(h) { const o = {}; for (const x of h || []) { const k = x.key ?? x.name; if (k) o[k] = x.value; } return o; }
// Same semantics as Make "Make an API call": url relative to the API base; errors on 4xx/5xx.
async function call(base, { url, method = 'GET', qs, headers, body }) {
  let rel = String(url || '');
  if (!/^https?:/.test(rel)) rel = base + (rel.startsWith('/') ? rel : '/' + rel);
  // WHATWG URL percent-encodes spaces/non-ASCII and keeps existing %XX escapes (no double encoding).
  const u = new URL(rel);
  for (const [k, v] of Object.entries(qsToObj(qs))) u.searchParams.set(k, v);
  const h = { Authorization: 'Bearer ' + (await token()), ...hdrToObj(headers) };
  let b = body;
  if (b !== undefined && b !== null && b !== '' && typeof b !== 'string') b = JSON.stringify(b);
  if (b && !Object.keys(h).some((k) => k.toLowerCase() === 'content-type')) h['Content-Type'] = 'application/json';
  const r = await fetch(u, { method: String(method).toUpperCase(), headers: h, body: ['GET', 'HEAD'].includes(String(method).toUpperCase()) ? undefined : (b || undefined) });
  const txt = await r.text(); let data; try { data = JSON.parse(txt); } catch { data = txt; }
  if (r.status >= 400) throw new Error(`Google API ${r.status}: ${typeof data === 'object' ? JSON.stringify(data.error || data).slice(0, 500) : String(data).slice(0, 500)}`);
  return { body: data, headers: Object.fromEntries(r.headers), statusCode: r.status };
}
const sheets = (o) => call('https://sheets.googleapis.com/v4', o);
const drive = (o) => call('https://www.googleapis.com/drive', o);
module.exports = { token, call, sheets, drive, qsToObj, hdrToObj };
