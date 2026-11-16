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
      if (!sc || mode === 'off') return send(res, 410, 'There is no scenario listening for this webhook.');
      const body = parseBody(await readBody(req), req.headers['content-type'], u.searchParams);
      const responds = JSON.stringify(sc.blueprint.flow).includes('gateway:WebhookRespond');
      const p = enqueue(sc, { type: 'webhook', body, headers: req.headers }, { dry: mode === 'dry' });
      if (!responds) return send(res, 200, 'Accepted');
      const r = await p; const rp = r && r.response;
      if (!rp) return send(res, r && r.status === 'error' ? 500 : 200, r && r.status === 'error' ? 'Scenario failed' : 'Accepted');
      return send(res, rp.status, typeof rp.body === 'string' ? rp.body : JSON.stringify(rp.body), rp.headers);
    }
    // ---- admin ----
    if (!E.ADMIN_KEY || (u.searchParams.get('key') !== E.ADMIN_KEY && req.headers['x-admin-key'] !== E.ADMIN_KEY)) return send(res, 401, { error: 'unauthorized' });
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
      if (body.mode === 'live' || body.mode === 'dry') scheduler.markRun(m[1], new Date().toISOString());
      return send(res, 200, { id: m[1], mode: body.mode || '(registry)', lastRun: scheduler.lastRun(m[1]) });
    }
    if ((m = /^\/admin\/ds\/(\d+)$/.exec(u.pathname))) { // GET = read local, POST = import from Make
      if (req.method === 'POST' && body.records) { store.dsSave(m[1], { records: body.records, importedAt: new Date().toISOString() }); return send(res, 200, { loaded: Object.keys(body.records).length }); }
      if (req.method === 'POST') { const n = await require('./tools').importDataStore(m[1]); return send(res, 200, { imported: n }); }
      return send(res, 200, store.ds(m[1], u.searchParams.get('dry') === '1'));
    }
    if (u.pathname === '/admin/check') return send(res, 200, await require('./tools').check(u.searchParams.get('only')));
    if (u.pathname === '/admin/tochat' && req.method === 'POST') return send(res, 200, await require('./modules/tochat').call(body).catch((e) => ({ error: String(e.message) })));
    return send(res, 404, { error: 'not found' });
  } catch (e) { log({ ev: 'http_err', path: u.pathname, err: String(e && e.stack || e) }); return send(res, 500, { error: String(e.message || e) }); }
}).listen(E.PORT || 8080, () => log({ ev: 'listening', port: E.PORT || 8080, scenarios: Object.keys(scenarios.all()).length }));

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
