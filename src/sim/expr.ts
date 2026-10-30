// Evaluator for block parameters and the model workspace.
// Syntax is a small MATLAB/Octave-like subset: numbers, row vectors `[1 2 3]`,
// + - * / ^ (and the element-wise .* ./ .^), parentheses, function calls,
// variables, `%` comments and `name = expr` assignments separated by `;` or newlines.

export type Value = number[]; // a scalar is a one-element vector
export type Scope = Record<string, Value>;

export class ExprError extends Error {}

type Tok = (
  | { k: 'num'; v: number }
  | { k: 'id'; v: string }
  | { k: 'op'; v: string }
  | { k: 'end' }
) & { sp?: boolean }; // sp: whitespace precedes the token (matters inside [ ])

const OPS = ['.*', './', '.^', '+', '-', '*', '/', '^', '(', ')', '[', ']', ',', '='];

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let sp = false;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t') { i++; sp = true; continue; }
    const num = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    const op = OPS.find((o) => src.startsWith(o, i));
    if (num) { out.push({ k: 'num', v: parseFloat(num[0]), sp }); i += num[0].length; }
    else if (id) { out.push({ k: 'id', v: id[0], sp }); i += id[0].length; }
    else if (op) { out.push({ k: 'op', v: op, sp }); i += op.length; }
    else throw new ExprError(`Neočakávaný znak „${c}“`);
    sp = false;
  }
  out.push({ k: 'end', sp });
  return out;
}

const CONSTANTS: Scope = { pi: [Math.PI], e: [Math.E], Inf: [Infinity], inf: [Infinity] };

const FUNCS: Record<string, (...a: Value[]) => Value> = {
  sin: map1(Math.sin), cos: map1(Math.cos), tan: map1(Math.tan),
  asin: map1(Math.asin), acos: map1(Math.acos), atan: map1(Math.atan),
  sinh: map1(Math.sinh), cosh: map1(Math.cosh), tanh: map1(Math.tanh),
  exp: map1(Math.exp), log: map1(Math.log), log10: map1(Math.log10), sqrt: map1(Math.sqrt),
  abs: map1(Math.abs), floor: map1(Math.floor), ceil: map1(Math.ceil), round: map1(Math.round),
  sign: map1(Math.sign),
  atan2: (a, b) => binary(a, b, Math.atan2),
  min: (a, b) => (b ? binary(a, b, Math.min) : [Math.min(...a)]),
  max: (a, b) => (b ? binary(a, b, Math.max) : [Math.max(...a)]),
  sum: (a) => [a.reduce((s, x) => s + x, 0)],
  prod: (a) => [a.reduce((s, x) => s * x, 1)],
  length: (a) => [a.length],
  zeros: (n) => new Array(scalar(n)).fill(0),
  ones: (n) => new Array(scalar(n)).fill(1),
};

function map1(f: (x: number) => number) {
  return (a: Value) => a.map(f);
}

function scalar(v: Value): number {
  if (v.length !== 1) throw new ExprError('Očakáva sa skalár');
  return v[0];
}

function binary(a: Value, b: Value, f: (x: number, y: number) => number): Value {
  if (a.length === 1) return b.map((y) => f(a[0], y));
  if (b.length === 1) return a.map((x) => f(x, b[0]));
  if (a.length !== b.length) throw new ExprError(`Nezhodné rozmery (${a.length} a ${b.length})`);
  return a.map((x, i) => f(x, b[i]));
}

function matOp(a: Value, b: Value, f: (x: number, y: number) => number, op: string): Value {
  // Matrix * / ^ are only defined here when one side is a scalar.
  if (a.length !== 1 && b.length !== 1) throw new ExprError(`Operátor ${op} vyžaduje skalár, použite .${op}`);
  return binary(a, b, f);
}

class Parser {
  private p = 0;
  private bracketDepth = 0;
  constructor(private toks: Tok[], private scope: Scope) {}

  private peek() { return this.toks[this.p]; }
  private isOp(v: string) { const t = this.peek(); return t.k === 'op' && t.v === v; }
  private expectOp(v: string) {
    if (!this.isOp(v)) throw new ExprError(`Očakáva sa „${v}“`);
    this.p++;
  }

  parseAll(): Value {
    const v = this.expr();
    if (this.peek().k !== 'end') throw new ExprError('Nadbytočné znaky na konci výrazu');
    return v;
  }

  private expr(): Value {
    let v = this.term();
    while ((this.isOp('+') || this.isOp('-')) && !this.startsNewElement()) {
      const op = (this.toks[this.p++] as { v: string }).v;
      const r = this.term();
      v = binary(v, r, op === '+' ? (x, y) => x + y : (x, y) => x - y);
    }
    return v;
  }

  /** Inside [ ], `1 -2` is two elements while `1 - 2` and `1-2` are one, as in Octave. */
  private startsNewElement(): boolean {
    if (this.bracketDepth === 0) return false;
    return !!this.peek().sp && !this.toks[this.p + 1].sp;
  }

  /** Whitespace is insignificant inside ( ), even within [ ]. */
  private inParens<T>(f: () => T): T {
    const saved = this.bracketDepth;
    this.bracketDepth = 0;
    try { return f(); } finally { this.bracketDepth = saved; }
  }

  private term(): Value {
    let v = this.unary();
    for (;;) {
      if (this.isOp('*')) { this.p++; v = matOp(v, this.unary(), (x, y) => x * y, '*'); }
      else if (this.isOp('/')) { this.p++; v = matOp(v, this.unary(), (x, y) => x / y, '/'); }
      else if (this.isOp('.*')) { this.p++; v = binary(v, this.unary(), (x, y) => x * y); }
      else if (this.isOp('./')) { this.p++; v = binary(v, this.unary(), (x, y) => x / y); }
      else return v;
    }
  }

  private unary(): Value {
    if (this.isOp('-')) { this.p++; return this.unary().map((x) => -x); }
    if (this.isOp('+')) { this.p++; return this.unary(); }
    return this.power();
  }

  private power(): Value {
    const base = this.primary();
    if (this.isOp('^')) { this.p++; return matOp(base, this.unary(), Math.pow, '^'); }
    if (this.isOp('.^')) { this.p++; return binary(base, this.unary(), Math.pow); }
    return base;
  }

  private primary(): Value {
    const t = this.peek();
    if (t.k === 'num') { this.p++; return [t.v]; }
    if (t.k === 'id') {
      this.p++;
      if (this.isOp('(')) {
        const f = FUNCS[t.v];
        if (!f) throw new ExprError(`Neznáma funkcia „${t.v}“`);
        this.p++;
        const args = this.inParens(() => {
          const a: Value[] = [];
          if (!this.isOp(')')) {
            a.push(this.expr());
            while (this.isOp(',')) { this.p++; a.push(this.expr()); }
          }
          return a;
        });
        this.expectOp(')');
        return f(...args);
      }
      const v = this.scope[t.v] ?? CONSTANTS[t.v];
      if (!v) throw new ExprError(`Neznáma premenná „${t.v}“`);
      return v;
    }
    if (this.isOp('(')) {
      this.p++;
      const v = this.inParens(() => this.expr());
      this.expectOp(')');
      return v;
    }
    if (this.isOp('[')) {
      this.p++;
      this.bracketDepth++;
      const items: number[] = [];
      while (!this.isOp(']')) {
        if (this.peek().k === 'end') throw new ExprError('Chýba „]“');
        if (this.isOp(',')) { this.p++; continue; }
        items.push(...this.expr());
      }
      this.bracketDepth--;
      this.p++;
      return items;
    }
    throw new ExprError('Neúplný výraz');
  }
}

export function evaluate(src: string, scope: Scope = {}): Value {
  if (src.trim() === '') throw new ExprError('Prázdny výraz');
  return new Parser(tokenize(src), scope).parseAll();
}

/** Runs workspace statements like `K = 2; T = [1 0.5]` and returns the resulting variables. */
export function runWorkspace(src: string): Scope {
  const scope: Scope = {};
  const stmts = src
    .split('\n')
    .map((line) => line.replace(/%.*$/, ''))
    .flatMap((line) => line.split(';'))
    .map((s) => s.trim())
    .filter(Boolean);
  for (const stmt of stmts) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)(.*)$/.exec(stmt);
    if (!m) throw new ExprError(`Očakáva sa priradenie „meno = výraz“: ${stmt}`);
    try {
      scope[m[1]] = evaluate(m[2], scope);
    } catch (e) {
      throw new ExprError(`${m[1]}: ${(e as Error).message}`);
    }
  }
  return scope;
}
