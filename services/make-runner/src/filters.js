// Make filter operators.
const { toStr, toNum, looseEq } = require('./iml');
const dates = require('./dates');
const exist = (v) => !(v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0));
function test(o, a, b) {
  const [type, op, ci] = String(o).split(':');
  if (type === 'exist') return exist(a);
  if (type === 'notexist') return !exist(a);
  const S = (x) => (ci === 'ci' ? toStr(x).toLowerCase() : toStr(x));
  switch (type) {
    case 'text':
      switch (op) {
        case 'equal': return S(a) === S(b);
        case 'notequal': return S(a) !== S(b);
        case 'contain': return S(a).includes(S(b));
        case 'notcontain': return !S(a).includes(S(b));
        case 'startwith': return S(a).startsWith(S(b));
        case 'notstartwith': return !S(a).startsWith(S(b));
        case 'endwith': return S(a).endsWith(S(b));
        case 'notendwith': return !S(a).endsWith(S(b));
        case 'pattern': return new RegExp(toStr(b), ci === 'ci' ? 'i' : '').test(toStr(a));
        case 'notpattern': return !new RegExp(toStr(b), ci === 'ci' ? 'i' : '').test(toStr(a));
        case 'empty': return toStr(a) === ''; case 'notempty': return toStr(a) !== '';
      }
      break;
    case 'number': {
      const x = toNum(a), y = toNum(b);
      switch (op) { case 'equal': return x === y; case 'notequal': return x !== y; case 'greater': return x > y; case 'less': return x < y; case 'greaterorequal': return x >= y; case 'lessorequal': return x <= y; }
      break;
    }
    case 'boolean': { const bool = (v) => v === true || v === 'true' || v === 1 || v === '1'; return op === 'equal' ? bool(a) === bool(b) : bool(a) !== bool(b); }
    case 'date': {
      const x = dates.toDate(a), y = dates.toDate(b); if (!x || !y) return false;
      switch (op) { case 'equal': return +x === +y; case 'notequal': return +x !== +y; case 'greater': return x > y; case 'less': return x < y; case 'greaterorequal': return x >= y; case 'lessorequal': return x <= y; }
      break;
    }
    case 'array': {
      const arr = Array.isArray(a) ? a : [];
      switch (op) { case 'contain': return arr.some((x) => looseEq(x, b)); case 'notcontain': return !arr.some((x) => looseEq(x, b)); case 'equal': return arr.length === toNum(b); case 'notequal': return arr.length !== toNum(b); case 'greater': return arr.length > toNum(b); case 'less': return arr.length < toNum(b); case 'greaterorequal': return arr.length >= toNum(b); case 'lessorequal': return arr.length <= toNum(b); }
      break;
    }
  }
  throw new Error('Unsupported filter operator: ' + o);
}
// conditions: [[{a,b,o}, ...AND], ...OR]; resolveFn turns templates into values
function passes(conditions, resolveFn) {
  if (!conditions || !conditions.length) return true;
  return conditions.some((group) => (group || []).every((c) => test(c.o, resolveFn(c.a), resolveFn(c.b))));
}
module.exports = { passes, test, exist };
