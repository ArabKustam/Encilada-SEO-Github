/** Minimal line diff, enough to show what `apply` would change in a README. */

export interface DiffLine {
  type: " " | "+" | "-";
  text: string;
}

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  // Longest common subsequence table, filled from the end.
  const lcs: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) out.push({ type: " ", text: a[i++] }), j++;
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ type: "-", text: a[i++] });
    else out.push({ type: "+", text: b[j++] });
  }
  while (i < a.length) out.push({ type: "-", text: a[i++] });
  while (j < b.length) out.push({ type: "+", text: b[j++] });
  return out;
}

export function diffStats(diff: DiffLine[]): { added: number; removed: number } {
  return { added: diff.filter((d) => d.type === "+").length, removed: diff.filter((d) => d.type === "-").length };
}

/** Unified-style text with `context` unchanged lines around each change. */
export function formatDiff(diff: DiffLine[], context = 2): string {
  const keep = new Set<number>();
  diff.forEach((line, index) => {
    if (line.type === " ") return;
    for (let k = index - context; k <= index + context; k++) if (k >= 0 && k < diff.length) keep.add(k);
  });
  const out: string[] = [];
  let previous = -1;
  for (const index of [...keep].sort((x, y) => x - y)) {
    if (previous !== -1 && index > previous + 1) out.push("@@");
    out.push(`${diff[index].type}${diff[index].text}`);
    previous = index;
  }
  return out.join("\n");
}
