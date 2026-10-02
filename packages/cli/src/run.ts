import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import {
  ExitCode, readArtifact, REPOKIT_DIR, repoRelative, resolveRepo, runCommand, UsageError, writeArtifact,
  type CommandResult, type Envelope, type HumanTodo,
} from "@repokit/core";

const BIN = fileURLToPath(new URL("./bin.js", import.meta.url));
const STATE_FILE = "state.json";
const DEFAULT_SCENARIO = "demo.scenario.yaml";
const HERO = "docs/media/hero";
const HERO_3D = "docs/media/hero-3d";

export const STEPS = ["scan", "brief", "claims", "deploy", "demo", "readme", "verify"] as const;
type StepId = (typeof STEPS)[number];
type StepStatus = "done" | "skipped" | "waiting" | "failed" | "pending";

interface State {
  schemaVersion: 1;
  steps: Partial<Record<StepId, "done" | "skipped">>;
}

interface StepReport {
  id: StepId;
  status: StepStatus;
  summary: string;
}

interface RunFlags {
  json?: boolean;
  approve: string[];
  skip: string[];
  scenario?: string;
  rules?: string;
  defaultBrief?: boolean;
  preset: string;
  preset3d: string;
  exec?: boolean;
  online?: boolean;
  reset?: boolean;
}

/** A step either finishes, or stops the run because a person has to do or approve something. */
class Pause extends Error {
  constructor(readonly kind: "waiting" | "failed", message: string, readonly todo: string) {
    super(message);
  }
}

const collect = (value: string, previous: string[]) => [...previous, value];

function parseSteps(values: string[], flag: string): Set<StepId> {
  const bad = values.filter((v) => !STEPS.includes(v as StepId));
  if (bad.length > 0) throw new UsageError(`${flag}: неизвестный шаг «${bad[0]}». Шаги: ${STEPS.join(", ")}`);
  return new Set(values as StepId[]);
}

async function run(path: string | undefined, flags: RunFlags): Promise<CommandResult<{ steps: StepReport[]; next: string | null }>> {
  const repo = resolveRepo(path ?? ".");
  const approved = parseSteps(flags.approve, "--approve");
  const skipped = parseSteps(flags.skip, "--skip");
  const saved = flags.reset ? null : readArtifact(repo, STATE_FILE);
  const state: State = saved ? JSON.parse(saved) : { schemaVersion: 1, steps: {} };
  const humanTodo: HumanTodo[] = [];
  const warnings: string[] = [];
  const again = `repokit run ${path ?? "."}`;

  /** Run one repokit command as a child process and read its envelope: the same contract any caller gets. */
  const call = (args: string[]): Envelope<any> => {
    const result = spawnSync(process.execPath, [BIN, ...args, "--repo", repo, "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (!result.stdout) {
      const reason = result.stderr.trim().split(/\r?\n/).slice(-3).join(" ");
      throw new Pause("failed", `repokit ${args.slice(0, 2).join(" ")} аварийно завершился: ${reason}`, "");
    }
    const envelope = JSON.parse(result.stdout) as Envelope<any>;
    for (const todo of envelope.humanTodo) if (!humanTodo.some((t) => t.id === todo.id)) humanTodo.push(todo);
    warnings.push(...envelope.warnings.map((w) => `${args[0]} ${args[1]}: ${w}`));
    return envelope;
  };
  /** A command that must succeed for the step to make sense. */
  const must = (args: string[]): Envelope<any> => {
    const envelope = call(args);
    if (envelope.exitCode === ExitCode.NeedsHuman) throw new Pause("waiting", envelope.error?.message ?? "нужен человек", envelope.error?.message ?? "");
    if (envelope.exitCode !== ExitCode.Ok) throw new Pause("failed", envelope.error?.message ?? `repokit ${args.join(" ")} завершился с кодом ${envelope.exitCode}`, "");
    return envelope;
  };

  const handlers: Record<StepId, () => string> = {
    scan: () => {
      must(["scan", "init"]);
      const audit = call(["scan", "audit"]);
      must(["scan", "context"]);
      if (audit.data?.repoHealth?.readme) must(["scan", "claims", "extract"]);
      const errors = (audit.data?.audit ?? []).filter((a: { severity: string }) => a.severity === "error").length;
      return `${audit.data.project.types.join(", ")}; роутов ${audit.data.routes.length}, заглушек ${audit.data.mocks.length}, ошибок аудита ${errors}`;
    },

    brief: () => {
      if (readArtifact(repo, "brief.json") === null) {
        if (flags.rules) {
          must(["brief", "extract", "--file", resolve(flags.rules)]);
          throw new Pause("waiting", "правила сохранены — нужна разметка критериев", `Заполните ${REPOKIT_DIR}/brief.json по тексту ${REPOKIT_DIR}/brief.source.txt (каждый пункт — с дословной цитатой), затем: ${again}`);
        }
        if (!flags.defaultBrief) {
          throw new Pause("waiting", "нет правил хакатона", `Передайте правила: ${again} --rules <файл>. Если правил нет: ${again} --default-brief`);
        }
        must(["brief", "init", "--default"]);
      }
      const validated = call(["brief", "validate"]);
      if (validated.exitCode !== ExitCode.Ok) {
        throw new Pause("waiting", "brief.json не прошёл проверку", `Исправьте ${REPOKIT_DIR}/brief.json: ${(validated.data?.problems ?? []).join("; ")}`);
      }
      return `критериев ${validated.data.criteria}${validated.data.isDefaultProfile ? " (профиль по умолчанию)" : ""}`;
    },

    claims: () => {
      const text = readArtifact(repo, "claims.json");
      const claims: { status: string; evidence: unknown[] }[] = text ? JSON.parse(text).claims : [];
      const proven = claims.filter((c) => (c.status === "implemented" || c.status === "partial") && c.evidence.length > 0).length;
      if (proven === 0) {
        throw new Pause("waiting", "нет утверждений с доказательствами", `Разметьте ${REPOKIT_DIR}/claims.json: для каждого утверждения укажите статус и строки кода (см. SKILL.md), затем: ${again}`);
      }
      call(["scan", "claims", "pin"]);
      const checked = call(["scan", "claims", "check"]);
      if (checked.exitCode !== ExitCode.Ok) {
        const problems = (checked.data?.results ?? []).filter((r: { ok: boolean }) => !r.ok).flatMap((r: { claimId: string; problems: string[] }) => r.problems.map((p) => `${r.claimId}: ${p}`));
        throw new Pause("failed", "утверждения не прошли проверку", `Исправьте ${REPOKIT_DIR}/claims.json: ${problems.join("; ")}`);
      }
      const undecided = claims.filter((c) => c.status === "unverified").length;
      return `подтверждено ${proven}, заглушек ${claims.filter((c) => c.status === "mock").length}, без решения ${undecided}`;
    },

    deploy: () => {
      // Publishing is never done here: the step only says where the project could go and what that takes.
      const planned = call(["deploy", "plan", "--dry-run"]);
      if (planned.exitCode !== ExitCode.Ok) return "подходящая площадка не определена — см. repokit deploy providers";
      const deployed = readArtifact(repo, "deploy.json");
      if (deployed && JSON.parse(deployed).healthy) return `уже работает: ${JSON.parse(deployed).url}`;
      humanTodo.push({ id: "run.deploy", text: `Деплой не выполнялся. Рекомендуется ${planned.data.title}: repokit deploy apply, затем repokit deploy run --confirm и repokit deploy check --url <адрес>.` });
      return `не выполнялся; рекомендуется ${planned.data.title}`;
    },

    demo: () => {
      const scenario = flags.scenario ? resolve(flags.scenario) : join(repo, DEFAULT_SCENARIO);
      if (!existsSync(scenario)) {
        must(["capture", "scenario", "draft"]);
        throw new Pause("waiting", "нет сценария демо", `Допишите сценарий из ${REPOKIT_DIR}/capture/scenario.draft.yaml, сохраните как ${DEFAULT_SCENARIO} и запустите: ${again}. Без демо: ${again} --skip demo`);
      }
      const checked = must(["capture", "scenario", "validate", "--scenario", scenario]);
      if (!approved.has("demo")) {
        const steps = readFileSync(scenario, "utf8").split(/\r?\n/).filter((line) => /^\s*-\s/.test(line)).map((line) => line.trim()).join("; ");
        throw new Pause("waiting", "сценарий демо ждёт одобрения",
          `Одобрите запись демо по сценарию ${repoRelative(repo, scenario)} (шагов ${checked.data.steps}: ${steps}). Будут созданы ${HERO}.gif и ${HERO_3D}.gif. Одобрить: ${again} --approve demo`);
      }
      const recorded = must(["capture", "run", "--scenario", scenario]);
      const flat = must(["studio", "render", "--capture", recorded.data.runId, "--out", `${HERO}.mp4`, "--gif"]);
      const spatial = must(["studio", "render", "--preset", flags.preset3d, "--slot", `main=${recorded.data.video}`, "--out", `${HERO_3D}.mp4`, "--gif"]);
      const size = (envelope: Envelope<any>) => (envelope.data.gif.bytes / 1024 / 1024).toFixed(2);
      return `запись ${recorded.data.duration} с; ${HERO}.gif ${size(flat)} МБ, ${HERO_3D}.gif ${size(spatial)} МБ`;
    },

    readme: () => {
      const hero = existsSync(join(repo, `${HERO}.gif`)) ? ["--hero", `${HERO}.gif`] : [];
      const plan = must(["readme", "plan", "--preset", flags.preset, ...hero]);
      const empty = plan.data.slots.filter((s: { status: string }) => s.status === "empty").length;
      const preview = call(["readme", "apply", "--dry-run", "--preset", flags.preset, ...hero]);
      if (!approved.has("readme")) {
        throw new Pause("waiting", "README ждёт одобрения",
          `Посмотрите черновик (repokit preview serve --repo ${path ?? "."} --open) и одобрите запись README.md: строк +${preview.data.added} −${preview.data.removed}, незаполненных разделов ${empty}. Одобрить: ${again} --approve readme`);
      }
      const applied = must(["readme", "apply", "--preset", flags.preset, ...hero]);
      return `README.md ${applied.data.written ? "записан" : "без изменений"}: +${applied.data.added} −${applied.data.removed}; незаполненных разделов ${empty}`;
    },

    verify: () => {
      // The working tree is checked, not HEAD: the run has just produced files that are not committed yet.
      const verified = call(["verify", "run", "--source", "worktree", ...(flags.exec ? ["--exec"] : []), ...(flags.online ? ["--online"] : [])]);
      const failed = (verified.data?.checks ?? []).filter((c: { status: string }) => c.status === "fail");
      if (failed.length > 0) {
        throw new Pause("failed", `проверка не пройдена: ${failed.map((c: { title: string }) => c.title).join("; ")}`, "");
      }
      return `пройдена: проверок ${verified.data.checks.length}`;
    },
  };

  const steps: StepReport[] = [];
  let stopped: Pause | null = null;
  for (const id of STEPS) {
    if (stopped) {
      steps.push({ id, status: "pending", summary: "ещё не выполнялся" });
      continue;
    }
    if (skipped.has(id)) state.steps[id] = "skipped";
    if (state.steps[id] === "skipped") {
      steps.push({ id, status: "skipped", summary: "пропущен по вашему решению" });
      humanTodo.push({ id: `run.skipped.${id}`, text: `Шаг «${id}» пропущен — результат неполный.` });
      continue;
    }
    // Verification is cheap and its answer goes stale, so it is repeated on every run.
    if (state.steps[id] === "done" && id !== "verify") {
      steps.push({ id, status: "done", summary: "выполнен ранее" });
      continue;
    }
    try {
      const summary = handlers[id]();
      state.steps[id] = "done";
      steps.push({ id, status: "done", summary });
    } catch (error) {
      if (!(error instanceof Pause)) throw error;
      stopped = error;
      steps.push({ id, status: error.kind, summary: error.message });
      if (error.todo) humanTodo.unshift({ id: `run.${id}`, text: error.todo });
    }
  }

  // Decisions that stay open across runs are collected again, even when their step was done earlier.
  if (state.steps.brief === "done") call(["brief", "validate"]);
  if (state.steps.readme === "done") call(["readme", "plan", "--dry-run"]);
  if (state.steps.demo === "done" && existsSync(join(repo, `${HERO_3D}.gif`))) {
    humanTodo.push({ id: "run.hero-3d", text: `3D-версия демо лежит в ${HERO_3D}.gif и в README не вставлена — добавьте её сами, если нужна.` });
  }

  const todoText = humanTodo.length === 0
    ? "# Для человека\n\nНичего не осталось.\n"
    : `# Для человека\n\nЭти решения repokit не принимает сам.\n\n${humanTodo.map((t) => `- [ ] ${t.text}`).join("\n")}\n`;
  const artifacts = [
    writeArtifact(repo, STATE_FILE, JSON.stringify(state, null, 2) + "\n", "state"),
    writeArtifact(repo, "human-todo.md", todoText, "human-todo"),
  ];
  const mark: Record<StepStatus, string> = { done: "готово ", skipped: "пропуск", waiting: "ЖДЁТ   ", failed: "ОШИБКА ", pending: "  —    " };
  return {
    data: { steps, next: stopped ? stopped.todo || stopped.message : null },
    exitCode: !stopped ? ExitCode.Ok : stopped.kind === "waiting" ? ExitCode.NeedsHuman : ExitCode.CheckFailed,
    warnings: [...new Set(warnings)],
    humanTodo,
    artifacts,
    summary: [
      ...steps.map((s) => `${mark[s.status]} ${s.id.padEnd(7)} ${s.summary}`),
      stopped ? `остановлено на шаге «${steps.find((s) => s.status === stopped!.kind)?.id}»` : "все шаги выполнены",
    ],
  };
}

export function registerRun(program: Command): void {
  program
    .command("run [path]")
    .description(`все шаги по порядку с остановками на одобрение: ${STEPS.join(" → ")}`)
    .option("--json", "один JSON-документ в stdout")
    .option("--approve <step>", "одобрить шаг, который ждёт решения: demo, readme; можно несколько раз", collect, [])
    .option("--skip <step>", "пропустить шаг; можно несколько раз", collect, [])
    .option("--scenario <file>", `сценарий демо (по умолчанию ${DEFAULT_SCENARIO} в репозитории)`)
    .option("--rules <file>", "файл с правилами хакатона")
    .option("--default-brief", "правил нет — взять типовой набор критериев")
    .option("--preset <name>", "пресет README", "showcase")
    .option("--preset-3d <name>", "3D-пресет для второй версии демо", "browser-tilt")
    .option("--exec", "при проверке выполнить команды Quick start из README")
    .option("--online", "при проверке обратиться к внешним ссылкам")
    .option("--reset", "забыть выполненные шаги и начать заново")
    .action((path: string | undefined, flags: RunFlags) => runCommand("repokit", "run", { ...flags, repo: path ?? "." }, () => run(path, flags)));
}
