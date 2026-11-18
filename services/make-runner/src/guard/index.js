// Upload guard (Steve 18/11/2026): automatic uploads never put a customer who is already open in another campaign.
// - Open follow-up (FOLLOWUP / INCOMING_FOLLOWUP) anywhere → never uploaded (sacred), not even to a prioritized campaign.
// - Open (pending) in another campaign → not uploaded, UNLESS the target is a prioritized ("pinned") campaign:
//   then it is uploaded and the hourly dedupe keeps the copy in the pinned campaign and closes the others.
// Pinned campaigns = the ones Steve asked to prioritize (POST /admin/dedupe/pinned). UPLOAD_GUARD=off disables the guard.
const tc = require('../leads/tochat-client');
const store = require('../store');
const FOLLOW = /FOLLOW/i;

const pinned = () => store.load('jobs/dedupe-pinned', []);
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
    else if (other.length && !pin) skipped.push({ phone: p, why: `פתוח בקמפיין ${other[0].campaignName || ''}` });
    else keep.push(c);
  });
  const log = store.load('jobs/upload-guard', []); log.unshift({ at: new Date().toISOString(), campaign: name || campaignId, pinned: pin, asked: customers.length, kept: keep.length, skipped: skipped.length, sample: skipped.slice(0, 20) }); if (log.length > 200) log.length = 200; store.save('jobs/upload-guard', log);
  return { keep, skipped };
}

module.exports = { filter, pinned, setPinned, isPinned };
