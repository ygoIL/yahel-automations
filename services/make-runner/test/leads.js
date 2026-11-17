// Offline tests for the lead-upload tool: scoring, iron rules, and a full dry run + confirm against a mocked ToChat/Sheets.
process.env.DATA_DIR = require('path').join(__dirname, '.data-leads'); require('fs').rmSync(process.env.DATA_DIR, { recursive: true, force: true });
process.env.TOCHAT_API_KEY = 'test-key';
const assert = require('assert');
const tc = require('../src/leads/tochat-client');
const scoring = require('../src/leads/scoring');
const rules = require('../src/leads/rules');

// ---- phone normalisation ----
assert.strictEqual(tc.normPhone('972544303994'), '0544303994');
assert.strictEqual(tc.normPhone('+972-54-430-3994'), '0544303994');
assert.strictEqual(tc.normPhone('544303994'), '0544303994');
assert.strictEqual(tc.normPhone('0544303994'), '0544303994');
assert.strictEqual(tc.normPhone('12'), '');

// ---- scoring ----
const now = new Date();
const d = (daysAgo) => { const x = new Date(now.getTime() - daysAgo * 86400000); return `${String(x.getDate()).padStart(2, '0')}/${String(x.getMonth() + 1).padStart(2, '0')}/${x.getFullYear()} 12:00`; };
const HOT = 'הלקוח ציין שהוא משלם היום 260 ש"ח להוט. שאל מה כלול בחבילה ושאל על ההתקנה ועל קנס יציאה. הנציג הציג מחיר של 179 ש"ח. הלקוח אמר שיחשוב על זה ויחזור אליו.';
const rows = [
  [d(10), 'נציג', '972501111111', 'רותח א', '05:10', 'לידים חדשים', HOT],
  [d(10), 'נציג', '972502222222', 'חם ב', '02:10', 'לידים חדשים', 'הלקוח שאל מה כלול. קיבל מחיר 150 ש"ח.'],
  [d(10), 'נציג', '972503333333', 'פושר ג', '01:10', 'לידים חדשים', 'הלקוח לא היה זמין.'],
  [d(10), 'נציג', '972504444444', 'כבר לקוח', '04:00', 'לידים חדשים', HOT + ' הלקוח ציין כי הוא כבר מנוי קיים של חברת יס.'],
  [d(10), 'נציג', '972505555555', 'עסקה', '06:00', 'מצטרפים', HOT + ' נקבע מועד התקנה ליום שני.'],
  [d(10), 'נציג', '972506666666', 'סייבר', '06:00', 'סייבר בוסט', HOT],
  [d(10), 'נציג', '972507777777', 'פולואפ', '06:00', 'לידים חדשים', HOT],
  [d(10), 'נציג', '972508888888', 'שחור', '06:00', 'לידים חדשים', HOT],
  [d(2), 'נציג', '972509999999', 'דיברנו', '06:00', 'לידים חדשים', HOT],
  [d(10), 'נציג', '972521111111', 'בקמפיין', '06:00', 'לידים חדשים', HOT],
  [d(10), 'נציג', '972522222222', 'מוטרד', '06:00', 'לידים חדשים', HOT],
  [d(10), 'נציג', '972523333333', 'סירוב', '06:00', 'לידים חדשים', HOT + ' הלקוחה הבהירה כי אינה מעוניינת בשום הצעה.'],
  [d(10), 'נציג', '972524444444', 'רותח ב', '03:30', 'לידים חדשים', HOT],
  [d(10), 'נציג', '972525555555', 'לא ענה לאחרונה', '03:30', 'לידים חדשים', HOT],
];
const cs = scoring.buildCustomers(rows);
const C = (p) => cs.find((c) => c.phone === p);
assert.strictEqual(C('0501111111').tier, 'רותח');
assert.strictEqual(C('0501111111').paid, '260');
assert.strictEqual(scoring.note(C('0501111111')).startsWith('רותח: משלם 260, שאל מה כלול, שאל על התקנה'), true, scoring.note(C('0501111111')));
assert.strictEqual(C('0502222222').tier, 'חם');
assert.strictEqual(C('0503333333').tier, 'פושר');
assert.deepStrictEqual(C('0504444444').disqualified, ['כבר לקוח yes']);
assert.ok(C('0505555555').disqualified.includes('עסקה נסגרה'));
assert.ok(C('0506666666').disqualified.includes('שיחה בקמפיין סייבר'));
assert.ok(C('0523333333').disqualified.includes('סירוב חד'));
// 4 signals but short call is not "hot"
assert.strictEqual(scoring.buildCustomers([[d(5), '', '972530000000', 'x', '02:59', 'c', HOT]])[0].tier, 'חם');

// ---- rules ----
const target = { id: 'c1', name: 'בוסט' };
const ev = (status, extra = {}) => rules.evaluate({ phone: '0500000000', status: { activeLeads: [], inactiveCampaigns: [], ...status }, deny: new Set(), target, ...extra }).map((w) => w.k);
assert.deepStrictEqual(ev({}), []);
assert.deepStrictEqual(ev({ activeLeads: [{ status: 'FOLLOW_UP', campaignName: 'אחר', followByName: 'דני' }] }), ['followup']);
assert.deepStrictEqual(ev({ inactiveCampaigns: [{ reason: 'CLOSED', timestamp: '2020-01-01' }] }), ['deal']);
assert.deepStrictEqual(ev({ inactiveCampaigns: [{ reason: 'NOT_RELEVANT', subReason: { name: 'לקוח פעיל' }, timestamp: '2019-01-01' }] }), ['blockedStatus']);
assert.deepStrictEqual(rules.evaluate({ phone: '0500000000', status: { activeLeads: [], inactiveCampaigns: [{ reason: 'NOT_RELEVANT', subReason: { name: 'לקוח פעיל' }, timestamp: '2019-01-01' }] }, deny: new Set(), target: { id: 'p', name: 'פלאפון סלולר' } }), [], 'pelephone exception');
assert.deepStrictEqual(ev({ inactiveCampaigns: [{ reason: 'NOT_RELEVANT', subReason: { name: 'אין תשתית' }, timestamp: '2019-01-01' }] }), ['blockedStatus']);
assert.deepStrictEqual(ev({ inactiveCampaigns: [{ reason: 'NOT_INTERESTED', timestamp: new Date(now - 86400000).toISOString() }] }), ['recentTalk']);
assert.deepStrictEqual(ev({ inactiveCampaigns: [{ reason: 'NO_ANSWER', timestamp: new Date(now - 86400000).toISOString() }] }), []);
assert.deepStrictEqual(ev({ inactiveCampaigns: [{ reason: 'NOT_INTERESTED', timestamp: new Date(now - 5 * 86400000).toISOString() }] }), []);
assert.deepStrictEqual(ev({ activeLeads: [{ status: 'NEW', campaignId: 'c1', campaignName: 'בוסט' }] }), ['inTarget']);
assert.deepStrictEqual(rules.evaluate({ phone: '0500000000', status: { activeLeads: [], inactiveCampaigns: [] }, deny: new Set(['0500000000']), target }).map((w) => w.k), ['denyList']);

// ---- end-to-end dry run + confirm with mocked APIs ----
const google = require('../src/google');
google.sheets = async () => ({ body: { values: rows } });
const posts = [];
const status = {
  '0507777777': { activeLeads: [{ status: 'FOLLOW_UP', campaignName: 'מצטרפים', followByName: 'משה' }], inactiveCampaigns: [] },
  '0521111111': { activeLeads: [{ status: 'NEW', campaignId: 'c1', campaignName: 'בוסט' }], inactiveCampaigns: [] },
  '0522222222': { activeLeads: [], inactiveCampaigns: [{ reason: 'NOT_RELEVANT', subReason: { name: 'מוטרד' }, timestamp: '2025-01-01T00:00:00Z' }] },
  '0525555555': { activeLeads: [], inactiveCampaigns: [{ reason: 'NO_ANSWER', timestamp: new Date(now - 86400000).toISOString() }] },
};
let calls429 = 0;
global.fetch = async (url, opts) => {
  const u = new URL(url); const p = decodeURIComponent(u.pathname);
  assert.ok(opts.headers.Authorization.startsWith('Basic '));
  const J = (code, b) => ({ status: code, headers: new Map(), text: async () => JSON.stringify(b) });
  if (p.endsWith('/campaigns')) return J(200, [{ id: 'c1', name: 'בוסט' }, { id: 'c2', name: 'מצטרפים' }, { id: 'c3', name: 'בוסט סייבר' }]);
  if (p.endsWith('/deny-list')) return J(200, [{ phone: '972508888888' }]);
  const m = /customers\/(\d+)$/.exec(p);
  if (m && opts.method === 'GET') { if (m[1] === '0524444444' && calls429++ < 1) return J(429, {}); return status[m[1]] ? J(200, status[m[1]]) : J(404, {}); }
  if (p.endsWith('/campaigns/c1/customers') && opts.method === 'POST') { const b = JSON.parse(opts.body); posts.push(b); return J(200, { created: b.customers.map((c) => c.phone), updated: [], failed: [] }); }
  throw new Error('unexpected ' + opts.method + ' ' + p);
};
const L = require('../src/leads/upload');
(async () => {
  const amb = await L.dryRun({ count: 5, tier: 'רותחים', campaign: 'קמפיין שלא קיים' });
  assert.strictEqual(amb.status, 'need_campaign');
  const r = await L.dryRun({ count: 5, tier: 'רותחים', campaign: 'בוסט' });
  assert.strictEqual(r.status, 'dry_run');
  assert.strictEqual(r.campaign.id, 'c1');
  assert.deepStrictEqual(r.examples.map((e) => e.phone).sort(), ['0501111111', '0524444444', '0525555555']);
  assert.ok(r.shortage, 'must report shortage instead of filling from warm');
  for (const k of ['פולואפ פתוח', 'רשימה שחורה', 'דיברנו ב-4 הימים האחרונים', 'כבר בקמפיין היעד']) assert.ok(r.rejectedByReason[k], k);
  assert.strictEqual(posts.length, 0, 'dry run must not upload');
  const c = await L.confirm({ runId: r.runId });
  assert.strictEqual(c.uploaded, 3); assert.strictEqual(c.failed, 0);
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(posts[0].dataSource.shouldCheckWithDontCallMe, false);
  assert.strictEqual(posts[0].dataSource.priority, 20);
  assert.ok(posts[0].customers[0].notes.startsWith('רותח:'));
  await assert.rejects(L.confirm({ runId: r.runId }), /כבר הועלתה/);
  // same customers are never uploaded twice
  const r2 = await L.dryRun({ count: 5, tier: 'רותח', campaign: 'בוסט' });
  assert.strictEqual(r2.willUpload, 0); assert.strictEqual(r2.rejectedByReason['כבר הועלה בעבר ע"י הכלי'], 3);
  // missing key → clear message
  delete process.env.TOCHAT_API_KEY;
  await assert.rejects(L.dryRun({ count: 5, tier: 'רותח', campaign: 'בוסט' }), /TOCHAT_API_KEY/);
  console.log('leads test OK');
})().catch((e) => { console.error(e); process.exit(1); });
