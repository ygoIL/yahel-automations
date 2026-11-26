// Green API sends from the existing bot line (same instance wa-gateway uses).
const { E, post, log } = require('./lib');
const base = () => E.GREEN_BASE, tok = () => E.GREEN_TOKEN;

function chat(phoneOrChat) {
  let s = String(phoneOrChat || '');
  if (s.includes('@')) return s;
  s = s.replace(/\D/g, ''); if (s.startsWith('0')) s = '972' + s.slice(1); else if (s.length === 9) s = '972' + s;
  return s + '@c.us';
}
async function text(to, message) {
  let r; try { r = await post(`${base()}/sendMessage/${tok()}`, { chatId: chat(to), message }, 30000); } catch (e) { log({ ev: 'wa_text_err', err: String(e) }); return null; }
  if (!(r.data && r.data.idMessage)) log({ ev: 'wa_text_fail', status: r.status, resp: JSON.stringify(r.data).slice(0, 200) });
  return r.data && r.data.idMessage;
}
async function file(to, url, fileName, caption) {
  let r; try { r = await post(`${base()}/sendFileByUrl/${tok()}`, { chatId: chat(to), urlFile: url, fileName, caption }, 60000); } catch (e) { log({ ev: 'wa_file_err', err: String(e) }); return null; }
  if (!(r.data && r.data.idMessage)) log({ ev: 'wa_file_fail', status: r.status, resp: JSON.stringify(r.data).slice(0, 200) });
  return r.data && r.data.idMessage;
}
module.exports = { text, file, chat };
