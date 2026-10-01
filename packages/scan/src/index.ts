import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import {
  assertValid, commonFlags, ExitCode, readArtifact, REPOKIT_DIR, resolveRepo, runCommand, UsageError, writeArtifact,
  type Artifact, type CommandResult, type CommonFlags, type HumanTodo,
} from "@repokit/core";
import { analyze } from "./analyze.js";
import { checkClaims, extractClaims, mergeClaims, pinClaims, type ClaimCheck } from "./claims.js";
import { renderContext, suggestTopics } from "./report.js";
import type { ClaimsDoc, ScanResult } from "./types.js";

export { analyze, isTestFile } from "./analyze.js";
export { checkClaims, extractClaims, mergeClaims, pinClaims, snippetHash } from "./claims.js";
export { renderContext, suggestTopics } from "./report.js";
export type * from "./types.js";

const CLAIMS_FILE = "claims.json";
const GITIGNORE_ENTRY = `${REPOKIT_DIR}/`;

const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

function scanRepo(flags: CommonFlags): { repo: string; scan: ScanResult } {
  const repo = resolveRepo(flags.repo);
  const scan = analyze(repo);
  assertValid("scan", scan);
  return { repo, scan };
}

function loadClaims(repo: string): ClaimsDoc | null {
  const text = readArtifact(repo, CLAIMS_FILE);
  if (text === null) return null;
  let doc: ClaimsDoc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new UsageError(`${REPOKIT_DIR}/${CLAIMS_FILE}: некорректный JSON`);
  }
  assertValid("claims", doc);
  return doc;
}

function requireClaims(repo: string): ClaimsDoc {
  const doc = loadClaims(repo);
  if (!doc) throw new UsageError(`Нет ${REPOKIT_DIR}/${CLAIMS_FILE}. Сначала: repokit scan claims extract`);
  return doc;
}

function audit(flags: CommonFlags): CommandResult<ScanResult> {
  const { repo, scan } = scanRepo(flags);
  const count = (severity: string) => scan.audit.filter((a) => a.severity === severity).length;
  const errors = count("error");
  return {
    data: scan,
    exitCode: errors > 0 ? ExitCode.CheckFailed : ExitCode.Ok,
    artifacts: [writeArtifact(repo, "scan.json", json(scan), "scan", flags.dryRun)],
    summary: [
      `${scan.project.name}: ${scan.project.types.join(", ")}; фреймворки: ${scan.project.frameworks.join(", ") || "—"}`,
      `роутов: ${scan.routes.length}, моделей: ${scan.models.length}, точек входа: ${scan.entrypoints.length}, заглушек: ${scan.mocks.length}`,
      `аудит: ошибок ${errors}, предупреждений ${count("warn")}, заметок ${count("info")}`,
      ...scan.audit.filter((a) => a.severity !== "info").map((a) => `  [${a.severity}] ${a.message}${a.file ? ` (${a.file})` : ""}`),
    ],
  };
}

function context(flags: CommonFlags): CommandResult<{ markdown: string }> {
  const { repo, scan } = scanRepo(flags);
  const markdown = renderContext(repo, scan);
  return {
    data: { markdown },
    artifacts: [writeArtifact(repo, "context.md", markdown, "context", flags.dryRun)],
    summary: [`контекст: ${markdown.split("\n").length} строк`],
  };
}

function topics(flags: CommonFlags): CommandResult<{ topics: string[] }> {
  const { scan } = scanRepo(flags);
  const list = suggestTopics(scan);
  return {
    data: { topics: list },
    humanTodo: [{ id: "topics.apply", text: `Проверьте и задайте topics репозитория на GitHub: ${list.join(", ")}` }],
    summary: [`предложено topics: ${list.length} (автоматически не применяются)`],
  };
}

function init(flags: CommonFlags & { writeGitignore?: boolean }): CommandResult<{ created: boolean; gitignored: boolean }> {
  const repo = resolveRepo(flags.repo);
  const dir = join(repo, REPOKIT_DIR);
  const created = !existsSync(dir);
  if (created && !flags.dryRun) mkdirSync(dir, { recursive: true });

  const gitignore = join(repo, ".gitignore");
  const current = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
  let gitignored = current.split(/\r?\n/).some((line) => line.trim().replace(/\/$/, "") === REPOKIT_DIR);
  const humanTodo: HumanTodo[] = [];
  const summary = [created ? `${flags.dryRun ? "будет создана" : "создана"} папка ${REPOKIT_DIR}/` : `папка ${REPOKIT_DIR}/ уже есть`];
  if (!gitignored) {
    if (flags.writeGitignore) {
      if (!flags.dryRun) appendFileSync(gitignore, `${current && !current.endsWith("\n") ? "\n" : ""}${GITIGNORE_ENTRY}\n`);
      gitignored = !flags.dryRun;
      summary.push(`${flags.dryRun ? "будет добавлено" : "добавлено"} в .gitignore: ${GITIGNORE_ENTRY}`);
    } else {
      humanTodo.push({ id: "gitignore.repokit", text: `Добавьте ${GITIGNORE_ENTRY} в .gitignore (или: repokit scan init --write-gitignore)` });
    }
  }
  return { data: { created, gitignored }, humanTodo, summary };
}

function claimsExtract(flags: CommonFlags): CommandResult<ClaimsDoc> {
  const { repo, scan } = scanRepo(flags);
  const readme = scan.repoHealth.readme;
  if (!readme) throw new UsageError("В репозитории нет README — извлекать утверждения неоткуда.");
  const found = extractClaims(readFileSync(join(repo, readme.file), "utf8"));
  const doc = mergeClaims(loadClaims(repo), found);
  assertValid("claims", doc);
  const unverified = doc.claims.filter((c) => c.status === "unverified").length;
  return {
    data: doc,
    artifacts: [writeArtifact(repo, CLAIMS_FILE, json(doc), "claims", flags.dryRun)],
    summary: [`утверждений в README: ${found.length}; всего в ${CLAIMS_FILE}: ${doc.claims.length}; не проверено: ${unverified}`],
  };
}

function claimsPin(flags: CommonFlags & { force?: boolean }): CommandResult<{ pinned: number; problems: string[] }> {
  const repo = resolveRepo(flags.repo);
  const { doc, pinned, problems } = pinClaims(repo, requireClaims(repo), flags.force);
  const artifacts: Artifact[] = [writeArtifact(repo, CLAIMS_FILE, json(doc), "claims", flags.dryRun)];
  return {
    data: { pinned, problems },
    exitCode: problems.length > 0 ? ExitCode.CheckFailed : ExitCode.Ok,
    artifacts,
    summary: [`зафиксировано доказательств: ${pinned}`, ...problems.map((p) => `  ${p}`)],
  };
}

function claimsCheck(flags: CommonFlags): CommandResult<{ results: ClaimCheck[]; failed: number }> {
  const repo = resolveRepo(flags.repo);
  const results = checkClaims(repo, requireClaims(repo));
  const failed = results.filter((r) => !r.ok);
  return {
    data: { results, failed: failed.length },
    exitCode: failed.length > 0 ? ExitCode.CheckFailed : ExitCode.Ok,
    summary: [
      `утверждений: ${results.length}, с проблемами: ${failed.length}`,
      ...failed.flatMap((r) => r.problems.map((p) => `  ${r.claimId}: ${p}`)),
    ],
  };
}

export function registerScan(program: Command): void {
  const scan = program.command("scan").description("анализ репозитория: факты, аудит, утверждения README");
  const add = <F extends CommonFlags>(parent: Command, name: string, description: string, body: (flags: F) => CommandResult<unknown>, extend?: (c: Command) => Command) => {
    const command = commonFlags(parent.command(name).description(description));
    (extend?.(command) ?? command).action((flags: F) => runCommand("scan", parent === scan ? name : `${parent.name()} ${name}`, flags, () => body(flags)));
  };

  add(scan, "audit", "собрать факты о проекте и замечания → .repokit/scan.json", audit);
  add(scan, "context", "краткая выжимка репозитория для модели → .repokit/context.md", context);
  add(scan, "topics", "предложить GitHub topics по обнаруженному стеку", topics);
  add(scan, "init", "создать .repokit/ в целевом репозитории", init, (c) => c.option("--write-gitignore", "добавить .repokit/ в .gitignore"));

  const claims = scan.command("claims").description("утверждения README и их доказательства в коде");
  add(claims, "extract", "извлечь утверждения из README → .repokit/claims.json", claimsExtract);
  add(claims, "pin", "зафиксировать хэши строк-доказательств", claimsPin, (c) => c.option("--force", "перезаписать уже зафиксированные хэши"));
  add(claims, "check", "проверить, что доказательства существуют и код не изменился", claimsCheck);
}
