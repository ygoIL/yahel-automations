// ToChat (custom Make app). Only the generic "Make an API call" is supported; base/auth from env.
const base = () => process.env.TOCHAT_BASE_URL || 'https://api.tochat.co.il/integrations/v1';
// HTTP Basic: username = tenant id, password = tenant integration API key.
function authHeaders() {
  const t = process.env.TOCHAT_TENANT || 'YahelCommunication', k = process.env.TOCHAT_API_KEY || '';
  return { Authorization: 'Basic ' + Buffer.from(`${t}:${k}`).toString('base64') };
}
async function call(mp) {
  const u = new URL(base() + (String(mp.url).startsWith('/') ? '' : '/') + mp.url);
  for (const q of mp.qs || []) if ((q.key ?? q.name)) u.searchParams.set(q.key ?? q.name, q.value);
  const method = String(mp.method || 'GET').toUpperCase();
  const h = { ...authHeaders(), 'Content-Type': 'application/json', Accept: 'application/json' };
  for (const x of mp.headers || []) if (x.key ?? x.name) h[x.key ?? x.name] = x.value;
  let body = mp.body; if (body !== undefined && body !== null && typeof body !== 'string') body = JSON.stringify(body);
  const r = await fetch(u, { method, headers: h, body: /GET|HEAD/.test(method) ? undefined : body || undefined });
  const txt = await r.text(); let data; try { data = JSON.parse(txt); } catch { data = txt; }
  if (r.status >= 400) throw new Error(`ToChat ${r.status}: ${String(txt).slice(0, 400)}`);
  return { body: data, headers: Object.fromEntries(r.headers), statusCode: r.status };
}
const registerBase = (reg) => {
  reg('tochat:makeAnApiCall', { write: true, readOnlyWhen: (mp) => /^get$/i.test(mp.method || 'GET'), dryResult: () => ({ body: {}, statusCode: 200 }), run: call });
};

module.exports.call = call;

// ---- ToChat app modules (Make "ToChat" custom app) mapped to the integrations API ----
const T = () => process.env.TOCHAT_TENANT || 'YahelCommunication';
const enc = encodeURIComponent;
const clean = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v !== undefined && v !== null && v !== ''));
const W = { write: true, dryResult: () => ({ created: [], updated: [], failed: [] }) };
const registerApp = (reg) => {
  reg('tochat:GetCampaigns', { multi: true, run: async () => { const r = await call({ url: '/campaigns', method: 'GET' }); return Array.isArray(r.body) ? r.body : []; } });
  reg('tochat:AddLeadsToCampaign2', { ...W, run: async (mp) => {
    const customers = (Array.isArray(mp.customers) ? mp.customers : []).map((c) => { const o = clean(c); if (o.customLeadFields && !Object.keys(o.customLeadFields).length) delete o.customLeadFields; return o; });
    const ds = clean(mp.dataSource); if (ds.priority !== undefined) ds.priority = Number(ds.priority);
    for (const k of ['newCustomersOnly', 'shouldCheckWithDontCallMe', 'shouldOverrideCustomerData']) if (k in ds) ds[k] = ds[k] === true || ds[k] === 'true';
    return (await call({ url: `/tenants/${T()}/campaigns/${enc(mp.campaignId)}/customers`, method: 'POST', body: { customers, dataSource: ds } })).body;
  } });
  const page = (kind) => async (mp) => {
    const qs = [{ key: 'limit', value: String(mp.limit || 50000) }]; if (mp.pageToken) qs.push({ key: 'pageToken', value: mp.pageToken });
    if (kind === 'closedLeads') qs.push({ key: 'start', value: mp.start }, { key: 'end', value: mp.end });
    return (await call({ url: `/tenants/${T()}/campaigns/${enc(mp.campaignId)}/${kind}`, method: 'GET', qs })).body;
  };
  reg('tochat:GetOpenLeadsPage', { run: page('openLeads') });
  reg('tochat:GetClosedLeadsPage', { run: page('closedLeads') });
  reg('tochat:GetOpenLeads', { multi: true, run: async (mp) => { const r = await call({ url: `/tenants/${T()}/campaigns/${enc(mp.campaignId)}/openLeads`, method: 'GET' }); return Array.isArray(r.body) ? r.body : (r.body.leads || []); } });
  reg('tochat:GetClosedLeads', { multi: true, run: async (mp) => { const r = await call({ url: `/tenants/${T()}/campaigns/${enc(mp.campaignId)}/closedLeads`, method: 'GET', qs: [{ key: 'start', value: mp.start }, { key: 'end', value: mp.end }] }); return Array.isArray(r.body) ? r.body : (r.body.leads || []); } });
  reg('tochat:AddDenyListItem', { ...W, run: async (mp) => (await call({ url: `/tenants/${T()}/deny-list`, method: 'POST', body: { items: (mp.items || []).map((i) => ({ phone: String(i.phone || ''), name: i.name === '' ? null : i.name ?? null, note: i.note === '' ? null : i.note ?? null })), dataSource: clean(mp.dataSource) } })).body });
  reg('tochat:MarkLeadAsDone', { ...W, run: async (mp) => (await call({ url: `/tenants/${T()}/campaigns/${enc(mp.campaignId)}/done`, method: 'POST', body: clean({ phone: mp.phone, reason: mp.reason, note: mp.note ?? '', subReasonId: mp.subReasonId, repEmail: mp.repEmail }) })).body });
  reg('tochat:UpdateLead2', { ...W, run: async (mp) => {
    const b = clean({ phone: mp.phone, priority: mp.priority, externalId: mp.externalId, notes: mp.notes, audience: mp.audience, followDate: mp.followDate, followByEmail: mp.followByEmail, subStatus: mp.subStatus });
    if (b.priority !== undefined) b.priority = Number(b.priority);
    return (await call({ url: `/tenants/${T()}/campaigns/${enc(mp.campaignId)}/customers`, method: 'PATCH', body: b })).body;
  } });
};

module.exports = (reg) => { registerBase(reg); registerApp(reg); };
module.exports.call = call;
