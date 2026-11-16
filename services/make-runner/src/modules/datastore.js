// Make data stores, stored locally on the volume.
const store = require('../store');
const { passes } = require('../filters');
const iml = require('../iml');
module.exports = (reg) => {
  const S = (rt, id) => store.ds(id, rt.dry);
  const W = (rt, id, v) => store.dsSave(id, v, rt.dry);
  reg('datastore:AddRecord', { run: (mp, p, { rt }) => {
    const d = S(rt, p.datastore); const key = mp.key == null || mp.key === '' ? require('crypto').randomUUID() : String(mp.key);
    if (d.records[key] && mp.overwrite === false) throw new Error(`The record with key '${key}' already exists`);
    d.records[key] = clean(mp.data); W(rt, p.datastore, d); return { key, data: d.records[key] };
  } });
  reg('datastore:UpdateRecord', { run: (mp, p, { rt }) => {
    const d = S(rt, p.datastore); const key = String(mp.key);
    if (!d.records[key] && mp.upsert === false) throw new Error(`Record '${key}' not found`);
    d.records[key] = { ...(d.records[key] || {}), ...clean(mp.data) }; W(rt, p.datastore, d); return { key, data: d.records[key] };
  } });
  reg('datastore:GetRecord', { run: (mp, p, { rt }) => {
    const d = S(rt, p.datastore); const key = String(mp.key ?? ''); const rec = d.records[key];
    if (!rec) return {};
    return mp.returnWrapped ? { key, data: rec } : { ...rec };
  } });
  reg('datastore:ExistRecord', { run: (mp, p, { rt }) => ({ exists: !!S(rt, p.datastore).records[String(mp.key)] }) });
  reg('datastore:DeleteRecord', { run: (mp, p, { rt }) => { const d = S(rt, p.datastore); delete d.records[String(mp.key)]; W(rt, p.datastore, d); return {}; } });
  reg('datastore:DeleteAll', { run: (mp, p, { rt }) => { W(rt, p.datastore, { records: {} }); return {}; } });
  reg('datastore:CountRecords', { run: (mp, p, { rt }) => ({ count: Object.keys(S(rt, p.datastore).records).length }) });
  reg('datastore:SearchRecord', { multi: true, rawMapper: true, run: (raw, p, { rt, resolve }) => {
    const d = S(rt, p.datastore);
    let rows = Object.entries(d.records).map(([key, data]) => ({ key, data }));
    const conds = raw.filter || [];
    rows = rows.filter((r) => passes(conds.map((g) => g.map((c) => ({ ...c, a: '__F:' + c.a }))), (v) => {
      if (typeof v === 'string' && v.startsWith('__F:')) { const f = v.slice(4); return f === 'key' ? r.key : iml.getPath(r.data, f.split('.')); }
      return resolve(v);
    }));
    for (const s of [...(raw.sort || [])].reverse()) { const k = s.key; rows.sort((a, b) => iml.cmp(k === 'key' ? a.key : a.data[k], k === 'key' ? b.key : b.data[k]) * (String(s.order) === '-1' || s.order === 'desc' ? -1 : 1)); }
    const limit = Number(raw.limit ?? p.limit) || 0; if (limit) rows = rows.slice(0, limit);
    if (!rows.length && p.continueWhenNoRes) return [{}];
    return rows.map((r, i) => ({ ...r, __IMTINDEX__: i + 1, __IMTLENGTH__: rows.length }));
  } });
};
function clean(o) { const r = {}; for (const [k, v] of Object.entries(o || {})) if (v !== undefined) r[k] = v instanceof Date ? v.toISOString() : v; return r; }
