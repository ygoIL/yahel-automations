// Make "IML" formula evaluator: {{ 1.data.x }}, functions (formatDate, ifempty, replace, map, ...), operators.
const dates = require('./dates');

// ---------- template splitting ----------
// Splits "abc {{expr}} def" into parts, respecting quotes inside {{ }}.
function splitTemplate(s) {
  const parts = []; let i = 0, buf = '';
  while (i < s.length) {
    if (s[i] === '{' && s[i + 1] === '{') {
      let j = i + 2, depth = 0, q = false;
      for (; j < s.length; j++) {
        const c = s[j];
        if (q) { if (c === '\\') { j++; continue; } if (c === '"') q = false; continue; }
        if (c === '"') { q = true; continue; }
        if (c === '(') depth++; else if (c === ')') depth--;
        else if (c === '}' && s[j + 1] === '}' && depth <= 0) break;
      }
      if (j >= s.length) { buf += s.slice(i); break; }
      if (buf) parts.push(buf); buf = '';
      parts.push({ expr: s.slice(i + 2, j) });
      i = j + 2;
    } else { buf += s[i++]; }
  }
  if (buf) parts.push(buf);
  return parts;
}

// ---------- tokenizer ----------
function tokenize(src) {
  const t = []; let i = 0;
  const isId = (c) => /[\p{L}\p{N}_$@#\-]/u.test(c);
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"') { let j = i + 1, v = ''; while (j < src.length && src[j] !== '"') { if (src[j] === '\\' && src[j + 1] === '"') { v += '"'; j += 2; continue; } v += src[j++]; } t.push({ k: 'str', v }); i = j + 1; continue; }
    if (c === '`') { let j = src.indexOf('`', i + 1); if (j < 0) j = src.length; t.push({ k: 'bq', v: src.slice(i + 1, j) }); i = j + 1; continue; }
    if ('();[],'.includes(c)) { t.push({ k: c }); i++; continue; }
    if (c === '.') { t.push({ k: '.' }); i++; continue; }
    const two = src.slice(i, i + 2);
    if (['!=', '<=', '>=', '&&', '||'].includes(two)) { t.push({ k: 'op', v: two }); i += 2; continue; }
    if ('+*/%=<>&|'.includes(c) || (c === '-' && !/\d/.test(src[i + 1] || '') )) { t.push({ k: 'op', v: c }); i++; continue; }
    if (/\d/.test(c) || (c === '-' && /\d/.test(src[i + 1]))) {
      let j = i + 1; while (j < src.length && /\d/.test(src[j])) j++;
      if (src[j] === '.' && /\d/.test(src[j + 1] || '')) { j++; while (j < src.length && /\d/.test(src[j])) j++; }
      // a number followed by '.' + identifier is a module reference like 1.data
      t.push({ k: 'num', v: src.slice(i, j) }); i = j; continue;
    }
    if (isId(c)) { let j = i; while (j < src.length && isId(src[j])) j++; t.push({ k: 'id', v: src.slice(i, j) }); i = j; continue; }
    // unknown char: treat as part of identifier
    t.push({ k: 'id', v: c }); i++;
  }
  return t;
}

// ---------- parser ----------
const PREC = { '||': 1, '|': 1, '&&': 2, '&': 2, '=': 3, '!=': 3, '<': 3, '>': 3, '<=': 3, '>=': 3, '+': 4, '-': 4, '*': 5, '/': 5, '%': 5 };
function parse(src) {
  const t = tokenize(src); let p = 0;
  const peek = () => t[p]; const next = () => t[p++];
  function expr(minP = 0) {
    let left = unary();
    while (peek() && peek().k === 'op' && PREC[peek().v] > minP) {
      const op = next().v; const right = expr(PREC[op]);
      left = { type: 'bin', op, left, right };
    }
    return left;
  }
  function unary() { return postfix(primary()); }
  function primary() {
    const tk = next(); if (!tk) return { type: 'lit', v: undefined };
    if (tk.k === 'str') return { type: 'lit', v: tk.v };
    if (tk.k === '(') { const e = expr(); if (peek() && peek().k === ')') next(); return e; }
    if (tk.k === 'num') {
      // module reference? "12.result.kind" → num "12.result"? tokenizer splits on '.', so check next is '.'
      if (/^\d+$/.test(tk.v) && peek() && peek().k === '.') return { type: 'ref', path: [tk.v] };
      if (/^\d+\.\d+$/.test(tk.v) === false && /^\d+\.$/.test(tk.v)) return { type: 'ref', path: [tk.v.slice(0, -1)] };
      return { type: 'lit', v: Number(tk.v) };
    }
    if (tk.k === 'bq') return { type: 'ref', path: [tk.v] };
    if (tk.k === 'id') {
      if (peek() && peek().k === '(') { // function call
        next(); const args = [];
        if (peek() && peek().k === ')') { next(); return { type: 'call', name: tk.v, args }; }
        while (p < t.length) { args.push(expr()); const sep = next(); if (!sep || sep.k === ')') break; }
        return { type: 'call', name: tk.v, args };
      }
      const kw = { true: true, false: false, null: null, emptystring: '', emptyarray: [], pi: Math.PI };
      if (Object.prototype.hasOwnProperty.call(kw, tk.v) && !(peek() && peek().k === '.')) return { type: 'lit', v: Array.isArray(kw[tk.v]) ? [] : kw[tk.v] };
      if (tk.v === 'now' && !(peek() && peek().k === '.')) return { type: 'now' };
      if (tk.v === 'timestamp') return { type: 'call', name: '__timestamp', args: [] };
      if (tk.v === 'random') return { type: 'call', name: '__random', args: [] };
      return { type: 'ref', path: [tk.v] };
    }
    return { type: 'lit', v: tk.v };
  }
  function postfix(node) {
    while (peek()) {
      if (peek().k === '.' && node.type !== 'ref' && (node.type === 'index' || node.type === 'call' || node.type === 'sub')) {
        next(); const n = next(); if (!n) break;
        if (node.type !== 'sub') node = { type: 'sub', obj: node, path: [] };
        node.path.push(...String(n.v).split('.')); continue;
      }
      if (peek().k === '.' && node.type === 'ref') {
        next(); const n = next(); if (!n) break;
        if (n.k === 'num' && /^\d+\.\d+$/.test(n.v)) { // "a.1.2" tokenized as num 1.2
          node.path.push(...n.v.split('.')); continue;
        }
        node.path.push(n.v); continue;
      }
      if (peek().k === '[') { next(); const idx = expr(); if (peek() && peek().k === ']') next(); node = { type: 'index', obj: node, idx }; continue; }
      break;
    }
    return node;
  }
  const e = expr();
  return e;
}

// ---------- evaluation ----------
const isEmpty = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
function getPath(obj, path) {
  let cur = obj;
  for (const seg of path) {
    if (cur == null) return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(seg) && !(seg in cur && cur.length > 9999)) { cur = cur[Number(seg) - 1] !== undefined && Number(seg) >= 1 ? cur[Number(seg) - 1] : undefined; continue; }
    if (Array.isArray(cur) && !/^\d+$/.test(seg)) { cur = cur.map((x) => (x == null ? undefined : x[seg])); continue; }
    cur = cur[seg];
  }
  return cur;
}
function toStr(v) {
  if (v === undefined || v === null) return '';
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(toStr).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
function toNum(v) { if (typeof v === 'number') return v; if (v === '' || v == null) return NaN; const n = Number(String(v).trim()); return n; }
function looseEq(a, b) {
  if (a === b) return true;
  if (typeof a === 'boolean' || typeof b === 'boolean') return String(a) === String(b);
  if (typeof a === 'number' || typeof b === 'number') { const x = toNum(a), y = toNum(b); if (!isNaN(x) && !isNaN(y)) return x === y; }
  if (a instanceof Date || b instanceof Date) return toStr(a) === toStr(b);
  if (a == null && b == null) return true;
  if ((a == null && b === '') || (b == null && a === '')) return true;
  return toStr(a) === toStr(b);
}
function truthy(v) { if (v === 'false' || v === '0') return false; if (Array.isArray(v)) return v.length > 0; return !!v; }

function evaluate(node, ctx) {
  switch (node.type) {
    case 'lit': return node.v;
    case 'now': return new Date();
    case 'ref': {
      const [head, ...rest] = node.path;
      if (head === 'var') { // var.input.x / var.scenario.x
        if (rest[0] === 'input') return getPath(ctx.input || {}, rest.slice(1));
        if (rest[0] === 'scenario') return getPath(ctx.scenarioVars || {}, rest.slice(1));
        return undefined;
      }
      if (head === 'env') return process.env[rest.join('.')];
      if (/^\d+$/.test(head)) return getPath(ctx.outputs[head], rest);
      return getPath(ctx.scope || {}, node.path); // map()/sort() item scope
    }
    case 'sub': return getPath(evaluate(node.obj, ctx), node.path);
    case 'index': { const o = evaluate(node.obj, ctx); const i = toNum(evaluate(node.idx, ctx)); if (!Array.isArray(o)) return undefined; return o[i - 1]; }
    case 'bin': {
      const op = node.op;
      if (op === '&' || op === '&&') return truthy(evaluate(node.left, ctx)) && truthy(evaluate(node.right, ctx));
      if (op === '|' || op === '||') return truthy(evaluate(node.left, ctx)) || truthy(evaluate(node.right, ctx));
      const a = evaluate(node.left, ctx), b = evaluate(node.right, ctx);
      switch (op) {
        case '=': return looseEq(a, b);
        case '!=': return !looseEq(a, b);
        case '<': return cmp(a, b) < 0; case '>': return cmp(a, b) > 0;
        case '<=': return cmp(a, b) <= 0; case '>=': return cmp(a, b) >= 0;
        case '+': { if (a instanceof Date) return new Date(a.getTime() + toNum(b)); const x = toNum(a), y = toNum(b); if (typeof a !== 'string' && typeof b !== 'string' && !isNaN(x) && !isNaN(y)) return x + y; if (!isNaN(x) && !isNaN(y) && typeof a === 'number' && typeof b === 'number') return x + y; return toStr(a) + toStr(b); }
        case '-': return toNum(a) - toNum(b);
        case '*': return toNum(a) * toNum(b);
        case '/': return toNum(a) / toNum(b);
        case '%': return toNum(a) % toNum(b);
      }
      return undefined;
    }
    case 'call': return callFn(node, ctx);
  }
  return undefined;
}
function cmp(a, b) {
  const x = toNum(a), y = toNum(b);
  if (!isNaN(x) && !isNaN(y)) return x - y;
  const da = dates.toDate(a), db = dates.toDate(b);
  if (da && db) return da - db;
  return toStr(a).localeCompare(toStr(b));
}

function makeRegex(s) { const m = /^\/(.*)\/([gimsuy]*)$/s.exec(String(s)); return m ? new RegExp(m[1], m[2]) : null; }
function callFn(node, ctx) {
  const name = node.name;
  const lazy = { if: 1, ifempty: 1, switch: 1, map: 1, sort: 1 };
  const A = lazy[name] ? null : node.args.map((a) => evaluate(a, ctx));
  const ev = (i) => evaluate(node.args[i], ctx);
  const arr = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);
  switch (name) {
    case 'if': return truthy(ev(0)) ? ev(1) : (node.args.length > 2 ? ev(2) : undefined);
    case 'ifempty': { const a = ev(0); return isEmpty(a) ? ev(1) : a; }
    case 'switch': { const v = ev(0); let i = 1; for (; i + 1 < node.args.length; i += 2) if (looseEq(v, ev(i))) return ev(i + 1); return i < node.args.length ? ev(i) : undefined; }
    case 'map': { // map(array; key; [filterKey; filterValues])
      const a = arr(ev(0)); const key = toStr(ev(1)); const fk = node.args.length > 2 ? toStr(ev(2)) : null; const fv = node.args.length > 3 ? ev(3) : null;
      const fvs = fv == null ? null : (Array.isArray(fv) ? fv : String(fv).split(',')).map((x) => toStr(x).trim());
      return a.filter((it) => !fk || fvs.includes(toStr(getPath(it, fk.split('.'))))).map((it) => getPath(it, key.split('.')));
    }
    case 'sort': { const a = [...arr(ev(0))]; const order = node.args.length > 1 ? toStr(ev(1)) : 'asc'; const key = node.args.length > 2 ? toStr(ev(2)) : null; const g = (x) => (key ? getPath(x, key.split('.')) : x); a.sort((x, y) => cmp(g(x), g(y))); if (/desc/.test(order)) a.reverse(); return a; }
    case 'formatDate': return dates.formatDate(A[0], A[1], A[2]);
    case 'parseDate': return dates.parseDate(A[0], A[1], A[2]);
    case 'addSeconds': return dates.add(A[0], toNum(A[1]) * 1000);
    case 'addMinutes': return dates.add(A[0], toNum(A[1]) * 60000);
    case 'addHours': return dates.add(A[0], toNum(A[1]) * 3600000);
    case 'addDays': return dates.addCal(A[0], 'd', toNum(A[1]));
    case 'addMonths': return dates.addCal(A[0], 'm', toNum(A[1]));
    case 'addYears': return dates.addCal(A[0], 'y', toNum(A[1]));
    case 'setHour': case 'setMinute': case 'setSecond': case 'setDate': case 'setMonth': case 'setYear': return dates.set(A[0], name, toNum(A[1]));
    case 'replace': { const s = toStr(A[0]); const re = makeRegex(A[1]); const rep = toStr(A[2]); return re ? s.replace(re, rep.replace(/\$(\d)/g, '$$$1')) : s.split(toStr(A[1])).join(rep); }
    case 'trim': return toStr(A[0]).trim();
    case 'lower': return toStr(A[0]).toLowerCase();
    case 'upper': return toStr(A[0]).toUpperCase();
    case 'capitalize': { const s = toStr(A[0]); return s.charAt(0).toUpperCase() + s.slice(1); }
    case 'startcase': return toStr(A[0]).replace(/\b\w/g, (c) => c.toUpperCase());
    case 'length': { const v = A[0]; if (Array.isArray(v) || typeof v === 'string') return v.length; if (v && typeof v === 'object') return Object.keys(v).length; return toStr(v).length; }
    case 'split': return toStr(A[0]).split(toStr(A[1]));
    case 'join': return arr(A[0]).map(toStr).join(A.length > 1 ? toStr(A[1]) : ', ');
    case 'first': return arr(A[0])[0];
    case 'last': { const a = arr(A[0]); return a[a.length - 1]; }
    case 'slice': return arr(A[0]).slice(toNum(A[1]), A.length > 2 ? toNum(A[2]) : undefined);
    case 'flatten': return arr(A[0]).flat();
    case 'distinct': { const a = arr(A[0]); const key = A[1]; const seen = new Set(); return a.filter((x) => { const k = toStr(key ? getPath(x, toStr(key).split('.')) : x); if (seen.has(k)) return false; seen.add(k); return true; }); }
    case 'contains': return Array.isArray(A[0]) ? A[0].some((x) => looseEq(x, A[1])) : toStr(A[0]).includes(toStr(A[1]));
    case 'indexOf': return toStr(A[0]).indexOf(toStr(A[1]), A.length > 2 ? toNum(A[2]) : 0);
    case 'substring': return toStr(A[0]).substring(toNum(A[1]), A.length > 2 ? toNum(A[2]) : undefined);
    case 'add': return [...arr(A[0]), ...A.slice(1)];
    case 'remove': return arr(A[0]).filter((x) => !A.slice(1).some((y) => looseEq(x, y)));
    case 'merge': return A.flatMap(arr);
    case 'keys': return A[0] && typeof A[0] === 'object' ? Object.keys(A[0]) : [];
    case 'get': return getPath(A[0], toStr(A[1]).split('.'));
    case 'toString': return toStr(A[0]);
    case 'toArray': return A[0] && typeof A[0] === 'object' && !Array.isArray(A[0]) ? Object.entries(A[0]).map(([key, value]) => ({ key, value })) : arr(A[0]);
    case 'parseNumber': { let s = toStr(A[0]); const dec = A.length > 1 ? toStr(A[1]) : '.'; if (dec === ',') s = s.replace(/\./g, '').replace(',', '.'); else s = s.replace(/,/g, ''); const n = parseFloat(s.replace(/[^\d.\-eE]/g, '')); return isNaN(n) ? undefined : n; }
    case 'formatNumber': { const n = toNum(A[0]); const d = A.length > 1 ? toNum(A[1]) : 0; return n.toFixed(d); }
    case 'round': return Math.round(toNum(A[0]));
    case 'floor': return Math.floor(toNum(A[0]));
    case 'ceil': return Math.ceil(toNum(A[0]));
    case 'abs': return Math.abs(toNum(A[0]));
    case 'max': return Math.max(...A.flatMap(arr).map(toNum));
    case 'min': return Math.min(...A.flatMap(arr).map(toNum));
    case 'sum': return A.flatMap(arr).map(toNum).reduce((s, x) => s + (isNaN(x) ? 0 : x), 0);
    case 'average': { const a = A.flatMap(arr).map(toNum); return a.reduce((s, x) => s + x, 0) / (a.length || 1); }
    case 'stripHTML': return toStr(A[0]).replace(/<[^>]*>/g, '');
    case 'escapeHTML': return toStr(A[0]).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    case 'encodeURL': return encodeURIComponent(toStr(A[0]));
    case 'decodeURL': return decodeURIComponent(toStr(A[0]));
    case 'base64': return Buffer.from(toStr(A[0])).toString('base64');
    case 'toBinary': return Buffer.from(toStr(A[0]), A.length > 1 ? toStr(A[1]) : 'utf8');
    case 'sha256': case 'sha1': case 'md5': { const c = require('crypto').createHash(name).update(toStr(A[0])); return c.digest(A.length > 1 && toStr(A[1]) === 'base64' ? 'base64' : 'hex'); }
    case 'ascii': return toStr(A[0]).replace(/[^\x00-\x7F]/g, '');
    case 'not': return !truthy(A[0]);
    case 'emptyarray': return [];
    case '__timestamp': return Math.floor(Date.now() / 1000);
    case '__random': return Math.random();
    case 'uuid': return require('crypto').randomUUID();
    case 'isEmpty': return isEmpty(A[0]);
  }
  throw new Error(`IML function not supported: ${name}`);
}

// ---------- public API ----------
const cache = new Map();
function compile(expr) { let c = cache.get(expr); if (!c) { c = parse(expr); cache.set(expr, c); } return c; }
function evalExpr(expr, ctx) { return evaluate(compile(expr), ctx); }
// Resolve a mapper value: strings are templates; objects/arrays recurse.
function resolve(v, ctx) {
  if (typeof v === 'string') {
    if (!v.includes('{{')) return v;
    const parts = splitTemplate(v);
    if (parts.length === 1 && typeof parts[0] === 'object') return evalExpr(parts[0].expr, ctx);
    return parts.map((pt) => (typeof pt === 'string' ? pt : toStr(evalExpr(pt.expr, ctx)))).join('');
  }
  if (Array.isArray(v)) return v.map((x) => resolve(x, ctx));
  if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = resolve(x, ctx); return o; }
  return v;
}
module.exports = { resolve, evalExpr, toStr, toNum, looseEq, isEmpty, getPath, cmp, makeRegex, splitTemplate };
