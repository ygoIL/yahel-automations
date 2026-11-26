// Blocked reps (e.g. Bezeq reps): no ManyChat message is sent in a run that is about one of them.
// The list is a Google Sheet (BLOCKED_REPS_SHEET_ID, first tab, every cell with letters = one name),
// re-read every 5 minutes, so a name added to the sheet takes effect within minutes without a deploy.
// The service account in GOOGLE_SERVICE_ACCOUNT_JSON needs view access to the sheet.
const google = require('./google');
const store = require('./store');

const SHEET_ID = () => process.env.BLOCKED_REPS_SHEET_ID || '1iV7g5_GcsSLmawx61mLDbTAt1xv2WYzFs0Y_b_Dnono';
const TTL = 5 * 60 * 1000;
let cache = { names: null, at: 0, error: null };

// Hebrew/Latin names: drop quotes/geresh/punctuation, collapse spaces, lower-case.
const norm = (s) => String(s ?? '').replace(/[֑-ׇ]/g, '').replace(/["'`׳״.,()\-–_/\\|:;]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
const hasLetters = (s) => /[A-Za-zא-ת]/.test(s);

function parseNames(values) {
  const out = new Set();
  for (const row of values || []) for (const cell of row || []) {
    const n = norm(cell);
    if (n && hasLetters(n) && !/^(שם|שם נציג|נציג|נציגים|שם מלא|name|rep|נציגי בזק)$/.test(n)) out.add(n);
  }
  return [...out];
}

async function fetchNames() {
  const id = SHEET_ID();
  const meta = await google.sheets({ url: `/spreadsheets/${id}`, qs: [{ key: 'fields', value: 'sheets.properties(sheetId,title,index)' }] });
  const sheets = (meta.body.sheets || []).map((s) => s.properties).sort((a, b) => a.index - b.index);
  const tab = sheets.find((s) => s.sheetId === 0) || sheets[0];
  const r = await google.sheets({ url: `/spreadsheets/${id}/values/${encodeURIComponent(`'${tab.title.replace(/'/g, "''")}'`)}` });
  return parseNames(r.body.values);
}

// Names list; on a read error keeps the last good list (memory, then volume).
async function names() {
  if (cache.names && Date.now() - cache.at < TTL) return cache.names;
  try {
    const n = await fetchNames();
    cache = { names: n, at: Date.now(), error: null };
    store.save('blocked-reps', { names: n, at: new Date().toISOString() });
  } catch (e) {
    const saved = store.load('blocked-reps', null);
    cache = { names: cache.names || (saved && saved.names) || [], at: Date.now() - TTL + 60000, error: String(e.message || e) };
    console.log(JSON.stringify({ t: new Date().toISOString(), ev: 'blocked-reps-error', error: cache.error, using: cache.names.length }));
  }
  return cache.names;
}

// Every string in the run so far: trigger body + module outputs (2 levels into objects, arrays of strings
// only - aggregated lists of other rows are skipped so another rep's row can't block this one).
function strings(ctx) {
  const out = [];
  const walk = (v, d) => {
    if (typeof v === 'string' || typeof v === 'number') { out.push(String(v)); return; }
    if (!v || typeof v !== 'object' || d > 3) return;
    if (Array.isArray(v)) { for (const x of v) if (typeof x === 'string') out.push(x); return; }
    for (const x of Object.values(v)) walk(x, d + 1);
  };
  walk(ctx.trigger && ctx.trigger.body, 0);
  walk(ctx.input, 0);
  for (const b of Object.values(ctx.outputs || {})) walk(b, 0);
  return out;
}

// A value matches a blocked name when it equals it, or (for names of 2+ words, unless exact) contains it as whole words.
function match(list, values, exact) {
  const multi = list.filter((n) => n.includes(' '));
  for (const raw of values) {
    const v = norm(raw);
    if (!v || v.length > 300 || !hasLetters(v)) continue;
    if (list.includes(v)) return { name: v, value: String(raw).slice(0, 120) };
    if (exact) continue;
    const padded = ` ${v} `;
    for (const n of multi) if (padded.includes(` ${n} `)) return { name: n, value: String(raw).slice(0, 120) };
  }
  return null;
}

// WhatsApp sends (wa-gateway /send|/gate, Green API sendMessage) - e.g. "customer answered the follow-up (rep: X)" to the ToChat group.
const WA_URL = /wa-gateway[^/]*\/(send|gate)\b|api\.green-api\.com\/.*\/send(Message|FileByUrl)/i;
function isWhatsApp(m, mapper) { return m.module === 'http:MakeRequest' && WA_URL.test(String(mapper.url || '')); }

// ManyChat modules that send a message to someone.
function isSend(m, mapper) {
  if (m.module === 'manychat:SendFlow' || m.module === 'manychat:SendText') return true;
  if (m.module === 'manychat:PerformAction') return (mapper.actions || []).some((a) => a && a.action === 'send_flow');
  return false;
}

async function check(m, mapper, ctx) {
  const mc = isSend(m, mapper || {});
  // WhatsApp: exact field match only (a run *about* that rep), so group digests that list many reps still go out.
  const wa = !mc && isWhatsApp(m, mapper || {});
  if (!mc && !wa) return null;
  const list = await names();
  if (!list.length) return null;
  return match(list, strings(ctx), wa);
}

function status() { return { sheet: SHEET_ID(), count: cache.names ? cache.names.length : null, loadedAt: cache.at ? new Date(cache.at).toISOString() : null, error: cache.error, names: cache.names }; }
function reset() { cache = { ...cache, at: 0 }; }
function _set(list) { cache = { names: list.map(norm), at: Date.now(), error: null }; }
module.exports = { check, names, status, reset, match, norm, parseNames, _set };
