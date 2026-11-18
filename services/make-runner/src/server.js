// make-runner: runs exported Make scenarios on Railway (webhooks, schedules, manual runs, dry-run validation).
const http = require('http');
const engine = require('./engine');
const scenarios = require('./scenarios');
const scheduler = require('./scheduler');
const store = require('./store');
const E = process.env;
const log = (o) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));
const running = new Map(); // scenario id -> promise chain (sequential per scenario)

function enqueue(sc, trigger, opts) {
  const prev = running.get(sc.id) || Promise.resolve();
  const seq = sc.blueprint.metadata && sc.blueprint.metadata.scenario && sc.blueprint.metadata.scenario.sequential;
  const job = (seq || trigger.type === 'schedule' ? prev : Promise.resolve()).then(() => engine.run(sc, trigger, opts)).catch((e) => log({ ev: 'run_crash', id: sc.id, err: String(e && e.stack || e) }));
  running.set(sc.id, job.then(() => {}));
  return job;
}
const readBody = (req) => new Promise((res) => { const ch = []; req.on('data', (c) => ch.push(c)); req.on('end', () => res(Buffer.concat(ch))); });
function parseBody(buf, type, query) {
  let b = {}; const txt = buf.toString('utf8');
  if (/json/.test(type || '') || /^[\s]*[{[]/.test(txt)) { try { b = JSON.parse(txt || '{}'); } catch { b = { value: txt }; } }
  else if (/urlencoded/.test(type || '')) b = Object.fromEntries(new URLSearchParams(txt));
  else if (txt) b = { value: txt };
  if (b && typeof b === 'object' && !Array.isArray(b)) for (const [k, v] of query) if (!(k in b)) b[k] = v;
  return b;
}
const send = (res, code, obj, headers = {}) => { const isStr = typeof obj === 'string'; res.writeHead(code, { 'Content-Type': isStr ? 'text/plain; charset=utf-8' : 'application/json', ...headers }); res.end(isStr ? obj : JSON.stringify(obj)); };

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/health') return send(res, 200, { ok: true });
    // ---- webhooks: /hook/<make-udid> ----
    const hm = /^\/hook\/([a-z0-9]+)$/.exec(u.pathname);
    if (hm) {
      const sc = scenarios.byHook(hm[1]); const mode = sc && scenarios.mode(sc);
      if (!sc || mode === 'off') {
        // Not handled here: pass the request through unchanged to the original Make webhook.
        const raw = await readBody(req);
        const h = {}; for (const k of ['content-type', 'accept', 'user-agent']) if (req.headers[k]) h[k] = req.headers[k];
        const r = await fetch(`https://hook.eu2.make.com/${hm[1]}${u.search}`, { method: req.method, headers: h, body: /GET|HEAD/.test(req.method) ? undefined : raw });
        const txt = Buffer.from(await r.arrayBuffer());
        log({ ev: 'hook_passthrough', udid: hm[1], status: r.status });
        res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'text/plain' }); return res.end(txt);
      }
      const body = parseBody(await readBody(req), req.headers['content-type'], u.searchParams);
      const responds = JSON.stringify(sc.blueprint.flow).includes('gateway:WebhookRespond');
      const p = enqueue(sc, { type: 'webhook', body, headers: req.headers }, { dry: mode === 'dry' });
      if (!responds) return send(res, 200, 'Accepted');
      const r = await p; const rp = r && r.response;
      if (!rp) return send(res, r && r.status === 'error' ? 500 : 200, r && r.status === 'error' ? 'Scenario failed' : 'Accepted');
      return send(res, rp.status, typeof rp.body === 'string' ? rp.body : JSON.stringify(rp.body), rp.headers);
    }
    // ---- admin ----
    const given = u.searchParams.get('key') || req.headers['x-admin-key'];
    const isAdmin = !!E.ADMIN_KEY && given === E.ADMIN_KEY;
    // TASK_KEY: limited key for scheduled Claude tasks that cannot read Railway variables.
    // It may run scenarios and read run logs, data stores and saved files; nothing else (no mode switches, no Google passthrough).
    const isTask = !!E.TASK_KEY && given === E.TASK_KEY && /^\/admin\/(run\/\d+|runs\/\d+|ds\/\d+|files(\/.*)?|scenarios|green\/[A-Za-z]+)$/.test(u.pathname) && (req.method === 'GET' || /^\/admin\/(run|green)\//.test(u.pathname));
    if (!isAdmin && !isTask) return send(res, 401, { error: 'unauthorized' });
    const body = req.method === 'POST' ? parseBody(await readBody(req), 'application/json', []) : {};
    let m;
    if (u.pathname === '/admin/scenarios') {
      return send(res, 200, Object.values(scenarios.all()).map((s) => { const runs = store.load(`runs/${s.id}`, []); const dr = store.load(`runs/${s.id}.dry`, []); return { id: s.id, name: s.name, mode: scenarios.mode(s), schedule: s.scheduling, hook: s.hookUdid || null, lastRun: scheduler.lastRun(s.id), last: runs[0] && { at: runs[0].at, status: runs[0].status, error: runs[0].error }, lastDry: dr[0] && { at: dr[0].at, status: dr[0].status, error: dr[0].error, actions: dr[0].actions.length } }; }));
    }
    if ((m = /^\/admin\/run\/(\d+)$/.exec(u.pathname))) { // manual run (on-demand scenarios / tests). ?dry=1
      const sc = scenarios.all()[m[1]]; if (!sc) return send(res, 404, { error: 'no such scenario' });
      const dry = u.searchParams.get('dry') !== '0';
      const r = await enqueue(sc, { type: body.trigger || 'manual', body: body.body || body, input: body.input || body }, { dry });
      return send(res, 200, r);
    }
    if ((m = /^\/admin\/runs\/(\d+)$/.exec(u.pathname))) return send(res, 200, store.load(`runs/${m[1]}${u.searchParams.get('dry') === '1' ? '.dry' : ''}`, []).slice(0, Number(u.searchParams.get('n')) || 20));
    if ((m = /^\/admin\/mode\/(\d+)$/.exec(u.pathname))) {
      scenarios.setMode(m[1], body.mode);
      // switching on: start the schedule from now, so a run Make already did today is not repeated
      // daily/weekly: only when today's slot has already passed (Make ran it); otherwise today's run would be skipped.
      if (body.mode === 'live' || body.mode === 'dry') { const sc = scenarios.all()[m[1]]; if (!sc || scheduler.slotPassedToday(sc.scheduling)) scheduler.markRun(m[1], new Date().toISOString()); }
      return send(res, 200, { id: m[1], mode: body.mode || '(registry)', lastRun: scheduler.lastRun(m[1]) });
    }
    if ((m = /^\/admin\/lastrun\/(\d+)$/.exec(u.pathname))) { // POST {"at": ISO} – set/repair the scheduler's last-run stamp
      if (req.method === 'POST' && body.at && !isNaN(new Date(body.at))) scheduler.markRun(m[1], new Date(body.at).toISOString());
      return send(res, 200, { id: m[1], lastRun: scheduler.lastRun(m[1]) });
    }
    if ((m = /^\/admin\/ds\/(\d+)$/.exec(u.pathname))) { // GET = read local, POST = import from Make
      if (req.method === 'POST' && body.records) { store.dsSave(m[1], { records: body.records, importedAt: new Date().toISOString() }); return send(res, 200, { loaded: Object.keys(body.records).length }); }
      if (req.method === 'POST') { const n = await require('./tools').importDataStore(m[1]); return send(res, 200, { imported: n }); }
      return send(res, 200, store.ds(m[1], u.searchParams.get('dry') === '1'));
    }
    if (u.pathname === '/admin/gapi') { // read-only Google API passthrough for diagnostics
      const g = require('./google'); const api = u.searchParams.get('api') === 'drive' ? g.drive : g.sheets;
      const method = req.method === 'POST' ? (body.method || 'PUT') : 'GET';
      return send(res, 200, await api({ url: u.searchParams.get('url'), method, body: req.method === 'POST' ? body.body : undefined, qs: body.qs }).catch((e) => ({ error: String(e.message) })));
    }
    if ((m = /^\/admin\/green\/([A-Za-z]+)$/.exec(u.pathname))) { // Green API via wa-gateway (which holds the Green credentials)
      const gu = new URL(`https://wa-gateway-production-3ddb70bf.up.railway.app/green/${m[1]}`); for (const [k, v] of u.searchParams) if (k !== 'key') gu.searchParams.set(k, v); gu.searchParams.set('key', E.GATEWAY_KEY || '');
      const r = await fetch(gu, { method: req.method, headers: { 'Content-Type': 'application/json' }, body: req.method === 'POST' ? JSON.stringify(body) : undefined });
      res.writeHead(r.status, { 'Content-Type': 'application/json' }); return res.end(await r.text());
    }
    if (u.pathname === '/admin/files') return send(res, 200, store.listFiles());
    if ((m = /^\/admin\/files\/(.+)$/.exec(u.pathname))) {
      const buf = store.readFile(decodeURIComponent(m[1])); if (!buf) return send(res, 404, { error: 'no such file' });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length }); return res.end(buf);
    }
    if ((m = /^\/admin\/watch-forget\/(\d+)$/.exec(u.pathname)) && req.method === 'POST') { // let a mail watcher return a message again
      const key = `watch/ms_${m[1]}`; const st = store.load(key, { seen: [] }); const before = st.seen.length;
      st.seen = st.seen.filter((x) => !(body.ids || []).includes(x)); store.save(key, st);
      return send(res, 200, { removed: before - st.seen.length });
    }
    if (u.pathname === '/admin/check') return send(res, 200, await require('./tools').check(u.searchParams.get('only')));
    // ---- lead upload to ToChat campaigns (dry run first; a real upload only via /confirm of an approved dry run) ----
    if (u.pathname.startsWith('/admin/leads/')) {
      const L = require('./leads/upload');
      const out = (j) => send(res, j.status === 'error' ? (j.missingKey ? 412 : 500) : 200, j.status === 'done' ? { jobId: j.id, ...j.result } : j);
      if (u.pathname === '/admin/leads/upload' && req.method === 'POST') {
        if (body.dryRun === false || body.dryRun === 'false') return send(res, 400, { error: 'העלאה אמיתית רק אחרי הרצה יבשה ואישור: POST /admin/leads/confirm {"runId":"..."}' });
        return out(await L.start('dry', body));
      }
      if (u.pathname === '/admin/leads/confirm' && req.method === 'POST') return out(await L.start('confirm', body));
      if ((m = /^\/admin\/leads\/job\/(\w+)$/.exec(u.pathname))) { const j = L.job(m[1]); return j ? out(j) : send(res, 404, { error: 'no such job' }); }
      if (u.pathname === '/admin/leads/log') return send(res, 200, L.runLog(Number(u.searchParams.get('n')) || 50));
      if (u.pathname === '/admin/leads/campaigns') return send(res, 200, (await require('./leads/tochat-client').listCampaigns()).map((c) => ({ id: c.id, name: c.name })));
    }
    // ---- global cross-campaign dedupe (sacred follow-up + campaign priority) ----
    if (u.pathname === '/admin/dedupe/run' && req.method === 'POST') { // ?dry=1 (default) / dry=0
      const dry = u.searchParams.get('dry') !== '0';
      return send(res, 200, await runDedupe({ dry, notify: u.searchParams.get('notify') === '1', full: u.searchParams.get('full') === '1' ? true : undefined }));
    }
    if (u.pathname === '/admin/dedupe/pinned') { // GET list / POST {"names":["..."]} – campaigns Steve asked to prioritize
      const G = require('./guard'); if (req.method === 'POST') G.setPinned(body.names); return send(res, 200, { pinned: G.pinned() });
    }
    if (u.pathname === '/admin/upload-guard') return send(res, 200, store.load('jobs/upload-guard', []).slice(0, Number(u.searchParams.get('n')) || 20));
    if (u.pathname === '/admin/dedupe/runs') return send(res, 200, store.load('jobs/dedupe', []).slice(0, Number(u.searchParams.get('n')) || 10));
    if (u.pathname === '/admin/tochat' && req.method === 'POST') return send(res, 200, await require('./modules/tochat').call(body).catch((e) => ({ error: String(e.message) })));
    return send(res, 404, { error: 'not found' });
  } catch (e) { log({ ev: 'http_err', path: u.pathname, err: String(e && e.stack || e) }); return send(res, 500, { error: String(e.message || e) }); }
}).listen(E.PORT || 8080, () => log({ ev: 'listening', port: E.PORT || 8080, scenarios: Object.keys(scenarios.all()).length }));

// ---- dedupe job (not a Make blueprint) ----
let dedupeBusy = null;
async function runDedupe({ dry, notify, full }) {
  if (dedupeBusy) return { status: 'busy', since: dedupeBusy };
  dedupeBusy = new Date().toISOString();
  try {
    const D = require('./dedupe');
    const r = await D.run({ dry, full, log });
    const hhmm = new Date().toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' });
    let msg = notify && D.message(r, hhmm);
    // hourly runs: never repeat the same alert body on the same day
    if (msg) { const body = msg.split('\n').slice(1).join('\n') || msg.replace(/\d\d:\d\d/, ''); const day = new Date().toISOString().slice(0, 10); const seen = store.load('jobs/dedupe-sent', {}); if (seen.day !== day) { seen.day = day; seen.bodies = []; } if (seen.bodies.includes(body) && !r.closedFU) msg = null; else { seen.bodies.push(body); store.save('jobs/dedupe-sent', seen); } }
    const wa = scenarios.all()['9900449'];
    if (msg && wa && !dry) await enqueue(wa, { type: 'manual', body: { phone: E.DEDUPE_ALERT_PHONE || '972544604246', message: msg }, input: { phone: E.DEDUPE_ALERT_PHONE || '972544604246', message: msg } }, { dry: false });
    return { status: 'done', message: msg || null, ...r };
  } catch (e) { log({ ev: 'dedupe_crash', err: String(e && e.stack || e) }); return { status: 'error', error: String(e.message || e) }; }
  finally { dedupeBusy = null; }
}
setInterval(() => {
  const mode = (E.DEDUPE_MODE || 'live').toLowerCase(); if (mode === 'off' || dedupeBusy) return;
  const D = require('./dedupe'); const now = new Date();
  const G = require('./guard');
  if (scheduler.due(G.MORNING_SCHEDULE, scheduler.lastRun('job_pinned_ask'), now)) {
    scheduler.markRun('job_pinned_ask', now.toISOString());
    const wa = scenarios.all()['9900449'];
    G.morningMessage().then((msg) => wa && mode !== 'dry' && enqueue(wa, { type: 'manual', body: { phone: E.DEDUPE_ALERT_PHONE || '972544604246', message: msg }, input: { phone: E.DEDUPE_ALERT_PHONE || '972544604246', message: msg } }, { dry: false })).catch((e) => log({ ev: 'pinned_ask_err', err: String(e.message) }));
  }
  if (scheduler.due(D.FULL_SCHEDULE, scheduler.lastRun('job_dedupe_full'), now)) { scheduler.markRun('job_dedupe_full', now.toISOString()); runDedupe({ dry: mode === 'dry', notify: true, full: true }); return; }
  if (!scheduler.due(D.SCHEDULE, scheduler.lastRun('job_dedupe'), now)) return;
  scheduler.markRun('job_dedupe', now.toISOString());
  runDedupe({ dry: mode === 'dry', notify: true });
}, 30000);

// ---- scheduler tick ----
setInterval(() => {
  const now = new Date();
  for (const sc of Object.values(scenarios.all())) {
    const mode = scenarios.mode(sc); if (mode === 'off') continue;
    const st = sc.scheduling || {}; if (!['indefinitely', 'daily', 'weekly', 'monthly', 'once'].includes(st.type)) continue;
    if (sc._busy) continue;
    if (!scheduler.due(st, scheduler.lastRun(sc.id), now)) continue;
    scheduler.markRun(sc.id, now.toISOString()); sc._busy = true;
    enqueue(sc, { type: 'schedule' }, { dry: mode === 'dry' }).finally(() => { sc._busy = false; });
  }
}, 20000);
