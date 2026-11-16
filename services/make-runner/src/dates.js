// Moment-style date formatting/parsing with IANA time zones (Make semantics). Default zone = Asia/Jerusalem.
const DEF_TZ = process.env.MAKE_TZ || 'Asia/Jerusalem';
function toDate(v) {
  if (v instanceof Date) return isNaN(v) ? null : v;
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v);
  const s = String(v).trim();
  if (/^\d{10}$/.test(s)) return new Date(Number(s) * 1000);
  if (/^\d{13}$/.test(s)) return new Date(Number(s));
  const d = new Date(s);
  return isNaN(d) ? null : d;
}
function parts(d, tz) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short', hourCycle: 'h23' }).formatToParts(d);
  const g = (t) => (p.find((x) => x.type === t) || {}).value;
  return { Y: +g('year'), M: +g('month'), D: +g('day'), h: +g('hour') % 24, m: +g('minute'), s: +g('second'), wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(g('weekday')), ms: d.getUTCMilliseconds() };
}
function offsetMin(d, tz) { const p = parts(d, tz); return Math.round((Date.UTC(p.Y, p.M - 1, p.D, p.h, p.m, p.s) - (d.getTime() - d.getUTCMilliseconds())) / 60000); }
// wall-clock (in tz) -> Date
function fromWall(Y, M, D, h, m, s, ms, tz) {
  let guess = Date.UTC(Y, M - 1, D, h, m, s, ms);
  for (let i = 0; i < 3; i++) { const off = offsetMin(new Date(guess), tz); const t = Date.UTC(Y, M - 1, D, h, m, s, ms) - off * 60000; if (t === guess) break; guess = t; }
  return new Date(guess);
}
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const TOK = /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DDDD|DD|Do|D|dddd|ddd|dd|d|E|HH|H|hh|h|mm|m|ss|s|SSS|A|a|X|x|ZZ|Z|Q|W|ww|w/g;
const z = (n, l = 2) => String(n).padStart(l, '0');
function formatDate(v, fmt, tz) {
  const d = toDate(v); if (!d) return v == null ? '' : String(v);
  tz = tz || DEF_TZ; fmt = fmt || 'YYYY-MM-DDTHH:mm:ss.SSSZ';
  const p = parts(d, tz); const off = offsetMin(d, tz);
  const offStr = (sep) => (off >= 0 ? '+' : '-') + z(Math.floor(Math.abs(off) / 60)) + sep + z(Math.abs(off) % 60);
  return String(fmt).replace(TOK, (t, lit) => {
    if (lit !== undefined) return lit;
    switch (t) {
      case 'YYYY': return String(p.Y); case 'YY': return z(p.Y % 100);
      case 'MMMM': return MONTHS[p.M - 1]; case 'MMM': return MONTHS[p.M - 1].slice(0, 3); case 'MM': return z(p.M); case 'M': return String(p.M);
      case 'DD': return z(p.D); case 'D': return String(p.D); case 'Do': return p.D + (['th', 'st', 'nd', 'rd'][(p.D % 100 > 10 && p.D % 100 < 14) ? 0 : Math.min(p.D % 10, 4) % 4] || 'th');
      case 'DDDD': { const start = Date.UTC(p.Y, 0, 1); return z(Math.floor((Date.UTC(p.Y, p.M - 1, p.D) - start) / 864e5) + 1, 3); }
      case 'dddd': return DAYS[p.wd]; case 'ddd': return DAYS[p.wd].slice(0, 3); case 'dd': return DAYS[p.wd].slice(0, 2); case 'd': return String(p.wd); case 'E': return String(p.wd === 0 ? 7 : p.wd);
      case 'HH': return z(p.h); case 'H': return String(p.h);
      case 'hh': return z(p.h % 12 || 12); case 'h': return String(p.h % 12 || 12);
      case 'mm': return z(p.m); case 'm': return String(p.m); case 'ss': return z(p.s); case 's': return String(p.s);
      case 'SSS': return z(p.ms, 3); case 'A': return p.h < 12 ? 'AM' : 'PM'; case 'a': return p.h < 12 ? 'am' : 'pm';
      case 'X': return String(Math.floor(d.getTime() / 1000)); case 'x': return String(d.getTime());
      case 'Z': return offStr(':'); case 'ZZ': return offStr('');
      case 'Q': return String(Math.ceil(p.M / 3));
      default: return t;
    }
  });
}
function parseDate(v, fmt, tz) {
  if (v instanceof Date) return v;
  if (v == null || v === '') return undefined;
  const s = String(v).trim(); tz = tz || DEF_TZ;
  if (!fmt) { const d = toDate(s); return d || undefined; }
  if (fmt === 'X') return new Date(Number(s) * 1000); if (fmt === 'x') return new Date(Number(s));
  // build regex from format
  const fields = []; let re = '^';
  let last = 0; const f = String(fmt);
  f.replace(TOK, (t, lit, idx) => {
    re += f.slice(last, idx).replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'); last = idx + t.length;
    if (lit !== undefined) { re += lit.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'); return t; }
    const map = { YYYY: '(\\d{4})', YY: '(\\d{2})', MM: '(\\d{1,2})', M: '(\\d{1,2})', DD: '(\\d{1,2})', D: '(\\d{1,2})', Do: '(\\d{1,2})(?:st|nd|rd|th)', HH: '(\\d{1,2})', H: '(\\d{1,2})', hh: '(\\d{1,2})', h: '(\\d{1,2})', mm: '(\\d{1,2})', m: '(\\d{1,2})', ss: '(\\d{1,2})', s: '(\\d{1,2})', SSS: '(\\d{1,3})', A: '(AM|PM|am|pm)', a: '(AM|PM|am|pm)', Z: '([+-]\\d{2}:?\\d{2}|Z)', ZZ: '([+-]\\d{2}:?\\d{2}|Z)', MMMM: '([A-Za-z]+)', MMM: '([A-Za-z]{3})', dddd: '[A-Za-z]+', ddd: '[A-Za-z]{3}' };
    re += map[t] || '.*?'; if (map[t] && map[t].startsWith('(')) fields.push(t);
    return t;
  });
  re += f.slice(last).replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
  const m = new RegExp(re).exec(s);
  if (!m) { const d = toDate(s); return d || undefined; }
  let Y = 1970, M = 1, D = 1, h = 0, mi = 0, sec = 0, ms = 0, pm = null, zoff = null;
  fields.forEach((t, i) => { const x = m[i + 1];
    switch (t) { case 'YYYY': Y = +x; break; case 'YY': Y = 2000 + +x; break; case 'MM': case 'M': M = +x; break; case 'MMMM': case 'MMM': M = MONTHS.findIndex((n) => n.toLowerCase().startsWith(x.toLowerCase().slice(0, 3))) + 1; break;
      case 'DD': case 'D': case 'Do': D = +x; break; case 'HH': case 'H': case 'hh': case 'h': h = +x; break; case 'mm': case 'm': mi = +x; break; case 'ss': case 's': sec = +x; break; case 'SSS': ms = +x; break;
      case 'A': case 'a': pm = /pm/i.test(x); break; case 'Z': case 'ZZ': zoff = x === 'Z' ? 0 : (x[0] === '-' ? -1 : 1) * (+x.slice(1, 3) * 60 + +x.slice(-2)); break; }
  });
  if (pm !== null) { if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; }
  if (zoff !== null) return new Date(Date.UTC(Y, M - 1, D, h, mi, sec, ms) - zoff * 60000);
  return fromWall(Y, M, D, h, mi, sec, ms, tz);
}
function add(v, ms) { const d = toDate(v); return d ? new Date(d.getTime() + ms) : undefined; }
function addCal(v, unit, n, tz = DEF_TZ) {
  const d = toDate(v); if (!d) return undefined;
  const p = parts(d, tz);
  if (unit === 'd') return fromWall(p.Y, p.M, p.D + n, p.h, p.m, p.s, p.ms, tz);
  if (unit === 'm') return fromWall(p.Y, p.M + n, p.D, p.h, p.m, p.s, p.ms, tz);
  return fromWall(p.Y + n, p.M, p.D, p.h, p.m, p.s, p.ms, tz);
}
function set(v, fn, n, tz = DEF_TZ) {
  const d = toDate(v); if (!d) return undefined; const p = parts(d, tz);
  const o = { Y: p.Y, M: p.M, D: p.D, h: p.h, m: p.m, s: p.s };
  ({ setHour: () => (o.h = n), setMinute: () => (o.m = n), setSecond: () => (o.s = n), setDate: () => (o.D = n), setMonth: () => (o.M = n), setYear: () => (o.Y = n) })[fn]();
  return fromWall(o.Y, o.M, o.D, o.h, o.m, o.s, 0, tz);
}
module.exports = { toDate, formatDate, parseDate, add, addCal, set, parts, fromWall, DEF_TZ };
