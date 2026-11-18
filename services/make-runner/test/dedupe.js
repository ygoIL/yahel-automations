// Offline tests for the global dedupe decision rules.
process.env.DATA_DIR = require('path').join(__dirname, '.data-dedupe'); require('fs').rmSync(process.env.DATA_DIR, { recursive: true, force: true });
const assert = require('assert');
const { decide, message, isOurRep } = require('../src/dedupe');
const L = (campaignName, status = 'PENDING', followByName = '', lastCall = '', createDate = '2026-11-01T08:00:00Z') => ({ campaignId: 'id_' + campaignName, campaignName, status, followByName, lastCall, createDate });
const names = (a) => a.map((x) => (x.lead || x).campaignName);

// Today's case (0506267777): Amit's follow-up + a copy in פולואפים כל הזמנים → the copy is closed, Amit keeps it.
let d = decide([L('תקשורת כל החברות חדש', 'FOLLOWUP', 'עמית הראל'), L('פולואפים כל הזמנים')]);
assert.deepStrictEqual(names(d.keep), ['תקשורת כל החברות חדש']);
assert.deepStrictEqual(names(d.close), ['פולואפים כל הזמנים']);

// No follow-up: priority פולואפים כל הזמנים > רותחים > תקשורת כל החברות.
d = decide([L('תקשורת כל החברות חדש'), L('רותחים תחרות !!!'), L('פולואפים כל הזמנים'), L('מצטרפים')]);
assert.deepStrictEqual(names(d.keep), ['פולואפים כל הזמנים']);
assert.deepStrictEqual(names(d.close).sort(), ['מצטרפים', 'רותחים תחרות !!!', 'תקשורת כל החברות חדש'].sort());
d = decide([L('תקשורת כל החברות חדש'), L('רותחים תחרות !!!')]);
assert.deepStrictEqual(names(d.keep), ['רותחים תחרות !!!']);
d = decide([L('ממירים'), L('תקשורת כל החברות חדש')]);
assert.deepStrictEqual(names(d.keep), ['תקשורת כל החברות חדש']);
// Unranked campaigns: the oldest lead stays.
d = decide([L('ממירים', 'PENDING', '', '', '2026-11-10T00:00:00Z'), L('שרון', 'PENDING', '', '', '2026-11-02T00:00:00Z')]);
assert.deepStrictEqual(names(d.keep), ['שרון']);

// Two follow-ups by different reps: first one wins; a non-FU copy is closed too.
d = decide([L('פולואפים כל הזמנים', 'FOLLOWUP', 'עילאי אוחנה', '2026-11-18T10:00:00Z'), L('תקשורת כל החברות חדש', 'FOLLOWUP', 'עמית הראל', '2026-11-18T07:30:00Z'), L('בוסט')]);
assert.deepStrictEqual(names(d.keep), ['תקשורת כל החברות חדש']);
assert.deepStrictEqual(names(d.close).sort(), ['בוסט', 'פולואפים כל הזמנים'].sort());
assert.ok(d.close.find((c) => c.lead.campaignName === 'פולואפים כל הזמנים').fu);
// Less than 10 minutes apart → no follow-up is closed, reported for review.
d = decide([L('א', 'FOLLOWUP', 'דני', '2026-11-18T10:00:00Z'), L('ב', 'FOLLOWUP', 'רוני', '2026-11-18T10:05:00Z'), L('ג')]);
assert.deepStrictEqual(names(d.close), ['ג']); assert.ok(d.review);
// Missing time → review, follow-ups untouched.
d = decide([L('א', 'FOLLOWUP', 'דני', '', ''), L('ב', 'FOLLOWUP', 'רוני', '2026-11-18T10:05:00Z')]);
assert.deepStrictEqual(d.close, []); assert.ok(d.review);
// Same rep with two follow-ups: his most recent one stays, the older copy is closed.
d = decide([L('א', 'FOLLOWUP', 'דני', '2026-11-18T09:00:00Z'), L('ב', 'INCOMING_FOLLOWUP', 'דני', '2026-11-18T10:00:00Z')]);
assert.deepStrictEqual(names(d.keep), ['ב']); assert.deepStrictEqual(names(d.close), ['א']); assert.strictEqual(d.review, null);
// Single lead / blacklist campaign never touched.
assert.deepStrictEqual(decide([L('א')]).close, []);
assert.deepStrictEqual(decide([L('רשימה שחורה'), L('א')]).close, []);

// Two follow-ups, only one rep in יעדים → he keeps it even if he was later; time doesn't matter.
const ours = ['עמית הראל', 'שילת', 'איתמר ששון'];
d = decide([L('פולואפים כל הזמנים', 'FOLLOWUP', 'עילאי אוחנה', '2026-11-18T07:00:00Z'), L('תקשורת כל החברות חדש', 'FOLLOWUP', 'עמית הראל', '2026-11-18T09:30:00Z')], ours);
assert.deepStrictEqual(names(d.keep), ['תקשורת כל החברות חדש']); assert.ok(d.close[0].fu);
d = decide([L('א', 'FOLLOWUP', 'עילאי אוחנה', '2026-11-18T10:00:00Z'), L('ב', 'FOLLOWUP', 'שילת חלפה', '2026-11-18T10:03:00Z')], ours);
assert.deepStrictEqual(names(d.keep), ['ב']); assert.strictEqual(d.review, null);
// both ours → earliest
d = decide([L('א', 'FOLLOWUP', 'עמית הראל', '2026-11-18T12:00:00Z'), L('ב', 'FOLLOWUP', 'איתמר חסון', '2026-11-18T08:00:00Z')], ours);
assert.deepStrictEqual(names(d.keep), ['ב']);
assert.ok(isOurRep('איתמר חסון', ours)); assert.ok(isOurRep('שילת חלפה', ours)); assert.ok(!isOurRep('עילאי אוחנה', ours));

// Message only when something between reps / problems happened.
assert.strictEqual(message({ closedFU: 0, review: [], failedCampaigns: [], errors: [], failedClose: 0, closed: 40, dupPhones: 40, fuConflicts: [] }, '07:50'), null);
assert.ok(message({ closedFU: 1, review: [], failedCampaigns: [], errors: [], failedClose: 0, closed: 3, dupPhones: 3, fuConflicts: [{ p: '0506267777', kept: 'x', closed: 'y' }] }, '07:50').includes('7777'));
console.log('dedupe tests ok');
