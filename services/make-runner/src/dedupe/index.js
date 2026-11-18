// Global cross-campaign dedupe for ToChat (Steve, 18/11/2026).
// Iron rules:
//   1. A customer may be open in ONE campaign only – never two reps on the same customer.
//   2. An open follow-up (FOLLOWUP / INCOMING_FOLLOWUP) is sacred: it always stays; every other copy is closed.
//      Two follow-ups by different reps: whoever set it first keeps it (lastCall, else createDate of that lead);
//      less than 10 minutes apart or a missing time → nothing is closed, the case is reported for a human.
//   3. No follow-up anywhere: keep the copy by campaign priority –
//      פולואפים כל הזמנים → רותחים → תקשורת כל החברות (חדש) → … ; the rest are closed.
// Open leads are only used to FIND phones that are open in 2+ campaigns. Every decision is taken from the live
// customer record (/customers/<phone> → activeLeads), read just before closing.
const tc = require('../leads/tochat-client');
const store = require('../store');
const enc = encodeURIComponent;

// Campaign priority for customers without a follow-up (first match wins; lower index = keep).
const PRIORITY = [
  /^פולואפים כל הזמנים$/,
  /^רותחים/,
  /^תקשורת כל החברות חדש$/,
  /^תקשורת כל החברות$/,
  /^הזדמנות שני/,
  /^בוסט$/,
  /מבצע/,
  /מצטרפים/,
];
// Campaigns that are never touched (not counted, never closed).
const SKIP = /רשימה שחורה/;
const FOLLOW = /FOLLOW/i;
const FU_GAP_MS = 10 * 60 * 1000;
const MAX_CLOSE = Number(process.env.DEDUPE_MAX_CLOSE || 5000);
const MAX_FU_CLOSE = Number(process.env.DEDUPE_MAX_FU_CLOSE || 30);

const rank = (name) => { const i = PRIORITY.findIndex((re) => re.test(String(name || '').trim())); return i < 0 ? PRIORITY.length : i; };
const time = (l) => { const d = new Date(l.lastCall || l.createDate || ''); return isNaN(d) ? null : d.getTime(); };
const created = (l) => { const d = new Date(l.createDate || ''); return isNaN(d) ? Infinity : d.getTime(); };
const isFU = (l) => FOLLOW.test(String(l.status || ''));
const label = (l) => `${l.campaignName || '?'}${isFU(l) ? ` (פולואפ ${l.followByName || '?'})` : ''}`;

// Pure decision for one customer. leads = activeLeads from the customer record.
// Returns { keep: [lead], close: [{ lead, why, fu }], review: string|null }
function decide(leads) {
  const L = (leads || []).filter((l) => !SKIP.test(String(l.campaignName || '')));
  if (L.length < 2) return { keep: L, close: [], review: null };
  const fu = L.filter(isFU);
  if (fu.length) {
    let keep = fu; let review = null; const close = [];
    const reps = new Set(fu.map((l) => String(l.followByName || '').trim()));
    if (fu.length > 1 && reps.size > 1) {
      const t = fu.map(time);
      if (t.some((x) => x === null)) review = 'שני פולואפים של נציגים שונים, חסר זמן';
      else {
        const s = fu.map((l, i) => ({ l, t: t[i] })).sort((a, b) => a.t - b.t);
        if (s[1].t - s[0].t < FU_GAP_MS) review = 'שני פולואפים של נציגים שונים בהפרש של פחות מ-10 דקות';
        else {
          keep = [s[0].l];
          for (const x of s.slice(1)) if (String(x.l.followByName || '').trim() !== String(s[0].l.followByName || '').trim()) close.push({ lead: x.l, fu: true, why: `פולואפ מאוחר יותר – הלקוח נשאר אצל ${s[0].l.followByName || '?'} (${s[0].l.campaignName || ''})` });
            else keep.push(x.l);
        }
      }
    }
    const owner = keep[0];
    for (const l of L) if (!isFU(l)) close.push({ lead: l, fu: false, why: `ללקוח פולואפ פתוח אצל ${owner.followByName || '?'} (${owner.campaignName || ''})` });
    return { keep, close, review: review && `${review}: ${fu.map(label).join(' / ')}` };
  }
  const s = L.slice().sort((a, b) => rank(a.campaignName) - rank(b.campaignName) || created(a) - created(b));
  return { keep: [s[0]], close: s.slice(1).map((l) => ({ lead: l, fu: false, why: `כפילות – הלקוח נשאר בקמפיין ${s[0].campaignName || ''}` })), review: null };
}

// All open leads of one campaign (follows pageToken; handles array / {leads} / {items} shapes).
async function openLeads(id) {
  const out = []; let pageToken; let guard = 0;
  do {
    const r = await tc.request(`/tenants/${enc(tc.tenant())}/campaigns/${enc(id)}/openLeads`, { qs: { limit: 10000, pageToken } });
    if (r.status >= 400) throw new Error(`openLeads ${r.status}`);
    const b = r.body; const arr = Array.isArray(b) ? b : (b && (b.leads || b.items || b.data)) || [];
    out.push(...arr);
    pageToken = b && !Array.isArray(b) ? (b.nextPageToken || b.pageToken || undefined) : undefined;
  } while (pageToken && ++guard < 200);
  return out;
}

async function pool(items, n, fn) {
  let i = 0; const res = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; res[k] = await fn(items[k], k); } }));
  return res;
}

async function closeLead(campaignId, phone, note) {
  const r = await tc.request(`/tenants/${enc(tc.tenant())}/campaigns/${enc(campaignId)}/done`, { method: 'POST', body: { phone, reason: 'IRRELEVANT', note: note.slice(0, 250) }, retries: 3 });
  return r.status < 400;
}

// One full pass. dry = decide and report only.
async function run({ dry = false, log = () => {} } = {}) {
  const started = new Date();
  const res = { at: started.toISOString(), dry, campaigns: 0, openLeads: 0, failedCampaigns: [], dupPhones: 0, checked: 0, closed: 0, closedFU: 0, failedClose: 0, review: [], fuConflicts: [], byCampaign: {}, errors: [] };
  const camps = (await tc.listCampaigns()).filter((c) => !SKIP.test(c.name));
  const where = new Map(); // phone -> Set(campaignId)
  await pool(camps, 3, async (c) => {
    try {
      const L = await openLeads(c.id); res.campaigns++; res.openLeads += L.length;
      for (const l of L) { const p = tc.normPhone(l.displayPhone || l.phone || (l.customer && l.customer.phone)); if (!p) continue; if (!where.has(p)) where.set(p, new Set()); where.get(p).add(c.id); }
    } catch (e) { res.failedCampaigns.push(c.name); }
  });
  const dups = [...where].filter(([, s]) => s.size > 1).map(([p]) => p);
  res.dupPhones = dups.length;
  log({ ev: 'dedupe_scan', campaigns: res.campaigns, openLeads: res.openLeads, dups: dups.length, failed: res.failedCampaigns.length });

  const plans = [];
  await pool(dups, 4, async (p) => {
    try {
      const st = await tc.customerStatus(p); res.checked++;
      const d = decide(st.activeLeads);
      if (d.review) res.review.push({ p, d: d.review });
      if (d.close.length) plans.push({ p, ...d });
    } catch (e) { res.errors.push(`${p.slice(-4)}: ${String(e.message).slice(0, 120)}`); }
  });
  const fuPlans = plans.filter((x) => x.close.some((c) => c.fu));
  const allowFU = fuPlans.length <= MAX_FU_CLOSE;
  if (!allowFU) res.errors.push(`${fuPlans.length} התנגשויות פולואפ בין נציגים – יותר מ-${MAX_FU_CLOSE}, לא נסגר אף פולואפ (לבדיקה ידנית)`);

  let budget = MAX_CLOSE;
  for (const pl of plans) {
    for (const c of pl.close) {
      if (c.fu && !allowFU) continue;
      if (budget-- <= 0) { res.errors.push(`הגעתי למגבלה של ${MAX_CLOSE} סגירות בהרצה`); break; }
      const name = c.lead.campaignName || '?';
      let okc = true;
      if (!dry) { try { okc = await closeLead(c.lead.campaignId, pl.p, `נסגר אוטומטית: ${c.why}`); } catch { okc = false; } }
      if (!okc) { res.failedClose++; continue; }
      res.closed++; res.byCampaign[name] = (res.byCampaign[name] || 0) + 1;
      if (c.fu) { res.closedFU++; res.fuConflicts.push({ p: pl.p, kept: label(pl.keep[0]), closed: label(c.lead) }); }
    }
  }
  res.secs = Math.round((Date.now() - started) / 1000);
  const runs = store.load('jobs/dedupe', []); runs.unshift(res); if (runs.length > 60) runs.length = 60; store.save('jobs/dedupe', runs);
  log({ ev: 'dedupe_done', closed: res.closed, closedFU: res.closedFU, review: res.review.length, errors: res.errors.length, secs: res.secs });
  return res;
}

// Short WhatsApp text for Steve (only when something between reps happened, or the run had problems).
function message(r, hhmm) {
  if (!r.closedFU && !r.review.length && !r.failedCampaigns.length && !r.errors.length && !r.failedClose) return null;
  const lines = [`🛡️ כפילויות טוצ'אט ${hhmm}: נסגרו ${r.closed} עותקים כפולים (${r.dupPhones} לקוחות היו פתוחים ביותר מקמפיין אחד)`];
  for (const x of r.fuConflicts.slice(0, 15)) lines.push(`• ${x.p.slice(-4)} – נשאר: ${x.kept} | נסגר: ${x.closed}`);
  if (r.review.length) { lines.push('לבדיקה ידנית (לא נסגר):'); for (const x of r.review.slice(0, 10)) lines.push(`• ${x.p.slice(-4)} – ${x.d}`); }
  if (r.failedCampaigns.length) lines.push(`⚠️ לא נקראו קמפיינים: ${r.failedCampaigns.slice(0, 8).join(', ')}`);
  if (r.failedClose) lines.push(`⚠️ ${r.failedClose} סגירות נכשלו`);
  for (const e of r.errors.slice(0, 3)) lines.push(`⚠️ ${e}`);
  return lines.join('\n');
}

// Schedule: Sun–Fri 07:50, 12:30, 16:30 (Asia/Jerusalem). Override with DEDUPE_TIMES="07:50,12:30,16:30".
const SCHEDULE = { type: 'daily', time: (process.env.DEDUPE_TIMES || '07:50,12:30,16:30').split(',').map((s) => s.trim()), restrict: [{ days: [0, 1, 2, 3, 4, 5] }] };

module.exports = { run, decide, message, SCHEDULE, PRIORITY, rank };
