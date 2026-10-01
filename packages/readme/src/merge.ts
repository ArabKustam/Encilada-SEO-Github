import { posix } from "node:path";

const H2 = /^##\s+(.+?)\s*#*\s*$/;
/** Headings of sections that `readme` regenerates from the same facts, so the old text is superseded. */
const SUPERSEDED = new Set(["features", "возможности", "key features", "функции", "license", "лицензия"]);
/** Headings that probably overlap with the generated Quick start; kept, but the author is told. */
const LIKELY_DUPLICATE = /запуск|установка|использование|как запустить|^run$|usage|install|getting started|quick ?start/i;

interface Section {
  heading: string;
  text: string;
}

/** Split a README into its H2 sections; text before the first H2 is the preamble. */
function sections(markdown: string): { preamble: string; sections: Section[] } {
  const lines = markdown.split(/\r?\n/);
  const out: Section[] = [];
  const preamble: string[] = [];
  let current: { heading: string; lines: string[] } | null = null;
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const match = inFence ? null : line.match(H2);
    if (match) {
      if (current) out.push({ heading: current.heading, text: current.lines.join("\n").trimEnd() });
      current = { heading: match[1], lines: [line] };
    } else if (current) current.lines.push(line);
    else preamble.push(line);
  }
  if (current) out.push({ heading: current.heading, text: current.lines.join("\n").trimEnd() });
  return { preamble: preamble.join("\n").trim(), sections: out };
}

export interface MergeResult {
  markdown: string;
  /** Headings of the author's own sections carried over unchanged. */
  preserved: string[];
  /** Carried-over sections that may repeat generated content. */
  possibleDuplicates: string[];
}

/**
 * Carry the author's own sections from the existing README into the generated one.
 * Only sections repokit regenerates are replaced; everything else is kept verbatim,
 * placed before the license section.
 */
export function mergeCustomSections(existing: string | null, generated: string, generatedHeadings: Set<string>, licenseHeading: string): MergeResult {
  if (!existing) return { markdown: generated, preserved: [], possibleDuplicates: [] };
  const known = (heading: string) => generatedHeadings.has(heading.toLowerCase()) || SUPERSEDED.has(heading.toLowerCase());
  const custom = sections(existing).sections.filter((s) => !known(s.heading));
  if (custom.length === 0) return { markdown: generated, preserved: [], possibleDuplicates: [] };

  const block = custom.map((s) => s.text).join("\n\n");
  const lines = generated.trimEnd().split("\n");
  const licenseAt = lines.findIndex((line) => line.match(H2)?.[1].toLowerCase() === licenseHeading.toLowerCase());
  const merged = licenseAt === -1
    ? [...lines, "", block]
    : [...lines.slice(0, licenseAt), block, "", ...lines.slice(licenseAt)];
  return {
    markdown: merged.join("\n") + "\n",
    preserved: custom.map((s) => s.heading),
    possibleDuplicates: custom.filter((s) => LIKELY_DUPLICATE.test(s.heading)).map((s) => s.heading),
  };
}

export interface ReadmeProblem {
  kind: "fill" | "missing-file" | "missing-alt";
  line: number;
  message: string;
}

const isLocal = (target: string) => !/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target);

/** Things that must not be left in a published README. */
export function checkReadme(markdown: string, files: Set<string>, readmeDir = "."): ReadmeProblem[] {
  const problems: ReadmeProblem[] = [];
  let inFence = false;
  markdown.split(/\r?\n/).forEach((text, index) => {
    const line = index + 1;
    if (/^\s*(```|~~~)/.test(text)) inFence = !inFence;
    if (inFence) return;

    for (const m of text.matchAll(/<!--\s*FILL:?\s*([^>]*?)\s*-->/g)) problems.push({ kind: "fill", line, message: `не заполнено: ${m[1]}` });

    const targets = [
      ...[...text.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map((m) => m[1]),
      ...[...text.matchAll(/\b(?:src|srcset|href)="([^"]+)"/g)].map((m) => m[1].split(/\s+/)[0]),
    ];
    for (const target of targets) {
      if (!isLocal(target)) continue;
      let path: string;
      try {
        path = decodeURI(target.split("#")[0].split("?")[0]);
      } catch {
        path = target.split("#")[0];
      }
      if (!path) continue;
      const resolved = posix.normalize(posix.join(readmeDir, path)).replace(/\/$/, "");
      const isDirectory = [...files].some((f) => f.startsWith(`${resolved}/`));
      if (!files.has(resolved) && !isDirectory) problems.push({ kind: "missing-file", line, message: `ссылка на несуществующий файл: ${target}` });
    }

    for (const m of text.matchAll(/!\[([^\]]*)\]\(/g)) if (!m[1].trim()) problems.push({ kind: "missing-alt", line, message: "изображение без alt-текста" });
    for (const m of text.matchAll(/<img\b[^>]*>/g)) {
      if (!/\balt="[^"]+"/.test(m[0])) problems.push({ kind: "missing-alt", line, message: "тег <img> без alt-текста" });
    }
  });
  return problems;
}
