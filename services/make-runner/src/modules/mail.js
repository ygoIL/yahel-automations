// Gmail (SMTP/IMAP with an app password) and Outlook (Microsoft Graph, app registration).
const store = require('../store');
const iml = require('../iml');
const W = { write: true, dryResult: () => ({}) };

// ---------- Gmail ----------
let transport;
function smtp() {
  if (!transport) transport = require('nodemailer').createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: process.env.GMAIL_USER, pass: (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '') } });
  return transport;
}
const toList = (v) => [].concat(v || []).flatMap((x) => (typeof x === 'string' ? x.split(/[;,]/) : [x && (x.address || x.email)])).map((s) => String(s || '').trim()).filter(Boolean);
function bodyOf(mp) {
  if (mp.bodyType === 'rawHtml' || mp.html) return { html: mp.html || mp.content };
  const text = (mp.contents || []).map((c) => iml.toStr(c.text ?? c.value ?? c)).join('\n');
  return { text, html: text.split('\n').map((l) => l.replace(/&/g, '&amp;').replace(/</g, '&lt;')).join('<br>') };
}
async function imap(fn) {
  const { ImapFlow } = require('imapflow');
  const c = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: process.env.GMAIL_USER, pass: (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '') }, logger: false });
  await c.connect();
  try { const lock = await c.getMailboxLock('[Gmail]/All Mail'); try { return await fn(c); } finally { lock.release(); } } finally { await c.logout().catch(() => {}); }
}
const hex = (big) => BigInt(big).toString(16);
async function toBundle(c, msg) {
  const { simpleParser } = require('mailparser');
  const parsed = await simpleParser(msg.source);
  const addr = (a) => (a && a.value ? a.value.map((x) => ({ name: x.name, email: x.address })) : []);
  return {
    id: hex(msg.emailId), threadId: hex(msg.threadId), uid: msg.uid, labelIds: [...(msg.labels || [])],
    subject: parsed.subject || '', date: parsed.date ? parsed.date.toISOString() : undefined, internalDate: parsed.date ? parsed.date.getTime() : undefined,
    from: addr(parsed.from)[0] || {}, to: addr(parsed.to), cc: addr(parsed.cc),
    snippet: (parsed.text || '').replace(/\s+/g, ' ').slice(0, 200),
    fullTextBody: parsed.text || '', text: parsed.text || '', html: parsed.html || '', messageId: parsed.messageId,
    headers: Object.fromEntries([...parsed.headers].map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)])),
    attachments: (parsed.attachments || []).map((a) => ({ fileName: a.filename, data: a.content, contentType: a.contentType, size: a.size })),
  };
}
// ---------- Microsoft Graph ----------
let msTok = { t: '', exp: 0 };
async function msToken() {
  if (msTok.t && Date.now() < msTok.exp - 60000) return msTok.t;
  const r = await fetch(`https://login.microsoftonline.com/${process.env.MS_TENANT_ID}/oauth2/v2.0/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: process.env.MS_CLIENT_ID, client_secret: process.env.MS_CLIENT_SECRET, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }) }).then((x) => x.json());
  if (!r.access_token) throw new Error('Microsoft auth failed: ' + JSON.stringify(r).slice(0, 300));
  msTok = { t: r.access_token, exp: Date.now() + r.expires_in * 1000 }; return msTok.t;
}
const meToUser = (url) => String(url).replace(/\/me(\/|$)/, `/users/${encodeURIComponent(process.env.MS_MAILBOX || '')}$1`);
async function graph(method, url, { qs, headers, body } = {}) {
  let rel = meToUser(url);
  if (!/^https?:/.test(rel)) { rel = (rel.startsWith('/') ? '' : '/') + rel; if (!/^\/(v1\.0|beta)\//.test(rel)) rel = '/v1.0' + rel; rel = 'https://graph.microsoft.com' + rel; }
  const u = new URL(rel); for (const q of [].concat(qs || [])) if (q && (q.key ?? q.name)) u.searchParams.set(q.key ?? q.name, q.value);
  const h = { Authorization: 'Bearer ' + (await msToken()), 'Content-Type': 'application/json' };
  for (const x of headers || []) if (x.key ?? x.name) h[x.key ?? x.name] = x.value;
  const r = await fetch(u, { method, headers: h, body: body == null || body === '' ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  const txt = await r.text(); let data; try { data = JSON.parse(txt); } catch { data = txt; }
  if (r.status >= 400) throw new Error(`Graph ${r.status}: ${String(txt).slice(0, 400)}`);
  return { body: data, statusCode: r.status, headers: Object.fromEntries(r.headers) };
}
const recips = (v) => toList(v).map((address) => ({ emailAddress: { address } }));

module.exports = (reg) => {
  reg('google-email:sendAnEmail', { ...W, run: async (mp) => {
    const info = await smtp().sendMail({ from: process.env.GMAIL_FROM || process.env.GMAIL_USER, to: toList(mp.to), cc: toList(mp.cc), bcc: toList(mp.bcc), subject: mp.subject || '', ...bodyOf(mp),
      attachments: (mp.attachments || []).map((a) => ({ filename: a.fileName, content: a.data })) });
    return { id: info.messageId, messageId: info.messageId };
  } });
  reg('google-email:replyToAnEmail', { ...W, run: async (mp) => {
    const thr = BigInt('0x' + String(mp.threadId)).toString();
    const orig = await imap(async (c) => { const uids = await c.search({ threadId: thr }, { uid: true }); if (!uids.length) return null; const m = await c.fetchOne(String(uids[uids.length - 1]), { envelope: true, headers: ['references'] }, { uid: true }); return m; });
    if (!orig) throw new Error('Gmail thread not found: ' + mp.threadId);
    const subj = orig.envelope.subject || ''; const mid = orig.envelope.messageId;
    const to = mp.replyMode === 'custom' ? toList(mp.to) : toList((orig.envelope.from || []).map((a) => a.address));
    const refs = (orig.headers ? orig.headers.toString().replace(/^references:\s*/i, '').trim() + ' ' : '') + mid;
    const info = await smtp().sendMail({ from: process.env.GMAIL_FROM || process.env.GMAIL_USER, to, cc: toList(mp.cc), subject: /^re:/i.test(subj) ? subj : 'Re: ' + subj, inReplyTo: mid, references: refs.trim(), ...bodyOf(mp) });
    return { id: info.messageId, threadId: mp.threadId };
  } });
  reg('google-email:triggerWatchNewEmails', { multi: true, run: () => [], trigger: async (trig, p, { scenario }) => {
    // Watch: return messages matching the Gmail search that were not returned before.
    const stKey = `watch/gmail_${scenario.id}`; const st = store.load(stKey, { seen: [] });
    const out = await imap(async (c) => {
      const uids = await c.search({ gmailRaw: p.q || 'in:inbox' }, { uid: true });
      const fresh = uids.filter((u) => !st.seen.includes(u)).slice(-(Number(p.limit) || 20));
      const res = []; for (const u of fresh) { const msg = await c.fetchOne(String(u), { source: true, emailId: true, threadId: true, labels: true, uid: true }, { uid: true }); res.push(await toBundle(c, msg)); }
      if (p.markSeen) for (const u of fresh) await c.messageFlagsAdd(String(u), ['\\Seen'], { uid: true });
      return res;
    });
    if (!st.init) { st.init = true; } // first run behaves like Make "from now on"? Make default = all matching on first run.
    st.seen = [...new Set([...st.seen, ...out.map((b) => b.uid)])].slice(-5000); store.save(stKey, st);
    return out;
  } });

  reg('microsoft-email:makeApiCall', { write: true, readOnlyWhen: (mp) => /^get$/i.test(mp.method || 'GET'), dryResult: () => ({ body: {}, statusCode: 200 }), run: (mp) => graph(String(mp.method || 'GET').toUpperCase(), mp.url, mp) });
  reg('microsoft-email:listMessages', { multi: true, run: async (mp) => {
    const folder = mp.folder ? `/me/mailFolders/${encodeURIComponent(mp.folder)}/messages` : '/me/messages';
    const qs = [{ key: '$top', value: String(Number(mp.limit) || 10) }]; if (mp.search) qs.push({ key: '$search', value: `"${String(mp.search).replace(/"/g, '\\"')}"` }); if (mp.filter) qs.push({ key: '$filter', value: mp.filter });
    const r = await graph('GET', folder, { qs, headers: [{ key: 'ConsistencyLevel', value: 'eventual' }] });
    return (r.body.value || []);
  } });
  reg('microsoft-email:listAttachments', { multi: true, run: async (mp) => {
    const r = await graph('GET', `/me/messages/${encodeURIComponent(mp.message)}/attachments`, { qs: [{ key: '$top', value: String(Number(mp.limit) || 10) }] });
    return (r.body.value || []).map((a) => ({ ...a, data: a.contentBytes ? Buffer.from(a.contentBytes, 'base64') : undefined, fileName: a.name }));
  } });
  reg('microsoft-email:createAndSendAMessage', { ...W, run: async (mp) => {
    const message = { subject: mp.subject || '', body: { contentType: mp.contentType === 'text' ? 'Text' : 'HTML', content: mp.content || mp.body || '' },
      toRecipients: recips(mp.toRecipients || mp.to), ccRecipients: recips(mp.ccRecipients || mp.cc), bccRecipients: recips(mp.bccRecipients || mp.bcc),
      attachments: (mp.attachments || []).map((a) => ({ '@odata.type': '#microsoft.graph.fileAttachment', name: a.fileName || a.name, contentBytes: Buffer.from(a.data || '').toString('base64') })) };
    if (mp.importance) message.importance = mp.importance;
    await graph('POST', '/me/sendMail', { body: { message, saveToSentItems: true } });
    return {};
  } });
  reg('microsoft-email:watchMessages', { multi: true, run: () => [], trigger: async (trig, p, { scenario }) => {
    const stKey = `watch/ms_${scenario.id}`; const st = store.load(stKey, { seen: [] });
    const qs = [{ key: '$top', value: String(Math.max(Number(p.limit) || 5, 25)) }];
    if (p.search) qs.push({ key: '$search', value: `"${String(p.search).replace(/"/g, '\\"')}"` }); else qs.push({ key: '$orderby', value: 'receivedDateTime desc' });
    const path = p.folder ? `/me/mailFolders/${encodeURIComponent(p.folder)}/messages` : '/me/messages';
    const r = await graph('GET', path, { qs, headers: [{ key: 'ConsistencyLevel', value: 'eventual' }] });
    const msgs = (r.body.value || []).filter((x) => !st.seen.includes(x.id)).sort((a, b) => String(a.createdDateTime || a.receivedDateTime).localeCompare(String(b.createdDateTime || b.receivedDateTime))).slice(-(Number(p.limit) || 5));
    st.seen = [...new Set([...st.seen, ...(r.body.value || []).map((x) => x.id)])].slice(-5000); store.save(stKey, st);
    return st.init ? msgs : (st.init = true, store.save(stKey, st), msgs);
  } });
};
module.exports.graph = graph;
