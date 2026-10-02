import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Command } from "commander";
import {
  assertValid, commonFlags, ExitCode, NeedsHumanError, readArtifact, redact, resolveRepo, runCommand, UsageError, writeArtifact,
  type CommandResult, type CommonFlags, type HumanTodo,
} from "@repokit/core";
import { analyze } from "@repokit/scan";
import { planDeploy, type DeployPlan, type PlannedFile } from "./plan.js";
import { candidates, PROVIDER_IDS, PROVIDERS, type ProviderId } from "./providers.js";

export { envVarNames, hostedStartCommand, planDeploy } from "./plan.js";
export type { DeployPlan, PlannedFile } from "./plan.js";
export { candidates, PROVIDER_IDS, PROVIDERS } from "./providers.js";
export type { Provider, ProviderId } from "./providers.js";

const DEPLOY_FILE = "deploy.json";
const DEFAULT_TIMEOUT_SEC = 90;
const RETRY_INTERVAL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 20_000;
/** A first response slower than this, or one that needed retries, is reported as a cold start. */
const COLD_START_MS = 5_000;

/** The deployment repokit knows about: where it is and whether it answered last time. */
export interface DeployRecord {
  schemaVersion: 1;
  provider: ProviderId | null;
  url: string;
  healthy: boolean;
  status: number | null;
  attempts: number;
  latencyMs: number | null;
  coldStart: boolean;
  /** The free tier of this provider puts the app to sleep. */
  sleeps: boolean;
  checkedAt: string;
}

export function loadDeploy(repo: string): DeployRecord | null {
  const text = readArtifact(repo, DEPLOY_FILE);
  return text ? (JSON.parse(text) as DeployRecord) : null;
}

/** Runs a command of the user's CLI. Injected so that deployments can be tested without touching real services. */
export type Executor = (command: string[], cwd: string) => { code: number; output: string };

const realExecutor: Executor = (command, cwd) => {
  // Fixed provider CLIs only; shell is needed on Windows to resolve their .cmd shims.
  const result = spawnSync(command.map((part) => (/[\s"]/.test(part) ? JSON.stringify(part) : part)).join(" "), { cwd, shell: true, encoding: "utf8" });
  return { code: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
};

interface PlanFlags extends CommonFlags {
  provider?: string;
}

interface PlanData {
  provider: ProviderId;
  title: string;
  reason: string;
  automated: boolean;
  alternatives: { provider: ProviderId; reason: string }[];
  files: { path: string; state: PlannedFile["state"]; purpose: string }[];
  commands: string[];
  humanSteps: string[];
  envVars: string[];
  limits: string[];
  expectedUrl: string | null;
}

/** Repo-level configs live at the git root, which may be above the project folder; say so instead of printing ../.. */
const filePath = (repo: string, file: PlannedFile) => (file.root === repo ? file.path : `${file.path} (в корне git-репозитория)`);
const STATE_LABEL: Record<PlannedFile["state"], string> = { new: "будет создан", same: "уже есть", differs: "есть с другим содержимым" };

function describe(repo: string, plan: DeployPlan): { data: PlanData; summary: string[]; humanTodo: HumanTodo[] } {
  const data: PlanData = {
    provider: plan.provider.id,
    title: plan.provider.title,
    reason: plan.reason,
    automated: plan.provider.automated,
    alternatives: plan.alternatives,
    files: plan.files.map((f) => ({ path: filePath(repo, f), state: f.state, purpose: f.purpose })),
    commands: plan.commands.map((c) => c.join(" ")),
    humanSteps: plan.humanSteps,
    envVars: plan.envVars,
    limits: plan.provider.limits,
    expectedUrl: plan.expectedUrl,
  };
  return {
    data,
    humanTodo: plan.humanSteps.map((text, index) => ({ id: `deploy.step-${index + 1}`, text: `Деплой (${plan.provider.title}): ${text}` })),
    summary: [
      `провайдер: ${plan.provider.title} — ${plan.reason}`,
      ...plan.alternatives.map((a) => `  другой вариант: ${PROVIDERS[a.provider].title} — ${a.reason}`),
      ...data.files.map((f) => `файл ${f.path} (${STATE_LABEL[f.state]}): ${f.purpose}`),
      ...data.commands.map((c) => `команда для deploy run: ${c}`),
      ...plan.provider.limits.map((l) => `ограничение бесплатного тарифа: ${l}`),
      ...(plan.expectedUrl ? [`ожидаемый адрес: ${plan.expectedUrl}`] : []),
    ],
  };
}

function providers(): CommandResult<{ providers: { id: ProviderId; title: string; automated: boolean; cli: string | null; sleeps: boolean; limits: string[] }[] }> {
  const list = PROVIDER_IDS.map((id) => ({ id, title: PROVIDERS[id].title, automated: PROVIDERS[id].automated, cli: PROVIDERS[id].cli?.name ?? null, sleeps: PROVIDERS[id].sleeps, limits: PROVIDERS[id].limits }));
  return { data: { providers: list }, summary: list.map((p) => `${p.id} — ${p.title}; ${p.automated ? `запуск через ${p.cli}` : "последний шаг вручную в панели"}${p.sleeps ? "; засыпает при простое" : ""}`) };
}

function detect(flags: CommonFlags): CommandResult<{ types: string[]; candidates: { provider: ProviderId; reason: string }[] }> {
  const scan = analyze(resolveRepo(flags.repo));
  const options = candidates(scan);
  return {
    data: { types: scan.project.types, candidates: options },
    summary: [
      `тип проекта: ${scan.project.types.join(", ")}`,
      ...(options.length > 0 ? options.map((o, i) => `${i === 0 ? "рекомендуется" : "запасной    "}: ${o.provider} — ${o.reason}`) : ["подходящий провайдер не определён — выберите сами: --provider"]),
    ],
  };
}

function plan(flags: PlanFlags): CommandResult<PlanData> {
  const repo = resolveRepo(flags.repo);
  const built = planDeploy(repo, analyze(repo), flags.provider);
  const { data, summary, humanTodo } = describe(repo, built);
  return {
    data, summary, humanTodo, warnings: built.warnings,
    artifacts: [writeArtifact(repo, "deploy.plan.json", JSON.stringify(data, null, 2) + "\n", "deploy-plan", flags.dryRun)],
  };
}

function apply(flags: PlanFlags & { force?: boolean }): CommandResult<{ written: string[]; skipped: string[] }> {
  const repo = resolveRepo(flags.repo);
  const built = planDeploy(repo, analyze(repo), flags.provider);
  const written: string[] = [];
  const skipped: string[] = [];
  const warnings = [...built.warnings];
  for (const file of built.files) {
    const path = filePath(repo, file);
    if (file.state === "same") continue;
    if (file.state === "differs" && !flags.force) {
      skipped.push(path);
      warnings.push(`${path} уже существует с другим содержимым — не тронут. Перезаписать: --force`);
      continue;
    }
    written.push(path);
    if (!flags.dryRun) {
      mkdirSync(dirname(join(file.root, file.path)), { recursive: true });
      writeFileSync(join(file.root, file.path), file.content);
    }
  }
  return {
    data: { written, skipped },
    warnings,
    humanTodo: describe(repo, built).humanTodo,
    summary: [
      written.length === 0 ? "файлы конфигурации уже на месте — изменений нет" : `${flags.dryRun ? "dry-run: были бы записаны" : "записаны"}: ${written.join(", ")}`,
      ...(flags.dryRun ? built.files.filter((f) => f.state !== "same").flatMap((f) => [`--- ${filePath(repo, f)}`, ...f.content.trimEnd().split("\n").map((l) => `  ${l}`)]) : []),
    ],
  };
}

export interface RunOutcome {
  executed: { command: string; ok: boolean; output: string }[];
  url: string | null;
}

/** Start the deployment through the user's CLI. Never logs in, never creates accounts. */
export function runDeploy(repo: string, built: DeployPlan, execute: Executor = realExecutor): RunOutcome {
  const { provider } = built;
  if (!provider.automated || !provider.cli || built.commands.length === 0) {
    throw new NeedsHumanError(`${provider.title}: у площадки нет команды для запуска деплоя. Сделайте сами: ${built.humanSteps.join("; ")}`);
  }
  const pending = built.files.filter((f) => f.state !== "same");
  if (pending.length > 0) throw new UsageError(`Сначала запишите конфигурацию: repokit deploy apply (не хватает: ${pending.map((f) => filePath(repo, f)).join(", ")})`);

  const { cli } = provider;
  const who = execute([cli.name, ...cli.whoami], repo);
  if (who.code !== 0) {
    throw new NeedsHumanError(
      /not found|не является|not recognized|ENOENT/i.test(who.output) || who.output.trim() === ""
        ? `Не найден ${cli.name}. Установите его (${cli.install}) и войдите: ${cli.login}`
        : `Вы не вошли в ${provider.title}. Выполните сами: ${cli.login}`,
    );
  }

  const executed: RunOutcome["executed"] = [];
  let url = built.expectedUrl;
  for (const command of built.commands) {
    const result = execute(command, repo);
    const output = redact(result.output.trim()).slice(-1500);
    // Enabling Pages on a repository where it is already enabled is not a failure.
    const alreadyDone = command.includes("build_type=workflow") && /already|409/i.test(result.output);
    executed.push({ command: command.join(" "), ok: result.code === 0 || alreadyDone, output });
    if (result.code !== 0 && !alreadyDone) break;
    const printed = result.output.match(/https:\/\/[^\s"']+\.(?:vercel\.app|netlify\.app|pages\.dev|fly\.dev)[^\s"']*/);
    if (printed) url = printed[0];
  }
  return { executed, url };
}

function run(flags: PlanFlags & { confirm?: boolean }): CommandResult<RunOutcome | { wouldRun: string[] }> {
  const repo = resolveRepo(flags.repo);
  const built = planDeploy(repo, analyze(repo), flags.provider);
  const commands = built.commands.map((c) => c.join(" "));
  if (flags.dryRun) return { data: { wouldRun: commands }, warnings: built.warnings, summary: ["dry-run: ничего не запускалось", ...commands.map((c) => `  ${c}`)] };
  // Publishing is outward-facing and hard to undo: it never happens on a plain invocation.
  if (!flags.confirm) {
    throw new NeedsHumanError(`Деплой на ${built.provider.title} публикует проект в интернете. Будут выполнены: ${commands.join("; ") || "—"}. Подтвердить: repokit deploy run --confirm`);
  }
  const outcome = runDeploy(repo, built);
  const failed = outcome.executed.find((e) => !e.ok);
  return {
    data: outcome,
    exitCode: failed ? ExitCode.CheckFailed : ExitCode.Ok,
    warnings: built.warnings,
    humanTodo: outcome.url ? [{ id: "deploy.check", text: `Проверьте, что сайт отвечает: repokit deploy check --url ${outcome.url}` }] : [],
    summary: [
      ...outcome.executed.map((e) => `${e.ok ? "ок    " : "ОШИБКА"} ${e.command}${e.ok ? "" : ` — ${e.output}`}`),
      failed ? "деплой не завершён" : `деплой запущен${outcome.url ? `; адрес: ${outcome.url}` : ""}`,
    ],
  };
}

interface CheckFlags extends CommonFlags {
  url?: string;
  path?: string;
  timeout: string;
  provider?: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Request a URL until it answers successfully or the time runs out. */
export async function waitForUrl(url: string, timeoutMs: number, intervalMs = RETRY_INTERVAL_MS): Promise<{ healthy: boolean; status: number | null; attempts: number; latencyMs: number | null }> {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let status: number | null = null;
  while (true) {
    attempts += 1;
    const started = Date.now();
    try {
      const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { "user-agent": "repokit-deploy-check" } });
      status = response.status;
      if (response.ok) return { healthy: true, status, attempts, latencyMs: Date.now() - started };
    } catch {
      status = null;
    }
    if (Date.now() + intervalMs > deadline) return { healthy: false, status, attempts, latencyMs: null };
    await sleep(intervalMs);
  }
}

async function check(flags: CheckFlags): Promise<CommandResult<DeployRecord>> {
  const repo = resolveRepo(flags.repo);
  const previous = loadDeploy(repo);
  const base = flags.url ?? previous?.url;
  if (!base) throw new UsageError("Укажите адрес: repokit deploy check --url https://…");
  if (!/^https?:\/\//.test(base)) throw new UsageError("--url должен начинаться с http:// или https://");
  if (flags.provider && !PROVIDER_IDS.includes(flags.provider as ProviderId)) throw new UsageError(`Неизвестный провайдер «${flags.provider}»`);
  const timeoutSec = Number(flags.timeout);
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) throw new UsageError(`--timeout: ожидается число секунд, получено «${flags.timeout}»`);

  const target = flags.path ? new URL(flags.path, base).toString() : base;
  const provider = (flags.provider as ProviderId | undefined) ?? previous?.provider ?? null;
  const result = await waitForUrl(target, timeoutSec * 1000);
  const coldStart = result.healthy && (result.attempts > 1 || (result.latencyMs ?? 0) > COLD_START_MS);
  const record: DeployRecord = {
    schemaVersion: 1, provider, url: base, ...result, coldStart,
    sleeps: provider ? PROVIDERS[provider].sleeps : false,
    checkedAt: new Date().toISOString(),
  };
  assertValid("deploy", record);
  const warnings: string[] = [];
  if (coldStart) warnings.push(`сайт ответил не сразу (попыток: ${result.attempts}) — похоже на холодный старт; откройте его заранее перед показом`);
  return {
    data: record,
    exitCode: result.healthy ? ExitCode.Ok : ExitCode.CheckFailed,
    warnings,
    artifacts: [writeArtifact(repo, DEPLOY_FILE, JSON.stringify(record, null, 2) + "\n", "deploy", flags.dryRun)],
    summary: [
      result.healthy
        ? `${target} отвечает: HTTP ${result.status}, ${result.latencyMs} мс, попыток ${result.attempts}`
        : `${target} не ответил за ${timeoutSec} с (попыток ${result.attempts}${result.status ? `, последний ответ HTTP ${result.status}` : ""})`,
      ...(result.healthy ? ["адрес сохранён: README возьмёт его в раздел «Демо», verify --online будет его проверять"] : []),
    ],
  };
}

export function registerDeploy(program: Command): void {
  const deploy = program.command("deploy").description("деплой на бесплатные площадки: выбор, конфигурация, запуск через ваш CLI, проверка адреса");
  const withProvider = (c: Command) => commonFlags(c).option("--provider <id>", `площадка: ${PROVIDER_IDS.join(", ")}`);

  deploy.command("providers").description("список площадок и ограничения их бесплатных тарифов").option("--json", "один JSON-документ в stdout")
    .action((flags: { json?: boolean }) => runCommand("deploy", "providers", flags, providers));
  commonFlags(deploy.command("detect").description("какая площадка подходит проекту и почему"))
    .action((flags: CommonFlags) => runCommand("deploy", "detect", flags, () => detect(flags)));
  withProvider(deploy.command("plan").description("что будет создано, какие команды выполнятся, что останется сделать вам"))
    .action((flags: PlanFlags) => runCommand("deploy", "plan", flags, () => plan(flags)));
  withProvider(deploy.command("apply").description("записать файлы конфигурации в репозиторий; --dry-run показывает их содержимое"))
    .option("--force", "перезаписать существующие файлы с другим содержимым")
    .action((flags: PlanFlags & { force?: boolean }) => runCommand("deploy", "apply", flags, () => apply(flags)));
  withProvider(deploy.command("run").description("запустить деплой через ваш CLI — только с --confirm"))
    .option("--confirm", "подтверждаю публикацию проекта")
    .action((flags: PlanFlags & { confirm?: boolean }) => runCommand("deploy", "run", flags, () => run(flags)));
  withProvider(deploy.command("check").description("дождаться ответа сайта и запомнить адрес"))
    .option("--url <url>", "адрес сайта (по умолчанию — сохранённый)")
    .option("--path <path>", "путь для проверки, например /health")
    .option("--timeout <sec>", "сколько ждать холодного старта", String(DEFAULT_TIMEOUT_SEC))
    .action((flags: CheckFlags) => runCommand("deploy", "check", flags, () => check(flags)));
}
