const { qsToObj, hdrToObj } = require('../google');
// Calls to Make webhooks of scenarios that already run here are routed locally (no Make credits).
function localize(url) {
  const m = /^https:\/\/hook\.eu2\.make\.com\/([a-z0-9]+)(\?.*)?$/.exec(String(url));
  if (!m) return url;
  const sc = require('../scenarios').byHook(m[1]);
  if (sc && require('../scenarios').mode(sc) === 'live') return `http://127.0.0.1:${process.env.PORT || 8080}/hook/${m[1]}${m[2] || ''}`;
  return url;
}
async function doFetch(url, { method, headers, body, timeout, qs }) {
  const u = new URL(localize(url)); for (const [k, v] of Object.entries(qs || {})) u.searchParams.append(k, v);
  const r = await fetch(u, { method: method.toUpperCase(), headers, body: /^(GET|HEAD)$/i.test(method) ? undefined : body, signal: AbortSignal.timeout((Number(timeout) || 300) * 1000), redirect: 'follow' });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, headers: Object.fromEntries(r.headers), buf, type: r.headers.get('content-type') || '' };
}
function parse(res, parseResponse) {
  const txt = res.buf.toString('utf8');
  if (parseResponse !== false) { try { return JSON.parse(txt); } catch {} }
  return txt;
}
// http:MakeRequest (v4)
async function makeRequest(mp) {
  const method = (mp.method || 'get').toLowerCase();
  const headers = hdrToObj(mp.headers);
  let body;
  if (!/^(get|head)$/.test(method)) {
    const ct = mp.contentType || '';
    if (ct === 'json') {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      body = mp.inputMethod === 'dataStructure' ? JSON.stringify(mp.dataStructureBodyContent || {}) : (typeof mp.jsonStringBodyContent === 'string' ? mp.jsonStringBodyContent : JSON.stringify(mp.jsonStringBodyContent ?? {}));
    } else if (ct === 'urlEncoded') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(qsToObj(mp.urlEncodedBodyContent)).toString();
    } else if (ct === 'custom' || ct === 'raw') {
      body = mp.customBodyContent ?? mp.rawBodyContent ?? ''; if (mp.customContentType) headers['Content-Type'] = mp.customContentType;
    }
  }
  const res = await doFetch(mp.url, { method, headers, body, timeout: mp.timeout, qs: qsToObj(mp.qs) });
  const data = parse(res, mp.parseResponse);
  if (mp.stopOnHttpError !== false && res.status >= 400) throw new Error(`HTTP ${res.status}: ${String(typeof data === 'string' ? data : JSON.stringify(data)).slice(0, 500)}`);
  return { data, statusCode: res.status, headers: res.headers };
}
// http:ActionSendData (v3)
async function sendData(mp, p) {
  const method = (mp.method || 'get').toLowerCase();
  const headers = hdrToObj(mp.headers);
  let body;
  if (!/^(get|head)$/.test(method)) {
    if (mp.bodyType === 'x_www_form_urlencoded') { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(qsToObj(mp.formFields)).toString(); }
    else { body = mp.data == null ? '' : (typeof mp.data === 'string' ? mp.data : JSON.stringify(mp.data)); if (mp.contentType && !headers['Content-Type']) headers['Content-Type'] = mp.contentType; }
  }
  if (mp.authUser) headers.Authorization = 'Basic ' + Buffer.from(`${mp.authUser}:${mp.authPass || ''}`).toString('base64');
  const res = await doFetch(mp.url, { method, headers, body, timeout: mp.timeout, qs: qsToObj(mp.qs) });
  const data = parse(res, mp.parseResponse);
  if (p && p.handleErrors && res.status >= 400) throw new Error(`HTTP ${res.status}: ${String(typeof data === 'string' ? data : JSON.stringify(data)).slice(0, 500)}`);
  return { data, statusCode: res.status, headers: res.headers };
}
async function getFile(mp) { const res = await doFetch(mp.url, { method: 'get', headers: {} }); return { data: res.buf, fileName: mp.url.split('/').pop().split('?')[0], fileSize: res.buf.length }; }
module.exports = { makeRequest, sendData, getFile, doFetch };
