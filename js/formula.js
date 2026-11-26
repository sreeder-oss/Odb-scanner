// Safe recursive-descent math expression parser for custom OBD-II PID formulas.
// Supports bytes A-H, numbers, +, -, *, /, parentheses, and s8(), s16(), min(), max(), abs().
// Never uses eval() or new Function().

const BYTE_NAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const FUNCTIONS = {
  s8: (args) => {
    if (args.length !== 1) throw new Error('s8() expects 1 argument');
    const v = Math.trunc(args[0]) & 0xff;
    return v > 127 ? v - 256 : v;
  },
  s16: (args) => {
    if (args.length !== 1 && args.length !== 2) throw new Error('s16() expects 1 or 2 arguments');
    const raw =
      args.length === 2
        ? ((Math.trunc(args[0]) & 0xff) << 8) | (Math.trunc(args[1]) & 0xff)
        : Math.trunc(args[0]) & 0xffff;
    return raw > 32767 ? raw - 65536 : raw;
  },
  min: (args) => {
    if (args.length < 1) throw new Error('min() expects at least 1 argument');
    return Math.min(...args);
  },
  max: (args) => {
    if (args.length < 1) throw new Error('max() expects at least 1 argument');
    return Math.max(...args);
  },
  abs: (args) => {
    if (args.length !== 1) throw new Error('abs() expects 1 argument');
    return Math.abs(args[0]);
  },
};

function tokenize(input) {
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '(' || ch === ')' || ch === ',') {
      tokens.push({ type: ch, value: ch, pos: i });
      i++;
      continue;
    }
    if (ch === '×') {
      tokens.push({ type: '*', value: '*', pos: i });
      i++;
      continue;
    }
    if (ch === '÷' || ch === '−') {
      const normalized = ch === '÷' ? '/' : '-';
      tokens.push({ type: normalized, value: normalized, pos: i });
      i++;
      continue;
    }
    // Numbers (integer or float)
    if (/[0-9.]/.test(ch)) {
      const start = i;
      let hasDot = false;
      while (i < input.length && (/[0-9]/.test(input[i]) || (input[i] === '.' && !hasDot))) {
        if (input[i] === '.') hasDot = true;
        i++;
      }
      const raw = input.slice(start, i);
      if (raw === '.') throw new Error(`Invalid number "." at position ${start + 1}`);
      const num = Number(raw);
      if (!Number.isFinite(num)) throw new Error(`Invalid number "${raw}"`);
      tokens.push({ type: 'num', value: num, pos: start });
      continue;
    }
    // Identifiers (A-H or function names)
    if (/[a-zA-Z_]/.test(ch)) {
      const start = i;
      while (i < input.length && /[a-zA-Z0-9_]/.test(input[i])) {
        i++;
      }
      const ident = input.slice(start, i);
      tokens.push({ type: 'ident', value: ident, pos: start });
      continue;
    }
    throw new Error(`Unexpected character "${ch}" at position ${i + 1}`);
  }
  return tokens;
}

export function compileFormula(formulaStr) {
  if (typeof formulaStr !== 'string' || !formulaStr.trim()) {
    throw new Error('Formula cannot be empty');
  }
  const tokens = tokenize(formulaStr.trim());
  let cursor = 0;
  let maxByteIndex = -1;

  function peek() {
    return tokens[cursor] || null;
  }

  function consume(expectedType) {
    const tok = tokens[cursor];
    if (!tok || (expectedType && tok.type !== expectedType)) {
      throw new Error(`Expected "${expectedType}" near position ${tok ? tok.pos + 1 : 'end'}`);
    }
    cursor++;
    return tok;
  }

  function parseExpression() {
    let node = parseTerm();
    while (peek() && (peek().type === '+' || peek().type === '-')) {
      const op = consume().type;
      const right = parseTerm();
      node = { kind: 'bin', op, left: node, right };
    }
    return node;
  }

  function parseTerm() {
    let node = parseUnary();
    while (peek() && (peek().type === '*' || peek().type === '/')) {
      const op = consume().type;
      const right = parseUnary();
      node = { kind: 'bin', op, left: node, right };
    }
    return node;
  }

  function parseUnary() {
    if (peek() && (peek().type === '+' || peek().type === '-')) {
      const op = consume().type;
      const operand = parseUnary();
      return { kind: 'unary', op, operand };
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const tok = peek();
    if (!tok) throw new Error('Unexpected end of formula');

    if (tok.type === 'num') {
      consume();
      return { kind: 'num', value: tok.value };
    }

    if (tok.type === '(') {
      consume('(');
      const expr = parseExpression();
      consume(')');
      return expr;
    }

    if (tok.type === 'ident') {
      consume();
      const upper = tok.value.toUpperCase();
      const lower = tok.value.toLowerCase();

      if (peek() && peek().type === '(') {
        if (!Object.prototype.hasOwnProperty.call(FUNCTIONS, lower)) {
          throw new Error(`Unknown function "${tok.value}()"`);
        }
        consume('(');
        const args = [];
        if (peek() && peek().type !== ')') {
          args.push(parseExpression());
          while (peek() && peek().type === ',') {
            consume(',');
            args.push(parseExpression());
          }
        }
        consume(')');
        if ((lower === 's8' || lower === 'abs') && args.length !== 1) {
          throw new Error(`${lower}() requires exactly 1 argument`);
        }
        if (lower === 's16' && args.length !== 1 && args.length !== 2) {
          throw new Error('s16() requires 1 or 2 arguments (e.g. s16(A,B) or s16(A*256+B))');
        }
        if ((lower === 'min' || lower === 'max') && args.length < 1) {
          throw new Error(`${lower}() requires at least 1 argument`);
        }
        return { kind: 'call', fn: lower, args };
      }

      const byteIdx = BYTE_NAMES.indexOf(upper);
      if (byteIdx !== -1) {
        if (byteIdx > maxByteIndex) maxByteIndex = byteIdx;
        return { kind: 'byte', index: byteIdx };
      }
      throw new Error(`Unknown variable "${tok.value}". Use bytes A–H.`);
    }

    throw new Error(`Unexpected token "${tok.value}" at position ${tok.pos + 1}`);
  }

  const ast = parseExpression();
  if (cursor < tokens.length) {
    throw new Error(`Unexpected "${tokens[cursor].value}" at position ${tokens[cursor].pos + 1}`);
  }

  function evalNode(node, bytes) {
    switch (node.kind) {
      case 'num':
        return node.value;
      case 'byte':
        if (!bytes || node.index >= bytes.length) {
          return NaN;
        }
        return bytes[node.index];
      case 'unary': {
        const v = evalNode(node.operand, bytes);
        return node.op === '-' ? -v : v;
      }
      case 'bin': {
        const l = evalNode(node.left, bytes);
        const r = evalNode(node.right, bytes);
        if (node.op === '+') return l + r;
        if (node.op === '-') return l - r;
        if (node.op === '*') return l * r;
        if (node.op === '/') return r === 0 ? NaN : l / r;
        return NaN;
      }
      case 'call': {
        const argVals = node.args.map((a) => evalNode(a, bytes));
        if (argVals.some((v) => !Number.isFinite(v))) return NaN;
        return FUNCTIONS[node.fn](argVals);
      }
      default:
        return NaN;
    }
  }

  return {
    requiredBytes: maxByteIndex + 1,
    evaluate(bytes) {
      const result = evalNode(ast, bytes);
      return Number.isFinite(result) ? result : null;
    },
  };
}

export function validateFormula(formulaStr) {
  try {
    const compiled = compileFormula(formulaStr);
    return { valid: true, requiredBytes: compiled.requiredBytes, error: null };
  } catch (err) {
    return { valid: false, requiredBytes: 0, error: err.message };
  }
}
