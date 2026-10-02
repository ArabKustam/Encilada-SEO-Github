import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Command } from "commander";
import {
  assertValid, commonFlags, fileSha256, gitHead, recordMedia, REPOKIT_DIR, repoRelative, requireTool, resolveRepo, runCommand,
  sha256 as hashOf, UsageError, VERSION, writeArtifact,
  type CommandResult, type CommonFlags, type MediaEntry,
} from "@repokit/core";
import { analyze } from "@repokit/scan";
import { FrameRecorder, OUTPUT_FPS } from "./recorder.js";
import { runScenario, shotPath, type CaptureEvent } from "./runner.js";
import { DEFAULT_VIEWPORT, draftScenario, envReferences, loadScenario, resolveEnv, type Scenario, type Viewport } from "./scenario.js";
import { launchBrowser, masks, openContext, startApp } from "./session.js";
import { runInTerminal, terminalSvg, terminalText } from "./terminal.js";

export { pointerPath, scrollDeltas, moveDuration, easeInOutCubic } from "./motion.js";
export { draftScenario, envReferences, loadScenario, resolveEnv } from "./scenario.js";
export type { Scenario, Step, Viewport } from "./scenario.js";
export type { CaptureEvent } from "./runner.js";
export { launchBrowser } from "./session.js";
export { cleanOutput, runInTerminal, terminalSvg, terminalText } from "./terminal.js";
export type { TerminalRun } from "./terminal.js";

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
  let browserLabel = "";
  let reusedRunningApp = false;
  const { browser, label } = await launchBrowser();
  browserLabel = label;
  try {
    for (const size of sizes) {
      for (const theme of themes as ("light" | "dark")[]) {
        // A fresh app per combination, so every set of screenshots starts from the same state.
        const app = await startApp(scenario, repo);
        reusedRunningApp ||= !app.started;
        try {
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
        } finally {
          app.stop();
        }
      }
    }
  } finally {
    await browser.close();
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
    warnings: [
      ...(themes.includes("dark") ? ["тёмная тема снимается через prefers-color-scheme: если приложение её не поддерживает, кадры совпадут со светлыми"] : []),
      ...(reusedRunningApp ? ["приложение уже было запущено — repokit его не перезапускал, данные от предыдущих прогонов могли накопиться"] : []),
    ],
    summary: [`скриншотов: ${paths.length} → ${repoRelative(repo, join(outDir, "shots"))}`],
  };
}

/** Where finished media goes unless `--out` says otherwise. */
const ASSET_DIR = "docs/assets";
const withSuffix = (file: string, suffix: string) => file.replace(/(\.[^./\\]+)$/, `${suffix}$1`);

function integer(value: string | undefined, fallback: number, name: string, min: number, max: number): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new UsageError(`${name}: целое число от ${min} до ${max}`);
  return number;
}

interface TerminalFlags extends CommonFlags {
  out?: string;
  title?: string;
  cols?: string;
  maxLines?: string;
  timeout?: string;
}

interface TerminalData {
  command: string;
  exitCode: number | null;
  lines: number;
  truncated: number;
  light: string;
  dark: string;
  /** The same run as text, for a fenced block. */
  text: string;
}

async function terminal(words: string[], flags: TerminalFlags): Promise<CommandResult<TerminalData | { plan: string[] }>> {
  const repo = resolveRepo(flags.repo);
  const command = words.join(" ").trim();
  if (!command) throw new UsageError("Укажите команду после «--»: repokit capture terminal -- python tool.py --help");
  const cols = integer(flags.cols, 88, "--cols", 40, 160);
  const maxLines = integer(flags.maxLines, 30, "--max-lines", 3, 80);
  const timeoutSec = integer(flags.timeout, 30, "--timeout", 1, 600);
  const out = (flags.out ?? `${ASSET_DIR}/terminal.svg`).split("\\").join("/");
  if (!out.toLowerCase().endsWith(".svg")) throw new UsageError("--out: файл должен иметь расширение .svg");
  const light = resolve(repo, out);
  const dark = withSuffix(light, "-dark");
  if (flags.dryRun) {
    return { data: { plan: [`в папке репозитория была бы выполнена команда: ${command}`, `её вывод был бы записан в ${out} и ${withSuffix(out, "-dark")}`] }, summary: ["dry-run: команда не выполнялась"] };
  }

  let run;
  try {
    run = await runInTerminal(command, repo, { cols, maxLines, timeoutSec });
  } catch (error) {
    throw new UsageError(`Команду не удалось запустить: ${(error as Error).message}`);
  }
  if (run.timedOut) throw new UsageError(`Команда не завершилась за ${timeoutSec} с — для записи нужна команда, которая печатает результат и выходит (--timeout меняет предел).`);
  if (run.lines.length === 0) throw new UsageError("Команда ничего не напечатала — показывать нечего.");

  const title = flags.title ?? command;
  mkdirSync(dirname(light), { recursive: true });
  writeFileSync(light, terminalSvg(run, "light", cols, title));
  writeFileSync(dark, terminalSvg(run, "dark", cols, title));
  const head = gitHead(repo);
  const createdAt = new Date().toISOString();
  recordMedia(repo, [light, dark].map((abs): MediaEntry => ({
    path: repoRelative(repo, abs),
    sha256: fileSha256(abs),
    kind: "terminal",
    createdAt,
    tool: { name: "repokit capture", version: VERSION },
    command: { line: command, exitCode: run.exitCode, targetCommit: head?.commit ?? null, targetDirty: head?.dirty ?? false },
  })));
  const warnings: string[] = [];
  if (run.exitCode !== 0) warnings.push(`команда завершилась с кодом ${run.exitCode}: на картинке — вывод неудачного запуска`);
  if (run.truncated > 0) warnings.push(`вывод длиннее ${maxLines} строк: последние ${run.truncated} не показаны, на картинке это отмечено`);
  return {
    data: { command, exitCode: run.exitCode, lines: run.lines.length, truncated: run.truncated, light: repoRelative(repo, light), dark: repoRelative(repo, dark), text: terminalText(run) },
    warnings,
    humanTodo: [{ id: "capture.terminal", text: `Посмотрите ${repoRelative(repo, light)}: в выводе не должно быть личных путей, имён и других данных, которые не стоит публиковать.` }],
    summary: [
      `выполнено: ${command} (код ${run.exitCode}), строк вывода: ${run.lines.length}`,
      `картинки: ${repoRelative(repo, light)}, ${repoRelative(repo, dark)}`,
      `в README: repokit readme plan --hero ${repoRelative(repo, light)} --hero-dark ${repoRelative(repo, dark)}`,
    ],
  };
}

interface ScreenshotFlags extends CommonFlags {
  url?: string;
  start?: string;
  waitFor?: string;
  wait?: string;
  size: string;
  themes: string;
  selector?: string;
  fullPage?: boolean;
  out?: string;
  demoData?: boolean;
}

function viewportFor(size: string): Viewport {
  if (size === "desktop") return { width: 1280, height: 800, deviceScaleFactor: 2 };
  if (size in SIZES) return SIZES[size]!;
  const custom = size.match(/^(\d{3,4})x(\d{3,4})$/);
  if (!custom) throw new UsageError(`--size: ${Object.keys(SIZES).join(", ")} или ШИРИНАxВЫСОТА, например 1440x900`);
  return { width: Number(custom[1]), height: Number(custom[2]), deviceScaleFactor: 2 };
}

/** One picture of a page of the running application, without writing a scenario. */
async function screenshot(flags: ScreenshotFlags): Promise<CommandResult<{ shots: string[] } | { plan: string[] }>> {
  const repo = resolveRepo(flags.repo);
  let url: URL;
  try {
    url = new URL(flags.url ?? "");
  } catch {
    throw new UsageError("Укажите адрес страницы: --url http://localhost:8000/");
  }
  const themes = flags.themes.split(",").map((t) => t.trim());
  if (themes.some((t) => t !== "light" && t !== "dark")) throw new UsageError("--themes: light, dark или light,dark");
  const viewport = viewportFor(flags.size);
  const waitMs = integer(flags.wait, 400, "--wait", 0, 30000);
  const out = (flags.out ?? `${ASSET_DIR}/screenshot.png`).split("\\").join("/");
  if (!out.toLowerCase().endsWith(".png")) throw new UsageError("--out: файл должен иметь расширение .png");
  const target = (theme: string) => resolve(repo, theme === "dark" ? withSuffix(out, "-dark") : out);
  const scenario: Scenario = {
    schemaVersion: 1,
    baseUrl: url.origin,
    ...(flags.start ? { start: { command: flags.start } } : {}),
    ...(flags.demoData ? { demoData: true } : {}),
    steps: [{ goto: url.pathname + url.search }],
  };
  if (flags.dryRun) {
    return {
      data: { plan: [flags.start ? `запуск приложения: ${flags.start}` : `приложение должно быть запущено на ${url.origin}`, ...themes.map((t) => `${repoRelative(repo, target(t))}: ${viewport.width}×${viewport.height}, тема ${t}`)] },
      summary: ["dry-run: браузер не запускался"],
    };
  }

  const app = await startApp(scenario, repo);
  const written: string[] = [];
  let browserLabel = "";
  try {
    const { browser, label } = await launchBrowser();
    browserLabel = label;
    try {
      for (const theme of themes as ("light" | "dark")[]) {
        const context = await openContext(browser, scenario, repo, viewport, theme);
        const page = await context.newPage();
        await page.goto(url.toString(), { waitUntil: "load" });
        if (flags.waitFor) await page.waitForSelector(flags.waitFor, { state: "visible", timeout: 15000 });
        await page.waitForTimeout(waitMs);
        const file = target(theme);
        mkdirSync(dirname(file), { recursive: true });
        if (flags.selector) await page.locator(flags.selector).first().screenshot({ path: file, animations: "disabled" });
        else await page.screenshot({ path: file, fullPage: Boolean(flags.fullPage), animations: "disabled" });
        written.push(file);
        await context.close();
      }
    } finally {
      await browser.close();
    }
  } finally {
    app.stop();
  }

  const head = gitHead(repo);
  const createdAt = new Date().toISOString();
  const recipe = JSON.stringify({ url: url.toString(), size: flags.size, selector: flags.selector ?? null, fullPage: Boolean(flags.fullPage), waitFor: flags.waitFor ?? null });
  recordMedia(repo, written.map((abs): MediaEntry => ({
    path: repoRelative(repo, abs),
    sha256: fileSha256(abs),
    kind: "screenshot",
    createdAt,
    tool: { name: "repokit capture", version: VERSION, browser: browserLabel },
    source: { runId: `screenshot-${newRunId()}`, scenario: `capture screenshot ${url.pathname}`, scenarioSha256: hashOf(recipe), baseUrl: url.origin, targetCommit: head?.commit ?? null, targetDirty: head?.dirty ?? false },
    masks: masks(scenario),
    demoData: Boolean(flags.demoData),
  })));
  const paths = written.map((abs) => repoRelative(repo, abs));
  return {
    data: { shots: paths },
    warnings: [
      ...(!app.started ? ["приложение уже было запущено — repokit его не стартовал; состояние данных могло отличаться от чистого запуска"] : []),
      ...(themes.includes("dark") ? ["тёмная тема снимается через prefers-color-scheme: если приложение её не поддерживает, кадр совпадёт со светлым"] : []),
    ],
    humanTodo: [{ id: "capture.screenshot", text: `Посмотрите ${paths[0]}: в кадре не должно быть личных данных и секретов.` }],
    summary: [`скриншотов: ${paths.length} — ${paths.join(", ")}`, `браузер: ${browserLabel}`],
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
  const capture = program.command("capture").description("запись реального демо: веб-приложение по сценарию, скриншот страницы, вывод команды в терминале");
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

  commonFlags(capture.command("screenshot").description(`один скриншот страницы без сценария → ${ASSET_DIR}/screenshot.png`))
    .option("--url <url>", "адрес страницы, например http://localhost:8000/")
    .option("--start <command>", "команда запуска приложения, если оно ещё не запущено")
    .option("--wait-for <selector>", "дождаться появления элемента")
    .option("--wait <ms>", "пауза перед снимком, мс (по умолчанию 400)")
    .option("--size <name>", `размер окна: ${Object.keys(SIZES).join(", ")} или ШИРИНАxВЫСОТА`, "desktop")
    .option("--themes <list>", "темы через запятую: light, dark; тёмный кадр получает суффикс -dark", "light")
    .option("--selector <css>", "снять только этот элемент")
    .option("--full-page", "снять страницу целиком, а не только видимую часть")
    .option("--demo-data", "в кадре демонстрационные данные — пометить это в записи о происхождении")
    .option("--out <file>", "куда записать PNG")
    .action((flags: ScreenshotFlags) => runCommand("capture", "screenshot", flags, () => screenshot(flags)));

  commonFlags(capture.command("terminal [command...]").description(`выполнить команду и сохранить её настоящий вывод картинкой → ${ASSET_DIR}/terminal.svg`))
    .option("--out <file>", "куда записать SVG; тёмный вариант получает суффикс -dark")
    .option("--title <text>", "заголовок окна (по умолчанию — сама команда)")
    .option("--cols <n>", "ширина терминала в символах (по умолчанию 88)")
    .option("--max-lines <n>", "сколько строк вывода показать (по умолчанию 30)")
    .option("--timeout <sec>", "сколько ждать завершения команды (по умолчанию 30)")
    .action((words: string[], flags: TerminalFlags) => runCommand("capture", "terminal", flags, () => terminal(words, flags)));
}
