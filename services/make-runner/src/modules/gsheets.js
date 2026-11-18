// Google Sheets / Drive modules (Make v2 semantics).
const g = require('../google');
const { passes } = require('../filters');
const iml = require('../iml');
const colIdx = (letters) => String(letters).toUpperCase().split('').reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
const colLetter = (i) => { let s = ''; i += 1; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
const sid = (x) => String(x || '').replace(/^\//, '').split('/').pop();
const q = (sheet) => `'${String(sheet).replace(/'/g, "''")}'`;
module.exports = (reg) => {
  reg('google-sheets:makeAPICall', {
    write: true, readOnlyWhen: (mp) => /^get$/i.test(mp.method || 'GET') || /batchGet|:batchGetByDataFilter/.test(mp.url || ''),
    dryResult: () => ({ body: {}, statusCode: 200, headers: {} }),
    run: (mp) => g.sheets({ url: mp.url, method: mp.method, qs: mp.qs, headers: mp.headers, body: mp.body }),
  });
  reg('google-sheets:filterRows', { multi: true, rawMapper: true, run: async (raw, p, { resolve }) => {
    const mp = resolve({ ...raw, filter: undefined });
    const id = sid(mp.spreadsheetId); const sheet = mp.sheetId;
    const firstRow = mp.tableFirstRow || 'A1:Z1';
    const m = /^([A-Z]+)(\d+):([A-Z]+)\d+$/i.exec(firstRow) || [null, 'A', '1', 'Z'];
    const startRow = Number(m[2]) + (mp.includesHeaders === false ? 0 : 1);
    const range = `${q(sheet)}!${m[1]}${startRow}:${m[3]}`;
    const r = await g.sheets({ url: `spreadsheets/${id}/values/${range}`, method: 'GET', qs: [{ key: 'valueRenderOption', value: mp.valueRenderOption || 'FORMATTED_VALUE' }, { key: 'dateTimeRenderOption', value: mp.dateTimeRenderOption || 'FORMATTED_STRING' }] });
    const off = colIdx(m[1]);
    let rows = (r.body.values || []).map((vals, i) => { const b = {}; vals.forEach((v, k) => { b[String(k + off)] = v; }); b.__ROW_NUMBER__ = startRow + i; b.__SPREADSHEET_ID__ = id; b.__SHEET__ = sheet; return b; });
    const conds = raw.filter || [];
    rows = rows.filter((row) => passes(conds.map((gp) => gp.map((c) => ({ ...c, a: '__C:' + c.a }))), (v) => (typeof v === 'string' && v.startsWith('__C:') ? row[String(colIdx(v.slice(4)))] : resolve(v))));
    if (mp.orderBy) { const k = String(colIdx(mp.orderBy)); rows.sort((a, b) => iml.cmp(a[k], b[k])); if (mp.sortOrder === 'desc') rows.reverse(); }
    const limit = Number(mp.limit) || 0; if (limit) rows = rows.slice(0, limit);
    return rows.map((row, i) => ({ ...row, __IMTINDEX__: i + 1, __IMTLENGTH__: rows.length }));
  } });
  reg('google-sheets:updateRow', { write: true, run: async (mp) => {
    const id = sid(mp.spreadsheetId); const row = Number(mp.rowNumber);
    const data = Object.entries(mp.values || {}).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => ({ range: `${q(mp.sheetId)}!${colLetter(Number(k))}${row}`, values: [[v instanceof Date ? v.toISOString() : v]] }));
    if (data.length) await g.sheets({ url: `spreadsheets/${id}/values:batchUpdate`, method: 'POST', body: { valueInputOption: mp.valueInputOption || 'USER_ENTERED', data } });
    return { ...(mp.values || {}), __ROW_NUMBER__: row };
  } });
  reg('google-sheets:addRow', { write: true, run: async (mp) => {
    const id = sid(mp.spreadsheetId); const vals = mp.values || {}; const max = Math.max(-1, ...Object.keys(vals).map(Number));
    const row = Array.from({ length: max + 1 }, (_, i) => (vals[i] === undefined || vals[i] === null ? '' : vals[i] instanceof Date ? vals[i].toISOString() : vals[i]));
    const sheet = mp.sheetId || 'Sheet1'; const firstCol = mp.tableFirstRow ? (/^([A-Z]+)/i.exec(mp.tableFirstRow) || [0, 'A'])[1] : 'A';
    const r = await g.sheets({ url: `spreadsheets/${id}/values/${q(sheet)}!${firstCol}1:append`, method: 'POST', qs: [{ key: 'valueInputOption', value: mp.valueInputOption || 'USER_ENTERED' }, { key: 'insertDataOption', value: mp.insertDataOption || 'INSERT_ROWS' }], body: { values: [row] } });
    const upd = (r.body.updates || {}).updatedRange || ''; const n = Number((/(\d+)(?::[A-Z]+\d+)?$/.exec(upd) || [])[1]) || undefined;
    return { ...vals, __ROW_NUMBER__: n, spreadsheetId: id, updatedRange: upd };
  } });
  reg('google-drive:makeApiCall', {
    write: true, readOnlyWhen: (mp) => /^get$/i.test(mp.method || 'GET'), dryResult: () => ({ body: {}, statusCode: 200 }),
    run: (mp) => g.drive({ url: mp.url, method: mp.method, qs: mp.qs, headers: mp.headers, body: mp.body }),
  });
  reg('google-drive:uploadAFile', { write: true, dryResult: () => ({ id: 'dry-run', name: 'dry-run' }), run: async (mp) => {
    const tok = await g.token(); const boundary = 'b' + Date.now();
    const meta = { name: mp.title || mp.filename, parents: mp.folderId && mp.folderId !== 'root' ? [String(mp.folderId).split('/').pop()] : undefined, mimeType: mp.convert ? mp.targetType : undefined };
    const data = Buffer.isBuffer(mp.data) ? mp.data : Buffer.from(typeof mp.data === 'string' ? mp.data : JSON.stringify(mp.data || ''), Buffer.isBuffer(mp.data) ? undefined : 'binary');
    const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`), data, Buffer.from(`\r\n--${boundary}--`)]);
    const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink&supportsAllDrives=true', { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': `multipart/related; boundary=${boundary}` }, body }).then((x) => x.json());
    if (r.error) {
      // A service account has no Drive storage of its own, so it cannot create files in a personal My Drive folder.
      // Keep the file on the Railway volume instead; GET /admin/files/<name> serves it to whoever uploads it with user credentials.
      if (/storage quota/i.test(JSON.stringify(r.error))) {
        const saved = require('../store').saveFile(meta.name + (/\.xlsx$/i.test(mp.filename || '') ? '.xlsx' : ''), data);
        return { id: null, name: meta.name, savedOnRailway: saved };
      }
      throw new Error('Drive upload: ' + JSON.stringify(r.error).slice(0, 300));
    }
    return r;
  } });
};
