import { LIMITS } from "./audit.js";

export interface Fixed {
  markdown: string;
  /** What was changed, one line per change. */
  fixes: string[];
}

/**
 * Mechanical repairs that cannot change what a README says: heading levels, blank lines,
 * very long code blocks folded away. Wording is never touched.
 */
export function fixReadme(markdown: string, detailsLabel: string): Fixed {
  const fixes: string[] = [];
  const eol = markdown.includes("\r\n") ? "\r\n" : "\n";
  const lines = markdown.split(/\r?\n/);

  // --- headings: one H1, and no level skipped on the way down
  let fence = false;
  let seenH1 = false;
  let previous = 0;
  lines.forEach((text, index) => {
    if (/^\s*(```|~~~)/.test(text)) fence = !fence;
    if (fence) return;
    const heading = text.match(/^(#{1,6})(\s+\S.*)$/);
    if (!heading) return;
    let level = heading[1].length;
    if (level === 1 && seenH1) {
      level = 2;
      fixes.push(`строка ${index + 1}: второй заголовок первого уровня понижен до второго`);
    }
    if (level === 1) seenH1 = true;
    if (previous > 0 && level > previous + 1) {
      fixes.push(`строка ${index + 1}: уровень заголовка ${level} → ${previous + 1}, чтобы не перескакивать`);
      level = previous + 1;
    }
    previous = level;
    lines[index] = "#".repeat(level) + heading[2];
  });

  // --- long code blocks outside <details> are folded
  const out: string[] = [];
  let details = 0;
  let open: { at: number; marker: string } | null = null;
  for (const [index, text] of lines.entries()) {
    const marker = text.match(/^\s*(```|~~~)/)?.[1];
    if (!open) {
      if (/<details/i.test(text)) details++;
      if (/<\/details/i.test(text)) details = Math.max(0, details - 1);
      if (marker) open = { at: out.length, marker };
      out.push(text);
      continue;
    }
    out.push(text);
    if (marker !== open.marker) continue;
    const length = out.length - open.at - 2;
    if (length > LIMITS.codeBlockLines && details === 0) {
      out.splice(open.at, 0, "<details>", `<summary>${detailsLabel} (${length})</summary>`, "");
      out.push("", "</details>");
      fixes.push(`строка ${index + 1 - length - 1}: блок кода из ${length} строк свёрнут в <details>`);
    }
    open = null;
  }

  // --- runs of blank lines outside code
  const compact: string[] = [];
  let blanks = 0;
  let removed = 0;
  fence = false;
  for (const text of out) {
    if (/^\s*(```|~~~)/.test(text)) fence = !fence;
    blanks = !fence && text.trim() === "" ? blanks + 1 : 0;
    if (blanks > 1) removed++;
    else compact.push(text);
  }
  if (removed > 0) fixes.push(`убраны лишние пустые строки: ${removed}`);

  return { markdown: compact.join(eol), fixes };
}
