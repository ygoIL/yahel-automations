// "Hot lead" scoring from ToChat AI call summaries (sheet "לוג שיקופים": every call of 1 minute and up).
// Built from the written rules (the original Python scoring script was not provided).
const { normPhone } = require('./tochat-client');

// Signals. Each one counts once per customer, across all of that customer's calls.
const SIGNALS = {
  long: { label: 'שיחה של 3+ דק\'' },
  pays: { label: 'אמר כמה משלם', re: /משל[מם]\S*|תשלום (הנוכחי|החודשי)|עלות (הנוכחית|החודשית)|חשבון (החודשי|הנוכחי)/ },
  included: { label: 'שאל מה כלול', re: /מה (כלול|כולל|נכלל|יש ב)|(שאל|התעניי|בירר|ביקש\S* לדעת)\S*[^.\n]{0,60}(כלול|כולל|ערוצ|תכול|מהירות)/ },
  install: { label: 'שאל על התקנה', re: /התקנ|טכנאי/ },
  disconnect: { label: 'שאל על ניתוק/קנס', re: /ניתוק|להתנתק|התנתקות|קנס|דמי יציאה|התחייבות|שחרור מ/ },
  price: { label: 'קיבל מחיר', re: /\d[\d,.]*\s*(ש["״']?ח|₪|שקל)|הצעת מחיר|הוצג\S* (לו |לה )?מחיר|קיבל\S* (את ה)?מחיר/ },
  deferred: { label: 'דחה את ההחלטה', re: /אחשוב|לחשוב על|יחשוב|תחשוב|ישקול|תשקול|לשקול|יתייעץ|תתייעץ|להתייעץ|תחזור אלי|יחזור אלי|לחזור אלי|לחזור אליו|לחזור אליה|יחזרו אלי|שיחה חוזרת|מאוחר יותר|בהמשך השבוע|בזמן אחר|לא עכשיו/ },
};

// Immediate disqualifiers (any call of the customer).
const DISQ = [
  ['deal', 'עסקה נסגרה', /נסגרה עסקה|העסקה נסגרה|סגירת (ה)?עסקה|נסגר\S* (ה)?עסקה|הפקת (ה)?הזמנה|ההזמנה (הופקה|בוצעה|נקלטה)|חוזה (לחתימה|נחתם)|חתם\S* על (ה)?חוזה|נקבע\S* (מועד )?(ה)?התקנה|מועד התקנה:|תוא[מם]\S* התקנה/],
  ['yesCustomer', 'כבר לקוח yes', /(כבר (מנוי|לקוח)\S*|מנוי\S* קיי[מם]\S*|לקוח\S* קיי[מם]\S*)[^.\n]{0,25}(yes|יס)(?![א-ת])|(מנוי|מנויה|לקוח|לקוחה)\S* (של |ב)(חברת )?(yes|יס)(?![א-ת])/i],
  ['noInfra', 'אין תשתית', /אין תשתית|אין (לו |לה )?סיבים|אין כיסוי|לא קיימת תשתית|אין אפשרות (ל)?התקנ|התשתית (לא|אינה) (זמינה|קיימת)/],
  ['remove', 'ביקש להסיר', /להסיר|הסרה מ|הסירו|להוריד (אותו |אותה )?מה?רשימ|לא להתקשר|אל תתקשר|שלא יתקשרו|לא לפנות אלי/],
  ['refusal', 'סירוב חד', /סירב\S* (בתוקף|נחרצות|חד)|סירוב (חד|מוחלט|נחרץ)|אינ\S* מעוניי\S* (בשום|בכלל|בתוקף)|לא מעוניי\S* (בשום|בכלל|בתוקף)|אין ל\S* (שום |כל )?עניין|ניתק\S* את השיחה|ביקש\S* (לסיים|שלא)|הבהיר\S* (כי |ש)(הוא |היא )?(אינ|לא) מעוניי/],
];
const CYBER = /סייבר/;

function durSec(s) { const p = String(s || '').trim().split(':').map(Number); if (p.some(isNaN) || !p.length) return 0; return p.reduce((a, x) => a * 60 + x, 0); }
// "dd/mm/yyyy hh:mm" in Israel time → Date
function parseIL(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/.exec(String(s || '').trim()); if (!m) return null;
  const guess = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0)));
  const off = /GMT([+-]\d+)/.exec(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', timeZoneName: 'shortOffset' }).format(guess));
  return new Date(guess.getTime() - (off ? Number(off[1]) : 2) * 3600000);
}
function amountPaid(text) { const m = /משל[מם]\S*[^\d\n]{0,30}?(\d{2,4})(?!\d)/.exec(text); return m ? m[1] : ''; }

function scoreCall(text) {
  const t = String(text || '');
  const sig = Object.entries(SIGNALS).filter(([k, s]) => s.re && s.re.test(t)).map(([k]) => k);
  const disq = DISQ.filter(([, , re]) => re.test(t)).map(([k, label]) => ({ k, label }));
  return { sig, disq, paid: amountPaid(t) };
}

// rows: arrays [date, rep, phone972, name, duration, campaign, summary, recording, checked]
function buildCustomers(rows) {
  const by = new Map();
  for (const r of rows) {
    const phone = normPhone(r[2]); if (!phone) continue;
    const at = parseIL(r[0]); const sec = durSec(r[4]); const campaign = String(r[5] || '').trim(); const text = String(r[6] || '');
    let c = by.get(phone);
    if (!c) by.set(phone, (c = { phone, name: String(r[3] || '').trim(), calls: 0, maxSec: 0, paidAt: null, lastCall: null, sig: new Set(), disq: new Map(), paid: '', campaigns: new Set() }));
    c.calls++; c.campaigns.add(campaign);
    if (at && (!c.lastCall || at > c.lastCall)) { c.lastCall = at; if (r[3]) c.name = String(r[3]).trim(); }
    c.maxSec = Math.max(c.maxSec, sec);
    if (CYBER.test(campaign)) c.disq.set('cyber', 'שיחה בקמפיין סייבר');
    const s = scoreCall(text);
    s.sig.forEach((k) => c.sig.add(k)); s.disq.forEach((d) => c.disq.set(d.k, d.label));
    if (s.paid && (!c.paidAt || (at && at >= c.paidAt))) { c.paid = s.paid; c.paidAt = at || c.paidAt; }
  }
  const out = [];
  for (const c of by.values()) {
    if (c.maxSec >= 180) c.sig.add('long');
    const n = c.sig.size;
    c.tier = n >= 4 && c.maxSec >= 180 ? 'רותח' : n >= 2 ? 'חם' : 'פושר';
    c.score = n;
    c.signals = [...c.sig].map((k) => SIGNALS[k].label);
    c.disqualified = [...c.disq.values()];
    out.push(c);
  }
  // hottest first: tier, then score, then longest call, then most recent
  const rank = { 'רותח': 0, 'חם': 1, 'פושר': 2 };
  out.sort((a, b) => rank[a.tier] - rank[b.tier] || b.score - a.score || b.maxSec - a.maxSec || (b.lastCall || 0) - (a.lastCall || 0));
  return out;
}

// Short note for the rep, e.g. "רותח: משלם 260, שאל על התקנה, דחה את ההחלטה"
function note(c) {
  const parts = [];
  if (c.paid) parts.push(`משלם ${c.paid}`);
  for (const k of ['included', 'install', 'disconnect', 'price', 'deferred']) if (c.sig.has(k)) parts.push(SIGNALS[k].label);
  return `${c.tier}: ${parts.join(', ') || `${c.score} סימנים`}`.slice(0, 120);
}

module.exports = { buildCustomers, scoreCall, note, durSec, parseIL, SIGNALS, DISQ };
