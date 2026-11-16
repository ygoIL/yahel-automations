// ToChat (custom Make app). Only the generic "Make an API call" is supported; base/auth from env.
const base = () => process.env.TOCHAT_BASE_URL || 'https://api.tochat.co.il';
function authHeaders() {
  const k = process.env.TOCHAT_API_KEY || ''; const h = process.env.TOCHAT_AUTH_HEADER || 'Authorization: Bearer';
  const [name, prefix] = h.split(':').map((s) => s.trim()); return { [name]: prefix ? `${prefix} ${k}` : k };
}
async function call(mp) {
  const u = new URL(base() + (String(mp.url).startsWith('/') ? '' : '/') + mp.url);
  for (const q of mp.qs || []) if ((q.key ?? q.name)) u.searchParams.set(q.key ?? q.name, q.value);
  const method = String(mp.method || 'GET').toUpperCase();
  const h = { ...authHeaders(), 'Content-Type': 'application/json', Accept: 'application/json' };
  for (const x of mp.headers || []) if (x.key ?? x.name) h[x.key ?? x.name] = x.value;
  let body = mp.body; if (body !== undefined && body !== null && typeof body !== 'string') body = JSON.stringify(body);
  const r = await fetch(u, { method, headers: h, body: /GET|HEAD/.test(method) ? undefined : body || undefined });
  const txt = await r.text(); let data; try { data = JSON.parse(txt); } catch { data = txt; }
  if (r.status >= 400) throw new Error(`ToChat ${r.status}: ${String(txt).slice(0, 400)}`);
  return { body: data, headers: Object.fromEntries(r.headers), statusCode: r.status };
}
module.exports = (reg) => {
  reg('tochat:makeAnApiCall', { write: true, readOnlyWhen: (mp) => /^get$/i.test(mp.method || 'GET'), dryResult: () => ({ body: {}, statusCode: 200 }), run: call });
};
module.exports.call = call;
