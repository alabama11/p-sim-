// Evaluator for block parameters, the model workspace and Octave Fcn blocks.
//
// Syntax is a MATLAB/Octave-like subset:
//  - numbers, row vectors `[1 2 3]`, ranges `1:3`, `0:0.5:2`, indexing `u(2)`, `v([1 3])`
//  - + - * / ^ and the element-wise .* ./ .^, comparisons == ~= < <= > >=,
//    logical ~ ! & | && ||, parentheses and function calls
//  - statements separated by `;`, `,` or new lines; `%` and `#` comments
//  - `x = expr`, `x(i) = expr`, if/elseif/else/end, for/end, while/end, break, continue
//
// Source text is parsed once into a tree (compileExpr / compileScript) and the tree is
// evaluated many times, which keeps per-step evaluation cheap inside simulations.

export type Value = number[]; // a scalar is a one-element vector; logical values are 1/0
export type Scope = Record<string, Value>;

export class ExprError extends Error {}

type Tok = (
  | { k: 'num'; v: number }
  | { k: 'id'; v: string }
  | { k: 'op'; v: string }
  | { k: 'end' }
) & { sp?: boolean }; // sp: whitespace precedes the token (matters inside [ ])

const OPS = [
  '...', '.*', './', '.^', '==', '~=', '!=', '<=', '>=', '&&', '||',
  '+', '-', '*', '/', '^', '(', ')', '[', ']', ',', ';', '=', '<', '>', '&', '|', '~', '!', ':', '\n',
];

const KEYWORDS = new Set(['if', 'elseif', 'else', 'end', 'for', 'while', 'break', 'continue']);

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let sp = false;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r') { i++; sp = true; continue; }
    if (c === '%' || c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (src.startsWith('...', i)) { while (i < src.length && src[i] !== '\n') i++; i++; sp = true; continue; }
    const rest = src.slice(i);
    const num = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(rest);
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    const op = OPS.find((o) => src.startsWith(o, i));
    // "1./x" is 1 ./ x, not 1. / x
    if (num && !(num[0].endsWith('.') && /^[*/^]/.test(src[i + num[0].length] ?? ''))) {
      out.push({ k: 'num', v: parseFloat(num[0]), sp }); i += num[0].length;
    } else if (num) {
      const n = num[0].slice(0, -1);
      out.push({ k: 'num', v: parseFloat(n), sp }); i += n.length;
    } else if (id) { out.push({ k: 'id', v: id[0], sp }); i += id[0].length; }
    else if (op) { out.push({ k: 'op', v: op, sp }); i += op.length; }
    else throw new ExprError(`Neočakávaný znak „${c}“`);
    sp = false;
  }
  out.push({ k: 'end', sp });
  return out;
}

const CONSTANTS: Scope = {
  pi: [Math.PI], e: [Math.E], Inf: [Infinity], inf: [Infinity], NaN: [NaN], nan: [NaN],
  true: [1], false: [0], eps: [Number.EPSILON],
};

const FUNCS: Record<string, (...a: Value[]) => Value> = {
  sin: map1(Math.sin), cos: map1(Math.cos), tan: map1(Math.tan),
  asin: map1(Math.asin), acos: map1(Math.acos), atan: map1(Math.atan),
  sinh: map1(Math.sinh), cosh: map1(Math.cosh), tanh: map1(Math.tanh),
  exp: map1(Math.exp), log: map1(Math.log), log10: map1(Math.log10), log2: map1(Math.log2), sqrt: map1(Math.sqrt),
  abs: map1(Math.abs), floor: map1(Math.floor), ceil: map1(Math.ceil), round: map1(Math.round),
  fix: map1(Math.trunc), sign: map1(Math.sign),
  atan2: (a, b) => binary(a, b, Math.atan2),
  hypot: (a, b) => binary(a, b, Math.hypot),
  mod: (a, b) => binary(a, b, (x, y) => (y === 0 ? x : x - Math.floor(x / y) * y)),
  rem: (a, b) => binary(a, b, (x, y) => (y === 0 ? x : x - Math.trunc(x / y) * y)),
  power: (a, b) => binary(a, b, Math.pow),
  min: (a, b) => (b ? binary(a, b, Math.min) : [Math.min(...a)]),
  max: (a, b) => (b ? binary(a, b, Math.max) : [Math.max(...a)]),
  sum: (a) => [a.reduce((s, x) => s + x, 0)],
  prod: (a) => [a.reduce((s, x) => s * x, 1)],
  mean: (a) => [a.reduce((s, x) => s + x, 0) / a.length],
  cumsum: (a) => { let s = 0; return a.map((x) => (s += x)); },
  dot: (a, b) => [binary(a, b, (x, y) => x * y).reduce((s, x) => s + x, 0)],
  norm: (a) => [Math.hypot(...a)],
  length: (a) => [a.length],
  numel: (a) => [a.length],
  zeros: (n) => new Array(count(n)).fill(0),
  ones: (n) => new Array(count(n)).fill(1),
  linspace: (a, b, n) => {
    const k = n ? count(n) : 100, x0 = scalar(a), x1 = scalar(b);
    return Array.from({ length: k }, (_, i) => (k === 1 ? x1 : x0 + ((x1 - x0) * i) / (k - 1)));
  },
  any: (a) => [a.some((x) => x !== 0) ? 1 : 0],
  all: (a) => [a.every((x) => x !== 0) ? 1 : 0],
  isempty: (a) => [a.length === 0 ? 1 : 0],
  fliplr: (a) => [...a].reverse(),
  sat: (u, lo, hi) => u.map((x, i) => Math.min(pick(hi, i), Math.max(pick(lo, i), x))),
};

function map1(f: (x: number) => number) {
  return (a: Value) => a.map(f);
}

function pick(v: Value, i: number) {
  return v.length === 1 ? v[0] : v[i];
}

function scalar(v: Value): number {
  if (v.length !== 1) throw new ExprError('Očakáva sa skalár');
  return v[0];
}

function count(v: Value): number {
  const n = scalar(v);
  if (!(n >= 0) || n > 1e7) throw new ExprError('Neplatná dĺžka');
  return Math.floor(n);
}

function binary(a: Value, b: Value, f: (x: number, y: number) => number): Value {
  if (a.length === 1) return b.map((y) => f(a[0], y));
  if (b.length === 1) return a.map((x) => f(x, b[0]));
  if (a.length !== b.length) throw new ExprError(`Nezhodné rozmery (${a.length} a ${b.length})`);
  return a.map((x, i) => f(x, b[i]));
}

function truthy(v: Value): boolean {
  return v.length > 0 && v.every((x) => x !== 0 && !isNaN(x));
}

const BIN: Record<string, (x: number, y: number) => number> = {
  '+': (x, y) => x + y, '-': (x, y) => x - y, '.*': (x, y) => x * y, './': (x, y) => x / y, '.^': Math.pow,
  '*': (x, y) => x * y, '/': (x, y) => x / y, '^': Math.pow,
  '==': (x, y) => +(x === y), '~=': (x, y) => +(x !== y), '!=': (x, y) => +(x !== y),
  '<': (x, y) => +(x < y), '<=': (x, y) => +(x <= y), '>': (x, y) => +(x > y), '>=': (x, y) => +(x >= y),
  '&': (x, y) => +(x !== 0 && y !== 0), '|': (x, y) => +(x !== 0 || y !== 0),
};

// ---------------- Syntax tree ----------------

type Node =
  | { t: 'num'; v: number }
  | { t: 'var'; name: string }
  | { t: 'call'; name: string; args: Node[] } // function call or indexing, decided at run time
  | { t: 'un'; op: string; a: Node }
  | { t: 'bin'; op: string; a: Node; b: Node }
  | { t: 'and' | 'or'; a: Node; b: Node }
  | { t: 'range'; a: Node; step?: Node; b: Node }
  | { t: 'mat'; items: Node[] };

type Stmt =
  | { t: 'assign'; name: string; index?: Node; value: Node }
  | { t: 'expr'; value: Node }
  | { t: 'if'; branches: { cond: Node; body: Stmt[] }[]; otherwise: Stmt[] }
  | { t: 'for'; name: string; range: Node; body: Stmt[] }
  | { t: 'while'; cond: Node; body: Stmt[] }
  | { t: 'break' | 'continue' };

class Parser {
  private p = 0;
  private bracketDepth = 0;
  constructor(private toks: Tok[]) {}

  private peek(o = 0) { return this.toks[this.p + o]; }
  private isOp(v: string, o = 0) { const t = this.peek(o); return t.k === 'op' && t.v === v; }
  private isKw(v: string) { const t = this.peek(); return t.k === 'id' && t.v === v; }
  private expectOp(v: string) {
    if (!this.isOp(v)) throw new ExprError(`Očakáva sa „${v === '\n' ? 'nový riadok' : v}“`);
    this.p++;
  }
  atEnd() { return this.peek().k === 'end'; }

  // ---- statements ----

  private isSep() { return this.isOp(';') || this.isOp(',') || this.isOp('\n'); }
  private skipSeps() { while (this.isSep()) this.p++; }

  block(stop: string[]): Stmt[] {
    const out: Stmt[] = [];
    for (;;) {
      this.skipSeps();
      if (this.atEnd()) {
        if (stop.length) throw new ExprError(`Chýba „${stop[stop.length - 1]}“`);
        return out;
      }
      const t = this.peek();
      if (t.k === 'id' && stop.includes(t.v)) return out;
      out.push(this.statement());
      if (!this.atEnd() && !this.isSep() && !(this.peek().k === 'id' && stop.includes((this.peek() as { v: string }).v))) {
        throw new ExprError('Očakáva sa koniec príkazu („;“ alebo nový riadok)');
      }
    }
  }

  private statement(): Stmt {
    const t = this.peek();
    if (t.k === 'id' && KEYWORDS.has(t.v)) {
      this.p++;
      switch (t.v) {
        case 'if': {
          const branches = [{ cond: this.expr(), body: this.block(['elseif', 'else', 'end']) }];
          let otherwise: Stmt[] = [];
          for (;;) {
            if (this.isKw('elseif')) { this.p++; branches.push({ cond: this.expr(), body: this.block(['elseif', 'else', 'end']) }); }
            else if (this.isKw('else')) { this.p++; otherwise = this.block(['end']); }
            else { this.p++; break; } // end
          }
          return { t: 'if', branches, otherwise };
        }
        case 'for': {
          const v = this.peek();
          if (v.k !== 'id') throw new ExprError('Za „for“ očakávam premennú');
          this.p++;
          this.expectOp('=');
          const range = this.expr();
          const body = this.block(['end']);
          this.p++;
          return { t: 'for', name: v.v, range, body };
        }
        case 'while': {
          const cond = this.expr();
          const body = this.block(['end']);
          this.p++;
          return { t: 'while', cond, body };
        }
        case 'break': case 'continue':
          return { t: t.v };
        default:
          throw new ExprError(`Neočakávané „${t.v}“`);
      }
    }
    // Assignment: name = expr or name(i) = expr
    if (t.k === 'id') {
      if (this.isOp('=', 1)) {
        this.p += 2;
        return { t: 'assign', name: t.v, value: this.expr() };
      }
      if (this.isOp('(', 1)) {
        const save = this.p;
        this.p += 2;
        const index = this.inParens(() => this.expr());
        if (this.isOp(')') && this.isOp('=', 1)) {
          this.p += 2;
          return { t: 'assign', name: t.v, index, value: this.expr() };
        }
        this.p = save;
      }
    }
    if (t.k === 'num' && this.isOp('=', 1)) throw new ExprError('Očakáva sa priradenie „meno = výraz“');
    return { t: 'expr', value: this.expr() };
  }

  // ---- expressions, lowest precedence first ----

  expr(): Node { return this.oror(); }

  private oror(): Node {
    let a = this.andand();
    while (this.isOp('||')) { this.p++; a = { t: 'or', a, b: this.andand() }; }
    return a;
  }
  private andand(): Node {
    let a = this.elOr();
    while (this.isOp('&&')) { this.p++; a = { t: 'and', a, b: this.elOr() }; }
    return a;
  }
  private elOr(): Node {
    let a = this.elAnd();
    while (this.isOp('|')) { this.p++; a = { t: 'bin', op: '|', a, b: this.elAnd() }; }
    return a;
  }
  private elAnd(): Node {
    let a = this.compare();
    while (this.isOp('&')) { this.p++; a = { t: 'bin', op: '&', a, b: this.compare() }; }
    return a;
  }
  private compare(): Node {
    let a = this.range();
    for (;;) {
      const t = this.peek();
      if (t.k === 'op' && ['==', '~=', '!=', '<', '<=', '>', '>='].includes(t.v)) {
        this.p++;
        a = { t: 'bin', op: t.v, a, b: this.range() };
      } else return a;
    }
  }
  private range(): Node {
    const a = this.additive();
    if (!this.isOp(':')) return a;
    this.p++;
    const b = this.additive();
    if (!this.isOp(':')) return { t: 'range', a, b };
    this.p++;
    return { t: 'range', a, step: b, b: this.additive() };
  }
  private additive(): Node {
    let v = this.term();
    while ((this.isOp('+') || this.isOp('-')) && !this.startsNewElement()) {
      const op = (this.toks[this.p++] as { v: string }).v;
      v = { t: 'bin', op, a: v, b: this.term() };
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

  private term(): Node {
    let v = this.unary();
    for (;;) {
      const t = this.peek();
      if (t.k === 'op' && ['*', '/', '.*', './'].includes(t.v)) {
        this.p++;
        v = { t: 'bin', op: t.v, a: v, b: this.unary() };
      } else return v;
    }
  }

  private unary(): Node {
    if (this.isOp('-')) { this.p++; return { t: 'un', op: '-', a: this.unary() }; }
    if (this.isOp('+')) { this.p++; return this.unary(); }
    if (this.isOp('~') || this.isOp('!')) { this.p++; return { t: 'un', op: '~', a: this.unary() }; }
    return this.power();
  }

  private power(): Node {
    const base = this.primary();
    if (this.isOp('^') || this.isOp('.^')) {
      const op = (this.toks[this.p++] as { v: string }).v;
      return { t: 'bin', op, a: base, b: this.unary() };
    }
    return base;
  }

  private primary(): Node {
    const t = this.peek();
    if (t.k === 'num') { this.p++; return { t: 'num', v: t.v }; }
    if (t.k === 'id') {
      if (KEYWORDS.has(t.v)) throw new ExprError(`Neočakávané „${t.v}“`);
      this.p++;
      // Inside [ ], "a (1)" is two elements; "a(1)" is a call.
      if (this.isOp('(') && !(this.bracketDepth > 0 && this.peek().sp)) {
        this.p++;
        const args = this.inParens(() => {
          const a: Node[] = [];
          if (!this.isOp(')')) {
            a.push(this.expr());
            while (this.isOp(',')) { this.p++; a.push(this.expr()); }
          }
          return a;
        });
        this.expectOp(')');
        return { t: 'call', name: t.v, args };
      }
      return { t: 'var', name: t.v };
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
      const items: Node[] = [];
      while (!this.isOp(']')) {
        if (this.atEnd()) throw new ExprError('Chýba „]“');
        if (this.isOp(',') || this.isOp(';') || this.isOp('\n')) { this.p++; continue; }
        items.push(this.expr());
      }
      this.bracketDepth--;
      this.p++;
      return { t: 'mat', items };
    }
    throw new ExprError('Neúplný výraz');
  }
}

// ---------------- Evaluation ----------------

function lookup(name: string, scope: Scope): Value {
  const v = scope[name] ?? CONSTANTS[name];
  if (!v) {
    if (FUNCS[name]) throw new ExprError(`Funkcia „${name}“ potrebuje argumenty`);
    throw new ExprError(`Neznáma premenná „${name}“`);
  }
  return v;
}

function indices(idx: Value, n: number, name: string): number[] {
  return idx.map((k) => {
    if (!Number.isInteger(k) || k < 1) throw new ExprError(`Index ${k} premennej „${name}“ musí byť celé kladné číslo`);
    if (k > n) throw new ExprError(`Index ${k} prekračuje dĺžku ${n} premennej „${name}“`);
    return k - 1;
  });
}

function evalNode(n: Node, scope: Scope): Value {
  switch (n.t) {
    case 'num': return [n.v];
    case 'var': return lookup(n.name, scope);
    case 'call': {
      const v = scope[n.name];
      if (v) {
        if (n.args.length !== 1) throw new ExprError(`Premenná „${n.name}“ sa indexuje jedným indexom`);
        return indices(evalNode(n.args[0], scope), v.length, n.name).map((i) => v[i]);
      }
      const f = FUNCS[n.name];
      if (!f) throw new ExprError(`Neznáma funkcia „${n.name}“`);
      return f(...n.args.map((a) => evalNode(a, scope)));
    }
    case 'un': {
      const a = evalNode(n.a, scope);
      return n.op === '-' ? a.map((x) => -x) : a.map((x) => +(x === 0));
    }
    case 'bin': {
      const a = evalNode(n.a, scope), b = evalNode(n.b, scope);
      if ((n.op === '*' || n.op === '/' || n.op === '^') && a.length !== 1 && b.length !== 1) {
        if (n.op === '*' && a.length === b.length) {
          throw new ExprError('Operátor * medzi vektormi: použite .* (po prvkoch) alebo dot(a, b)');
        }
        throw new ExprError(`Operátor ${n.op} vyžaduje skalár, použite .${n.op}`);
      }
      return binary(a, b, BIN[n.op]);
    }
    case 'and': return [truthy(evalNode(n.a, scope)) && truthy(evalNode(n.b, scope)) ? 1 : 0];
    case 'or': return [truthy(evalNode(n.a, scope)) || truthy(evalNode(n.b, scope)) ? 1 : 0];
    case 'range': {
      const a = scalar(evalNode(n.a, scope)), b = scalar(evalNode(n.b, scope));
      const s = n.step ? scalar(evalNode(n.step, scope)) : 1;
      if (s === 0 || !isFinite(a) || !isFinite(b)) return [];
      const len = Math.floor((b - a) / s + 1e-10) + 1;
      if (len > 1e7) throw new ExprError('Rozsah je príliš veľký');
      return Array.from({ length: Math.max(0, len) }, (_, i) => a + i * s);
    }
    case 'mat': return n.items.flatMap((it) => evalNode(it, scope));
  }
}

class Break {}
class Continue {}
const MAX_ITER = 1_000_000;

function exec(stmts: Stmt[], scope: Scope) {
  for (const s of stmts) {
    switch (s.t) {
      case 'assign': {
        const v = evalNode(s.value, scope);
        if (!s.index) { scope[s.name] = v; break; }
        const idx = evalNode(s.index, scope);
        const cur = [...(scope[s.name] ?? [])];
        idx.forEach((k, j) => {
          if (!Number.isInteger(k) || k < 1 || k > 1e7) throw new ExprError(`Neplatný index ${k} premennej „${s.name}“`);
          while (cur.length < k) cur.push(0);
          cur[k - 1] = v.length === 1 ? v[0] : v[j];
        });
        if (v.length !== 1 && v.length !== idx.length) throw new ExprError(`Nezhodné rozmery pri priradení do „${s.name}“`);
        scope[s.name] = cur;
        break;
      }
      case 'expr': evalNode(s.value, scope); break;
      case 'if': {
        const br = s.branches.find((b) => truthy(evalNode(b.cond, scope)));
        exec(br ? br.body : s.otherwise, scope);
        break;
      }
      case 'for': {
        const vals = evalNode(s.range, scope);
        try {
          for (const v of vals) {
            scope[s.name] = [v];
            try { exec(s.body, scope); } catch (e) { if (!(e instanceof Continue)) throw e; }
          }
        } catch (e) { if (!(e instanceof Break)) throw e; }
        break;
      }
      case 'while': {
        let it = 0;
        try {
          while (truthy(evalNode(s.cond, scope))) {
            if (++it > MAX_ITER) throw new ExprError('Cyklus while prekročil milión opakovaní');
            try { exec(s.body, scope); } catch (e) { if (!(e instanceof Continue)) throw e; }
          }
        } catch (e) { if (!(e instanceof Break)) throw e; }
        break;
      }
      case 'break': throw new Break();
      case 'continue': throw new Continue();
    }
  }
}

// ---------------- Public API ----------------

/** Parses an expression once; the returned function evaluates it in a scope. */
export function compileExpr(src: string): (scope: Scope) => Value {
  if (src.trim() === '') throw new ExprError('Prázdny výraz');
  const p = new Parser(tokenize(src));
  const node = p.expr();
  if (!p.atEnd()) throw new ExprError('Nadbytočné znaky na konci výrazu');
  return (scope) => evalNode(node, scope);
}

export function evaluate(src: string, scope: Scope = {}): Value {
  return compileExpr(src)(scope);
}

/** Parses a script (statements, if/for/while); the returned function runs it on a scope in place. */
export function compileScript(src: string): (scope: Scope) => void {
  const p = new Parser(tokenize(src));
  const stmts = p.block([]);
  return (scope) => {
    try {
      exec(stmts, scope);
    } catch (e) {
      if (e instanceof Break || e instanceof Continue) throw new ExprError('break/continue mimo cyklu');
      throw e;
    }
  };
}

/** Runs workspace statements like `K = 2; T = [1 0.5]` and returns the resulting variables. */
export function runWorkspace(src: string): Scope {
  const scope: Scope = {};
  compileScript(src)(scope);
  return scope;
}

/** True for a built-in function name such as sin or max. */
export function isFunction(name: string): boolean {
  return name in FUNCS;
}
