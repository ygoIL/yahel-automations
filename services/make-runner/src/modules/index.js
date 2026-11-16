// Module registry. Each module: { run(mapper, params, rt) , multi?, write?, dryResult?, trigger?, rawMapper? }
const iml = require('../iml');
const store = require('../store');
const R = {};
const reg = (names, def) => { for (const n of [].concat(names)) R[n] = def; };
const get = (name) => R[name] || R[name.replace(/^app#[^:]+:/, 'tochat:')];

// ---------------- builtin / util / json / regexp ----------------
reg('builtin:BasicFeeder', { multi: true, run: (mp) => {
  const a = Array.isArray(mp.array) ? mp.array : mp.array == null || mp.array === '' ? [] : [mp.array];
  return a.map((it, i) => ({ ...(it && typeof it === 'object' && !Array.isArray(it) ? it : { value: it }), __IMTINDEX__: i + 1, __IMTLENGTH__: a.length }));
} });
reg('util:FunctionSleep', { run: async (mp) => { await new Promise((r) => setTimeout(r, Math.min(300, Number(mp.duration) || 0) * 1000)); return {}; } });
reg('util:SetVariable2', { run: (mp) => ({ [mp.name]: mp.value }) });
reg('util:SetVariables', { run: (mp) => Object.fromEntries((mp.variables || []).map((v) => [v.name, v.value])) });
reg('util:GetVariable2', { run: () => ({}) });
reg('util:ComposeTransformer', { run: (mp) => ({ value: mp.value }) });
reg('json:TransformToJSON', { run: (mp, p) => ({ json: JSON.stringify(mp.object === undefined ? null : mp.object, null, p && p.space ? Number(p.space) || p.space : undefined) }) });
reg('json:ParseJSON', { run: (mp) => { const v = typeof mp.json === 'string' ? JSON.parse(mp.json) : mp.json; return v && typeof v === 'object' && !Array.isArray(v) ? v : { array: v }; } });
reg('regexp:Parser', { multi: true, run: (mp, p) => {
  const flags = (p.global ? 'g' : '') + (p.sensitive === false ? 'i' : '') + (p.multiline ? 'm' : '') + (p.singleline ? 's' : '');
  const re = new RegExp(p.pattern, flags.includes('g') ? flags : flags + 'g'); const text = iml.toStr(mp.text); const out = [];
  let m; let i = 0;
  while ((m = re.exec(text))) {
    const b = { i: ++i }; m.forEach((v, k) => { if (k > 0) b['$' + k] = v; }); Object.assign(b, m.groups || {}); out.push(b);
    if (!p.global) break; if (m[0] === '') re.lastIndex++;
  }
  if (!out.length && p.continueWhenNoRes) return [{}];
  return out;
} });
reg('regexp:Replace', { run: (mp, p) => ({ text: iml.toStr(mp.text).replace(new RegExp(p.pattern, (p.global ? 'g' : '') + (p.sensitive === false ? 'i' : '')), iml.toStr(mp.value)) }) });
reg('phonenumber:TransformerParseNumber', { run: (mp) => {
  // Minimal Israeli/E.164 parser (Make uses libphonenumber).
  let d = iml.toStr(mp.number).replace(/[^\d+]/g, ''); const cc = (mp.defaultCountry || 'IL').toUpperCase();
  let intl = d.startsWith('+') ? d.slice(1) : d.startsWith('00') ? d.slice(2) : (cc === 'IL' && d.startsWith('0') ? '972' + d.slice(1) : (cc === 'IL' && /^5\d{8}$/.test(d) ? '972' + d : d));
  const valid = /^972(5\d{8}|[2-9]\d{7})$/.test(intl);
  const national = intl.startsWith('972') ? '0' + intl.slice(3) : intl;
  return { valid, possible: valid, countryCode: intl.startsWith('972') ? '972' : '', nationalNumber: intl.startsWith('972') ? intl.slice(3) : intl, e164: '+' + intl, international: '+' + intl, national, rfc3966: 'tel:+' + intl, type: /^9725/.test(intl) ? 'MOBILE' : 'FIXED_LINE', region: valid ? 'IL' : '' };
} });

// ---------------- code (Make "Code" app) ----------------
const vm = require('vm');
reg('code:ExecuteCode', { rawMapper: true, run: (raw, p, { resolve }) => {
  const input = {}; for (const it of raw.input || []) input[it.name] = resolve(it.value);
  const code = raw.codeEditorJavascript || raw.code || '';
  const sandbox = { input, console: { log: () => {}, error: () => {} }, JSON, Math, Date, Intl, RegExp, String, Number, Array, Object, Boolean, parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent, escape, unescape, Buffer, Set, Map };
  const result = vm.runInNewContext(`(function(input){\n${code}\n})(input)`, sandbox, { timeout: 10000 });
  return { result: result === undefined ? null : JSON.parse(JSON.stringify(result)) };
} });

// ---------------- HTTP ----------------
const http = require('./http');
reg('http:MakeRequest', { write: true, readOnlyWhen: (mp) => /^(get|head)$/i.test(mp.method || 'get'), dryResult: () => ({ data: {}, statusCode: 200, headers: {} }), run: http.makeRequest });
reg('http:ActionSendData', { write: true, readOnlyWhen: (mp) => /^(get|head)$/i.test(mp.method || 'get'), dryResult: () => ({ data: {}, statusCode: 200, headers: {} }), run: http.sendData });
reg('http:ActionGetFile', { run: http.getFile });

// ---------------- Webhooks ----------------
reg('gateway:CustomWebHook', { trigger: (trig) => { const b = trig.body; if (Array.isArray(b)) return b.map((x) => (x && typeof x === 'object' ? x : { value: x })); return [b && typeof b === 'object' ? b : {}]; } });
reg('gateway:WebhookRespond', { run: (mp, p, { rt }) => {
  let body = mp.body; rt.response = { status: Number(mp.status) || 200, body: body == null ? '' : body, headers: Object.fromEntries((mp.headers || []).map((h) => [h.key ?? h.name, h.value])) }; return {};
} });

// ---------------- Data stores (local) ----------------
require('./datastore')(reg);
// ---------------- Google ----------------
require('./gsheets')(reg);
// ---------------- ManyChat / ToChat / mail / ElevenLabs ----------------
require('./manychat')(reg);
require('./tochat')(reg);
require('./mail')(reg);
require('./elevenlabs')(reg);

// ---------------- aggregators ----------------
async function aggregate(agg, collected, ctx, rt) {
  rt.ops++;
  if (agg.module === 'builtin:BasicAggregator') {
    const items = collected.map((c) => { const mp = agg.mapper || {}; return Object.keys(mp).length ? iml.resolve(mp, c) : c.outputs[String(agg.parameters.feeder)]; });
    return { array: items, __IMTAGGLENGTH__: items.length };
  }
  if (agg.module === 'util:TextAggregator') {
    const sepMap = { '\\n': '\n', newline: '\n', tab: '\t' };
    const p = iml.resolve(agg.parameters || {}, ctx); const sep = p.rowSeparator ? (p.rowSeparator === 'other' ? (p.otherRowSeparator || '') : (sepMap[p.rowSeparator] ?? p.rowSeparator)) : '';
    return { text: collected.map((c) => iml.toStr(iml.resolve((agg.mapper || {}).value, c))).join(sep), __IMTAGGLENGTH__: collected.length };
  }
  if (agg.module === 'util:NumAggregator') {
    const v = collected.map((c) => iml.toNum(iml.resolve((agg.mapper || {}).value, c)));
    const fn = (agg.parameters || {}).fn || 'SUM'; const s = v.reduce((a, b) => a + b, 0);
    return { result: fn === 'AVG' ? s / (v.length || 1) : fn === 'COUNT' ? v.length : fn === 'MAX' ? Math.max(...v) : fn === 'MIN' ? Math.min(...v) : s };
  }
  if (agg.module === 'json:AggregateToJSON') {
    const items = collected.map((c) => iml.resolve(agg.mapper || {}, c)); return { json: JSON.stringify(items) };
  }
  throw new Error('Aggregator not supported: ' + agg.module);
}
module.exports = { get, aggregate, list: () => Object.keys(R) };
