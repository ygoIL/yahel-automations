// Global cross-campaign dedupe for ToChat (Steve, 18/11/2026).
// Iron rules:
//   1. A customer may be open in ONE campaign only – never two reps on the same customer.
//   2. An open follow-up (FOLLOWUP / INCOMING_FOLLOWUP) is sacred: it always stays; every other copy is closed.
//      Two follow-ups by different reps (should never happen): a rep listed in the דוח מכר 'יעדים' tab beats a rep
//      who is not there (Steve, 18/11); if both or neither are listed – whoever set it first keeps it
//      (lastCall, else createDate) – always, even minutes apart; only a missing time → nothing is closed, reported.
//   3. No follow-up anywhere: keep the copy by campaign priority –
//      פולואפים כל הזמנים → רותחים → תקשורת כל החברות (חדש) → … ; the rest are closed.
// ToChat caps openLeads at 150,000 rows per hour for the whole tenant (shared with every other automation), so the
// hourly pass reads only the FOCUS campaigns (small, high priority) and finds the other copies of each of their customers
// through the customer record (activeLeads lists every campaign). A full scan of all campaigns: DEDUPE_FULL=1.
// Open leads are only used to FIND phones. Every decision is taken from the live
// customer record (/customers/<phone> → activeLeads), read just before closing.
const tc = require('../leads/tochat-client');
const store = require('../store');
const enc = encodeURIComponent;

// Campaign priority for customers without a follow-up (first match wins; lower index = keep).
const PRIORITY = [ // Steve 18/11 (evening): הזדמנות שניה and בוסט first, then the rest
  /^הזדמנות שני/,
  /^בוסט$/,
  /^פולואפים כל הזמנים$/,
  /^רותחים/,
  /^תקשורת כל החברות חדש$/,
  /^תקשורת כל החברות$/,
  /מבצע/,
  /מצטרפים/,
];
// Campaigns that are never touched (not counted, never closed).
const SKIP = /רשימה שחורה/;
// Campaigns read every hour (every customer in them is checked against all his other open copies).
const FOCUS = [/^פולואפים כל הזמנים$/, /^רותחים/, /^הזדמנות שני/, /^בוסט$/]; // + pinned campaigns
const FOLLOW = /FOLLOW/i;
const FU_GAP_MS = 10 * 60 * 1000;
const MAX_CLOSE = Number(process.env.DEDUPE_MAX_CLOSE || 5000);
// Nightly full scan may close more: the backlog (19/11: 26,666 dups) must clear in one night instead of eating the daytime ToChat budget.
const MAX_CLOSE_FULL = Number(process.env.DEDUPE_MAX_CLOSE_FULL || 30000);
const MAX_FU_CLOSE = Number(process.env.DEDUPE_MAX_FU_CLOSE || 30);

// Campaigns Steve asked to prioritize ("pinned") come before the fixed order; open follow-ups still win over everything.
const pinnedList = () => { try { return require('../guard').pinned(); } catch { return []; } };
const rank = (name) => { const n = String(name || '').trim(); const pi = pinnedList().indexOf(n); if (pi >= 0) return -100 + pi; const i = PRIORITY.findIndex((re) => re.test(n)); return i < 0 ? PRIORITY.length : i; };
const time = (l) => { const d = new Date(l.lastCall || l.createDate || ''); return isNaN(d) ? null : d.getTime(); };
const created = (l) => { const d = new Date(l.createDate || ''); return isNaN(d) ? Infinity : d.getTime(); };
const isFU = (l) => FOLLOW.test(String(l.status || ''));
const label = (l) => `${l.campaignName || '?'}${isFU(l) ? ` (פולואפ ${l.followByName || '?'})` : ''}`;

// Pure decision for one customer. leads = activeLeads from the customer record.
// Returns { keep: [lead], close: [{ lead, why, fu }], review: string|null }
// Our reps = names in 'יעדים'!A of the דוח מכר (not marked fired in L). Matching ToChat ↔ יעדים names.
const ALIASES = { 'איתמר חסון': 'איתמר ששון', 'עדן שטרית': 'עדן שיטרית', 'אוראל ניקודים 2': 'אוראל ניקודים' };
const norm = (n) => String(n || '').replace(/[\d.]+/g, ' ').replace(/\s+/g, ' ').trim();
function isOurRep(name, ours) {
  if (!ours || !name) return false;
  const n = norm(ALIASES[String(name).trim()] || name); if (!n) return false;
  for (const o of ours) { const m = norm(o); if (!m) continue; if (n === m) return true; if (!m.includes(' ') && n.startsWith(m + ' ')) return true; if (!n.includes(' ') && m.startsWith(n + ' ')) return true; }
  return false;
}
async function loadOurReps() {
  const id = process.env.SALES_REPORT_SHEET_ID || '12NkSDD2emzTYb4n5Zt5P9aLdEcgtrIGelZCKRoU7dZI';
  const r = await require('../google').sheets({ url: `/spreadsheets/${id}/values/${encodeURIComponent("'יעדים'!A2:L300")}` });
  return (r.body.values || []).filter((row) => row[0] && String(row[11] || '').toUpperCase() !== 'TRUE').map((row) => String(row[0]).trim());
}

function decide(leads, ours) {
  const L = (leads || []).filter((l) => !SKIP.test(String(l.campaignName || '')));
  if (L.length < 2) return { keep: L, close: [], review: null };
  const fu = L.filter(isFU);
  if (fu.length) {
    let keep = fu; let review = null; const close = [];
    const reps = new Set(fu.map((l) => String(l.followByName || '').trim()));
    if (fu.length > 1 && reps.size > 1) {
      const t = fu.map(time); const our = fu.map((l) => isOurRep(l.followByName, ours));
      const mixed = our.some(Boolean) && !our.every(Boolean);
      if (!mixed && t.some((x) => x === null)) review = 'שני פולואפים של נציגים שונים, חסר זמן';
      else {
        // our reps (יעדים) first, then earliest follow-up
        const s = fu.map((l, i) => ({ l, t: t[i] === null ? Infinity : t[i], o: our[i] })).sort((a, b) => (b.o - a.o) || (a.t - b.t));
        { // Steve 18/11: always whoever set it first – also when they are minutes apart
          keep = [s[0].l];
          for (const x of s.slice(1)) if (String(x.l.followByName || '').trim() !== String(s[0].l.followByName || '').trim()) close.push({ lead: x.l, fu: true, why: `${mixed ? 'הנציג לא ביעדים' : 'פולואפ מאוחר יותר'} – הלקוח נשאר אצל ${s[0].l.followByName || '?'} (${s[0].l.campaignName || ''})` });
            else keep.push(x.l);
        }
      }
    }
    // Same rep with the customer open twice (Steve 18/11): keep his most recent follow-up, close the older copies.
    if (keep.length > 1 && new Set(keep.map((l) => String(l.followByName || '').trim())).size === 1) {
      const s2 = keep.slice().sort((a, b) => (time(b) ?? 0) - (time(a) ?? 0));
      for (const l of s2.slice(1)) close.push({ lead: l, fu: false, why: `פולואפ כפול של ${l.followByName || '?'} – נשאר הפולואפ העדכני שלו (${s2[0].campaignName || ''})` });
      keep = [s2[0]];
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
  // 4xx/429 are thrown (never treated as an empty campaign)
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
async function run({ dry = false, full: full_, log = () => {} } = {}) {
  const started = new Date();
  const res = { at: started.toISOString(), dry, campaigns: 0, openLeads: 0, failedCampaigns: [], dupPhones: 0, checked: 0, closed: 0, closedFU: 0, failedClose: 0, review: [], fuConflicts: [], byCampaign: {}, errors: [] };
  const full = full_ ?? process.env.DEDUPE_FULL === '1';
  await require('../guard').refreshPinned(true);
  const all = (await tc.listCampaigns()).filter((c) => !SKIP.test(c.name));
  const isOn = (c) => String((c.raw && c.raw.status) || '').toUpperCase() === 'ON';
  const isFocus = (c) => FOCUS.some((re) => re.test(c.name)) || pinnedList().includes(c.name);
  // Hourly pass: focus + prioritized campaigns + every campaign that is ON right now (also one opened during the day).
  // Big campaigns are rotated so one pass stays under DEDUPE_MAX_ROWS (ToChat allows 150k rows/hour for the whole tenant).
  const memo = store.load('jobs/dedupe-camps', {}); // id -> { status, at, rows }
  let camps;
  if (full) camps = all;
  else {
    const cand = all.filter((c) => isFocus(c) || isOn(c));
    const turnedOn = (c) => isOn(c) && (memo[c.id] || {}).status !== 'ON';
    cand.sort((a, b) => (turnedOn(b) - turnedOn(a)) || (isFocus(b) - isFocus(a)) || String((memo[a.id] || {}).at || '').localeCompare(String((memo[b.id] || {}).at || '')));
    const cap = Number(process.env.DEDUPE_MAX_ROWS || 90000); let est = 0; camps = [];
    for (const c of cand) { const r = (memo[c.id] || {}).rows || 0; if (camps.length && !isFocus(c) && est + r > cap) { res.deferred = (res.deferred || 0) + 1; continue; } camps.push(c); est += r; }
  }
  for (const c of all) memo[c.id] = { ...(memo[c.id] || {}), status: isOn(c) ? 'ON' : 'OFF' };
  res.campaignNames = camps.map((c) => c.name);
  const where = new Map(); // phone -> Set(campaignId)
  const focusPhones = new Set();
  let waits = 0;
  for (let i = 0; i < camps.length; i++) {
    const c = camps[i];
    try {
      const L = await openLeads(c.id); res.campaigns++; res.openLeads += L.length;
      memo[c.id] = { ...(memo[c.id] || {}), at: new Date().toISOString(), rows: L.length };
      for (const l of L) { const p = tc.normPhone(l.displayPhone || l.phone || (l.customer && l.customer.phone)); if (!p) continue; if (!where.has(p)) where.set(p, new Set()); where.get(p).add(c.id); if (!full && isFocus(c)) focusPhones.add(p); }
    } catch (e) {
      if (/429/.test(String(e.message))) {
        // full (nightly) scan: the hourly ToChat budget ran out – wait for the next clock hour and continue (at most twice)
        if (full && waits < 2) { waits++; const now = new Date(); const next = new Date(now); next.setUTCMinutes(2, 0, 0); next.setUTCHours(now.getUTCHours() + 1); log({ ev: 'dedupe_wait_budget', until: next.toISOString(), at: c.name }); await new Promise((r) => setTimeout(r, next - now)); i--; continue; }
        res.failedCampaigns.push(c.name); res.errors.push('מכסת השעה של טוצ\'אט לקריאת לידים נגמרה – הבדיקה תושלם בהרצה הבאה'); break;
      }
      res.failedCampaigns.push(c.name);
    }
  }
  store.save('jobs/dedupe-camps', memo);
  // every customer of a focus/prioritized campaign is checked (his other copies are in the customer record);
  // for the rest, a customer open in 2+ of the campaigns read now
  const dups = [...where].filter(([p, s]) => s.size > 1 || focusPhones.has(p)).map(([p]) => p);
  res.dupPhones = dups.length;
  log({ ev: 'dedupe_scan', campaigns: res.campaigns, openLeads: res.openLeads, dups: dups.length, failed: res.failedCampaigns.length });

  let ours = null;
  try { ours = await loadOurReps(); res.ourReps = ours.length; } catch (e) { res.errors.push('לא נקראה לשונית יעדים – בהתנגשות פולואפים הוכרע לפי מי שקבע ראשון'); }
  const plans = [];
  await pool(dups, 4, async (p) => {
    try {
      const st = await tc.customerStatus(p); res.checked++;
      const d = decide(st.activeLeads, ours);
      if (d.review) res.review.push({ p, d: d.review });
      if (d.close.length) plans.push({ p, ...d });
    } catch (e) { if (res.errors.length < 20) res.errors.push(`${p.slice(-4)}: ${String(e.message).slice(0, 120)}`); }
  });
  res.dupPhones = plans.length;
  const fuPlans = plans.filter((x) => x.close.some((c) => c.fu));
  const allowFU = fuPlans.length <= MAX_FU_CLOSE;
  if (!allowFU) res.errors.push(`${fuPlans.length} התנגשויות פולואפ בין נציגים – יותר מ-${MAX_FU_CLOSE}, לא נסגר אף פולואפ (לבדיקה ידנית)`);

  const cap = full ? MAX_CLOSE_FULL : MAX_CLOSE;
  let budget = cap;
  plansLoop:
  for (const pl of plans) {
    for (const c of pl.close) {
      if (c.fu && !allowFU) continue;
      if (budget-- <= 0) { res.errors.push(`הגעתי למגבלה של ${cap} סגירות בהרצה – ${plans.length} מספרים כפולים, השאר ייסגרו בהרצה הבאה`); break plansLoop; }
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

// Schedule: every hour during working hours (Steve 18/11) – Sun–Fri 09:00–17:00 (Asia/Jerusalem).
// Runs on Railway only (ToChat API + Google) – no Make operations, no Claude.
// Nightly full scan of ALL campaigns (Steve 18/11; moved 02:10→23:40 on 19/11 so it ends long before the 05:20 follow-up list and the morning uploads) – at night nothing else uses the ToChat budget; continues into the next hour if needed.
const FULL_SCHEDULE = { type: 'daily', time: [process.env.DEDUPE_FULL_TIME || '23:40'] };
const SCHEDULE = { type: 'indefinitely', interval: Number(process.env.DEDUPE_INTERVAL_SEC || 3600), restrict: [{ days: [0, 1, 2, 3, 4, 5], time: ['09:00', '17:00'] }] };

module.exports = { run, decide, message, isOurRep, SCHEDULE, FULL_SCHEDULE, PRIORITY, FOCUS, rank };
