import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import {
  assertValid, commonFlags, fileSha256, gitHead, recordMedia, REPOKIT_DIR, repoRelative, requireTool, resolveRepo, runCommand,
  UsageError, VERSION, writeArtifact,
  type CommandResult, type CommonFlags, type MediaEntry,
} from "@repokit/core";
import { analyze } from "@repokit/scan";
import { FrameRecorder, OUTPUT_FPS } from "./recorder.js";
import { runScenario, shotPath, type CaptureEvent } from "./runner.js";
import { DEFAULT_VIEWPORT, draftScenario, envReferences, loadScenario, resolveEnv, type Scenario, type Viewport } from "./scenario.js";
import { launchBrowser, masks, openContext, startApp } from "./session.js";

export { pointerPath, scrollDeltas, moveDuration, easeInOutCubic } from "./motion.js";
export { draftScenario, envReferences, loadScenario, resolveEnv } from "./scenario.js";
export type { Scenario, Step, Viewport } from "./scenario.js";
export type { CaptureEvent } from "./runner.js";

const CAPTURE_DIR = "capture";

/** Named screen sizes for `capture shots`. `desktop` means the scenario's own viewport. */
const SIZES: Record<string, Viewport | null> = {
  desktop: null,
  tablet: { width: 820, height: 1180, deviceScaleFactor: 2 },
  mobile: { width: 390, height: 844, deviceScaleFactor: 3 },
};

export interface CaptureEvents {
  schemaVersion: 1;
  viewport: Viewport;
  duration: number;
  fps: number;
  events: CaptureEvent[];
}

interface ScenarioFlags extends CommonFlags {
  scenario?: string;
}

const viewportOf = (scenario: Scenario): Viewport => ({ ...DEFAULT_VIEWPORT, ...scenario.viewport });

function requireScenario(flags: ScenarioFlags) {
  if (!flags.scenario) throw new UsageError("Укажите сценарий: --scenario <файл.yaml>");
  return { file: resolve(flags.scenario), ...loadScenario(resolve(flags.scenario)) };
}

/** Sortable, human-readable run id: 20261001-153045. */
const newRunId = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

function draft(flags: CommonFlags): CommandResult<{ scenario: string }> {
  const repo = resolveRepo(flags.repo);
  const text = draftScenario(analyze(repo));
  return {
    data: { scenario: text },
    artifacts: [writeArtifact(repo, `${CAPTURE_DIR}/scenario.draft.yaml`, text, "scenario-draft", flags.dryRun)],
    humanTodo: [{ id: "capture.scenario", text: "Допишите в черновик сценария реальные действия пользователя и утвердите его перед записью." }],
    summary: ["черновик содержит только найденные страницы; взаимодействия нужно дописать и проверить"],
  };
}

function validateScenario(flags: ScenarioFlags): CommandResult<{ steps: number; env: string[]; masks: string[] }> {
  const { scenario } = requireScenario(flags);
  const env = envReferences(scenario);
  return {
    data: { steps: scenario.steps.length, env, masks: masks(scenario) },
    summary: [
      `сценарий корректен: шагов ${scenario.steps.length}, адрес ${scenario.baseUrl}`,
      env.length > 0 ? `нужны переменные окружения: ${env.join(", ")}` : "переменные окружения не используются",
    ],
  };
}

interface RunData {
  runId: string;
  dir: string;
  video: string;
  events: string;
  shots: string[];
  duration: number;
  frames: number;
  averageFps: number;
  appStartedByRepokit: boolean;
}

async function run(flags: ScenarioFlags): Promise<CommandResult<RunData | { plan: string[] }>> {
  const repo = resolveRepo(flags.repo);
  const { file, scenario: raw, sha256 } = requireScenario(flags);
  const viewport = viewportOf(raw);
  if (flags.dryRun) {
    return {
      data: {
        plan: [
          raw.start ? `запуск приложения: ${raw.start.command}` : `приложение должно быть запущено на ${raw.baseUrl}`,
          `запись ${viewport.width}×${viewport.height} @${viewport.deviceScaleFactor}x, шагов: ${raw.steps.length}`,
          `маскируются: ${masks(raw).join(", ")}`,
        ],
      },
      summary: ["dry-run: браузер не запускался, ничего не записано"],
    };
  }

  const scenario = resolveEnv(raw);
  requireTool("ffmpeg");
  const runId = newRunId();
  const dir = join(repo, REPOKIT_DIR, CAPTURE_DIR, runId);
  mkdirSync(join(dir, "shots"), { recursive: true });

  const app = await startApp(scenario, repo);
  let browserLabel = "";
  let events: CaptureEvent[] = [];
  let duration = 0;
  let frames = 0;
  const shots: string[] = [];
  try {
    const { browser, label } = await launchBrowser();
    browserLabel = label;
    try {
      const context = await openContext(browser, scenario, repo, viewport);
      const page = await context.newPage();
      const recorder = new FrameRecorder(await context.newCDPSession(page), dir, viewport);

      // Load the first page before recording so the video does not open on a blank tab.
      const [first, ...rest] = scenario.steps;
      const leadingGoto = "goto" in first;
      if (leadingGoto) await page.goto(new URL(first.goto, scenario.baseUrl).toString(), { waitUntil: "load" });
      recorder.start();
      events = await runScenario({
        page,
        scenario: { ...scenario, steps: leadingGoto ? rest : scenario.steps },
        viewport,
        recorder,
        onMark: async (name) => {
          await recorder.still(shotPath(dir, name));
          shots.push(shotPath(dir, name));
        },
      });
      if (leadingGoto) events.unshift({ t: 0, type: "nav", url: first.goto });
      duration = await recorder.finish("video.mp4");
      frames = recorder.frameCount;
    } finally {
      await browser.close();
    }
  } finally {
    app.stop();
  }

  const eventsDoc: CaptureEvents = { schemaVersion: 1, viewport, duration: Math.round(duration * 1000) / 1000, fps: OUTPUT_FPS, events };
  assertValid("events", eventsDoc);
  const eventsFile = join(dir, "events.json");
  writeFileSync(eventsFile, JSON.stringify(eventsDoc) + "\n");
  writeFileSync(join(dir, "scenario.sha256"), sha256 + "\n");

  const head = gitHead(repo);
  const createdAt = new Date().toISOString();
  const entry = (abs: string, kind: MediaEntry["kind"]): MediaEntry => ({
    path: repoRelative(repo, abs),
    sha256: fileSha256(abs),
    kind,
    createdAt,
    tool: { name: "repokit capture", version: VERSION, browser: browserLabel },
    source: {
      runId,
      scenario: repoRelative(repo, file),
      scenarioSha256: sha256,
      baseUrl: scenario.baseUrl,
      targetCommit: head?.commit ?? null,
      targetDirty: head?.dirty ?? false,
    },
    masks: masks(scenario),
    demoData: scenario.demoData ?? false,
  });
  const video = join(dir, "video.mp4");
  recordMedia(repo, [entry(video, "video"), entry(eventsFile, "events"), ...shots.map((shot) => entry(shot, "screenshot"))]);

  const averageFps = Math.round((frames / duration) * 10) / 10;
  const warnings: string[] = [];
  if (!app.started) warnings.push("приложение уже было запущено — repokit его не стартовал; состояние данных могло отличаться от чистого запуска");
  if (head?.dirty) warnings.push("в репозитории есть незакоммиченные изменения: запись сделана не с чистого коммита");
  return {
    data: {
      runId,
      dir: repoRelative(repo, dir),
      video: repoRelative(repo, video),
      events: repoRelative(repo, eventsFile),
      shots: shots.map((shot) => repoRelative(repo, shot)),
      duration: eventsDoc.duration,
      frames,
      averageFps,
      appStartedByRepokit: app.started,
    },
    warnings,
    summary: [
      `запись ${runId}: ${eventsDoc.duration.toFixed(1)} с, кадров ${frames} (${averageFps} к/с), событий ${events.length}, скриншотов ${shots.length}`,
      `видео: ${repoRelative(repo, video)}`,
      `браузер: ${browserLabel}`,
    ],
  };
}

interface ShotsFlags extends ScenarioFlags {
  sizes: string;
  themes: string;
  out?: string;
}

async function shotsCommand(flags: ShotsFlags): Promise<CommandResult<{ shots: string[] } | { plan: string[] }>> {
  const repo = resolveRepo(flags.repo);
  const { file, scenario: raw, sha256 } = requireScenario(flags);
  const sizes = flags.sizes.split(",").map((s) => s.trim());
  const themes = flags.themes.split(",").map((s) => s.trim());
  const unknown = [...sizes.filter((s) => !(s in SIZES)), ...themes.filter((t) => t !== "light" && t !== "dark")];
  if (unknown.length > 0) throw new UsageError(`Неизвестные значения: ${unknown.join(", ")}. Размеры: ${Object.keys(SIZES).join(", ")}; темы: light, dark.`);
  const marks = raw.steps.filter((s) => "mark" in s).length;
  if (marks === 0) throw new UsageError("В сценарии нет шагов mark — снимать нечего.");
  if (flags.dryRun) {
    return { data: { plan: sizes.flatMap((s) => themes.map((t) => `${s}/${t}: ${marks} скриншотов`)) }, summary: ["dry-run: браузер не запускался"] };
  }

  const scenario = { ...resolveEnv(raw), pace: "fast" as const };
  const outDir = flags.out ? resolve(repo, flags.out) : join(repo, REPOKIT_DIR, CAPTURE_DIR, `shots-${newRunId()}`);
  mkdirSync(join(outDir, "shots"), { recursive: true });
  const written: string[] = [];
  const app = await startApp(scenario, repo);
  let browserLabel = "";
  try {
    const { browser, label } = await launchBrowser();
    browserLabel = label;
    try {
      for (const size of sizes) {
        for (const theme of themes as ("light" | "dark")[]) {
          const viewport = SIZES[size] ?? viewportOf(scenario);
          const context = await openContext(browser, scenario, repo, viewport, theme);
          const page = await context.newPage();
          const stills = new FrameRecorder(await context.newCDPSession(page), outDir, viewport);
          await runScenario({
            page, scenario, viewport,
            onMark: async (name) => {
              const target = shotPath(outDir, name, `-${size}-${theme}`);
              await stills.still(target);
              written.push(target);
            },
          });
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  } finally {
    app.stop();
  }

  const head = gitHead(repo);
  const createdAt = new Date().toISOString();
  recordMedia(repo, written.map((abs): MediaEntry => ({
    path: repoRelative(repo, abs),
    sha256: fileSha256(abs),
    kind: "screenshot",
    createdAt,
    tool: { name: "repokit capture", version: VERSION, browser: browserLabel },
    source: {
      runId: repoRelative(repo, outDir),
      scenario: repoRelative(repo, file),
      scenarioSha256: sha256,
      baseUrl: scenario.baseUrl,
      targetCommit: head?.commit ?? null,
      targetDirty: head?.dirty ?? false,
    },
    masks: masks(scenario),
    demoData: scenario.demoData ?? false,
  })));
  const paths = written.map((abs) => repoRelative(repo, abs));
  return {
    data: { shots: paths },
    warnings: themes.includes("dark") ? ["тёмная тема снимается через prefers-color-scheme: если приложение её не поддерживает, кадры совпадут со светлыми"] : [],
    summary: [`скриншотов: ${paths.length} → ${repoRelative(repo, join(outDir, "shots"))}`],
  };
}

/** Most recent recording in a repository, or null. */
export function latestRun(repo: string): string | null {
  const root = join(repo, REPOKIT_DIR, CAPTURE_DIR);
  if (!existsSync(root)) return null;
  const runs = readdirSync(root).filter((name) => /^\d{8}-\d{6}$/.test(name) && existsSync(join(root, name, "video.mp4"))).sort();
  return runs.length > 0 ? join(root, runs[runs.length - 1]) : null;
}

export function registerCapture(program: Command): void {
  const capture = program.command("capture").description("запись реального демо приложения по сценарию");
  const withScenario = (c: Command) => commonFlags(c).option("--scenario <file>", "файл сценария (YAML)");

  const scenario = capture.command("scenario").description("черновик и проверка сценария");
  commonFlags(scenario.command("draft").description("каркас сценария из результатов scan → .repokit/capture/scenario.draft.yaml"))
    .action((flags: CommonFlags) => runCommand("capture", "scenario draft", flags, () => draft(flags)));
  withScenario(scenario.command("validate").description("проверить сценарий по схеме"))
    .action((flags: ScenarioFlags) => runCommand("capture", "scenario validate", flags, () => validateScenario(flags)));

  withScenario(capture.command("run").description("записать видео, лог событий и скриншоты по меткам"))
    .action((flags: ScenarioFlags) => runCommand("capture", "run", flags, () => run(flags)));

  withScenario(capture.command("shots").description("скриншоты по меткам сценария в нескольких размерах и темах"))
    .option("--sizes <list>", `размеры через запятую: ${Object.keys(SIZES).join(", ")}`, "desktop")
    .option("--themes <list>", "темы через запятую: light, dark", "light")
    .option("--out <dir>", "папка для результата (по умолчанию внутри .repokit/capture/)")
    .action((flags: ShotsFlags) => runCommand("capture", "shots", flags, () => shotsCommand(flags)));
}
