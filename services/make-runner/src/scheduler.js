// Make-compatible scheduling (Asia/Jerusalem): indefinitely(interval, restrict), daily, weekly, monthly.
const dates = require('./dates');
const store = require('./store');
const TZ = dates.DEF_TZ;
const hm = (s) => { const [h, m] = String(s || '0:0').split(':').map(Number); return h * 60 + (m || 0); };
function allowed(sch, now) {
  const p = dates.parts(now, TZ); const mins = p.h * 60 + p.m;
  if (sch.between) { const [a, b] = sch.between.map((x) => dates.toDate(x)); if ((a && now < a) || (b && now > b)) return false; }
  if (sch.restrict && sch.restrict.length) {
    return sch.restrict.some((r) => (!r.days || r.days.includes(p.wd)) && (!r.months || r.months.includes(p.M)) && (!r.time || (mins >= hm(r.time[0]) && mins <= hm(r.time[1] || '23:59'))));
  }
  return true;
}
// returns true when the scenario is due now; `last` = ISO of last run
function due(sch, last, now = new Date()) {
  if (!sch || !sch.type) return false;
  const lastD = last ? new Date(last) : null;
  const p = dates.parts(now, TZ); const mins = p.h * 60 + p.m; const today = `${p.Y}-${p.M}-${p.D}`;
  const lastDay = lastD ? (() => { const q = dates.parts(lastD, TZ); return `${q.Y}-${q.M}-${q.D}`; })() : '';
  switch (sch.type) {
    case 'indefinitely': return allowed(sch, now) && (!lastD || now - lastD >= (Number(sch.interval) || 900) * 1000 - 5000);
    case 'daily': { const times = [].concat(sch.time || '00:00'); return allowed(sch, now) && times.some((t) => mins >= hm(t) && (!lastD || lastD < dates.fromWall(p.Y, p.M, p.D, Math.floor(hm(t) / 60), hm(t) % 60, 0, 0, TZ))); }
    case 'weekly': return (sch.days || []).includes(p.wd) && mins >= hm(sch.time) && lastDay !== today && mins - hm(sch.time) < 120;
    case 'monthly': return (sch.dates || []).includes(p.D) && mins >= hm(sch.time) && lastDay !== today && mins - hm(sch.time) < 120;
    case 'once': return !lastD && sch.date && now >= new Date(sch.date);
  }
  return false;
}
function lastRun(id) { return store.load('lastrun', {})[id]; }
function markRun(id, at) { const o = store.load('lastrun', {}); o[id] = at; store.save('lastrun', o); }
module.exports = { due, lastRun, markRun, allowed };
