/**
 * Evaluates a simple SPDX expression (AND / OR / parentheses) against an allowed set.
 * Fail-closed: anything unparseable or empty is NOT allowed.
 */
export function spdxAllowed(expression: string | undefined, allowed: ReadonlySet<string>): boolean {
  if (!expression) return false;
  const tokens = expression.replace(/\(/g, " ( ").replace(/\)/g, " ) ").split(/\s+/).filter(Boolean);
  let pos = 0;
  const parseOr = (): boolean => {
    let v = parseAnd();
    while (tokens[pos]?.toUpperCase() === "OR") {
      pos++;
      const r = parseAnd();
      v = v || r;
    }
    return v;
  };
  const parseAnd = (): boolean => {
    let v = parseAtom();
    while (tokens[pos]?.toUpperCase() === "AND") {
      pos++;
      const r = parseAtom();
      v = v && r;
    }
    return v;
  };
  const parseAtom = (): boolean => {
    const t = tokens[pos++];
    if (t === undefined) throw new Error("unexpected end");
    if (t === "(") {
      const v = parseOr();
      if (tokens[pos++] !== ")") throw new Error("missing )");
      return v;
    }
    if (t === ")" || t.toUpperCase() === "AND" || t.toUpperCase() === "OR") throw new Error("unexpected " + t);
    return allowed.has(t.replace(/\+$/, "")) || allowed.has(t);
  };
  try {
    const v = parseOr();
    return pos === tokens.length && v;
  } catch {
    return false;
  }
}
