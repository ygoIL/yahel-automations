// yahel wa-gateway: WhatsApp hub on Railway.
// Replaces Make: 10115344 (incoming bot), 10171886 (sender), 10125129 (gate), 10125131 (Sunday queue),
// 10171903 (health/failover), 10125213 (reminder intake), 10125215 (reminder sender).
const http = require('http');
const crypto = require('crypto');
const classify = require('./classify_mod');
const { E, log, post, makeDsAdd, ilParts, ilStamp } = require('./lib');
const wa = require('./whatsapp');
const reminders = require('./reminders');
const BOT = E.REPS_BOT_URL || 'https://reps-bot-production.up.railway.app';
const BOT_KEY = E.REPS_BOT_KEY;
const GW_KEY = E.GATEWAY_KEY;
const MAKE_FALLBACK = E.MAKE_FALLBACK_HOOK || '';
const APPS_SCRIPT = 'https://script.google.com/macros/s/AKfycbwSDoIorFtwDt1kTgkW32oVEWgmWpfDfX-GdgPE6LE585lCZwbzwUsczAQ6loE1M03k/exec';
const DS_BOT_LOG = 207208, DS_GROUP_KNOWLEDGE = 206718;

const ACK_POS = /\?|^\s*(מה|איך|כמה|למה|מתי|האם|מי|איפה|למי|אפשר|יש|תבדוק|תבדקי|תגיד|תגידי|בדיקת עסקה|הלקוח|לקוח)(\s|$)/;
const ACK_NEG = /הקדמ|להקדים|ניתוק|חשמל|^\s*(עזרה|תפריט|עצור|עצרי|stop)|^\s*(תודה|אוקי|אוקיי|סבבה|מעולה|יופי|קיבלתי|תותח)|\d{1,2}\s*[./]\s*\d{1,2}/;
// Kinds whose logic still lives in Make (Sheets-heavy scenarios); forwarded to the old Make bot hook.
const MAKE_KINDS = (E.MAKE_KINDS || 'shikuf,disc,port,cancel,save,shikdone,advance').split(',');

// RULE (Steve 18/11/2026): in the group מנהלים yes only messages of יורן טוויטו (יורן יס) count.
// Each one (text, image or file) is forwarded as-is to "הנהלה מצומצם"; text also goes through the group AI filter into the bot's
// knowledge (DS 206718). Senders = YES_FWD_SENDERS (comma-separated phones), default יורן 050-8680888. Do not remove.
const YES_GROUP = /מנהלים\s*yes/i;
const YES_SENDERS = String(E.YES_FWD_SENDERS || '0508680888').split(',').map((x) => x.replace(/\D/g, '').slice(-9)).filter((x) => x.length === 9);
const MGMT_GROUP = E.MGMT_GROUP || '120363430128240440@g.us'; // הנהלה מצומצם
async function handleYesGroup(p) {
  const md = p.messageData || {}, sd = p.senderData || {};
  if (!YES_SENDERS.includes(String(sd.sender || '').replace(/\D/g, '').slice(-9))) return;
  const text = String((md.textMessageData && md.textMessageData.textMessage) || (md.extendedTextMessageData && md.extendedTextMessageData.text)
    || (md.fileMessageData && md.fileMessageData.caption) || '').trim();
  log({ ev: 'yes_group', chat: sd.chatName, type: md.typeMessage });
  const head = `📢 ${sd.senderName || ''} בקבוצת ${sd.chatName}:`;
  await wa.send(MGMT_GROUP, head);
  if (!(await wa.forward(MGMT_GROUP, sd.chatId, p.idMessage)) && text) await wa.send(MGMT_GROUP, text);
  if (text.length >= 12) {
    const g = await post(`${BOT}/group?key=${BOT_KEY}`, JSON.stringify({ chatId: sd.chatId, sender: sd.sender, senderName: sd.senderName || '', text }), 60000);
    if (String((g.data && g.data.result) || '').includes('כן')) makeDsAdd(DS_GROUP_KNOWLEDGE, p.idMessage, { ts: p.timestamp, chat: sd.chatName, text, sender: sd.senderName });
  }
}

async function handleIncoming(p, depth = 0) {
  const md = p.messageData || {}, sd = p.senderData || {}, qm = md.quotedMessage || {};
  if (p.typeWebhook === 'incomingMessageReceived' && String(sd.chatId || '').endsWith('@g.us') && YES_GROUP.test(String(sd.chatName || ''))) return handleYesGroup(p);
  const r = classify({
    type: p.typeWebhook, chatId: sd.chatId, sender: sd.sender, senderName: sd.senderName, chatName: sd.chatName,
    t1: md.textMessageData && md.textMessageData.textMessage, t2: md.extendedTextMessageData && md.extendedTextMessageData.text,
    id: p.idMessage, ts: p.timestamp, tm: md.typeMessage, forceKind: p.forceKind,
    q: (qm.textMessage || '') + ((qm.extendedTextMessage && qm.extendedTextMessage.text) || ''),
  });
  if (r.kind === 'ignore') return;
  log({ ev: 'in', kind: r.kind, chat: r.chatId });

  if (r.kind === 'private') {
    if ((ACK_POS.test(r.text) || r.len >= 25) && !ACK_NEG.test(r.text)) wa.send(r.chatId, '👀 קיבלתי, בודק...');
    const a = await post(`${BOT}/ask?key=${BOT_KEY}`, r.fwd, 120000);
    const d = a.data || {};
    if (d.mode === 'reroute') {
      if (depth > 0) return;
      let rp = d.reroutePayload; try { if (typeof rp === 'string') rp = JSON.parse(rp); } catch { return; }
      return handleIncoming(rp, depth + 1);
    }
    log({ ev: 'ask_result', chat: r.chatId, id: r.id, status: a.status, mode: d.mode || null, replyLen: d.reply ? String(d.reply).length : 0, q: String(r.text).slice(0, 60) });
    if (d.reply) { const s = await wa.send(r.chatId, d.reply); if (!s) log({ ev: 'reply_not_sent', chat: r.chatId, id: r.id }); }
    if (d.mode !== 'deny') makeDsAdd(DS_BOT_LOG, r.id, { a: d.reply || '', q: r.text, ts: ilStamp(), rep: d.rep || '', phone: r.sender, topic: d.topic || '' });
    if (d.advSubmit) { try { await post(E.ADV_HOOK || 'https://make-runner-production.up.railway.app/hook/x9p7y4lwz3mbnapzd6e2djc5qrwqjqq1', d.advSubmit); } catch (e) { log({ ev: 'adv_fwd_err', err: String(e) }); } }
    return;
  }
  if (r.kind === 'group') {
    if (r.mgr === 'yes' && r.len >= 12) {
      const g = await post(`${BOT}/group?key=${BOT_KEY}`, r.fwd, 60000);
      if (String((g.data && g.data.result) || '').includes('כן')) makeDsAdd(DS_GROUP_KNOWLEDGE, r.id, { ts: r.ts, chat: r.chatName, text: r.text, sender: r.senderName });
    }
    return;
  }
  if (r.kind === 'reminder') return reminders.intake({ chatId: r.chatId, sender: r.sender, text: r.text });
  if (r.kind === 'customer') { await wa.send('972525102820@c.us', r.cmsg); return; }
  if (r.kind === 'bezeq') {
    const tok = crypto.createHash('sha256').update(r.tokenSrc).digest('hex').slice(0, 20);
    await wa.send(r.chatId, `📡 *תיאום בזק*\nהטופס האישי שלך:\n${APPS_SCRIPT}?b=${tok}\n\nממלאים את פרטי הלקוח ושולחים. הפרטים עוברים ישר לבזק, לא דרך הוואטסאפ. עדכונים מבזק יגיעו אליך לכאן.`);
    return;
  }
  if (r.kind === 'bezeqreply') {
    let msg = '', note = '';
    try { const b = await post(APPS_SCRIPT, r.bzbody); msg = b.data && b.data.msg; } catch (e) { log({ ev: 'bz_err', err: String(e) }); }
    if (r.bzStatus) note = await bezeqStatus(r.bzCode, r.bzStatus);
    await wa.send(r.chatId, (msg || (r.bzStatus ? 'קיבלתי.' : 'לא הצלחתי לרשום את התגובה, תנסו שוב.')) + (note ? '\n' + note : ''));
    return;
  }
  if (MAKE_KINDS.includes(r.kind) && MAKE_FALLBACK) {
    try { await post(MAKE_FALLBACK, { ...p, forceKind: r.kind }); } catch (e) { log({ ev: 'make_fwd_err', err: String(e) }); }
  }
}

// Former Make route 401-403: write the Bezeq status to column L of 'תיאום חדש 26'.
async function bezeqStatus(code, status) {
  const { sheets } = require('./lib');
  const SH = '1UVYFtT7nJMByfM3yjXN51ZXXIOKTDgVqIf5fy6ODlhU';
  const p9 = (s) => String(s == null ? '' : s).replace(/\D/g, '').slice(-9);
  try {
    const r = await sheets('GET', `spreadsheets/${SH}/values/'תיאום חדש 26'!E2:E1001`);
    let row = 0; (r.body.values || []).forEach((v, i) => { if (p9(code) && p9(v && v[0]) === p9(code)) row = i + 2; });
    if (!row) return '⚠️ לא מצאתי את הלקוח בגיליון בזק, אז הסטטוס לא עודכן. תגיד/י לקורל.';
    await sheets('PUT', `spreadsheets/${SH}/values/'תיאום חדש 26'!L${row}`, { values: [[status]] }, { valueInputOption: 'USER_ENTERED' });
    return '📌 סטטוס עודכן ל: ' + status;
  } catch (e) { log({ ev: 'bz_status_err', err: String(e) }); return ''; }
}

let inflight = 0, closing = false;
const track = (p) => { inflight++; return p.finally(() => { inflight--; }); };
process.on('SIGTERM', () => {
  closing = true; log({ ev: 'sigterm', inflight });
  const t0 = Date.now(); const iv = setInterval(() => { if (inflight === 0 || Date.now() - t0 > 110000) { log({ ev: 'exit', inflight }); process.exit(0); } }, 500);
});
const readBody = (req) => new Promise((res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => res(b)); });

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const ok = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (u.pathname === '/health') return ok(200, { ok: true, wa: (({ active, last_state, last_check }) => ({ active, last_state, last_check }))(wa.state()) });
  if (!GW_KEY || u.searchParams.get('key') !== GW_KEY) return ok(401, { error: 'unauthorized' });
  let body = {}; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return ok(400, { error: 'bad json' }); }
  try {
    if (u.pathname === '/greenapi' && req.method === 'POST') {
      ok(200, { ok: true });
      track(handleIncoming(body)).catch((e) => log({ ev: 'handle_err', err: String((e && e.stack) || e) }));
      return;
    }
    if (u.pathname === '/send' && req.method === 'POST') { // former Make central sender hook
      if (!(body.chatId || body.phone) || !body.message) return ok(400, { error: 'chatId and message required' });
      const r = await wa.send(wa.normChat(body.chatId, body.phone), body.message);
      return r ? ok(200, r) : ok(502, { error: 'send failed' });
    }
    if (u.pathname === '/gate' && req.method === 'POST') { // former Make Shabbat gate hook
      const r = await wa.gate(body); return ok(r.ok ? 200 : 400, r);
    }
    ok(404, { error: 'not found' });
  } catch (e) { log({ ev: 'route_err', path: u.pathname, err: String(e) }); ok(500, { error: 'internal' }); }
}).listen(E.PORT || 8080, () => log({ ev: 'listening', port: E.PORT || 8080 }));

// ---- schedulers ----
let lastSunday = '';
setInterval(() => wa.healthCheck().catch((e) => log({ ev: 'health_err', err: String(e) })), 5 * 60 * 1000);
setInterval(() => reminders.sendDue().catch((e) => log({ ev: 'rem_err', err: String(e) })), 60 * 1000);
setInterval(() => {
  const p = ilParts(); const tag = `${p.y}-${p.mo}-${p.d}`;
  if (p.wd === 'Sun' && p.h * 60 + p.mi >= 510 && lastSunday !== tag) { lastSunday = tag; wa.flushSundayQueue().catch((e) => log({ ev: 'flush_err', err: String(e) })); }
}, 60 * 1000);
setTimeout(() => wa.healthCheck().catch(() => {}), 15000);

// One-time bootstrap: import pending reminders / Sunday queue from the old Make data stores.
(async () => {
  const { load, save, get } = require('./lib');
  if (!E.MAKE_API_TOKEN) return;
  const H = { Authorization: 'Token ' + E.MAKE_API_TOKEN };
  try {
    if (load('reminders', null) === null) {
      const r = await get('https://eu2.make.com/api/v2/data-stores/207368/data?pg[limit]=1000', 30000, H);
      const rs = (r.data.records || []).map((x) => x.data).filter((x) => x && x.status === 'ממתין');
      save('reminders', rs); log({ ev: 'import_reminders', count: rs.length });
    }
    if (load('sunday_queue', null) === null) {
      const r = await get('https://eu2.make.com/api/v2/data-stores/207359/data?pg[limit]=1000', 30000, H);
      const q = (r.data.records || []).map((x) => ({ key: x.key, ...x.data })).filter((x) => x.chatId);
      save('sunday_queue', q); log({ ev: 'import_sunday_queue', count: q.length });
    }
  } catch (e) { log({ ev: 'import_err', err: String(e) }); }
})();
