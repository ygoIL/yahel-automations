// Blocked reps: a ManyChat send is skipped when the run carries a blocked rep's name; other modules still run.
process.env.DATA_DIR = require('path').join(__dirname, '.data-br'); require('fs').rmSync(process.env.DATA_DIR, { recursive: true, force: true });
const assert = require('assert');
const B = require('../src/blocked-reps');
const engine = require('../src/engine');
B._set(['ישראל ישראלי', 'משה כהן']);
assert.deepStrictEqual(B.parseNames([['שם נציג'], ['  ישראל  ישראלי '], ['050-1234567'], [''], ['משה "כהן"']]), ['ישראל ישראלי', 'משה כהן']);
assert.ok(B.match(B.status().names, ['ישראל ישראלי']));
assert.ok(B.match(B.status().names, ['ישראל ישראלי - בזק']));
assert.ok(!B.match(B.status().names, ['ישראל']));
assert.ok(!B.match(B.status().names, ['ישראל ישראליאן']));
const sc = (rep) => ({ id: 2, name: 't', blueprint: { flow: [
  { id: 1, module: 'gateway:CustomWebHook', parameters: {} },
  { id: 2, module: 'manychat:PerformAction', mapper: { subscriberId: '1', actions: [{ action: 'set_field_value', field_name: 'x', value: '{{1.rep}}' }] } },
  { id: 3, module: 'manychat:SendFlow', mapper: { subscriberId: '1', flowName: 'f' } },
  { id: 4, module: 'datastore:AddRecord', parameters: { datastore: 998 }, mapper: { key: 'k', data: { rep: '{{1.rep}}' } } },
] } });
(async () => {
  let r = await engine.run(sc('ישראל ישראלי'), { type: 'webhook', body: { rep: 'ישראל ישראלי' } }, { dry: true });
  assert.strictEqual(r.status, 'success', JSON.stringify(r.error));
  assert.strictEqual(r.actions.find((a) => a.module === 3).skipped, 'blocked rep');
  assert.ok(!r.actions.find((a) => a.module === 2).skipped, 'non-send ManyChat action still runs');
  assert.ok(r.trace.find((t) => t.id === 4), 'flow continues after the skipped send');
  r = await engine.run(sc('דנה לוי'), { type: 'webhook', body: { rep: 'דנה לוי' } }, { dry: true });
  assert.ok(!r.actions.some((a) => a.skipped));
  console.log('blocked reps test OK');
})().catch((e) => { console.error(e); process.exit(1); });
