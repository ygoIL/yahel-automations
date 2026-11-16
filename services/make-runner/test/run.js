// Offline engine test with a synthetic blueprint: webhook -> code -> iterator -> aggregator -> router -> datastore/http (dry).
process.env.DATA_DIR = require('path').join(__dirname, '.data');
const assert = require('assert');
const engine = require('../src/engine');
const sc = { id: 1, name: 'test', blueprint: { flow: [
  { id: 1, module: 'gateway:CustomWebHook', parameters: {} },
  { id: 2, module: 'code:ExecuteCode', mapper: { input: [{ name: 'n', value: '{{1.n}}' }], codeEditorJavascript: "return {items:[1,2,3].map(x=>({v:x*Number(input.n)})), weird:'{{not a template}}'};" } },
  { id: 3, module: 'builtin:BasicFeeder', mapper: { array: '{{2.result.items}}' } },
  { id: 4, module: 'builtin:BasicAggregator', parameters: { feeder: 3 }, mapper: { v: '{{3.v}}' } },
  { id: 5, module: 'builtin:BasicRouter', routes: [
    { flow: [{ id: 6, module: 'datastore:AddRecord', parameters: { datastore: 999 }, mapper: { key: 'k', data: { sum: '{{join(map(4.array; "v"); "+")}}' } } }] },
    { flow: [{ id: 7, module: 'http:MakeRequest', filter: { conditions: [[{ a: '{{length(4.array)}}', b: '3', o: 'number:equal' }]] }, mapper: { url: 'https://example.com', method: 'post', contentType: 'json', inputMethod: 'jsonString', jsonStringBodyContent: '{"x":1}' } }] },
  ] },
] } };
(async () => {
  const r = await engine.run(sc, { type: 'webhook', body: { n: 2 } }, { dry: true });
  assert.strictEqual(r.status, 'success', JSON.stringify(r.error));
  const ds = require('../src/store').ds(999, true);
  assert.strictEqual(ds.records.k.sum, '2+4+6');
  assert.strictEqual(r.actions.length, 1);
  assert.strictEqual(r.trace.find((t) => t.id === 2).out.result.weird, '{{not a template}}');
  console.log('engine test OK');
})().catch((e) => { console.error(e); process.exit(1); });
