import { statSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { Command } from "commander";
import {
  commonFlags, ExitCode, fileSha256, recordMedia, repoRelative, requireTool, resolveRepo, runCommand, say, sha256, UsageError, VERSION,
  writeArtifact,
  type CommandResult, type CommonFlags, type MediaEntry,
} from "@repokit/core";
import { DEFAULT_GIF_BUDGET_BYTES, encodeGif, encodePoster, encodeWebp, type GifResult } from "./encode.js";
import { renderVideo } from "./render.js";
import { STYLE_NAMES, type StyleName } from "./remotion/props.js";
import { captureRunDir, loadTimeline, resolveTimeline, timelineFromCapture, type Timeline } from "./timeline.js";

export { buildCamera, cameraAt, cursorAt, ripplesAt } from "./camera.js";
export { gifLadder } from "./encode.js";
export { resolveTimeline, timelineFromCapture } from "./timeline.js";
export type { Timeline, TimelineScene } from "./timeline.js";

const STYLE_DESCRIPTIONS: Record<StyleName, string> = {
  light: "светлый мягкий градиент, светлая рамка окна",
  dark: "тёмный фон с приглушённым свечением, тёмная рамка окна",
  glass: "яркий градиент и полупрозрачная «стеклянная» рамка",
};
/** Where in the video the poster frame is taken, as a fraction of its length. */
const POSTER_POSITION = 0.6;
const MEGABYTE = 1024 * 1024;

interface RenderFlags extends CommonFlags {
  timeline?: string;
  capture: string;
  style: string;
  width: string;
  height: string;
  fps: string;
  zoom: boolean;
  zoomScale?: string;
  title?: string;
  out?: string;
  gif?: boolean;
  webp?: boolean;
  gifBudgetMb: string;
}

interface OutputInfo {
  path: string;
  kind: MediaEntry["kind"];
  bytes: number;
}

interface RenderData {
  timeline: Timeline;
  durationSeconds: number;
  outputs: OutputInfo[];
  gif?: GifResult;
}

function styles(): CommandResult<{ styles: { name: StyleName; description: string }[] }> {
  const list = STYLE_NAMES.map((name) => ({ name, description: STYLE_DESCRIPTIONS[name] }));
  return { data: { styles: list }, summary: list.map((s) => `${s.name} — ${s.description}`) };
}

function positiveNumber(value: string, flag: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new UsageError(`${flag}: ожидается положительное число, получено «${value}»`);
  return number;
}

async function render(flags: RenderFlags): Promise<CommandResult<RenderData>> {
  const repo = resolveRepo(flags.repo);
  if (!STYLE_NAMES.includes(flags.style as StyleName)) {
    throw new UsageError(`Неизвестный стиль «${flags.style}». Доступны: ${STYLE_NAMES.join(", ")}`);
  }
  if (!flags.out) throw new UsageError("Укажите, куда сохранить результат: --out docs/media/hero.mp4");
  const output = resolve(repo, flags.out);
  if (extname(output).toLowerCase() !== ".mp4") throw new UsageError("--out должен указывать на файл .mp4; GIF и WebP создаются рядом по флагам --gif и --webp");
  const budget = positiveNumber(flags.gifBudgetMb, "--gif-budget-mb") * MEGABYTE;

  const timeline = flags.timeline
    ? loadTimeline(resolve(flags.timeline))
    : timelineFromCapture(repo, captureRunDir(repo, flags.capture), {
        style: flags.style as StyleName,
        width: positiveNumber(flags.width, "--width"),
        height: positiveNumber(flags.height, "--height"),
        fps: positiveNumber(flags.fps, "--fps"),
        zoom: flags.zoom,
        zoomScale: flags.zoomScale ? positiveNumber(flags.zoomScale, "--zoom-scale") : undefined,
        title: flags.title,
      });

  requireTool("ffmpeg");
  requireTool("ffprobe");
  const { props, sources, warnings } = await resolveTimeline(repo, timeline);
  const durationSeconds = Math.round((props.durationInFrames / props.fps) * 100) / 100;
  const timelineJson = JSON.stringify(timeline, null, 2) + "\n";
  const artifacts = [writeArtifact(repo, "timeline.json", timelineJson, "timeline", flags.dryRun)];
  const zoomMoves = props.scenes.reduce((sum, s) => sum + Math.max(0, s.camera.length - 2), 0);
  const plan = `${props.width}×${props.height}, ${props.fps} к/с, ${durationSeconds} с, стиль ${timeline.style}, сцен ${props.scenes.length}, ключевых кадров камеры ${zoomMoves}`;

  if (flags.dryRun) {
    return { data: { timeline, durationSeconds, outputs: [] }, warnings, artifacts, summary: [`dry-run: ${plan}`, "рендер не выполнялся"] };
  }

  let lastReported = -10;
  await renderVideo({
    props, sources, output,
    onProgress: (percent) => {
      if (flags.verbose && percent >= lastReported + 10) {
        say(`[studio render] ${percent}%`);
        lastReported = percent;
      }
    },
  });

  const base = output.slice(0, -".mp4".length);
  const outputs: OutputInfo[] = [{ path: output, kind: "render", bytes: statSync(output).size }];
  const poster = `${base}.png`;
  outputs.push({ path: poster, kind: "poster", bytes: await encodePoster(output, poster, durationSeconds * POSTER_POSITION) });
  let gif: GifResult | undefined;
  if (flags.gif) {
    gif = await encodeGif(output, `${base}.gif`, props.width, props.fps, budget);
    outputs.push({ path: `${base}.gif`, kind: "gif", bytes: gif.bytes });
    if (!gif.withinBudget) warnings.push(`GIF не уложился в бюджет даже на минимальных настройках: ${(gif.bytes / MEGABYTE).toFixed(1)} МБ. Сократите ролик (in/out в таймлайне).`);
  }
  if (flags.webp) outputs.push({ path: `${base}.webp`, kind: "webp", bytes: await encodeWebp(output, `${base}.webp`, props.width, props.fps) });

  const createdAt = new Date().toISOString();
  const derivedFrom = [...new Set(sources.map(fileSha256)), sha256(timelineJson)];
  recordMedia(repo, outputs.map((o): MediaEntry => ({
    path: repoRelative(repo, o.path),
    sha256: fileSha256(o.path),
    kind: o.kind,
    createdAt,
    tool: { name: "repokit studio", version: VERSION },
    derivedFrom,
  })));

  const relative = outputs.map((o) => ({ ...o, path: repoRelative(repo, o.path) }));
  return {
    data: { timeline, durationSeconds, outputs: relative, ...(gif ? { gif } : {}) },
    exitCode: gif && !gif.withinBudget ? ExitCode.CheckFailed : ExitCode.Ok,
    warnings,
    artifacts,
    summary: [
      plan,
      ...relative.map((o) => `${o.path} — ${(o.bytes / MEGABYTE).toFixed(2)} МБ`),
      ...(gif ? [`GIF: ${gif.width}px, ${gif.fps} к/с, ${gif.colors} цветов (попытка ${gif.attempts})`] : []),
    ],
  };
}

export function registerStudio(program: Command): void {
  const studio = program.command("studio").description("монтаж записей: оформление, авто-зум, GIF");

  studio
    .command("styles")
    .description("список стилей оформления")
    .option("--json", "один JSON-документ в stdout")
    .action((flags: { json?: boolean }) => runCommand("studio", "styles", flags, styles));

  commonFlags(studio.command("render").description("смонтировать запись в MP4 (и GIF/WebP) с оформлением и авто-зумом"))
    .option("--timeline <file>", "готовый timeline.json; без него таймлайн строится из записи")
    .option("--capture <run>", "запись capture: идентификатор или latest", "latest")
    .option("--style <name>", `стиль: ${STYLE_NAMES.join(", ")}`, "light")
    .option("--width <px>", "ширина кадра", "1280")
    .option("--height <px>", "высота кадра", "720")
    .option("--fps <n>", "частота кадров", "30")
    .option("--no-zoom", "без авто-зума")
    .option("--zoom-scale <n>", "кратность зума (по умолчанию 1.8)")
    .option("--title <text>", "заголовок над окном")
    .option("--out <file>", "итоговый файл .mp4, например docs/media/hero.mp4")
    .option("--gif", "дополнительно создать GIF в пределах бюджета")
    .option("--webp", "дополнительно создать анимированный WebP")
    .option("--gif-budget-mb <n>", "максимальный размер GIF в мегабайтах", String(DEFAULT_GIF_BUDGET_BYTES / MEGABYTE))
    .action((flags: RenderFlags) => runCommand("studio", "render", flags, () => render(flags)));
}
