// Bridge to Make data stores over the Make REST API (no credits). Used while some scenarios that
// share a data store still run in Make. Enabled per store with DS_BRIDGE=191414,202662,...
const iml = require('../iml');
const BASE = 'https://eu2.make.com/api/v2';
const H = () => ({ Authorization: 'Token ' + process.env.MAKE_API_TOKEN, 'Content-Type': 'application/json' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, path, body) {
  for (let i = 0; i < 12; i++) {
    const r = await fetch(BASE + path, { method, headers: H(), body: body ? JSON.stringify(body) : undefined });
    const t = await r.text();
    if (/Requests limit/.test(t) || r.status === 429) { await sleep(5000); continue; }
    let j; try { j = JSON.parse(t); } catch { j = { raw: t }; }
    if (r.status >= 400) throw new Error(`Make data store API ${r.status}: ${t.slice(0, 300)}`);
    return j;
  }
  throw new Error('Make API rate limit');
}
const enabled = (id) => String(process.env.DS_BRIDGE || '').split(',').map((s) => s.trim()).includes(String(id));
const specCache = {};
async function spec(id) {
  if (specCache[id]) return specCache[id];
  const ds = (await api('GET', `/data-stores/${id}`)).dataStore;
  const st = (await api('GET', `/data-structures/${ds.datastructureId}`)).dataStructure;
  return (specCache[id] = Object.fromEntries((st.spec || []).map((f) => [f.name, f.type])));
}
async function cast(id, data) {
  const sp = await spec(id); const o = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (v === undefined) continue;
    const t = sp[k];
    if (v === '' || v === null) { o[k] = t === 'text' || !t ? (v ?? '') : null; continue; }
    if (t === 'number') { const n = iml.toNum(v); o[k] = isNaN(n) ? null : n; }
    else if (t === 'boolean') o[k] = v === true || v === 'true' || v === 1 || v === '1';
    else if (t === 'date') { const d = require('../dates').toDate(v); o[k] = d ? d.toISOString() : null; }
    else o[k] = v instanceof Date ? v.toISOString() : (typeof v === 'object' ? v : String(v));
  }
  return o;
}
const cache = {}; // id -> {at, recs}; short TTL, dropped on every write
async function all(id) {
  const c = cache[id]; if (c && Date.now() - c.at < 30000) return JSON.parse(JSON.stringify(c.recs));
  const recs = {}; let off = 0;
  for (;;) { const r = await api('GET', `/data-stores/${id}/data?pg%5Blimit%5D=100&pg%5Boffset%5D=${off}`); for (const x of r.records || []) recs[x.key] = x.data; if ((r.records || []).length < 100) break; off += 100; }
  cache[id] = { at: Date.now(), recs: JSON.parse(JSON.stringify(recs)) };
  return recs;
}
async function get(id, key) { const r = await all(id); return r[key]; }
async function put(id, key, data) { delete cache[id]; return api('PUT', `/data-stores/${id}/data/${encodeURIComponent(key)}`, await cast(id, data)); }
async function patch(id, key, data) { delete cache[id]; return api('PATCH', `/data-stores/${id}/data/${encodeURIComponent(key)}`, await cast(id, data)); }
async function del(id, keys) { delete cache[id]; return api('DELETE', `/data-stores/${id}/data`, { keys: [].concat(keys) }); }
module.exports = { enabled, all, get, put, patch, del };
