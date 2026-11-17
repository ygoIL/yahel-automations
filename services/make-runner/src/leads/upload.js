// upload-leads(count, tier, campaign, dryRun=true)
// Dry run: score → check every candidate against the iron rules → summary + plan (nothing is written to ToChat).
// Confirm: re-check the approved plan right before uploading (follow-ups can open in between), then upload in batches of 200.
const crypto = require('crypto');
const store = require('../store');
const google = require('../google');
const tc = require('./tochat-client');
const scoring = require('./scoring');
const rules = require('./rules');

const SHEET_ID = () => process.env.LEADS_SHEET_ID || '1QXWDWawAVRj6W5dxtbKesD7Z3NZtOuEEBaq0O-2QYF0';
const SHEET_TAB = () => process.env.LEADS_SHEET_TAB || 'לוג שיקופים';
const TIERS = ['רותח', 'חם', 'פושר'];
const TIER_ALIASES = { 'רותחים': 'רותח', 'רותח': 'רותח', hot: 'רותח', 'חמים': 'חם', 'חם': 'חם', warm: 'חם', 'פושרים': 'פושר', 'פושר': 'פושר' };
const BATCH = 200;
const CONCURRENCY = Number(process.env.LEADS_CONCURRENCY || 4);
const PLAN_TTL_H = 24;
const log = (o) => console.log(JSON.stringify({ t: new Date().toISOString(), ev: 'leads', ...o }));

const jobs = new Map(); // runId -> { status, result, error }
const uploadedIndex = () => store.load('leads/uploaded', {}); // phone -> {campaign, campaignId, at, runId}

async function readSheet() {
  const r = await google.sheets({ url: `/spreadsheets/${SHEET_ID()}/values/${encodeURIComponent(`'${SHEET_TAB()}'!A2:I`)}` });
  return (r.body && r.body.values) || [];
}

async function resolveCampaign(name) {
  const all = await tc.listCampaigns();
  const q = String(name || '').trim();
  const exact = all.filter((c) => c.name === q || c.id === q);
  if (exact.length === 1) return { campaign: exact[0] };
  const part = all.filter((c) => c.name.includes(q) || q.includes(c.name));
  if (!exact.length && part.length === 1) return { campaign: part[0] };
  return { ambiguous: true, matches: (exact.length ? exact : part).map((c) => ({ id: c.id, name: c.name })), all: part.length || exact.length ? undefined : all.map((c) => c.name) };
}

async function pool(items, n, fn) {
  let i = 0; const workers = Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } });
  await Promise.all(workers);
}

// Check candidates in rank order until `stopAt` pass (or the list ends). Returns { passed, rejected, checked, seenStatuses }.
async function checkCandidates(cands, target, deny, stopAt) {
  const uploaded = uploadedIndex();
  const passed = [], rejected = []; let checked = 0, next = 0;
  const seen = {}; // distinct "reason / subReason" of past campaigns, to let a human verify the status mapping
  while (next < cands.length && passed.length < stopAt) {
    const wave = cands.slice(next, next + Math.max((stopAt - passed.length) * 2, CONCURRENCY));
    const results = new Array(wave.length);
    await pool(wave, CONCURRENCY, async (c, k) => {
      try {
        const status = await tc.customerStatus(c.phone);
        for (const l of status.inactiveCampaigns) { const key = `${l.reason || ''} / ${(l.subReason && l.subReason.name) || ''}`; seen[key] = (seen[key] || 0) + 1; }
        results[k] = { c, why: rules.evaluate({ phone: c.phone, status, deny, target, sheetLastCall: c.lastCall, uploadedBefore: uploaded[c.phone] }) };
      } catch (e) { results[k] = { c, why: [{ k: 'checkError', d: String(e.message).slice(0, 200) }] }; }
    });
    for (const r of results) {
      if (passed.length >= stopAt) break; // surplus of the last wave: not counted, not used
      checked++;
      if (r.why.length) rejected.push(r); else passed.push(r.c);
    }
    next += wave.length;
  }
  return { passed, rejected, checked, seenStatuses: seen };
}

const brief = (c) => ({ phone: c.phone, name: c.name, tier: c.tier, signals: c.signals, paid: c.paid || undefined, maxCall: `${Math.floor(c.maxSec / 60)}:${String(c.maxSec % 60).padStart(2, '0')}`, lastCall: c.lastCall && c.lastCall.toISOString().slice(0, 10), note: scoring.note(c) });

async function dryRun({ count, tier, campaign }) {
  tc.requireKey();
  count = Math.max(1, Math.min(5000, Number(count) || 0));
  const t = TIER_ALIASES[String(tier || '').trim()] || (TIERS.includes(tier) ? tier : null);
  if (!t) throw new Error(`דרגה לא מוכרת: "${tier}". אפשרויות: רותח / חם / פושר`);

  const rc = await resolveCampaign(campaign);
  if (!rc.campaign) return { status: 'need_campaign', message: `לא זיהיתי קמפיין אחד בשם "${campaign}". צריך לבחור:`, matches: rc.matches, allCampaigns: rc.all };
  const target = rc.campaign;
  const pelephone = /פלאפון/.test(target.name);

  const [rows, deny] = await Promise.all([readSheet(), tc.denyList()]);
  const customers = scoring.buildCustomers(rows);
  const tierCounts = Object.fromEntries(TIERS.map((x) => [x, customers.filter((c) => c.tier === x).length]));
  // scoring-level disqualifications (deal / already yes / no infra / remove / sharp refusal / cyber). Pelephone may take yes customers.
  const scoringRejected = [];
  const inTier = customers.filter((c) => {
    if (c.tier !== t) return false;
    const d = [...c.disq.entries()].filter(([k]) => !(pelephone && k === 'yesCustomer'));
    if (d.length) { scoringRejected.push({ c, why: [{ k: 'scoring', d: d.map(([, v]) => v).join(', ') }] }); return false; }
    return true;
  });

  const { passed, rejected, checked, seenStatuses } = await checkCandidates(inTier, target, deny, count);
  const allRejected = [...scoringRejected, ...rejected];
  const byReason = {};
  for (const r of allRejected) for (const w of r.why) byReason[rules.REASON_LABELS[w.k] || w.k] = (byReason[rules.REASON_LABELS[w.k] || w.k] || 0) + 1;
  const runId = new Date().toISOString().slice(0, 10) + '-' + crypto.randomBytes(3).toString('hex');
  const plan = {
    runId, createdAt: new Date().toISOString(), campaign: { id: target.id, name: target.name }, tier: t, requested: count,
    sourceName: `Claude ${t} ${new Date().toISOString().slice(0, 10)}`,
    leads: passed.map((c) => ({ phone: c.phone, notes: scoring.note(c), audience: t })),
  };
  store.save(`leads/plans/${runId}`, plan);
  const shortage = passed.length < count;
  const summary = {
    status: 'dry_run', runId, campaign: plan.campaign, tier: t, requested: count,
    pool: { sheetRows: rows.length, customers: customers.length, byTier: tierCounts, denyList: deny.size },
    candidates: inTier.length + scoringRejected.length, statusChecked: checked,
    rejectedTotal: allRejected.length, rejectedByReason: byReason,
    willUpload: passed.length,
    shortage: shortage ? `יש רק ${passed.length} לידים ${t}ים שעוברים את כל הבדיקות מתוך ${count} שביקשת. לא השלמתי מדרגה נמוכה יותר – להשלים מ"${TIERS[TIERS.indexOf(t) + 1] || '-'}"?` : undefined,
    examples: passed.slice(0, 5).map(brief),
    statusValuesSeen: Object.fromEntries(Object.entries(seenStatuses).sort((a, b) => b[1] - a[1]).slice(0, 40)),
    rejectedExamples: allRejected.slice(0, 15).map((r) => ({ phone: r.c.phone, why: r.why.map((w) => w.d).join(' | ') })),
    next: `לאישור ההעלאה: POST /admin/leads/confirm {"runId":"${runId}"} (התוכנית בתוקף ${PLAN_TTL_H} שעות)`,
  };
  appendLog({ at: plan.createdAt, runId, type: 'dry', campaign: target.name, tier: t, requested: count, candidates: summary.candidates, rejected: allRejected.length, rejectedByReason: byReason, willUpload: passed.length });
  log({ runId, type: 'dry', campaign: target.name, willUpload: passed.length, rejected: allRejected.length });
  return summary;
}

async function confirm({ runId }) {
  tc.requireKey();
  const plan = store.load(`leads/plans/${runId}`, null);
  if (!plan) throw new Error(`לא נמצאה הרצה יבשה ${runId}`);
  if (plan.uploadedAt) throw new Error(`הרצה ${runId} כבר הועלתה ב-${plan.uploadedAt}`);
  if (Date.now() - new Date(plan.createdAt).getTime() > PLAN_TTL_H * 3600000) throw new Error(`התוכנית ${runId} ישנה מ-${PLAN_TTL_H} שעות – צריך הרצה יבשה חדשה`);
  plan.uploadedAt = new Date().toISOString(); store.save(`leads/plans/${runId}`, plan); // lock against double confirm

  // Re-check every approved lead right before the upload (iron rules may have changed since the dry run).
  const deny = await tc.denyList();
  const target = plan.campaign;
  const rechecked = await checkCandidates(plan.leads.map((l) => ({ ...l, lastCall: null })), target, deny, plan.leads.length);
  const ok = rechecked.passed;
  const droppedNow = rechecked.rejected.map((r) => ({ phone: r.c.phone, why: r.why.map((w) => w.d).join(' | ') }));

  const uploaded = [], failed = [];
  for (let i = 0; i < ok.length; i += BATCH) {
    const batch = ok.slice(i, i + BATCH);
    try {
      const r = await tc.addLeads(target.id, batch, plan.sourceName);
      if (r.status >= 400) { batch.forEach((l) => failed.push({ phone: l.phone, error: `HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}` })); continue; }
      const b = r.body || {};
      const failedSet = new Map();
      for (const f of (Array.isArray(b.failed) ? b.failed : [])) { const p = tc.normPhone(f.phone ?? f.customer?.phone ?? f); failedSet.set(p, f.reason || f.error || f.message || JSON.stringify(f).slice(0, 150)); }
      for (const l of batch) { if (failedSet.has(l.phone)) failed.push({ phone: l.phone, error: failedSet.get(l.phone) }); else uploaded.push(l.phone); }
      log({ runId, batch: i / BATCH, sent: batch.length, created: (b.created || []).length, updated: (b.updated || []).length, failed: failedSet.size });
    } catch (e) { batch.forEach((l) => failed.push({ phone: l.phone, error: String(e.message).slice(0, 200) })); }
  }
  const idx = uploadedIndex();
  for (const p of uploaded) idx[p] = { campaign: target.name, campaignId: target.id, at: plan.uploadedAt, runId };
  store.save('leads/uploaded', idx);
  const failReasons = {}; failed.forEach((f) => { failReasons[f.error] = (failReasons[f.error] || 0) + 1; });
  const res = { status: 'uploaded', runId, campaign: target, approved: plan.leads.length, droppedOnRecheck: droppedNow, uploaded: uploaded.length, failed: failed.length, failReasons, failedPhones: failed.slice(0, 50) };
  plan.result = { uploaded: uploaded.length, failed: failed.length, droppedOnRecheck: droppedNow.length }; store.save(`leads/plans/${runId}`, plan);
  appendLog({ at: plan.uploadedAt, runId, type: 'upload', campaign: target.name, tier: plan.tier, requested: plan.requested, approved: plan.leads.length, droppedOnRecheck: droppedNow.length, uploaded: uploaded.length, failed: failed.length, failReasons });
  return res;
}

function appendLog(entry) {
  const l = store.load('leads/runlog', []); l.unshift(entry); if (l.length > 1000) l.length = 1000; store.save('leads/runlog', l);
  // Optional mirror to a Google Sheet tab (needs edit access for the service account). Never fails the run.
  const id = process.env.LEADS_LOG_SHEET_ID; if (!id) return;
  const tab = process.env.LEADS_LOG_SHEET_TAB || 'לוג העלאות';
  const row = [entry.at, entry.type, entry.runId, entry.campaign, entry.tier, entry.requested, entry.willUpload ?? entry.uploaded ?? '', entry.rejected ?? entry.droppedOnRecheck ?? '', entry.failed ?? '', JSON.stringify(entry.rejectedByReason || entry.failReasons || {})];
  google.sheets({ url: `/spreadsheets/${id}/values/${encodeURIComponent(`'${tab}'!A1`)}:append`, method: 'POST', qs: [{ key: 'valueInputOption', value: 'RAW' }], body: { values: [row] } }).catch((e) => log({ ev: 'leads_log_sheet_err', err: String(e.message).slice(0, 200) }));
}

// Run as a background job; wait up to `waitMs` for the answer so short runs return synchronously.
function start(kind, args, waitMs = 25000) {
  const id = crypto.randomBytes(4).toString('hex');
  const job = { id, kind, status: 'running', startedAt: new Date().toISOString() }; jobs.set(id, job);
  const p = (kind === 'confirm' ? confirm(args) : dryRun(args)).then((r) => { job.status = 'done'; job.result = r; }, (e) => { job.status = 'error'; job.error = String(e.message || e); job.missingKey = e instanceof tc.MissingKeyError; log({ ev: 'leads_err', kind, err: String(e.stack || e) }); });
  return Promise.race([p.then(() => job), new Promise((r) => setTimeout(() => r(job), waitMs))]);
}
const job = (id) => jobs.get(id) || null;
const runLog = (n = 50) => store.load('leads/runlog', []).slice(0, n);

module.exports = { dryRun, confirm, start, job, runLog, resolveCampaign };
