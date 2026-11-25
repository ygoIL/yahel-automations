// Executes a Make blueprint flow: filters, routers, iterators, aggregators, error handlers.
const iml = require('./iml');
const { passes } = require('./filters');
const modules = require('./modules');
const store = require('./store');
const blockedReps = require('./blocked-reps');
const log = (o) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));

class Stop extends Error { constructor(kind) { super(kind); this.kind = kind; } }
const DIRECTIVES = new Set(['builtin:Ignore', 'builtin:Resume', 'builtin:Break', 'builtin:Rollback', 'builtin:Commit']);
const trunc = (v, n = 2000) => { try { const s = JSON.stringify(v); return s && s.length > n ? s.slice(0, n) + '…' : v; } catch { return String(v); } };

function findAggregator(list, i, feederId) {
  for (let k = i + 1; k < list.length; k++) {
    const p = list[k].parameters || {};
    if (p.feeder !== undefined && String(p.feeder) === String(feederId)) return k;
  }
  return -1;
}

async function execModule(m, ctx, rt) {
  const def = modules.get(m.module);
  if (!def) throw new Error(`Module not supported on Railway: ${m.module}`);
  const res = (v) => iml.resolve(v, ctx);
  const mapper = def.rawMapper ? m.mapper : res(m.mapper || {});
  const params = res(m.parameters || {});
  rt.ops++;
  if (rt.ops > (rt.maxOps || 5000)) throw new Error('operation limit reached');
  const t0 = Date.now();
  let out;
  const blocked = m.module.startsWith('manychat:') ? await blockedReps.check(m, mapper, ctx) : null;
  if (blocked) {
    // Blocked rep (sheet of Bezeq reps): skip the send, the rest of the flow continues as if it was sent.
    rt.warnings.push({ module: m.id, skipped: 'blocked rep', rep: blocked.name });
    rt.actions.push({ module: m.id, type: m.module, skipped: 'blocked rep', rep: blocked.name, value: blocked.value });
    out = def.dryResult ? def.dryResult(mapper, params) : {};
  } else if (rt.dry && def.write && !(def.readOnlyWhen && def.readOnlyWhen(mapper, params))) {
    rt.actions.push({ module: m.id, type: m.module, input: trunc(mapper, 4000) });
    out = def.dryResult ? def.dryResult(mapper, params) : {};
  } else {
    out = await def.run(mapper, params, { m, ctx, rt, resolve: res });
  }
  const bundles = def.multi ? (Array.isArray(out) ? out : []) : [out];
  rt.trace.push({ id: m.id, module: m.module, ms: Date.now() - t0, bundles: bundles.length, out: trunc(bundles[0], 1500) });
  return bundles;
}

async function runSeq(list, i, ctx, rt, sink) {
  if (i >= list.length) { if (sink) await sink(ctx); return; }
  const m = list[i];
  // filter on the link into this module
  if (m.filter && m.filter.conditions && !passes(m.filter.conditions, (v) => iml.resolve(v, ctx))) return;

  if (m.module === 'builtin:BasicRouter') {
    for (const route of m.routes || []) {
      const flow = route.flow || [];
      await runSeq(flow, 0, { ...ctx, outputs: { ...ctx.outputs } }, rt, sink);
    }
    return;
  }
  if (DIRECTIVES.has(m.module)) return handleDirective(m, ctx, rt, list, i, sink);

  let bundles;
  try {
    bundles = await execModule(m, ctx, rt);
  } catch (err) {
    if (err instanceof Stop) throw err;
    rt.trace.push({ id: m.id, module: m.module, error: String(err && err.message || err) });
    const handler = m.onerror || [];
    if (!handler.length) throw Object.assign(err instanceof Error ? err : new Error(String(err)), { moduleId: m.id });
    rt.warnings.push({ module: m.id, error: String(err.message || err) });
    const errCtx = { ...ctx, outputs: { ...ctx.outputs, [m.id]: { error: { message: String(err.message || err) } } } };
    // run handler modules; the directive decides what happens next
    for (let h = 0; h < handler.length; h++) {
      const hm = handler[h];
      if (hm.module === 'builtin:Resume') {
        const out = iml.resolve(hm.mapper || {}, errCtx);
        bundles = [out]; break;
      }
      if (hm.module === 'builtin:Ignore') return;
      if (hm.module === 'builtin:Break') { rt.status = 'incomplete'; return; }
      if (hm.module === 'builtin:Commit') throw new Stop('commit');
      if (hm.module === 'builtin:Rollback') throw Object.assign(new Error(String(err.message || err)), { moduleId: m.id });
      try { await execModule(hm, errCtx, rt); } catch (e2) { rt.warnings.push({ module: hm.id, error: String(e2.message || e2) }); }
    }
    if (!bundles) return;
  }

  const aggIdx = findAggregator(list, i, m.id);
  if (aggIdx >= 0) {
    const collected = [];
    for (const b of bundles) {
      const c2 = { ...ctx, outputs: { ...ctx.outputs, [m.id]: b } };
      await runSeq(list.slice(0, aggIdx), i + 1, c2, rt, async (c) => { collected.push(c); });
    }
    const agg = list[aggIdx];
    const out = await modules.aggregate(agg, collected, ctx, rt);
    if (out === null) return;
    rt.trace.push({ id: agg.id, module: agg.module, bundles: 1, out: trunc(out, 1500) });
    return runSeq(list, aggIdx + 1, { ...ctx, outputs: { ...ctx.outputs, [agg.id]: out } }, rt, sink);
  }
  for (const b of bundles) {
    await runSeq(list, i + 1, { ...ctx, outputs: { ...ctx.outputs, [m.id]: b } }, rt, sink);
  }
}

async function handleDirective(m, ctx, rt, list, i, sink) {
  // A directive placed in the main flow (rare): Ignore = stop silently, Commit = stop OK, Break/Rollback = stop with status.
  if (m.module === 'builtin:Resume') return runSeq(list, i + 1, ctx, rt, sink);
  if (m.module === 'builtin:Commit') throw new Stop('commit');
  if (m.module === 'builtin:Rollback') throw new Error('rollback');
  if (m.module === 'builtin:Break') rt.status = 'incomplete';
}

// Run a scenario. trigger: {type:'webhook'|'schedule'|'manual', body, input}
async function run(scenario, trigger = {}, opts = {}) {
  const bp = scenario.blueprint;
  const rt = { scenario, ops: 0, trace: [], warnings: [], actions: [], dry: !!opts.dry, status: 'success', response: null, maxOps: opts.maxOps };
  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const t0 = Date.now();
  const flow = bp.flow || [];
  const ctx = { outputs: {}, input: trigger.input || {}, scenarioVars: { id: scenario.id, name: scenario.name, executionId: runId }, trigger };
  let error = null;
  try {
    const first = flow[0];
    const triggerDef = first && modules.get(first.module);
    if (triggerDef && triggerDef.trigger) {
      // trigger module produces the initial bundles (webhook body, watch-mail results, ...)
      const bundles = await triggerDef.trigger(trigger, iml.resolve(first.parameters || {}, ctx), { m: first, ctx, rt, scenario });
      rt.trace.push({ id: first.id, module: first.module, bundles: bundles.length, out: trunc(bundles[0], 1500) });
      rt.ops += bundles.length ? 1 : 0;
      for (const b of bundles) await runSeq(flow, 1, { ...ctx, outputs: { [first.id]: b } }, rt, null);
    } else {
      await runSeq(flow, 0, ctx, rt, null);
    }
  } catch (e) {
    if (e instanceof Stop && e.kind === 'commit') { /* ok */ } else { error = { message: String(e && e.message || e), module: e && e.moduleId }; rt.status = 'error'; }
  }
  const rec = { id: runId, at: new Date(t0).toISOString(), ms: Date.now() - t0, trigger: trigger.type || 'manual', dry: rt.dry, status: rt.status, ops: rt.ops, error, warnings: rt.warnings, actions: rt.actions, trace: rt.trace };
  store.logRun(scenario.id + (rt.dry ? '.dry' : ''), rec);
  log({ ev: 'run', scenario: scenario.id, name: scenario.name, status: rt.status, ops: rt.ops, ms: rec.ms, dry: rt.dry, error: error && error.message, warnings: rt.warnings.length || undefined });
  return { ...rec, response: rt.response };
}
module.exports = { run };
