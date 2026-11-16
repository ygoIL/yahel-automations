// Offline engine test: runs the Shabbat-gate scenario (10125129) in dry mode with a fake webhook.
process.env.DATA_DIR = require('path').join(__dirname, '.data');
process.env.GATEWAY_KEY = 'test';
const engine = require('../src/engine');
const sc = require('../src/scenarios').all()['10125129'];
(async () => {
  const r = await engine.run(sc, { type: 'webhook', body: { phone: '0501234567', message: 'בדיקה', source: 'test' } }, { dry: true });
  console.log(JSON.stringify({ status: r.status, error: r.error, ops: r.ops, actions: r.actions, trace: r.trace.map((t) => [t.id, t.module, t.bundles, t.error]) }, null, 1));
})();
