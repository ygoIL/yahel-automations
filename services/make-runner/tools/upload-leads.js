#!/usr/bin/env node
// CLI for the lead-upload tool running on Railway.
//   MAKE_RUNNER_URL=https://make-runner-production.up.railway.app ADMIN_KEY=... node tools/upload-leads.js dry 50 רותח בוסט
//   node tools/upload-leads.js confirm <runId>
//   node tools/upload-leads.js campaigns | log
const [cmd, ...a] = process.argv.slice(2);
const B = (process.env.MAKE_RUNNER_URL || 'https://make-runner-production.up.railway.app').replace(/\/$/, '');
const K = process.env.ADMIN_KEY;
if (!K) { console.error('ADMIN_KEY env var is required'); process.exit(1); }
const call = async (path, body) => {
  const r = await fetch(B + path, { method: body ? 'POST' : 'GET', headers: { 'x-admin-key': K, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
};
(async () => {
  let r;
  if (cmd === 'dry') r = await call('/admin/leads/upload', { count: Number(a[0]), tier: a[1], campaign: a.slice(2).join(' '), dryRun: true });
  else if (cmd === 'confirm') r = await call('/admin/leads/confirm', { runId: a[0] });
  else if (cmd === 'campaigns') r = await call('/admin/leads/campaigns');
  else if (cmd === 'log') r = await call('/admin/leads/log');
  else { console.error('usage: dry <count> <tier> <campaign> | confirm <runId> | campaigns | log'); process.exit(1); }
  while (r && r.status === 'running' && r.id) { await new Promise((x) => setTimeout(x, 5000)); r = await call(`/admin/leads/job/${r.id}`); }
  console.log(JSON.stringify(r, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
