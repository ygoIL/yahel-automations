// End-to-end test with fake Green API / Claude / Instagram. Usage: node test/e2e.js <video|image> [...]
// Checks: claim routing, batching, render with on-screen text, preview to Yarden, correction, single publish, no double publish.
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const { spawn } = require('child_process');
const files = process.argv.slice(2);
if (!files.length) { console.error('usage: node test/e2e.js file...'); process.exit(2); }
const sent = [], igCalls = []; let claudeCalls = 0;
const FAKE = 18181, APP = 18180, KEY = 'test';
const fake = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    const j = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url.startsWith('/file/')) { const f = files[+req.url.split('/')[2]]; res.writeHead(200); return fs.createReadStream(f).pipe(res); }
    if (req.url.includes('/sendMessage/') || req.url.includes('/sendFileByUrl/')) { sent.push(JSON.parse(b)); return j({ idMessage: 'm' + sent.length }); }
    if (req.url === '/v1/messages') {
      claudeCalls++;
      const fix = claudeCalls > 1;
      return j({ content: [{ type: 'text', text: JSON.stringify({ caption: fix ? 'חמישי שמח מתוקן 🥁 #יהלתקשורת' : 'חמישי שמח… לא נשאר מקום ברכב 😂🍔🥁 #יהלתקשורת #דרושים',
        overlays: [['כל חמישי', 'אנחנו מפנקים את הצוות'], ['רוצים להצטרף?', 'מגייסים עכשיו בנהריה']], song: 'נועה קירל – טרנד', exclude: [], warning: '' }) }] });
    }
    if (req.url.includes('/media_publish')) { igCalls.push('publish'); return j({ id: 'MEDIA' + igCalls.length }); }
    if (req.url.includes('/media')) { igCalls.push(JSON.parse(b).media_type); return j({ id: 'C' + igCalls.length }); }
    if (req.url.includes('status_code')) return j({ status_code: 'FINISHED' });
    if (req.url.includes('permalink')) return j({ permalink: 'https://instagram.com/reel/TEST' });
    j({});
  });
}).listen(FAKE);
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'social-'));
const env = { ...process.env, PORT: APP, SOCIAL_KEY: KEY, DATA_DIR: data, BATCH_QUIET_SEC: '2', PUBLIC_URL: `http://127.0.0.1:${APP}`,
  GREEN_BASE: `http://127.0.0.1:${FAKE}`, GREEN_TOKEN: 't', ANTHROPIC_API_KEY: 'k', ANTHROPIC_URL: `http://127.0.0.1:${FAKE}`, IG_TOKEN: 'ig', IG_GRAPH: `http://127.0.0.1:${FAKE}` };
const app = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'inherit'] });
let logs = ''; app.stdout.on('data', (c) => (logs += c));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const claim = (p) => fetch(`http://127.0.0.1:${APP}/claim?key=${KEY}`, { method: 'POST', body: JSON.stringify(p) }).then((r) => r.json());
const msg = (sender, md) => ({ typeWebhook: 'incomingMessageReceived', idMessage: Math.random().toString(36), senderData: { chatId: sender + '@c.us', sender: sender + '@c.us' }, messageData: md });
const Y = '972504445169', REP = '972521111111';
const ok = (c, m) => { if (!c) { console.error('FAIL', m, '\n', logs.slice(-2000)); process.exit(1); } console.log('ok -', m); };

(async () => {
  await sleep(800);
  ok(!(await claim(msg(REP, { typeMessage: 'textMessage', textMessageData: { textMessage: 'מה הסטטוס של לקוח?' } }))).handled, 'rep message not claimed');
  ok(!(await claim(msg(Y, { typeMessage: 'textMessage', textMessageData: { textMessage: 'מה המצב של הקדמה 123456' } }))).handled, 'normal Yarden text not claimed');
  ok(!(await claim(msg(Y, { typeMessage: 'imageMessage', fileMessageData: { downloadUrl: 'x', caption: 'עסקה חדשה' } }))).handled, 'image without סושיאל not claimed');
  for (let i = 0; i < files.length; i++) {
    const vid = /\.(mov|mp4)$/i.test(files[i]);
    const r = await claim(msg(Y, { typeMessage: vid ? 'videoMessage' : 'imageMessage', fileMessageData: { downloadUrl: `http://127.0.0.1:${FAKE}/file/${i}`, fileName: path.basename(files[i]), caption: i === 0 ? 'סושיאל חמישי שמח, הבאנו מקדונלדס' : '' } }));
    ok(r.handled, `media ${i} claimed`);
  }
  for (let t = 0; t < 120 && !sent.some((s) => s.urlFile); t++) await sleep(1000);
  const prev = sent.find((s) => s.urlFile); ok(prev && /🎬 סושיאל #/.test(prev.caption), 'preview with video sent to Yarden');
  ok(prev.chatId === Y + '@c.us', 'preview goes to Yarden');
  const id = prev.caption.match(/סושיאל #(\w+)/)[1];
  const vid = await fetch(prev.urlFile); ok(vid.status === 200, 'public media URL serves the video');
  fs.writeFileSync(path.join(__dirname, 'out-preview.mp4'), Buffer.from(await vid.arrayBuffer()));
  // correction
  ok((await claim(msg(Y, { typeMessage: 'extendedTextMessage', extendedTextMessageData: { text: 'תוסיף שזה כל חמישי' }, quotedMessage: { caption: prev.caption } }))).handled, 'correction claimed via quote');
  for (let t = 0; t < 90 && sent.filter((s) => s.urlFile).length < 2; t++) await sleep(1000);
  ok(sent.filter((s) => s.urlFile).length === 2 && claudeCalls === 2, 'corrected preview re-sent');
  // approve twice -> one publish
  ok((await claim(msg(Y, { typeMessage: 'textMessage', textMessageData: { textMessage: 'כן' } }))).handled, 'bare כן claimed');
  await sleep(300);
  await claim(msg(Y, { typeMessage: 'extendedTextMessage', extendedTextMessageData: { text: 'כן' }, quotedMessage: { caption: prev.caption } }));
  for (let t = 0; t < 30 && !sent.some((s) => /עלה לאינסטגרם/.test(s.message || '')); t++) await sleep(500);
  ok(igCalls.filter((x) => x === 'REELS').length === 1 && igCalls.filter((x) => x === 'STORIES').length === 1, 'exactly one reel + one story published: ' + igCalls.join(','));
  ok(sent.some((s) => /instagram.com\/reel\/TEST/.test(s.message || '')), 'link sent to Yarden');
  ok(!(await claim(msg(Y, { typeMessage: 'textMessage', textMessageData: { textMessage: 'כן' } }))).handled, 'later bare כן not claimed');
  console.log('ALL PASSED  (preview saved to test/out-preview.mp4, draft', id + ')');
  app.kill(); fake.close(); process.exit(0);
})().catch((e) => { console.error(e, logs.slice(-2000)); app.kill(); process.exit(1); });
