// Central sender + Shabbat gate + Sunday queue + health monitor/failover.
// Replaces Make scenarios 10171886, 10125129, 10125131, 10171903.
const { E, log, post, get, load, save, ilParts, ilStamp } = require('./lib');

const acct = (n) => (n === 'backup' ? { name: 'backup', base: E.GREEN_B_BASE, token: E.GREEN_B_TOKEN } : { name: 'primary', base: E.GREEN_P_BASE, token: E.GREEN_P_TOKEN });
const hasBackup = () => !!(E.GREEN_B_BASE && E.GREEN_B_TOKEN);
const state = () => load('wa_state', { active: E.GREEN_ACTIVE === 'backup' ? 'backup' : 'primary', fails: 0, oks: 0, last_q: 0, down_alerted: false, b_alerted: false, switched_at: '' });

function normChat(chatId, phone) {
  chatId = String(chatId || '').trim();
  const ph = String(phone || '').replace(/\D/g, '');
  if (!chatId && ph) { let p = ph; if (p.startsWith('0')) p = '972' + p.slice(1); chatId = p + '@c.us'; }
  if (chatId.endsWith('@c.us')) { let d = chatId.replace(/@c\.us$/, '').replace(/\D/g, ''); if (d.startsWith('0')) d = '972' + d.slice(1); else if (d.length === 9 && d.startsWith('5')) d = '972' + d; chatId = d + '@c.us'; }
  return chatId;
}

async function sendVia(a, chatId, message) {
  try {
    const r = await post(`${a.base}/sendMessage/${a.token}`, { chatId, message });
    if (r.data && r.data.idMessage) return r.data.idMessage;
    log({ ev: 'send_fail', via: a.name, status: r.status });
  } catch (e) { log({ ev: 'send_err', via: a.name, err: String(e) }); }
  return null;
}

// Plain send (former Make "שולח מרכזי"): active account first, other one as fallback.
async function send(chatId, message) {
  chatId = normChat(chatId);
  const first = state().active === 'backup' && hasBackup() ? 'backup' : 'primary';
  const order = [first]; if (hasBackup()) order.push(first === 'primary' ? 'backup' : 'primary');
  for (const n of order) { const id = await sendVia(acct(n), chatId, message); if (id) { log({ ev: 'sent', via: n, chatId }); return { idMessage: id, via: n }; } }
  return null;
}

// Gate (former Make 10125129): reps don't get messages Fri 16:00+ / Sat; they are queued to Sunday 08:30. Managers always get them.
const MGR = ['544604246', '504445169', '525102820', '525192071', '584896222', '542607144'];
async function gate({ chatId, phone, message, source }) {
  chatId = normChat(chatId, phone);
  let msg = String(message == null ? '' : message);
  // RULE (Steve 15/11/2026): every 'עדכון מבזק' alert to a rep ends with the numbered status menu for a quoted reply. Do not remove.
  if (/עדכון מבזק/.test(msg) && !/1 ממתין לתיאום/.test(msg)) msg += '\n\n↩️ לעדכון: לחצו "השב" על ההודעה הזו וכתבו מספר + תיאור:\n1 ממתין לתיאום (הלקוח זמין)\n2 המשך טיפול\n3 אין מענה\n4 בוטל\nלמשל: 1 זמינה מחר אחרי 16:00';
  if (!chatId || !msg.trim()) return { ok: false, error: 'chatId/phone and message required' };
  const isMgr = chatId.endsWith('@c.us') && MGR.includes(chatId.replace(/\D/g, '').slice(-9));
  const p = ilParts(); const hm = p.h * 60 + p.mi;
  const blocked = !isMgr && (p.wd === 'Sat' || (p.wd === 'Fri' && hm >= 960));
  if (blocked) {
    const q = load('sunday_queue', []); q.push({ key: Date.now() + '-' + Math.random().toString(36).slice(2, 8), ts: ilStamp(), chatId, message: msg, source: String(source || '') }); save('sunday_queue', q);
    log({ ev: 'queued_sunday', chatId, source }); return { ok: true, queued: true };
  }
  const r = await send(chatId, msg); return r ? { ok: true, ...r } : { ok: false, error: 'send failed' };
}

async function flushSundayQueue() {
  const q = load('sunday_queue', []); if (!q.length) return;
  log({ ev: 'sunday_flush', count: q.length });
  q.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  while (q.length) { const m = q[0]; await send(m.chatId, m.message); q.shift(); save('sunday_queue', q); await new Promise((r) => setTimeout(r, 4000)); }
}

// Health monitor (former Make 10171903), every 5 min. Primary unhealthy = not authorized, or 3+ queued and not shrinking.
// 2 bad checks in a row -> switch to backup (if backup authorized), resend stuck queue, move incoming webhook. Back after 2 good checks.
async function alert(text) {
  log({ ev: 'alert', text });
  const to = E.ALERT_WHATSAPP || '972504445169@c.us';
  try { await send(to, text); } catch {}
}
async function healthCheck() {
  const st = state(); const P = acct('primary'), B = acct('backup');
  const pState = await get(`${P.base}/getStateInstance/${P.token}`).then((r) => r.data.stateInstance || 'error').catch(() => 'error');
  let q = await get(`${P.base}/showMessagesQueue/${P.token}`).then((r) => r.data).catch(() => []); if (!Array.isArray(q)) q = [];
  const bState = hasBackup() ? await get(`${B.base}/getStateInstance/${B.token}`).then((r) => r.data.stateInstance || 'error').catch(() => 'error') : 'none';
  const qLen = q.length, stuck = qLen >= 3 && qLen >= (st.last_q || 0), healthy = pState === 'authorized' && !stuck;
  st.fails = healthy ? 0 : (st.fails || 0) + 1; st.oks = healthy ? (st.oks || 0) + 1 : 0; st.last_q = qLen;
  const why = `מצב החשבון הראשי: ${pState} | הודעות תקועות בתור: ${qLen}`;
  const inHook = E.SET_WEBHOOK_URL_PERSIST || E.IN_WEBHOOK;
  if (st.active === 'primary' && st.fails >= 2) {
    if (hasBackup() && bState === 'authorized') {
      st.active = 'backup'; st.switched_at = new Date().toISOString(); st.down_alerted = true; save('wa_state', st);
      if (inHook) await post(`${B.base}/setSettings/${B.token}`, { incomingWebhook: 'yes', webhookUrl: inHook }).catch(() => {});
      await post(`${P.base}/setSettings/${P.token}`, { incomingWebhook: 'no' }).catch(() => {});
      for (const m of q) { const chatId = m.chatId || m.chatID; const message = m.message || (m.messageData && m.messageData.textMessage); if (chatId && message) await sendVia(B, chatId, message); }
      await get(`${P.base}/clearMessagesQueue/${P.token}`).catch(() => {});
      await alert(`⚠️ וואטסאפ: עברנו לחשבון הגיבוי\n${why}`);
    } else if (!st.down_alerted) { st.down_alerted = true; await alert(`🔴 וואטסאפ למטה ואין חשבון גיבוי פעיל\n${why}`); }
  } else if (st.active === 'backup' && st.oks >= 2) {
    st.active = 'primary'; st.down_alerted = false; save('wa_state', st);
    if (inHook) await post(`${P.base}/setSettings/${P.token}`, { incomingWebhook: 'yes', webhookUrl: inHook }).catch(() => {});
    if (hasBackup()) await post(`${B.base}/setSettings/${B.token}`, { incomingWebhook: 'no' }).catch(() => {});
    await alert('✅ וואטסאפ: חזרנו לחשבון הראשי');
  } else if (healthy && st.active === 'primary') st.down_alerted = false;
  st.last_check = new Date().toISOString(); st.last_state = `${pState} q=${qLen} b=${bState}`;
  let hook = '';
  try { const cfg = await get(`${(st.active==='backup'&&hasBackup()?B:P).base}/getSettings/${(st.active==='backup'&&hasBackup()?B:P).token}`).then((r) => r.data); hook = String(cfg.webhookUrl||'').replace(/key=\w+/, 'key=***') + ' incoming=' + cfg.incomingWebhook; } catch {}
  log({ ev: 'health', state: st.last_state, active: st.active, fails: st.fails, hook });
  save('wa_state', st);
}

module.exports = { send, gate, normChat, flushSundayQueue, healthCheck, state };
