// Loads scenarios/<id>.json (exported blueprints, secrets replaced by __ENV:NAME__) + registry.json (enabled/mode).
const fs = require('fs'), path = require('path');
const store = require('./store');
const DIR = path.join(__dirname, '..', 'scenarios');
function subEnv(text) {
  return text.replace(/__ENV:([A-Z0-9_]+)__/g, (_, n) => { const v = process.env[n]; if (v === undefined) { console.log(JSON.stringify({ ev: 'missing_env', name: n })); return ''; } return JSON.stringify(v).slice(1, -1); });
}
let cache = null;
function all() {
  if (cache) return cache;
  const reg = JSON.parse(fs.readFileSync(path.join(DIR, 'registry.json'), 'utf8'));
  cache = {};
  for (const f of fs.readdirSync(DIR)) {
    if (!/^\d+\.json$/.test(f)) continue;
    const sc = JSON.parse(subEnv(fs.readFileSync(path.join(DIR, f), 'utf8')));
    const r = reg[sc.id] || {};
    sc.mode = r.mode || 'off'; // off | dry | live
    cache[sc.id] = sc;
  }
  return cache;
}
// runtime override (set through /admin/mode) wins over registry.json
function mode(sc) { const o = store.load('modes', {}); return o[sc.id] || sc.mode; }
function setMode(id, m) { const o = store.load('modes', {}); if (m) o[id] = m; else delete o[id]; store.save('modes', o); }
function byHook(udid) { return Object.values(all()).find((s) => s.hookUdid === udid); }
module.exports = { all, mode, setMode, byHook };
