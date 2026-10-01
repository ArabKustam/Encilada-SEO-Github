import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import { launchBrowser } from "@repokit/capture";
import {
  commonFlags, ExitCode, REPOKIT_DIR, repoRelative, resolveRepo, runCommand, UsageError,
  type CommandResult, type CommonFlags,
} from "@repokit/core";
import { previewState, startPreviewServer } from "./server.js";

export { renderMarkdown, renderPage } from "./render.js";
export { previewState, startPreviewServer } from "./server.js";

const DEFAULT_PORT = 4173;
const READY_TIMEOUT_MS = 30_000;
/** Height of the "first screen" a visitor sees before scrolling, at each width. */
const FOLD_HEIGHT: Record<number, number> = { 1280: 800, 390: 844 };
const DEFAULT_FOLD = 800;
const MAX_TABLE_LINE = 400;

type Source = "draft" | "current";

interface ViewFlags extends CommonFlags {
  source: string;
  preset?: string;
}

function viewUrl(base: string, source: Source, theme: string, preset?: string): string {
  const query = new URLSearchParams({ source, theme, ...(preset ? { preset } : {}) });
  return `${base}/view?${query}`;
}

function parseSource(value: string): Source {
  if (value !== "draft" && value !== "current") throw new UsageError(`--source: ожидается draft или current, получено «${value}»`);
  return value;
}

function parseList<T extends string | number>(value: string, allowed: readonly T[], flag: string): T[] {
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  const parsed = items.map((item) => (typeof allowed[0] === "number" ? Number(item) : item) as T);
  const bad = parsed.filter((item) => !allowed.includes(item));
  if (bad.length > 0 || parsed.length === 0) throw new UsageError(`${flag}: допустимые значения — ${allowed.join(", ")}`);
  return parsed;
}

interface ServeFlags extends CommonFlags {
  port: string;
  open?: boolean;
}

async function serve(flags: ServeFlags): Promise<CommandResult<{ url: string; port: number }>> {
  const repo = resolveRepo(flags.repo);
  const port = Number(flags.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError(`--port: некорректный порт «${flags.port}»`);
  if (flags.dryRun) return { data: { url: `http://127.0.0.1:${port}`, port }, summary: ["dry-run: сервер не запускался"] };

  let server;
  try {
    server = await startPreviewServer(repo, port);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") throw new UsageError(`Порт ${port} занят. Укажите другой: --port <номер>`);
    throw error;
  }
  if (flags.open) {
    // Opening a browser is a convenience; failing to do so is not an error.
    const [command, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", server.url]]
      : process.platform === "darwin" ? ["open", [server.url]] : ["xdg-open", [server.url]];
    spawn(command as string, args as string[], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  }
  return {
    data: { url: server.url, port: server.port },
    summary: [`предпросмотр README: ${server.url}`, "сервер слушает только этот компьютер; остановить — Ctrl+C"],
  };
}

interface ShotFlags extends ViewFlags {
  themes: string;
  widths: string;
  out?: string;
  sections?: boolean;
}

async function shot(flags: ShotFlags): Promise<CommandResult<{ shots: string[] }>> {
  const repo = resolveRepo(flags.repo);
  const source = parseSource(flags.source);
  const themes = parseList(flags.themes, ["light", "dark"] as const, "--themes");
  const widths = parseList(flags.widths, [1280, 390] as const, "--widths");
  const outDir = flags.out ? resolve(repo, flags.out) : join(repo, REPOKIT_DIR, "preview");
  if (flags.dryRun) {
    return { data: { shots: [] }, summary: [`dry-run: снимков было бы ${themes.length * widths.length} → ${repoRelative(repo, outDir)}`] };
  }

  mkdirSync(outDir, { recursive: true });
  const server = await startPreviewServer(repo, 0);
  const shots: string[] = [];
  try {
    const { browser } = await launchBrowser();
    try {
      for (const theme of themes) {
        for (const width of widths) {
          const context = await browser.newContext({ viewport: { width, height: FOLD_HEIGHT[width] ?? DEFAULT_FOLD }, deviceScaleFactor: width < 600 ? 2 : 1 });
          const page = await context.newPage();
          await page.goto(viewUrl(server.url, source, theme, flags.preset), { waitUntil: "load" });
          await page.waitForSelector("html[data-ready]", { timeout: READY_TIMEOUT_MS });
          const name = `readme-${source}-${theme}-${width}`;
          const full = join(outDir, `${name}.png`);
          await page.screenshot({ path: full, fullPage: true });
          shots.push(full);

          if (flags.sections) {
            // One image per H2 section: from its heading to the next one.
            const bounds = await page.evaluate(() => {
              const headings = [...document.querySelectorAll(".markdown-body h2")];
              const end = document.querySelector(".markdown-body")!.getBoundingClientRect().bottom + scrollY;
              return headings.map((h, i) => ({
                id: h.id,
                top: h.getBoundingClientRect().top + scrollY - 8,
                bottom: (headings[i + 1]?.getBoundingClientRect().top ?? end - scrollY) + scrollY - 8,
              }));
            });
            for (const section of bounds) {
              const file = join(outDir, `${name}-${section.id || "section"}.png`);
              await page.screenshot({ path: file, fullPage: true, clip: { x: 0, y: section.top, width, height: Math.max(1, section.bottom - section.top) } });
              shots.push(file);
            }
          }
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  } finally {
    await server.close();
  }
  const paths = shots.map((file) => repoRelative(repo, file));
  return { data: { shots: paths }, summary: [`снимков: ${paths.length} → ${repoRelative(repo, outDir)}`, ...paths.map((p) => `  ${p}`)] };
}

interface Issue {
  severity: "error" | "warn";
  kind: string;
  message: string;
}

interface CheckData {
  source: Source;
  issues: Issue[];
  firstScreen: { width: number; height: number; headings: string[]; images: number; pageHeight: number }[];
  slots: { id: string; status: string; note: string }[];
  media: { path: string; bytes: number; provenance: string | null }[];
}

async function check(flags: ViewFlags): Promise<CommandResult<CheckData>> {
  const repo = resolveRepo(flags.repo);
  const source = parseSource(flags.source);
  const state = previewState(repo, flags.preset ?? null);
  const issues: Issue[] = [];

  if (source === "draft") {
    for (const problem of state.plan.problems) {
      issues.push({ severity: "error", kind: problem.kind, message: `строка ${problem.line}: ${problem.message}` });
    }
  }
  for (const stale of state.staleClaims) issues.push({ severity: "warn", kind: "stale-claim", message: stale });
  for (const media of state.media) {
    if (!media.provenance) issues.push({ severity: "warn", kind: "unknown-origin", message: `${media.path}: происхождение неизвестно` });
  }

  const firstScreen: CheckData["firstScreen"] = [];
  const server = await startPreviewServer(repo, 0);
  try {
    const { browser } = await launchBrowser();
    try {
      for (const width of [1280, 390]) {
        const height = FOLD_HEIGHT[width];
        const context = await browser.newContext({ viewport: { width, height } });
        const page = await context.newPage();
        await page.goto(viewUrl(server.url, source, "light", flags.preset), { waitUntil: "load" });
        await page.waitForSelector("html[data-ready]", { timeout: READY_TIMEOUT_MS });
        const measured = await page.evaluate((fold) => {
          const body = document.querySelector(".markdown-body")!;
          const visible = (el: Element) => el.getBoundingClientRect().top < fold;
          const column = body.getBoundingClientRect().width;
          return {
            headings: [...body.querySelectorAll("h1, h2")].filter(visible).map((h) => h.textContent ?? ""),
            images: [...body.querySelectorAll("img")].filter(visible).length,
            pageHeight: document.documentElement.scrollHeight,
            broken: [...body.querySelectorAll("img")].filter((img) => img.complete && img.naturalWidth === 0).map((img) => img.getAttribute("src") ?? ""),
            noAlt: [...body.querySelectorAll("img")].filter((img) => !img.getAttribute("alt")).map((img) => img.getAttribute("src") ?? ""),
            overflowing: [...body.querySelectorAll("table, pre, img")].filter((el) => el.scrollWidth > column + 1 || el.getBoundingClientRect().width > column + 1).map((el) => el.tagName.toLowerCase()),
            mermaidError: document.documentElement.dataset.mermaidError ?? null,
            mermaidPending: document.querySelectorAll("pre.mermaid:not([data-processed])").length,
          };
        }, height);
        firstScreen.push({ width, height, headings: measured.headings, images: measured.images, pageHeight: measured.pageHeight });
        const at = `при ширине ${width}`;
        for (const src of measured.broken) issues.push({ severity: "error", kind: "broken-image", message: `изображение не загрузилось (${at}): ${src}` });
        if (width === 1280) for (const src of measured.noAlt) issues.push({ severity: "error", kind: "missing-alt", message: `изображение без alt: ${src}` });
        for (const tag of new Set(measured.overflowing)) issues.push({ severity: "warn", kind: "overflow", message: `<${tag}> шире колонки (${at}) — появится горизонтальная прокрутка` });
        if (measured.mermaidError || measured.mermaidPending > 0) issues.push({ severity: "error", kind: "mermaid", message: `схема mermaid не отрисовалась (${at}): ${measured.mermaidError ?? "неизвестная ошибка"}` });
        await context.close();
      }
    } finally {
      await browser.close();
    }
  } finally {
    await server.close();
  }

  const markdown = source === "draft" ? state.draft.markdown : state.draft.current ?? "";
  const longRow = markdown.split("\n").find((line) => line.startsWith("|") && line.length > MAX_TABLE_LINE);
  if (longRow) issues.push({ severity: "warn", kind: "long-table-row", message: `очень длинная строка таблицы (${longRow.length} символов) — на телефоне будет прокрутка` });
  const desktop = firstScreen[0];
  if (desktop && desktop.images === 0) issues.push({ severity: "warn", kind: "no-visual", message: "на первом экране нет ни одного изображения" });

  const errors = issues.filter((i) => i.severity === "error").length;
  return {
    data: {
      source,
      issues,
      firstScreen,
      slots: state.plan.slots,
      media: state.media.map(({ path, bytes, provenance }) => ({ path, bytes, provenance })),
    },
    exitCode: errors > 0 ? ExitCode.CheckFailed : ExitCode.Ok,
    summary: [
      `источник: ${source === "draft" ? "черновик" : "текущий README"}; ошибок ${errors}, предупреждений ${issues.length - errors}`,
      ...firstScreen.map((f) => `первый экран ${f.width}×${f.height}: заголовки [${f.headings.join(" | ")}], изображений ${f.images}; высота страницы ${f.pageHeight}px`),
      ...issues.map((i) => `  [${i.severity}] ${i.message}`),
    ],
  };
}

export function registerPreview(program: Command): void {
  const preview = program.command("preview").description("предпросмотр README как на GitHub: в браузере для человека, снимками и JSON для модели");
  const view = (c: Command) =>
    commonFlags(c)
      .option("--source <kind>", "что показывать: draft (черновик по плану) или current (текущий README.md)", "draft")
      .option("--preset <name>", "пресет README вместо сохранённого");

  commonFlags(preview.command("serve").description("локальный веб-интерфейс предпросмотра (только 127.0.0.1)"))
    .option("--port <n>", "порт; 0 — любой свободный", String(DEFAULT_PORT))
    .option("--open", "открыть страницу в браузере по умолчанию")
    .action((flags: ServeFlags) => runCommand("preview", "serve", flags, () => serve(flags)));

  view(preview.command("shot").description("снимки README в PNG: темы и ширины"))
    .option("--themes <list>", "light, dark", "light,dark")
    .option("--widths <list>", "1280 (десктоп), 390 (телефон)", "1280,390")
    .option("--sections", "дополнительно — по снимку на каждый раздел")
    .option("--out <dir>", "папка для снимков (по умолчанию .repokit/preview)")
    .action((flags: ShotFlags) => runCommand("preview", "shot", flags, () => shot(flags)));

  view(preview.command("check").description("измеримые проблемы вида: первый экран, битые картинки, alt, переполнение, пустые слоты"))
    .action((flags: ViewFlags) => runCommand("preview", "check", flags, () => check(flags)));
}
