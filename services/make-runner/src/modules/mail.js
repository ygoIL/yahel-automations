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

// ---------- Gmail modules sent through Outlook (GMAIL_VIA=outlook; Railway Hobby blocks SMTP) ----------
const viaOutlook = () => (process.env.GMAIL_VIA || 'outlook') === 'outlook';
async function outlookSend(mp) {
  const b = bodyOf(mp);
  const draft = await graph('POST', '/me/messages', { body: { subject: mp.subject || '', body: b.html ? { contentType: 'HTML', content: b.html } : { contentType: 'Text', content: b.text }, toRecipients: recips(mp.to), ccRecipients: recips(mp.cc), bccRecipients: recips(mp.bcc) } });
  await graph('POST', `/me/messages/${draft.body.id}/send`);
  return { id: draft.body.id, threadId: draft.body.conversationId, messageId: draft.body.internetMessageId };
}
async function outlookReply(mp) {
  const r = await graph('GET', '/me/messages', { qs: [{ key: '$filter', value: `conversationId eq '${String(mp.threadId).replace(/'/g, "''")}'` }, { key: '$select', value: 'id,receivedDateTime,subject' }, { key: '$top', value: '50' }] });
  const msgs = (r.body.value || []).sort((a, b) => String(b.receivedDateTime).localeCompare(String(a.receivedDateTime)));
  if (!msgs.length) throw new Error('Outlook conversation not found (request was probably sent from Gmail before the switch): ' + String(mp.threadId).slice(0, 40));
  const d = await graph('POST', `/me/messages/${msgs[0].id}/createReply`);
  const b = bodyOf(mp);
  const patch = { body: { contentType: 'HTML', content: (b.html || b.text) + '<br><br>' + ((d.body.body || {}).content || '') } };
  if (mp.replyMode === 'custom' && mp.to) patch.toRecipients = recips(mp.to);
  await graph('PATCH', `/me/messages/${d.body.id}`, { body: patch });
  await graph('POST', `/me/messages/${d.body.id}/send`);
  return { id: d.body.id, threadId: mp.threadId };
}
// Gmail search (subset) -> Outlook messages in the shape the scenarios read (subject, fullTextBody, from, ...)
async function outlookWatch(p, scenario) {
  const q = String(p.q || '');
  const froms = [...q.matchAll(/from:([^\s)]+)/g)].map((m) => m[1]);
  const days = Number((/newer_than:(\d+)d/.exec(q) || [])[1] || 3);
  const since = new Date(Date.now() - days * 864e5).toISOString().replace(/\.\d+Z$/, 'Z');
  let filter = `receivedDateTime ge ${since}`;
  if (froms.length) filter += ' and (' + froms.map((f) => `from/emailAddress/address eq '${f}'`).join(' or ') + ')';
  const r = await graph('GET', '/me/mailFolders/inbox/messages', { qs: [{ key: '$filter', value: filter }, { key: '$top', value: '50' }, { key: '$select', value: 'id,conversationId,subject,from,toRecipients,receivedDateTime,body,bodyPreview,internetMessageId' }], headers: [{ key: 'Prefer', value: 'outlook.body-content-type="text"' }] });
  const stKey = `watch/outlookgmail_${scenario.id}`; const st = store.load(stKey, { seen: [] });
  const fresh = (r.body.value || []).filter((m) => !st.seen.includes(m.id)).sort((a, b) => String(a.receivedDateTime).localeCompare(String(b.receivedDateTime))).slice(-(Number(p.limit) || 20));
  st.seen = [...new Set([...st.seen, ...(r.body.value || []).map((m) => m.id)])].slice(-5000); store.save(stKey, st);
  return fresh.map((m) => ({ id: m.id, threadId: m.conversationId, subject: m.subject || '', date: m.receivedDateTime, from: { email: (m.from && m.from.emailAddress || {}).address, name: (m.from && m.from.emailAddress || {}).name },
    to: (m.toRecipients || []).map((x) => ({ email: x.emailAddress.address, name: x.emailAddress.name })), snippet: m.bodyPreview, fullTextBody: (m.body || {}).content || '', text: (m.body || {}).content || '', html: '', messageId: m.internetMessageId, source: 'outlook' }));
}

module.exports = (reg) => {
  reg('google-email:sendAnEmail', { ...W, dryResult: () => ({ id: 'dry', threadId: 'dry-thread' }), run: async (mp) => {
    if (viaOutlook()) return outlookSend(mp);
    const info = await smtp().sendMail({ from: process.env.GMAIL_FROM || process.env.GMAIL_USER, to: toList(mp.to), cc: toList(mp.cc), bcc: toList(mp.bcc), subject: mp.subject || '', ...bodyOf(mp),
      attachments: (mp.attachments || []).map((a) => ({ filename: a.fileName, content: a.data })) });
    return { id: info.messageId, messageId: info.messageId };
  } });
  reg('google-email:replyToAnEmail', { ...W, run: async (mp) => {
    if (viaOutlook() && !/^[0-9a-f]{16}$/.test(String(mp.threadId))) return outlookReply(mp);
    if (viaOutlook()) throw new Error('Request ' + mp.threadId + ' was sent from Gmail before the switch to Outlook; reminder skipped.');
    const thr = BigInt('0x' + String(mp.threadId)).toString();
    const orig = await imap(async (c) => { const uids = await c.search({ threadId: thr }, { uid: true }); if (!uids.length) return null; const m = await c.fetchOne(String(uids[uids.length - 1]), { envelope: true, headers: ['references'] }, { uid: true }); return m; });
    if (!orig) throw new Error('Gmail thread not found: ' + mp.threadId);
    const subj = orig.envelope.subject || ''; const mid = orig.envelope.messageId;
    const to = mp.replyMode === 'custom' ? toList(mp.to) : toList((orig.envelope.from || []).map((a) => a.address));
    const refs = (orig.headers ? orig.headers.toString().replace(/^references:\s*/i, '').trim() + ' ' : '') + mid;
    const info = await smtp().sendMail({ from: process.env.GMAIL_FROM || process.env.GMAIL_USER, to, cc: toList(mp.cc), subject: /^re:/i.test(subj) ? subj : 'Re: ' + subj, inReplyTo: mid, references: refs.trim(), ...bodyOf(mp) });
    return { id: info.messageId, threadId: mp.threadId };
  } });
  reg('google-email:triggerWatchNewEmails', { multi: true, run: () => [], trigger: async (trig, p, ctx) => {
    if (!viaOutlook()) return gmailWatch(trig, p, ctx);
    // Outlook replies + Gmail replies to requests that were sent from Gmail before the switch
    const [o, g] = await Promise.all([outlookWatch(p, ctx.scenario), gmailWatch(trig, p, ctx).catch(() => [])]);
    return [...g, ...o];
  } });
  const gmailWatch = async (trig, p, { scenario }) => {
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
  };

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
