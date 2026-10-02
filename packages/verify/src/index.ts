import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Command } from "commander";
import {
  commonFlags, ExitCode, fileSha256, gitHead, listFiles, readArtifact, readManifest, readText, REPOKIT_DIR, resolveRepo, runCommand,
  UsageError, writeArtifact,
  type CommandResult, type CommonFlags, type HumanTodo,
} from "@repokit/core";
import { checkReadme, loadHuman } from "@repokit/readme";
import { analyze, checkClaims, isTestFile, type ClaimsDoc } from "@repokit/scan";
import { extractQuickstart, runQuickstart, type CommandOutcome } from "./quickstart.js";
import { scanForHiddenText, scanForSecrets } from "./secrets.js";

export { extractQuickstart, runQuickstart } from "./quickstart.js";
export { entropy, scanForHiddenText, scanForSecrets } from "./secrets.js";

const MEGABYTE = 1024 * 1024;
/** Size budgets. GitHub itself warns at 50 MB and rejects files over 100 MB. */
const BUDGET = { gif: 8 * MEGABYTE, image: 5 * MEGABYTE, fileWarn: 25 * MEGABYTE, fileFail: 95 * MEGABYTE };
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
const LINK_TIMEOUT_MS = 15_000;
const MAX_LISTED = 20;

export type CheckStatus = "pass" | "fail" | "warn" | "skip";

export interface Check {
  id: string;
  title: string;
  status: CheckStatus;
  details: string[];
}

export interface VerifyReport {
  schemaVersion: 1;
  ok: boolean;
  /** What was checked: a fresh clone of HEAD, or a copy of the working tree without ignored files. */
  source: "head" | "worktree";
  commit: string | null;
  checks: Check[];
}

interface VerifyFlags extends CommonFlags {
  source: string;
  online?: boolean;
  exec?: boolean;
  url?: string;
}

interface Snapshot {
  dir: string;
  notes: string[];
  cleanup: () => void;
}

const git = (cwd: string, args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

/** A throwaway copy of the repository as someone else would get it. */
function snapshot(repo: string, source: "head" | "worktree"): Snapshot {
  const work = mkdtempSync(join(tmpdir(), "repokit-verify-"));
  const cleanup = () => rmSync(work, { recursive: true, force: true });
  const notes: string[] = [];
  try {
    if (source === "head") {
      let top: string;
      let prefix: string;
      try {
        top = git(repo, ["rev-parse", "--show-toplevel"]);
        prefix = git(repo, ["rev-parse", "--show-prefix"]);
        git(repo, ["rev-parse", "HEAD"]);
      } catch {
        throw new UsageError("Здесь нет git-репозитория с коммитами. Проверить рабочую папку: repokit verify run --source worktree");
      }
      const clone = join(work, "clone");
      execFileSync("git", ["clone", "--quiet", "--depth", "1", pathToFileURL(top).href, clone], { stdio: "ignore" });
      if (gitHead(repo)?.dirty) notes.push("в рабочей папке есть незакоммиченные изменения — они не проверялись (проверен последний коммит)");
      return { dir: join(clone, prefix), notes, cleanup };
    }
    const copy = join(work, "copy");
    for (const file of listFiles(repo).files) {
      mkdirSync(dirname(join(copy, file.path)), { recursive: true });
      cpSync(join(repo, file.path), join(copy, file.path));
    }
    notes.push("проверена копия рабочей папки без игнорируемых файлов — так репозиторий будет выглядеть после коммита всех изменений");
    return { dir: copy, notes, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

const listed = (items: string[]) => (items.length > MAX_LISTED ? [...items.slice(0, MAX_LISTED), `… ещё ${items.length - MAX_LISTED}`] : items);

async function linkAlive(url: string): Promise<string | null> {
  for (const method of ["HEAD", "GET"]) {
    try {
      const response = await fetch(url, { method, redirect: "follow", signal: AbortSignal.timeout(LINK_TIMEOUT_MS), headers: { "user-agent": "repokit-verify" } });
      if (response.ok) return null;
      // Some servers reject HEAD; only a failed GET counts.
      if (method === "GET") return `HTTP ${response.status}`;
    } catch (error) {
      if (method === "GET") return (error as Error).name === "TimeoutError" ? "нет ответа" : "не удалось подключиться";
    }
  }
  return null;
}

export async function verifyRepository(repo: string, flags: Pick<VerifyFlags, "online" | "exec" | "url"> & { source: "head" | "worktree" }): Promise<{ report: VerifyReport; notes: string[] }> {
  const snap = snapshot(repo, flags.source);
  const checks: Check[] = [];
  const add = (id: string, title: string, status: CheckStatus, details: string[] = []) => checks.push({ id, title, status, details: listed(details) });
  try {
    const dir = snap.dir;
    const files = listFiles(dir).files;
    const paths = new Set(files.map((f) => f.path));
    const scan = analyze(dir);
    const readmeFile = scan.repoHealth.readme?.file ?? null;
    const readme = readmeFile ? readFileSync(join(dir, readmeFile), "utf8") : "";

    // --- README
    if (!readmeFile) add("readme.exists", "README есть", "fail", ["в репозитории нет README"]);
    else {
      add("readme.exists", "README есть", "pass", [readmeFile]);
      const problems = checkReadme(readme, paths);
      const of = (kind: string) => problems.filter((p) => p.kind === kind).map((p) => `строка ${p.line}: ${p.message}`);
      add("readme.fill", "В README нет незаполненных мест", of("fill").length ? "fail" : "pass", of("fill"));
      add("readme.links", "Ссылки и картинки README ведут на существующие файлы", of("missing-file").length ? "fail" : "pass", of("missing-file"));
      add("readme.alt", "У изображений есть alt-текст", of("missing-alt").length ? "fail" : "pass", of("missing-alt"));
    }

    // --- external links and the deployed URL
    const external = [...new Set([...readme.matchAll(/https?:\/\/[^\s)"'<>\]]+/g)].map((m) => m[0].replace(/[.,;:]+$/, "")))];
    const deployed = readArtifact(repo, "deploy.json");
    const demoUrl = flags.url ?? loadHuman(repo).demoUrl ?? (deployed ? (JSON.parse(deployed) as { url: string }).url : undefined);
    if (!flags.online) {
      add("readme.external-links", "Внешние ссылки README отвечают", "skip", [`не проверялись (${external.length}): добавьте --online`]);
      add("deploy.url", "Работающая версия отвечает", "skip", [demoUrl ? "не проверялась: добавьте --online" : "адрес не указан"]);
    } else {
      const dead: string[] = [];
      for (const url of external) {
        const problem = await linkAlive(url);
        if (problem) dead.push(`${url} — ${problem}`);
      }
      add("readme.external-links", "Внешние ссылки README отвечают", dead.length ? "fail" : "pass", dead.length ? dead : [`проверено ссылок: ${external.length}`]);
      if (!demoUrl) add("deploy.url", "Работающая версия отвечает", "skip", ["адрес не указан: --url или поле demoUrl"]);
      else {
        const problem = await linkAlive(demoUrl);
        add("deploy.url", "Работающая версия отвечает", problem ? "fail" : "pass", [problem ? `${demoUrl} — ${problem}` : demoUrl]);
      }
    }

    // --- text scans
    const secrets: string[] = [];
    const hidden: string[] = [];
    for (const file of files) {
      const text = readText(dir, file.path);
      if (text === null) continue;
      for (const finding of scanForSecrets(file.path, text)) secrets.push(`${finding.file}:${finding.line} [${finding.rule}] ${finding.preview}`);
      // Tests may legitimately contain such phrases as test data; everything a reviewer reads may not.
      if (!isTestFile(file.path)) for (const finding of scanForHiddenText(file.path, text)) hidden.push(`${finding.file}:${finding.line} — ${finding.message}`);
    }
    add("secrets", "В репозитории нет секретов", secrets.length ? "fail" : "pass", secrets);
    add("hidden-text", "Нет скрытого текста и инструкций для автоматических проверяющих", hidden.length ? "fail" : "pass", hidden);

    // --- junk and sizes
    const junk = files.map((f) => f.path).filter((p) => /(^|\/)(node_modules|__pycache__|\.venv|\.pytest_cache)\//.test(p) || /(^|\/)(\.env|\.DS_Store|Thumbs\.db)$/.test(p) || /\.(pyc|log)$/.test(p) || p.startsWith(`${REPOKIT_DIR}/`));
    add("junk", "Нет служебных файлов", junk.length ? "fail" : "pass", junk);

    const huge = files.filter((f) => f.size >= BUDGET.fileFail).map((f) => `${f.path} — ${(f.size / MEGABYTE).toFixed(1)} МБ (GitHub не примет файл больше 100 МБ)`);
    const large = files.filter((f) => f.size >= BUDGET.fileWarn && f.size < BUDGET.fileFail).map((f) => `${f.path} — ${(f.size / MEGABYTE).toFixed(1)} МБ`);
    add("large-files", "Нет слишком тяжёлых файлов", huge.length ? "fail" : large.length ? "warn" : "pass", [...huge, ...large]);

    const referenced = [...new Set([...readme.matchAll(/(?:src|srcset)="([^"\s]+)|!\[[^\]]*\]\(([^)\s]+)/g)].map((m) => m[1] ?? m[2]))]
      .filter((p) => !/^https?:/.test(p) && IMAGE_EXT.has(extname(p).toLowerCase()) && existsSync(join(dir, p)));
    const overBudget = referenced.flatMap((path) => {
      const size = statSync(join(dir, path)).size;
      const limit = extname(path).toLowerCase() === ".gif" ? BUDGET.gif : BUDGET.image;
      return size > limit ? [`${path} — ${(size / MEGABYTE).toFixed(1)} МБ при бюджете ${limit / MEGABYTE} МБ`] : [];
    });
    add("media-budget", "Медиа в README укладывается в бюджет", overBudget.length ? "fail" : "pass", overBudget.length ? overBudget : [`файлов: ${referenced.length}`]);

    // --- provenance and claims use repokit's records from the original repository
    let known = new Set<string>();
    try {
      known = new Set(readManifest(repo).media.map((m) => m.sha256));
    } catch {
      // No manifest yet.
    }
    const unknown = referenced.filter((path) => !known.has(fileSha256(join(dir, path))));
    add("provenance", "Происхождение медиа известно", unknown.length ? "warn" : "pass", unknown.map((p) => `${p} — не создан через repokit capture/studio`));

    const claimsText = readArtifact(repo, "claims.json");
    if (!claimsText) add("claims", "Утверждения README подтверждены кодом", "skip", ["нет .repokit/claims.json"]);
    else {
      const stale = checkClaims(dir, JSON.parse(claimsText) as ClaimsDoc).filter((c) => !c.ok);
      add("claims", "Утверждения README подтверждены кодом", stale.length ? "fail" : "pass", stale.flatMap((c) => c.problems.map((p) => `${c.claimId}: ${p}`)));
    }

    // --- quick start
    const commands = extractQuickstart(readme);
    if (commands.length === 0) add("quickstart", "Команды из README выполняются", readmeFile ? "warn" : "skip", ["в README не найдено команд запуска"]);
    else if (!flags.exec) add("quickstart", "Команды из README выполняются", "skip", ["не выполнялись — добавьте --exec, чтобы запустить их во временной копии:", ...commands.map((c) => `  ${c.command}`)]);
    else {
      const { outcomes, notes } = await runQuickstart(commands, dir);
      snap.notes.push(...notes);
      const line = (o: CommandOutcome) => `${o.status === "pass" ? "ок" : o.status === "fail" ? "ОШИБКА" : "пропущена"}: ${o.command} — ${o.detail}`;
      const status = outcomes.some((o) => o.status === "fail") ? "fail" : outcomes.some((o) => o.status === "skip") ? "warn" : "pass";
      add("quickstart", "Команды из README выполняются", status, outcomes.map(line));
    }

    const report: VerifyReport = {
      schemaVersion: 1,
      ok: !checks.some((c) => c.status === "fail"),
      source: flags.source,
      commit: gitHead(repo)?.commit ?? null,
      checks,
    };
    return { report, notes: snap.notes };
  } finally {
    snap.cleanup();
  }
}

const MARK: Record<CheckStatus, string> = { pass: "ок   ", fail: "ОШИБКА", warn: "внимание", skip: "пропущено" };

async function run(flags: VerifyFlags): Promise<CommandResult<VerifyReport>> {
  const repo = resolveRepo(flags.repo);
  if (flags.source !== "head" && flags.source !== "worktree") throw new UsageError(`--source: ожидается head или worktree, получено «${flags.source}»`);
  if (flags.url && !/^https?:\/\//.test(flags.url)) throw new UsageError("--url должен начинаться с http:// или https://");
  const { report, notes } = await verifyRepository(repo, { ...flags, source: flags.source });

  const failed = report.checks.filter((c) => c.status === "fail");
  const humanTodo: HumanTodo[] = failed.map((c) => ({ id: `verify.${c.id}`, text: `Проверка «${c.title}» не пройдена: ${c.details.slice(0, 3).join("; ")}` }));
  return {
    data: report,
    exitCode: report.ok ? ExitCode.Ok : ExitCode.CheckFailed,
    warnings: notes,
    humanTodo,
    artifacts: [writeArtifact(repo, "verify.json", JSON.stringify(report, null, 2) + "\n", "verify", flags.dryRun)],
    summary: [
      `${report.ok ? "проверка пройдена" : "ПРОВЕРКА НЕ ПРОЙДЕНА"}: ок ${report.checks.filter((c) => c.status === "pass").length}, ошибок ${failed.length}, ` +
        `предупреждений ${report.checks.filter((c) => c.status === "warn").length}, пропущено ${report.checks.filter((c) => c.status === "skip").length}`,
      ...report.checks.flatMap((c) => [`  ${MARK[c.status].padEnd(9)} ${c.title}`, ...(c.status === "pass" ? [] : c.details.map((d) => `              ${d}`))]),
    ],
  };
}

interface QuickstartData {
  source: "head" | "worktree";
  status: CheckStatus;
  details: string[];
}

/** Only the question a newcomer cares about: do the commands from the README work in a fresh copy? */
export async function quickstartCommand(flags: CommonFlags & { source: string }): Promise<CommandResult<QuickstartData | { plan: string[] }>> {
  const repo = resolveRepo(flags.repo);
  if (flags.source !== "head" && flags.source !== "worktree") throw new UsageError(`--source: ожидается head или worktree, получено «${flags.source}»`);
  if (flags.dryRun) {
    return { data: { plan: ["во временной копии репозитория были бы выполнены команды из раздела о запуске README"] }, summary: ["dry-run: команды не выполнялись"] };
  }
  const { report, notes } = await verifyRepository(repo, { source: flags.source, exec: true });
  const check = report.checks.find((c) => c.id === "quickstart")!;
  return {
    data: { source: flags.source, status: check.status, details: check.details },
    exitCode: check.status === "fail" ? ExitCode.CheckFailed : ExitCode.Ok,
    warnings: notes,
    humanTodo: check.status === "fail" ? [{ id: "verify.quickstart", text: `Команды из README не работают в чистой копии: ${check.details.filter((d) => d.startsWith("ОШИБКА")).join("; ")}` }] : [],
    summary: [`${MARK[check.status].trim()}: ${check.title}`, ...check.details.map((d) => `  ${d}`)],
  };
}

export const QUICKSTART_DESCRIPTION = "выполнить команды запуска из README во временной копии репозитория";

export function registerVerify(program: Command): void {
  const verify = program.command("verify").description("проверка репозитория глазами того, кто его только что склонировал");
  commonFlags(verify.command("run").description("клонировать во временную папку и проверить README, ссылки, медиа, секреты, скрытый текст"))
    .option("--source <kind>", "что проверять: head (чистый клон последнего коммита) или worktree (рабочая папка без игнорируемых файлов)", "head")
    .option("--online", "проверить внешние ссылки README и адрес работающей версии")
    .option("--exec", "выполнить команды Quick start из README во временной копии")
    .option("--url <url>", "адрес работающей версии (по умолчанию — поле demoUrl)")
    .action((flags: VerifyFlags) => runCommand("verify", "run", flags, () => run(flags)));
  commonFlags(verify.command("quickstart").description(QUICKSTART_DESCRIPTION))
    .option("--source <kind>", "head (чистый клон последнего коммита) или worktree (рабочая папка без игнорируемых файлов)", "worktree")
    .action((flags: CommonFlags & { source: string }) => runCommand("verify", "quickstart", flags, () => quickstartCommand(flags)));
}
