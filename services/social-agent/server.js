// yahel social-agent: WhatsApp → edited reel/story with Hebrew on-screen text → Yarden approves → Instagram (yahel.tik).
// RULES (Steve 26/11/2026) – do not remove:
//  * The page's goal is recruitment. Every video gets on-screen text, always.
//  * Nothing is published without Yarden's explicit "כן"; nothing is ever published twice.
//  * Material arrives on the existing bot line: Yarden/Steve send photos/videos with the word "סושיאל".
//  * Daily content (Sun–Thu): morning trend idea to Yarden; if nothing went up by the afternoon, a recruitment story for approval.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { E, log, load, save, MEDIA, download, ilParts, ilDay, p9 } = require('./lib');
const render = require('./render');
const ai = require('./ai');
const ig = require('./ig');
const wa = require('./wa');

const KEY = E.SOCIAL_KEY;
const PUBLIC = (E.PUBLIC_URL || '').replace(/\/$/, '');
const APPROVER = p9(E.APPROVER || '504445169');                       // Yarden
const SENDERS = String(E.SOCIAL_SENDERS || '504445169,544604246').split(',').map(p9).filter(Boolean); // Yarden, Steve
const QUIET_MS = +(E.BATCH_QUIET_SEC || 180) * 1000;
const MARK = '🎬 סושיאל #';
process.on('unhandledRejection', (e) => log({ ev: 'unhandled', err: String((e && e.stack) || e) }));

const S = () => load('state', { batches: {}, drafts: {}, days: {} });
const put = (s) => save('state', s);
const rid = (n = 6) => crypto.randomBytes(n).toString('hex');
const YES = /^\s*(כן|מאושר|מאשר|פרסם|תפרסם|אשר|יאללה|סגור|👍)/;
const NO = /^\s*(לא|בטל|תבטל|❌|👎)\s*[.!]*\s*$/;

function textOf(md) {
  return String((md.textMessageData && md.textMessageData.textMessage) || (md.extendedTextMessageData && md.extendedTextMessageData.text)
    || (md.fileMessageData && md.fileMessageData.caption) || '').trim();
}
function quotedOf(md) {
  const q = md.quotedMessage || {};
  return String(q.textMessage || q.caption || (q.extendedTextMessage && q.extendedTextMessage.text) || (q.fileMessage && q.fileMessage.caption) || '');
}

// Called synchronously by wa-gateway for every private message of SENDERS. Must answer fast: true = ours.
function claim(p) {
  if (p.typeWebhook !== 'incomingMessageReceived') return false;
  const md = p.messageData || {}, sd = p.senderData || {};
  if (!String(sd.chatId || '').endsWith('@c.us')) return false;
  const who = p9(sd.sender || sd.chatId); if (!SENDERS.includes(who)) return false;
  const tm = md.typeMessage, text = textOf(md), quoted = quotedOf(md);
  const s = S();
  const qid = (quoted.match(/סושיאל #(\w+)/) || [])[1];
  if (qid) { setImmediate(() => reply(qid, text, who).catch((e) => log({ ev: 'reply_err', err: String(e.stack || e) }))); return true; }
  const isMedia = tm === 'imageMessage' || tm === 'videoMessage';
  const b = s.batches[who];
  const open = b && Date.now() - b.last < 20 * 60 * 1000;
  if (isMedia && (/סושיאל/.test(text) || open)) {
    const fd = md.fileMessageData || {};
    const batch = open ? b : { id: rid(4), items: [], note: '', last: 0, acked: false, from: who };
    batch.items.push({ url: fd.downloadUrl, type: tm, name: fd.fileName || '' });
    const note = text.replace(/סושיאל/g, '').trim(); if (note) batch.note = (batch.note + ' ' + note).trim();
    batch.last = Date.now(); s.batches[who] = batch; put(s);
    if (!batch.acked) { batch.acked = true; put(s); wa.text(sd.chatId, '📸 קיבלתי לסושיאל. אפשר לשלוח עוד תמונות וסרטונים ומשפט על מה קרה.\nעוד 3 דקות בלי חומרים חדשים אני מכין טיוטה (או כתוב "סושיאל סיום").'); }
    log({ ev: 'item', batch: batch.id, n: batch.items.length });
    return true;
  }
  if (/^\s*סושיאל/.test(text)) {
    const rest = text.replace(/^\s*סושיאל/, '').trim();
    if (/^(סיום|זהו|תכין|מוכן|יאללה)/.test(rest)) { if (open) { b.last = 0; put(s); } else wa.text(sd.chatId, 'אין חומרים פתוחים לסושיאל. שלח תמונה או סרטון עם המילה סושיאל.'); return true; }
    if (/^(רעיון|טרנד)/.test(rest)) { setImmediate(() => sendIdea(true)); return true; }
    if (/^(סטורי)/.test(rest)) { setImmediate(() => fallbackStory(true)); return true; }
    if (open) { b.note = (b.note + ' ' + rest).trim(); b.last = Date.now(); put(s); }
    else { s.batches[who] = { id: rid(4), items: [], note: rest, last: Date.now(), acked: true, from: who }; put(s); wa.text(sd.chatId, 'קיבלתי. עכשיו שלח את התמונות והסרטונים.'); }
    return true;
  }
  // Bare כן / לא from Yarden right after a preview (only when exactly one draft waits, sent in the last 3 hours).
  if (who === APPROVER && (YES.test(text) || NO.test(text)) && text.length <= 12) {
    const waiting = Object.values(s.drafts).filter((d) => d.status === 'awaiting' && Date.now() - d.sentAt < 3 * 3600 * 1000);
    if (waiting.length === 1) { setImmediate(() => reply(waiting[0].id, text, who).catch((e) => log({ ev: 'reply_err', err: String(e.stack || e) }))); return true; }
  }
  return false;
}

// ---- build a draft from a finished batch ----
async function buildFromBatch(batch) {
  const dir = path.join(MEDIA, 'w-' + batch.id); fs.mkdirSync(dir, { recursive: true });
  const items = [];
  for (let i = 0; i < batch.items.length; i++) {
    const it = batch.items[i]; if (!it.url) continue;
    const ext = it.type === 'videoMessage' ? (path.extname(it.name) || '.mp4') : (path.extname(it.name) || '.jpg');
    try { items.push({ file: await download(it.url, path.join(dir, `in${i}${ext}`)) }); } catch (e) { log({ ev: 'dl_err', err: String(e) }); }
  }
  if (!items.length) throw new Error('לא הצלחתי להוריד את הקבצים');
  let base = await render.assemble(items, path.join(dir, 'base.mp4'));
  const fr = await render.frames(base.segments, dir);
  const d = await ai.draft({ note: batch.note, framesList: fr });
  let excluded = [];
  if (d.exclude.length) {
    const keep = items.filter((_, i) => !d.exclude.includes(i));
    excluded = d.exclude;
    if (keep.length) base = await render.assemble(keep, path.join(dir, 'base2.mp4'));
    else throw new Error('בכל החומרים רואים מסכים או פרטי לקוחות, לא הכנתי טיוטה');
  }
  return { dir, base, ai: d, excluded };
}

async function renderDraft(dft, base, overlays) {
  const out = path.join(MEDIA, `${dft.id}-v${dft.version}-${dft.token}.mp4`);
  await render.overlay(base.file, render.timeline(overlays, base.duration), out, dft.dir);
  dft.file = out; dft.url = `${PUBLIC}/m/${path.basename(out)}`;
}

function previewCaption(d) {
  const lines = [`${MARK}${d.id}${d.kind === 'story' ? ' (סטורי)' : ''}`, '', d.caption || ''];
  if (d.song) lines.push('', `🎵 שיר שמתאים: ${d.song}\n(אם רוצים את השיר – מעלים מהטלפון, בפרסום אוטומטי אי אפשר להוסיף שיר)`);
  if (d.warning) lines.push('', '⚠️ ' + d.warning);
  if (d.excluded && d.excluded.length) lines.push('', `הוצאתי ${d.excluded.length} פריטים שרואים בהם מסך או פרטי לקוחות.`);
  lines.push('', 'לפרסם? ענה על ההודעה הזו:', d.kind === 'story' ? 'כן – עולה לסטורי' : 'כן – עולה לרילס + סטורי', 'לא – מבטל', 'כל דבר אחר – אתקן לפי מה שכתבת');
  return lines.join('\n');
}
async function sendPreview(d) {
  await wa.file(APPROVER, d.url, `social-${d.id}.mp4`, previewCaption(d));
  d.sentAt = Date.now(); d.reminded = false;
}

async function finalize(who) {
  const s = S(); const batch = s.batches[who]; if (!batch) return;
  delete s.batches[who]; put(s);
  if (!batch.items.length) return;
  try {
    const b = await buildFromBatch(batch);
    const d = { id: batch.id, kind: 'reel', version: 1, token: rid(8), status: 'awaiting', from: who, note: batch.note, dir: b.dir,
      base: b.base, caption: b.ai.caption, overlays: b.ai.overlays, song: b.ai.song || '', warning: b.ai.warning || '', excluded: b.excluded, created: Date.now(), day: ilDay() };
    await renderDraft(d, b.base, d.overlays);
    await sendPreview(d);
    const s2 = S(); s2.drafts[d.id] = d; put(s2);
    if (who !== APPROVER) wa.text(who, `✅ הטיוטה מוכנה ונשלחה לירדן לאישור (#${d.id}).`);
    log({ ev: 'draft', id: d.id, dur: b.base.duration });
  } catch (e) {
    log({ ev: 'build_err', err: String(e.stack || e) });
    wa.text(who, '⚠️ לא הצלחתי להכין טיוטה מהחומרים: ' + String(e.message || e).slice(0, 200));
  }
}

// ---- Yarden's answer on a preview ----
async function reply(id, text, who) {
  const s = S(); const d = s.drafts[id];
  if (!d) return wa.text(who, 'לא מצאתי את הטיוטה הזו.');
  if (who !== APPROVER) return wa.text(who, 'רק ירדן מאשר פרסומים 🙂');
  if (d.status === 'published') return wa.text(who, `זה כבר עלה ✅ ${d.link || ''}`);
  if (d.status === 'publishing') return wa.text(who, 'זה בדיוק עולה, עוד רגע אשלח קישור.');
  if (d.status === 'cancelled' || d.status === 'expired') return wa.text(who, 'הטיוטה הזו כבר סגורה.');
  if (YES.test(text) && text.length <= 20) {
    if (!(d.status === 'awaiting' || d.status === 'error')) return;
    d.status = 'publishing'; put(s);                      // guard: one publish only
    if (!ig.enabled()) { d.status = 'awaiting'; put(s); return wa.text(who, 'הסרטון מאושר, אבל עוד לא חיברו לי טוקן של אינסטגרם. בינתיים אפשר להעלות ידנית את הסרטון שלמעלה.'); }
    try {
      let link = '';
      if (d.kind !== 'story') { const r = await ig.reel(d.url, d.caption); link = r.link; d.reelId = r.id; }
      try { const st = await ig.story(d.url); d.storyId = st.id; } catch (e) { log({ ev: 'story_err', err: String(e) }); d.storyErr = String(e.message || e).slice(0, 200); }
      const s2 = S(); Object.assign(s2.drafts[id], d, { status: 'published', link, publishedAt: Date.now(), day: ilDay() }); put(s2);
      return wa.text(who, `✅ עלה לאינסטגרם${d.kind !== 'story' ? ' (רילס' + (d.storyId ? ' + סטורי' : '') + ')' : ' (סטורי)'}${link ? '\n' + link : ''}${d.storyErr ? '\n⚠️ הסטורי לא עלה: ' + d.storyErr : ''}`);
    } catch (e) {
      log({ ev: 'publish_err', id, err: String(e.stack || e) });
      const s2 = S(); s2.drafts[id].status = 'error'; put(s2);
      return wa.text(who, '⚠️ הפרסום נכשל: ' + String(e.message || e).slice(0, 200) + '\nלנסות שוב? ענה "כן" על הטיוטה.');
    }
  }
  if (NO.test(text)) { d.status = 'cancelled'; put(s); return wa.text(who, 'בוטל 👍'); }
  // anything else = correction
  if (d.status !== 'awaiting' && d.status !== 'error') return;
  d.status = 'revising'; put(s);
  wa.text(who, '✍️ מתקן...');
  try {
    const fr = await render.frames(d.base.segments, d.dir);
    const prev = { caption: d.caption, overlays: d.overlays };
    const n = await ai.draft({ note: d.note, framesList: fr, feedback: text, previous: prev });
    d.caption = n.caption; d.overlays = n.overlays; d.song = n.song || d.song; d.warning = n.warning || ''; d.version += 1; d.status = 'awaiting';
    await renderDraft(d, d.base, d.overlays); await sendPreview(d);
    const s2 = S(); s2.drafts[id] = d; put(s2);
  } catch (e) {
    log({ ev: 'revise_err', err: String(e.stack || e) });
    const s2 = S(); s2.drafts[id].status = 'awaiting'; put(s2);
    wa.text(who, '⚠️ לא הצלחתי לתקן: ' + String(e.message || e).slice(0, 200));
  }
}

// ---- daily content ----
async function sendIdea(force) {
  const s = S(); const today = ilDay();
  if (!force && s.days.idea === today) return; s.days.idea = today; put(s);
  try {
    const recent = Object.values(s.drafts).filter((d) => d.status === 'published').slice(-5).map((d) => d.caption).join(' | ');
    const t = await ai.dailyIdea(recent);
    await wa.text(APPROVER, t + '\n\nמצלמים ושולחים לי עם המילה סושיאל 🎬');
  } catch (e) { log({ ev: 'idea_err', err: String(e) }); }
}
async function fallbackStory(force) {
  const s = S(); const today = ilDay();
  if (!force) {
    if (s.days.story === today) return;
    const active = Object.values(s.drafts).some((d) => d.day === today && ['published', 'awaiting', 'publishing', 'revising'].includes(d.status));
    if (active || Object.keys(s.batches).length) return;
  }
  s.days.story = today; put(s);
  try {
    const st = await ai.storyText();
    const id = rid(4), dir = path.join(MEDIA, 'w-' + id); fs.mkdirSync(dir, { recursive: true });
    const base = path.join(dir, 'bg.mp4'); // written by render.textStory, reused for corrections
    const d = { id, kind: 'story', version: 1, token: rid(8), status: 'awaiting', from: 'auto', note: 'סטורי גיוס', dir, caption: st.caption || '', overlays: [st.lines], song: '', warning: '', excluded: [], created: Date.now(), day: today };
    const out = path.join(MEDIA, `${id}-v1-${d.token}.mp4`);
    await render.textStory(st.lines, out, dir);
    d.file = out; d.url = `${PUBLIC}/m/${path.basename(out)}`; d.base = { file: base, duration: 7, segments: [] };
    d.caption = 'היום לא היה סרטון חדש, אז הכנתי סטורי גיוס.';
    await sendPreview(d);
    const s2 = S(); s2.drafts[id] = d; put(s2);
  } catch (e) { log({ ev: 'story_err', err: String(e) }); }
}

// ---- schedulers ----
setInterval(() => {
  const s = S();
  for (const [who, b] of Object.entries(s.batches)) if (Date.now() - b.last > QUIET_MS) finalize(who).catch((e) => log({ ev: 'fin_err', err: String(e) }));
  const p = ilParts(); const hm = p.h * 60 + p.mi; const workday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu'].includes(p.wd);
  if (workday && hm >= 9 * 60 + 20 && hm < 12 * 60) sendIdea(false);
  if (workday && hm >= 16 * 60 + 30 && hm < 18 * 60) fallbackStory(false);
  let dirty = false;
  for (const d of Object.values(s.drafts)) {
    if (d.status !== 'awaiting') continue;
    const age = Date.now() - d.sentAt;
    if (age > 72 * 3600e3) { d.status = 'expired'; dirty = true; }
    else if (age > 24 * 3600e3 && !d.reminded) { d.reminded = true; dirty = true; wa.text(APPROVER, `תזכורת: טיוטת ${MARK}${d.id} מחכה לאישור שלך (כן / לא / תיקון).`); }
  }
  if (dirty) put(s);
}, 30 * 1000);
setInterval(() => { // media older than 10 days
  const lim = Date.now() - 10 * 864e5;
  for (const f of fs.readdirSync(MEDIA)) { const p = path.join(MEDIA, f); try { if (fs.statSync(p).mtimeMs < lim) fs.rmSync(p, { recursive: true, force: true }); } catch {} }
}, 6 * 3600 * 1000);

const readBody = (req) => new Promise((res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => res(b)); });
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const ok = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (u.pathname === '/health') return ok(200, { ok: true, ig: ig.enabled(), public: !!PUBLIC });
  if (u.pathname.startsWith('/m/') && req.method === 'GET') { // public media for Instagram + WhatsApp (unguessable names)
    const f = path.join(MEDIA, path.basename(u.pathname));
    if (!/^[a-f0-9]+-v\d+-[a-f0-9]{16}\.mp4$/.test(path.basename(f)) || !fs.existsSync(f)) return ok(404, { error: 'not found' });
    const st = fs.statSync(f); res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': st.size }); return fs.createReadStream(f).pipe(res);
  }
  if (!KEY || u.searchParams.get('key') !== KEY) return ok(401, { error: 'unauthorized' });
  let body = {}; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return ok(400, { error: 'bad json' }); }
  try {
    if (u.pathname === '/claim' && req.method === 'POST') return ok(200, { handled: claim(body) });
    if (u.pathname === '/admin/state' && req.method === 'GET') { const s = S(); return ok(200, { batches: Object.keys(s.batches), drafts: Object.values(s.drafts).map(({ id, kind, status, day, link }) => ({ id, kind, status, day, link })), days: s.days }); }
    if (u.pathname === '/admin/idea' && req.method === 'POST') { sendIdea(true); return ok(200, { ok: true }); }
    ok(404, { error: 'not found' });
  } catch (e) { log({ ev: 'route_err', err: String(e.stack || e) }); ok(500, { error: 'internal' }); }
}).listen(E.PORT || 8080, () => log({ ev: 'listening', port: E.PORT || 8080 }));
