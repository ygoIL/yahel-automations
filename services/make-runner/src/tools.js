// Admin helpers: import Make data stores, connectivity checks.
const store = require('./store');
const scenarios = require('./scenarios');
async function importDataStore(id) {
  const H = { Authorization: 'Token ' + process.env.MAKE_API_TOKEN };
  const records = {}; let offset = 0;
  for (;;) {
    const r = await fetch(`https://eu2.make.com/api/v2/data-stores/${id}/data?pg%5Blimit%5D=1000&pg%5Boffset%5D=${offset}`, { headers: H }).then((x) => x.json());
    const recs = r.records || []; for (const x of recs) records[x.key] = x.data; if (recs.length < 1000) break; offset += 1000;
  }
  store.dsSave(id, { records, importedAt: new Date().toISOString() }); return Object.keys(records).length;
}
async function check() {
  const out = { google: {}, manychat: {}, tochat: null, gmail: null, microsoft: null, elevenlabs: !!process.env.ELEVENLABS_API_KEY };
  const g = require('./google');
  const ids = new Set();
  for (const sc of Object.values(scenarios.all())) { const s = JSON.stringify(sc.blueprint); for (const m of s.matchAll(/spreadsheets\/([A-Za-z0-9_-]{30,})/g)) ids.add(m[1]); for (const m of s.matchAll(/"spreadsheetId":"\/?([A-Za-z0-9_-]{30,})"/g)) ids.add(m[1]); }
  for (const id of ids) { try { const r = await g.sheets({ url: `spreadsheets/${id}?fields=properties.title`, method: 'GET' }); out.google[id] = 'ok: ' + r.body.properties.title; } catch (e) { out.google[id] = 'NO ACCESS: ' + String(e.message).slice(0, 120); } }
  for (const [k, v] of Object.entries(process.env)) if (/^MANYCHAT_(API_KEY|KEY_\d+)$/.test(k)) { try { const r = await fetch('https://api.manychat.com/fb/page/getInfo', { headers: { Authorization: 'Bearer ' + v } }).then((x) => x.json()); out.manychat[k] = r.data ? `${r.data.name} (page ${r.data.id})` : JSON.stringify(r).slice(0, 120); } catch (e) { out.manychat[k] = String(e.message); } }
  try { const t = await require('./modules/tochat').call({ url: `/tenants/${process.env.TOCHAT_TENANT || 'YahelCommunication'}/campaigns`, method: 'GET' }); out.tochat = 'ok ' + t.statusCode; } catch (e) { out.tochat = String(e.message).slice(0, 200); }
  if (process.env.GMAIL_USER) { try { await require('nodemailer').createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: process.env.GMAIL_USER, pass: (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '') } }).verify(); out.gmail = 'ok'; } catch (e) { out.gmail = String(e.message).slice(0, 200); } }
  if (process.env.MS_CLIENT_ID) { try { const r = await require('./modules/mail').graph('GET', '/me/mailFolders/inbox?$select=displayName,totalItemCount'); out.microsoft = 'ok ' + JSON.stringify(r.body).slice(0, 100); } catch (e) { out.microsoft = String(e.message).slice(0, 200); } }
  return out;
}
module.exports = { importDataStore, check };
