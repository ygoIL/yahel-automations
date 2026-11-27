// Upload guard (Steve 18/11/2026): automatic uploads never put a customer who is already open in another campaign.
// - Open follow-up (FOLLOWUP / INCOMING_FOLLOWUP) anywhere → never uploaded (sacred), not even to a prioritized campaign.
// - Open (pending) in another campaign → not uploaded, UNLESS the target ranks higher than every other open copy
//   (a pinned campaign, or e.g. הזדמנות שניה over תקשורת כל החברות): then it is uploaded and the hourly dedupe closes the others.
// Pinned campaigns = the ones Steve asked to prioritize (POST /admin/dedupe/pinned). UPLOAD_GUARD=off disables the guard.
const tc = require('../leads/tochat-client');
const store = require('../store');
const FOLLOW = /FOLLOW/i;
const rank = (n) => require('../dedupe').rank(n);

// Prioritized campaigns come from two places: the sheet tab 'קמפיינים מתועדפים' (A2:A, Steve edits it; first = most important)
// and the admin list (POST /admin/dedupe/pinned). The sheet is re-read at most every 10 minutes.
const SHEET = () => process.env.PINNED_SHEET_ID || '1-mXfg-H5pZzGtTLTYOcU_SBgOEu8S2FnTrvz3Brc_7M';
const TAB = "'קמפיינים מתועדפים'!A2:A50";
let sheetCache = { at: 0, names: [] };
async function refreshPinned(force) {
  if (!force && Date.now() - sheetCache.at < 600e3) return;
  try { const r = await require('../google').sheets({ url: `/spreadsheets/${SHEET()}/values/${encodeURIComponent(TAB)}` }); sheetCache = { at: Date.now(), names: (r.body.values || []).map((x) => String(x[0] || '').trim()).filter(Boolean) }; }
  catch (e) { sheetCache.at = Date.now(); } // keep the last known list on failure
}
const pinned = () => [...new Set([...sheetCache.names, ...store.load('jobs/dedupe-pinned', [])])];
const setPinned = (names) => store.save('jobs/dedupe-pinned', (names || []).map((n) => String(n).trim()).filter(Boolean));
const isPinned = (nameOrId, list = pinned()) => list.some((p) => p === String(nameOrId || '').trim());

async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } })); }

let nameCache = { at: 0, map: {} };
async function campaignName(id) {
  if (Date.now() - nameCache.at > 3600e3) { try { nameCache = { at: Date.now(), map: Object.fromEntries((await tc.listCampaigns()).map((c) => [c.id, c.name])) }; } catch {} }
  return nameCache.map[id] || '';
}

// customers: [{ phone, ... }] → { keep: [...], skipped: [{ phone, why }] }
async function filter(campaignId, customers) {
  if (String(process.env.UPLOAD_GUARD || 'on').toLowerCase() === 'off' || !Array.isArray(customers) || !customers.length) return { keep: customers || [], skipped: [] };
  await refreshPinned();
  const name = await campaignName(campaignId);
  const pin = isPinned(name) || isPinned(campaignId);
  const keep = [], skipped = [];
  await pool(customers, 5, async (c) => {
    const p = tc.normPhone(c.phone);
    if (!p) { keep.push(c); return; }
    let st;
    try { st = await tc.customerStatus(p); } catch (e) { keep.push(c); return; } // lookup failure never blocks an upload; the hourly dedupe still covers it
    const other = (st.activeLeads || []).filter((l) => String(l.campaignId) !== String(campaignId));
    const fu = (st.activeLeads || []).filter((l) => FOLLOW.test(String(l.status || '')) && String(l.campaignId) !== String(campaignId));
    if (fu.length) skipped.push({ phone: p, why: `פולואפ פתוח אצל ${fu[0].followByName || '?'} (${fu[0].campaignName || ''})` });
    // a higher-priority target "pulls" the customer: allowed when it outranks every other open copy (the hourly dedupe then closes those)
    else if (other.length && !pin && !other.every((l) => rank(name) < rank(l.campaignName))) skipped.push({ phone: p, why: `פתוח בקמפיין ${other[0].campaignName || ''}` });
    else keep.push(c);
  });
  const log = store.load('jobs/upload-guard', []); log.unshift({ at: new Date().toISOString(), campaign: name || campaignId, pinned: pin, asked: customers.length, kept: keep.length, skipped: skipped.length, sample: skipped.slice(0, 20) }); if (log.length > 200) log.length = 200; store.save('jobs/upload-guard', log);
  return { keep, skipped };
}

// Morning question to Steve: which campaigns matter most today (Steve 18/11).
async function morningMessage() {
  await refreshPinned(true);
  const camps = await tc.listCampaigns();
  const on = camps.filter((c) => String((c.raw && c.raw.status) || '').toUpperCase() === 'ON').map((c) => c.name);
  const p = pinned();
  return `🎯 בוקר טוב! אילו קמפיינים הכי חשובים היום?\n\nמתועדפים עכשיו: ${p.length ? p.join(', ') : 'אין (רק הסדר הקבוע: פולואפים כל הזמנים ← רותחים ← תקשורת כל החברות)'}\nפתוחים בטוצ'אט: ${on.join(', ') || '-'}\n\nלשנות – תכתוב ל-Claude או תעדכן כאן (שורה לכל קמפיין, הראשון הכי חשוב):\nhttps://docs.google.com/spreadsheets/d/${SHEET()}/edit#gid=1880073664`;
}
const MORNING_SCHEDULE = { type: 'weekly', days: [0, 1, 2, 3, 4, 5], time: process.env.PINNED_ASK_TIME || '08:40' };

module.exports = { filter, pinned, setPinned, isPinned, refreshPinned, morningMessage, MORNING_SCHEDULE };
