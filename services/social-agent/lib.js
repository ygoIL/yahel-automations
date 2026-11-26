const fs = require('fs'), path = require('path');
const E = process.env;
const log = (o) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));

const DIR = E.DATA_DIR || './data';
const MEDIA = path.join(DIR, 'media');
fs.mkdirSync(MEDIA, { recursive: true });
function load(name, def) { try { return JSON.parse(fs.readFileSync(path.join(DIR, name + '.json'), 'utf8')); } catch { return def; } }
function save(name, val) { const f = path.join(DIR, name + '.json'); fs.writeFileSync(f + '.tmp', JSON.stringify(val, null, 1)); fs.renameSync(f + '.tmp', f); }

async function post(url, body, timeoutMs = 60000, headers = {}) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const txt = await r.text(); let data; try { data = JSON.parse(txt); } catch { data = txt; }
  return { status: r.status, data };
}
async function get(url, timeoutMs = 30000, headers = {}) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  const txt = await r.text(); let data; try { data = JSON.parse(txt); } catch { data = txt; }
  return { status: r.status, data };
}
async function download(url, file) {
  const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error('download ' + r.status);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  return file;
}

function ilParts(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const g = (t) => (p.find((x) => x.type === t) || {}).value;
  return { wd: g('weekday'), y: +g('year'), mo: +g('month'), d: +g('day'), h: +g('hour') % 24, mi: +g('minute') };
}
const ilDay = () => { const p = ilParts(); return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; };
const p9 = (s) => String(s == null ? '' : s).replace(/\D/g, '').slice(-9);

module.exports = { E, log, DIR, MEDIA, load, save, post, get, download, ilParts, ilDay, p9 };
