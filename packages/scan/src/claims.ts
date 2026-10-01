import { existsSync, readFileSync } from "node:fs";
import { insideRepo, sha256 } from "@repokit/core";
import type { Claim, ClaimsDoc, Evidence } from "./types.js";

const FEATURE_HEADING = /features|what it does|возможност|функци|что умеет/i;
const HEADING = /^(#{1,6})\s+(.*)$/;
const LIST_ITEM = /^\s*[-*+]\s+(.*\S)\s*$/;

/** Statuses that are allowed into README Features and therefore must be proven. */
const NEEDS_EVIDENCE = new Set(["implemented", "partial"]);

const plain = (markdown: string) => markdown.replace(/[*_`]/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim();

/** Pull feature statements out of a README. They start as `unverified`: a README is not proof. */
export function extractClaims(readme: string): Claim[] {
  const claims: Claim[] = [];
  let featureLevel = 0;
  let inFence = false;
  readme.split(/\r?\n/).forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) return;
    const heading = line.match(HEADING);
    if (heading) {
      const level = heading[1].length;
      if (FEATURE_HEADING.test(heading[2])) featureLevel = level;
      else if (level <= featureLevel) featureLevel = 0;
      return;
    }
    const item = featureLevel > 0 ? line.match(LIST_ITEM) : null;
    if (item) {
      claims.push({ id: "", text: plain(item[1]), status: "unverified", evidence: [], source: "readme", readmeLine: index + 1 });
    }
  });
  return claims;
}

/** Add newly found claims to an existing document without touching the ones already there. */
export function mergeClaims(existing: ClaimsDoc | null, found: Claim[]): ClaimsDoc {
  const claims = [...(existing?.claims ?? [])];
  const known = new Set(claims.map((c) => c.text));
  let next = claims.reduce((max, c) => Math.max(max, Number(c.id.match(/^c(\d+)$/)?.[1] ?? 0)), 0);
  for (const claim of found) {
    if (known.has(claim.text)) continue;
    known.add(claim.text);
    claims.push({ ...claim, id: `c${++next}` });
  }
  return { schemaVersion: 1, claims };
}

/** Hash of an inclusive line range; line endings and trailing whitespace are normalised. */
export function snippetHash(repo: string, evidence: Evidence): { hash: string } | { problem: string } {
  const [from, to] = evidence.lines;
  let abs: string;
  try {
    abs = insideRepo(repo, evidence.file);
  } catch {
    return { problem: `${evidence.file}: путь выходит за пределы репозитория` };
  }
  if (!existsSync(abs)) return { problem: `${evidence.file}: файл не найден` };
  const lines = readFileSync(abs, "utf8").split(/\r?\n/);
  if (from > to || to > lines.length) return { problem: `${evidence.file}:${from}-${to}: таких строк нет (в файле ${lines.length})` };
  const snippet = lines.slice(from - 1, to).map((l) => l.trimEnd()).join("\n");
  if (!snippet.trim()) return { problem: `${evidence.file}:${from}-${to}: указанные строки пусты` };
  return { hash: sha256(snippet) };
}

export interface ClaimCheck {
  claimId: string;
  ok: boolean;
  problems: string[];
}

/** Verify that every claim allowed into README is backed by code that still looks the same. */
export function checkClaims(repo: string, doc: ClaimsDoc): ClaimCheck[] {
  return doc.claims.map((claim) => {
    const problems: string[] = [];
    if (NEEDS_EVIDENCE.has(claim.status) && claim.evidence.length === 0) {
      problems.push(`статус «${claim.status}» без доказательства в коде`);
    }
    for (const evidence of claim.evidence) {
      const result = snippetHash(repo, evidence);
      const where = `${evidence.file}:${evidence.lines[0]}-${evidence.lines[1]}`;
      if ("problem" in result) problems.push(result.problem);
      else if (!evidence.snippetSha256) problems.push(`${where}: доказательство не зафиксировано (repokit scan claims pin)`);
      else if (evidence.snippetSha256 !== result.hash) problems.push(`${where}: код изменился с момента фиксации — перепроверьте утверждение`);
    }
    return { claimId: claim.id, ok: problems.length === 0, problems };
  });
}

/** Record hashes for evidence that has none yet (or for all of it with `force`). */
export function pinClaims(repo: string, doc: ClaimsDoc, force = false): { doc: ClaimsDoc; pinned: number; problems: string[] } {
  let pinned = 0;
  const problems: string[] = [];
  const claims = doc.claims.map((claim) => ({
    ...claim,
    evidence: claim.evidence.map((evidence) => {
      if (evidence.snippetSha256 && !force) return evidence;
      const result = snippetHash(repo, evidence);
      if ("problem" in result) {
        problems.push(`${claim.id}: ${result.problem}`);
        return evidence;
      }
      pinned += 1;
      return { ...evidence, snippetSha256: result.hash };
    }),
  }));
  return { doc: { schemaVersion: 1, claims }, pinned, problems };
}
