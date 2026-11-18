// Local JSON persistence on the Railway volume: data stores, execution logs, misc state.
const fs = require('fs'), path = require('path');
const DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(path.join(DIR, 'ds'), { recursive: true });
fs.mkdirSync(path.join(DIR, 'runs'), { recursive: true });
const mem = new Map();
function file(name) { return path.join(DIR, name + '.json'); }
function load(name, def) {
  if (mem.has(name)) return mem.get(name);
  let v = def; try { v = JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch {}
  mem.set(name, v); return v;
}
function save(name, val) { mem.set(name, val); const f = file(name); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + '.tmp', JSON.stringify(val)); fs.renameSync(f + '.tmp', f); }
function exists(name) { return mem.has(name) || fs.existsSync(file(name)); }
// ---- data stores ----
const dsName = (id, shadow) => `ds/${id}${shadow ? '.shadow' : ''}`;
function ds(id, shadow) {
  if (shadow && !exists(dsName(id, true))) save(dsName(id, true), JSON.parse(JSON.stringify(load(dsName(id), { records: {} }))));
  return load(dsName(id, shadow), { records: {} });
}
function dsSave(id, val, shadow) { save(dsName(id, shadow), val); }
// ---- run log (last 200 per scenario) ----
function logRun(scenarioId, run) {
  const name = `runs/${scenarioId}`; const runs = load(name, []);
  runs.unshift(run); if (runs.length > 200) runs.length = 200; save(name, runs);
}
// ---- binary files kept on the volume (e.g. uploads Drive refused) ----
const FDIR = path.join(DIR, 'files'); fs.mkdirSync(FDIR, { recursive: true });
const safeName = (n) => String(n).replace(/[\/\\\0]/g, '_').slice(0, 200);
function saveFile(name, buf) { const n = safeName(name); fs.writeFileSync(path.join(FDIR, n), buf); return n; }
function listFiles() { return fs.readdirSync(FDIR).map((n) => { const st = fs.statSync(path.join(FDIR, n)); return { name: n, size: st.size, at: st.mtime.toISOString() }; }).sort((a, b) => b.at.localeCompare(a.at)); }
function readFile(name) { const f = path.join(FDIR, safeName(name)); return fs.existsSync(f) ? fs.readFileSync(f) : null; }
module.exports = { load, save, exists, ds, dsSave, logRun, DIR, saveFile, listFiles, readFile };
