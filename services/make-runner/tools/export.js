// Export Make scenarios into scenarios/<id>.json, replacing secrets with __ENV:NAME__ placeholders.
// Usage: node tools/export.js <secrets-out.json> <id> [id...]
// Needs network access to eu2.make.com with a Make API token (MAKE_API_TOKEN or a proxy that injects it).
const fs = require('fs'), path = require('path');
const [outSecrets, ...ids] = process.argv.slice(2);
const H = { Authorization: 'Token ' + (process.env.MAKE_API_TOKEN || 'dummy') };
const api = async (p) => { for (let i = 0; i < 30; i++) { const r = await fetch('https://eu2.make.com/api/v2' + p, { headers: H }); const t = await r.text(); if (!/Requests limit/.test(t)) return JSON.parse(t); await new Promise((x) => setTimeout(x, 10000)); } throw new Error('rate limited'); };
const secrets = fs.existsSync(outSecrets) ? JSON.parse(fs.readFileSync(outSecrets, 'utf8')) : {};
const byValue = Object.fromEntries(Object.entries(secrets).map(([k, v]) => [v, k]));
function name(base, value) {
  if (byValue[value]) return byValue[value];
  let n = base.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, ''); let i = 2; const b = n;
  while (secrets[n] && secrets[n] !== value) n = `${b}_${i++}`;
  secrets[n] = value; byValue[value] = n; return n;
}
const ph = (n) => `__ENV:${n}__`;
function scrub(text) {
  // Green API instance tokens
  text = text.replace(/(waInstance(\d+)\/[A-Za-z]+\/)([0-9a-f]{40,})/g, (_, pre, inst, tok) => pre + ph(name('GREEN_TOKEN_' + inst, tok)));
  // key/secret/token query params
  text = text.replace(/([?&](?:key|secret|token|apikey|api_key|access_token)=)([A-Za-z0-9_\-]{12,})/gi, (all, pre, v, off, s) => {
    let host = (/https?:\/\/([a-z0-9.-]+)[^"]*$/i.exec(s.slice(Math.max(0, off - 300), off)) || [, 'URL'])[1].split('.')[0];
    host = ({ 'wa-gateway-production-3ddb70bf': 'GATEWAY', 'reps-bot-production': 'REPS_BOT', 'tochat-bridge-production': 'TOCHAT_BRIDGE' })[host] || host;
    return pre + ph(name(host + '_KEY', v));
  });
  // secret-looking JSON string fields (also inside escaped JSON strings)
  text = text.replace(/(\\*"(?:secret|apiKey|api_key|token|password|authorization|x-api-key|ADMIN_SECRET|HOOK_SECRET)\\*"\s*:\s*\\*")([^"\\]{8,})(\\*")/gi, (all, pre, v, post) => (v.includes('{{') || v.startsWith('__ENV:') ? all : pre + ph(name('SECRET_' + pre.replace(/[^A-Za-z]/g, ''), v)) + post));
  // Bearer tokens in header values
  text = text.replace(/(Bearer )([A-Za-z0-9._\-]{20,})/g, (all, pre, v) => (v.startsWith('__ENV') ? all : pre + ph(name('BEARER', v))));
  // Railway wa-gateway key
  return text;
}
(async () => {
  const dir = path.join(__dirname, '..', 'scenarios');
  for (const id of ids) {
   try {
    const s = (await api(`/scenarios/${id}`)).scenario; const bpr = await api(`/scenarios/${id}/blueprint`);
    if (!s || !bpr.response) { console.log('SKIP', id, JSON.stringify(bpr).slice(0, 150)); continue; }
    const bp = bpr.response.blueprint;
    let hookUdid = null; if (s.hookId) { const h = (await api(`/hooks/${s.hookId}`)).hook; hookUdid = h && h.udid; }
    const doc = { id: s.id, name: s.name, scheduling: s.scheduling, hookId: s.hookId || null, hookUdid, exportedAt: new Date().toISOString(), blueprint: bp };
    const text = scrub(JSON.stringify(doc, null, 1));
    fs.writeFileSync(path.join(dir, `${id}.json`), text);
    console.log(id, s.name, s.scheduling && s.scheduling.type, hookUdid ? 'hook' : '');
    fs.writeFileSync(outSecrets, JSON.stringify(secrets, null, 1));
    await new Promise((x) => setTimeout(x, 2500));
   } catch (e) { console.log('ERR', id, String(e.message)); }
  }
  fs.writeFileSync(outSecrets, JSON.stringify(secrets, null, 1));
  console.log('secrets:', Object.keys(secrets).join(' '));
})();
