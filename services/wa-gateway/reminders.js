// Rep reminders: intake (former Make 10125213) + sender every 10 min (former Make 10125215).
const { E, log, post, load, save, sheets } = require('./lib');
const wa = require('./whatsapp');
const BOT = E.REPS_BOT_URL, KEY = E.REPS_BOT_KEY;
const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const dg = (s) => String(s == null ? '' : s).replace(/\D/g, '');
const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const MGRN = { '544604246': 'סטיב', '504445169': 'ירדן', '525102820': 'טלי', '525192071': 'הילה', '584896222': 'קורל', '542607144': 'שחר' };
const HELP = 'כתוב למשל: תזכיר לי ב-30 לנובמבר ב-10:00 להתקשר לאביחי';

async function repName(sender) {
  const s9 = dg(sender).slice(-9); let rep = '';
  try { const r = await sheets('GET', "spreadsheets/12NkSDD2emzTYb4n5Zt5P9aLdEcgtrIGelZCKRoU7dZI/values/יעדים!A2:B80"); for (const row of r.body.values || []) if (row && s9.length === 9 && dg(row[1]).slice(-9) === s9) rep = norm(row[0]); } catch (e) { log({ ev: 'rep_lookup_err', err: String(e) }); }
  if (MGRN[s9]) rep = MGRN[s9];
  return rep;
}
const toEpoch = (y, mo, d, h, mi) => { let guess = Date.UTC(y, mo - 1, d, h, mi) - 2 * 3600e3; for (let i = 0; i < 2; i++) { const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(guess)); const g = (t) => +((p.find((x) => x.type === t) || {}).value); guess += Date.UTC(y, mo - 1, d, h, mi) - Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute')); } return Math.round(guess / 1000); };

async function intake({ chatId, sender, text }) {
  const rep = await repName(sender); const known = !!rep; const phone = '972' + dg(sender).slice(-9);
  let message;
  if (!known) message = 'היי, אני הבוט של יהל תקשורת. לא זיהיתי את המספר שלך ברשימת הנציגים, פנה/י לסטיב.';
  else {
    let j = {}; try { const a = await post(`${BOT}/reminder?key=${KEY}`, { chatId, message: text }, 60000); const m = String((a.data && a.data.result) || '').match(/\{[\s\S]*\}/); j = JSON.parse(m ? m[0] : '{}'); } catch { j = {}; }
    const task = norm(j.task); const dm = String(j.date || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/); const tm = String(j.time || '09:00').match(/^(\d{1,2}):(\d{2})$/) || [null, '9', '00'];
    if (j.ok === true && dm && task) {
      const y = +dm[1], mo = +dm[2], d = +dm[3], h = +tm[1], mi = +tm[2]; const due = toEpoch(y, mo, d, h, mi);
      const dueText = 'יום ' + DAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()] + ' ' + d + '/' + mo + ' ב-' + String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
      if (due <= Math.floor(Date.now() / 1000) + 60) message = 'המועד שביקשת (' + dueText + ') כבר עבר. ' + HELP;
      else {
        const id = 'r' + Date.now() + phone.slice(-4); const rs = load('reminders', []);
        rs.push({ id, due, rep, task, phone, status: 'ממתין', created: new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' }), dueText }); save('reminders', rs);
        message = '✅ רשמתי תזכורת\n📅 ' + dueText + '\n📝 ' + task + '\n\nאזכיר לך בזמן 💪';
      }
    } else message = 'לא הצלחתי להבין מתי להזכיר לך. ' + HELP;
  }
  await wa.send(chatId, message);
}

async function sendDue() {
  const rs = load('reminders', []); const now = Math.floor(Date.now() / 1000); let changed = false;
  for (const r of rs) {
    if (r.status !== 'ממתין' || Number(r.due) > now) continue;
    const first = String(r.rep || '').trim().split(/\s+/)[0] || '';
    await wa.gate({ phone: r.phone, message: '⏰ ' + (first ? 'היי ' + first + ', ' : '') + 'תזכורת שביקשת:\n📝 ' + r.task + '\n\n(נרשם לתזכורת ל' + r.dueText + ')', source: 'תזכורות נציגים' });
    r.status = 'נשלח'; changed = true; save('reminders', rs);
  }
  if (changed) log({ ev: 'reminders_sent' });
}
module.exports = { intake, sendDue };
