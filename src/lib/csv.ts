// Tiny CSV parser (quoted fields, commas, CRLF). Enough for demo datasets.
export function parseCsv(text: string): { columns: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;
  const src = text.replace(/\r\n?/g, "\n").trim();
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field.trim());
      field = "";
    } else if (c === "\n") {
      row.push(field.trim());
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  row.push(field.trim());
  if (row.some((x) => x !== "")) rows.push(row);
  const [columns = [], ...body] = rows;
  return { columns, rows: body.filter((r) => r.length === columns.length) };
}

/** Heuristic: does this text contain a CSV block (header + ≥2 rows, same comma count)? */
export function extractCsv(text: string): string | null {
  const fenced = text.match(/```(?:csv)?\n([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const lines = candidate.split(/\r?\n/).map((l) => l.trim());
  let best: string[] = [];
  let cur: string[] = [];
  let commas = -1;
  for (const l of lines) {
    const n = (l.match(/,/g) ?? []).length;
    if (n >= 1 && (cur.length === 0 || n === commas)) {
      cur.push(l);
      commas = n;
    } else {
      if (cur.length > best.length) best = cur;
      cur = n >= 1 ? [l] : [];
      commas = n >= 1 ? n : -1;
    }
  }
  if (cur.length > best.length) best = cur;
  return best.length >= 3 ? best.join("\n") : null;
}
