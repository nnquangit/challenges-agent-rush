// Tiny exact evaluator for Python integer arithmetic, used by MockSandbox's
// print() emulator and its allocation estimate. No eval/Function on the host:
// a hand-written recursive-descent parser over BigInt.
//
// Supported, with Python semantics: integer literals (with _ separators),
// + - * // % ** , unary + -, parentheses. `//` and `%` floor toward -inf like
// Python. Anything else — true division `/`, floats, names, calls, division by
// zero, huge results — returns null, and the caller prints "not evaluated"
// instead of signing a wrong answer.

const MAX_LEN = 120;
const MAX_BITS = 4096;
const MAX_EXP = 4096n;

type Tok = { t: "num"; v: bigint } | { t: "op"; v: string };

function lex(src: string): Tok[] | null {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    const num = /^\d(?:_?\d)*/.exec(src.slice(i));
    if (num) {
      const digits = num[0].replace(/_/g, "");
      if (/^0\d/.test(digits) && /[1-9]/.test(digits)) return null; // 07 is a SyntaxError in Python 3
      // A float literal (1.5, 1e3) or a name right after the digits is not supported.
      if (/^[.eEjJ\w]/.test(src.slice(i + num[0].length))) return null;
      out.push({ t: "num", v: BigInt(digits) });
      i += num[0].length;
      continue;
    }
    const op = /^(\*\*|\/\/|[+\-*%()])/.exec(src.slice(i));
    if (!op) return null; // "/" alone, ".", letters, anything else
    out.push({ t: "op", v: op[0] });
    i += op[0].length;
  }
  return out;
}

class Unsupported extends Error {}

const floorDiv = (a: bigint, b: bigint) => {
  if (b === 0n) throw new Unsupported("ZeroDivisionError");
  const q = a / b;
  return (a % b !== 0n) && ((a < 0n) !== (b < 0n)) ? q - 1n : q;
};
const pyMod = (a: bigint, b: bigint) => {
  if (b === 0n) throw new Unsupported("ZeroDivisionError");
  const r = a % b;
  return r !== 0n && ((r < 0n) !== (b < 0n)) ? r + b : r;
};
const bounded = (v: bigint) => {
  if ((v < 0n ? -v : v).toString(2).length > MAX_BITS) throw new Unsupported("too large");
  return v;
};

function parse(toks: Tok[]): bigint {
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek()?.t === "op" && peek()!.v === v;
  const take = () => toks[p++];

  // expr := term (('+'|'-') term)*
  function expr(): bigint {
    let v = term();
    while (isOp("+") || isOp("-")) v = bounded(take().v === "+" ? v + term() : v - term());
    return v;
  }
  // term := unary (('*'|'//'|'%') unary)*
  function term(): bigint {
    let v = unary();
    while (isOp("*") || isOp("//") || isOp("%")) {
      const op = take().v;
      const r = unary();
      v = bounded(op === "*" ? v * r : op === "//" ? floorDiv(v, r) : pyMod(v, r));
    }
    return v;
  }
  // unary := ('+'|'-') unary | power      (so -2**2 == -4, as in Python)
  function unary(): bigint {
    if (isOp("-")) return take() && -unary();
    if (isOp("+")) return take() && unary();
    return power();
  }
  // power := atom ('**' unary)?            (right-associative; 2**-1 is a float → unsupported)
  function power(): bigint {
    const base = atom();
    if (!isOp("**")) return base;
    take();
    const e = unary();
    if (e < 0n) throw new Unsupported("float result");
    if (e > MAX_EXP && base !== 0n && base !== 1n && base !== -1n) throw new Unsupported("too large");
    return bounded(base ** e);
  }
  function atom(): bigint {
    const t = take();
    if (!t) throw new Unsupported("unexpected end");
    if (t.t === "num") return t.v;
    if (t.v === "(") {
      const v = expr();
      if (!isOp(")")) throw new Unsupported("missing )");
      take();
      return v;
    }
    throw new Unsupported(`unexpected ${t.v}`);
  }

  const v = expr();
  if (p !== toks.length) throw new Unsupported("trailing tokens");
  return v;
}

/** Exact value of a Python integer expression, or null when it is not supported (never a guess). */
export function evalPythonInt(src: string): bigint | null {
  const s = src.trim();
  if (!s || s.length > MAX_LEN) return null;
  const toks = lex(s);
  if (!toks || !toks.length) return null;
  try {
    return parse(toks);
  } catch {
    return null;
  }
}
