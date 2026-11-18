// Iron rules, evaluated per customer BEFORE any upload. Returns the list of reasons that block the customer (empty = may upload).
// Reason keys: followup | deal | blockedStatus | denyList | recentTalk | inTarget | alreadyUploaded

// "Ever marked" statuses that block every campaign (matched on subReason.name / reason / note of past campaigns).
const ACTIVE_CUSTOMER = /לקוח פעיל/;
const BLOCKED = [
  [/מוטרד/, 'מוטרד'],
  [/להסיר|הסרה|הסיר/, 'להסיר'],
  [/אל תתקשר|לא להתקשר/, 'אל תתקשר'],
  [/אין תשתית/, 'אין תשתית'],
  [/כבר לקוח/, 'כבר לקוח'],
];
// Closing reasons that mean "nobody actually talked" (do not count as a recent conversation).
const NO_TALK = /CALL_ATTEMPTS|NO_?ANSWER|NOT_?ANSWER|UNANSWER|BUSY|VOICE_?MAIL|WRONG_?NUMBER|לא ענה|לא עונה|אין מענה|לא נענ|תא קולי|תפוס|מספר שגוי/i;
const RECENT_DAYS = 4;

const txt = (l) => [l.reason, l.subReason && l.subReason.name, l.note].filter(Boolean).join(' ');
const ts = (v) => { const d = new Date(v); return isNaN(d) ? null : d; };

function evaluate({ phone, status, deny, target, sheetLastCall, uploadedBefore, now = new Date() }) {
  const why = [];
  const act = status.activeLeads || [], inact = status.inactiveCampaigns || [];
  const pelephone = /פלאפון/.test(target.name);

  // 1. Sacred follow-up: open follow-up with any rep, in any campaign (including the target).
  const fu = act.filter((l) => /FOLLOW/i.test(String(l.status || '')));
  if (fu.length) why.push({ k: 'followup', d: 'פולואפ פתוח: ' + fu.map((l) => `${l.followByName || '?'} (${l.campaignName || ''})`).join(', ') });

  // 2. Ever closed a deal.
  const deals = inact.filter((l) => String(l.reason || '').toUpperCase() === 'CLOSED');
  if (deals.length) why.push({ k: 'deal', d: 'עסקה נסגרה: ' + deals.map((l) => `${l.agentName || '?'} ${String(l.timestamp || '').slice(0, 10)}`).join(', ') });

  // 3. Ever marked active customer / harassed / remove / don't call / no infrastructure / already a customer.
  const marks = new Set();
  for (const l of inact) {
    const t = txt(l);
    if (ACTIVE_CUSTOMER.test(t) && !pelephone) marks.add('לקוח פעיל'); // exception: Pelephone cellular campaign may take active yes customers
    for (const [re, label] of BLOCKED) if (re.test(t)) marks.add(label);
  }
  if (marks.size) why.push({ k: 'blockedStatus', d: 'סומן: ' + [...marks].join(', ') });

  // 4. Deny list.
  if (deny.has(phone)) why.push({ k: 'denyList', d: 'ברשימה השחורה' });

  // 5. Talked in the last 4 days (unanswered calls do not count).
  const since = now.getTime() - RECENT_DAYS * 86400000;
  const recent = inact.filter((l) => { const d = ts(l.timestamp); return d && d.getTime() >= since && !NO_TALK.test(txt(l)); });
  if (sheetLastCall && sheetLastCall.getTime() >= since) recent.push({ timestamp: sheetLastCall.toISOString(), agentName: 'שיחה בלוג השיקופים' });
  if (recent.length) why.push({ k: 'recentTalk', d: 'דיברו איתו לאחרונה: ' + recent.map((l) => `${l.agentName || '?'} ${String(l.timestamp).slice(0, 10)}`).join(', ') });

  // 6. Already in the target campaign.
  if (act.some((l) => String(l.campaignId ?? '') === target.id || String(l.campaignName || '').trim() === target.name)) why.push({ k: 'inTarget', d: 'כבר בקמפיין היעד' });

  // 7. Already uploaded by this tool before (run log) – never upload the same customer twice.
  if (uploadedBefore) why.push({ k: 'alreadyUploaded', d: `כבר הועלה ע"י הכלי: ${uploadedBefore.campaign} ${String(uploadedBefore.at).slice(0, 10)}` });

  return why;
}

const REASON_LABELS = {
  scoring: 'נפסל בסיכום השיחה (עסקה/כבר לקוח/אין תשתית/להסיר/סירוב/סייבר)',
  followup: 'פולואפ פתוח', deal: 'עסקה נסגרה', blockedStatus: 'סומן פעיל/מוטרד/להסיר/אל תתקשר/אין תשתית/כבר לקוח',
  denyList: 'רשימה שחורה', recentTalk: 'דיברנו ב-4 הימים האחרונים', inTarget: 'כבר בקמפיין היעד', alreadyUploaded: 'כבר הועלה בעבר ע"י הכלי', checkError: 'שגיאה בבדיקת סטטוס (לא עולה)',
};

module.exports = { evaluate, REASON_LABELS, NO_TALK, RECENT_DAYS };
