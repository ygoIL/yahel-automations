// Replace secret-looking literal header values ({name|key, value}) with __ENV:NAME__ placeholders.
const fs = require('fs'), path = require('path');
const secretsFile = process.argv[2]; const secrets = JSON.parse(fs.readFileSync(secretsFile, 'utf8'));
const byValue = Object.fromEntries(Object.entries(secrets).map(([k, v]) => [v, k]));
const dir = path.join(__dirname, '..', 'scenarios'); let n = 0;
function walk(o) {
  if (Array.isArray(o)) return o.forEach(walk);
  if (!o || typeof o !== 'object') return;
  const hn = o.name ?? o.key;
  if (typeof hn === 'string' && typeof o.value === 'string' && /key|secret|token|auth|password/i.test(hn) && !/content-type/i.test(hn) && o.value.length >= 8 && !o.value.includes('{{') && !o.value.startsWith('__ENV:')) {
    let name = byValue[o.value];
    if (!name) { name = 'HDR_' + hn.toUpperCase().replace(/[^A-Z0-9]+/g, '_'); let i = 2; const b = name; while (secrets[name] && secrets[name] !== o.value) name = `${b}_${i++}`; secrets[name] = o.value; byValue[o.value] = name; }
    o.value = `__ENV:${name}__`; n++;
  }
  for (const v of Object.values(o)) walk(v);
}
for (const f of fs.readdirSync(dir)) { if (!/^\d+\.json$/.test(f)) continue; const p = path.join(dir, f); const doc = JSON.parse(fs.readFileSync(p, 'utf8')); const before = JSON.stringify(doc); walk(doc); if (JSON.stringify(doc) !== before) fs.writeFileSync(p, JSON.stringify(doc, null, 1)); }
fs.writeFileSync(secretsFile, JSON.stringify(secrets, null, 1)); console.log('replaced', n, 'secrets:', Object.keys(secrets).join(' '));
