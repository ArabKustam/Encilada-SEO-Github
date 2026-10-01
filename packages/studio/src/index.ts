import { statSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { Command } from "commander";
import {
  commonFlags, ExitCode, fileSha256, recordMedia, repoRelative, requireTool, resolveRepo, runCommand, say, sha256, UsageError, VERSION,
  writeArtifact,
  type Artifact, type CommandResult, type CommonFlags, type MediaEntry,
} from "@repokit/core";
import { PRESET_COMPOSITION_ID, type PresetDefinition } from "@repokit/presets/types";
import { DEFAULT_GIF_BUDGET_BYTES, encodeGif, encodePoster, encodeWebp, type GifResult } from "./encode.js";
import { findPreset, listPresets, resolvePreset } from "./presets.js";
import { glBackend, renderStills, renderVideo, type RenderJob } from "./render.js";
import { COMPOSITION_ID, STYLE_NAMES, type StyleName } from "./remotion/props.js";
import { captureRunDir, loadTimeline, resolveTimeline, timelineFromCapture, type Timeline } from "./timeline.js";

export { buildCamera, cameraAt, cursorAt, ripplesAt } from "./camera.js";
export { gifLadder } from "./encode.js";
export { findPreset, listPresets, resolvePreset } from "./presets.js";
export { glBackend, renderStills, renderVideo } from "./render.js";
export type { RenderJob } from "./render.js";
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

interface SourceFlags extends CommonFlags {
  preset?: string;
  slot: string[];
  aspect?: string;
  width?: string;
  gl?: string;
  out?: string;
}

interface RenderFlags extends SourceFlags {
  timeline?: string;
  capture: string;
  style: string;
  height?: string;
  fps?: string;
  zoom: boolean;
  zoomScale?: string;
  title?: string;
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
  mode: "timeline" | "preset";
  timeline?: Timeline;
  preset?: string;
  durationSeconds: number;
  outputs: OutputInfo[];
  gif?: GifResult;
}

/** Everything needed to render, whichever way the content was specified. */
interface Plan {
  mode: "timeline" | "preset";
  job: RenderJob;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  warnings: string[];
  artifacts: Artifact[];
  /** Hashes for `derivedFrom`, beyond the media files themselves. */
  recipeSha256: string;
  description: string;
  timeline?: Timeline;
  preset?: string;
}

function positiveNumber(value: string, flag: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new UsageError(`${flag}: ожидается положительное число, получено «${value}»`);
  return number;
}

const collect = (value: string, previous: string[]) => [...previous, value];

async function planPreset(repo: string, flags: SourceFlags): Promise<Plan> {
  const { props, files, warnings } = await resolvePreset(repo, flags.preset!, {
    slots: flags.slot,
    aspect: flags.aspect,
    width: flags.width ? positiveNumber(flags.width, "--width") : undefined,
  });
  const slotList = Object.entries(props.slots).map(([id, media]) => `${id}=${media.kind}`).join(", ");
  return {
    mode: "preset",
    job: { compositionId: PRESET_COMPOSITION_ID, inputProps: props, files, gl: glBackend(flags.gl) },
    width: props.width,
    height: props.height,
    fps: props.fps,
    durationInFrames: props.durationInFrames,
    warnings,
    artifacts: [],
    recipeSha256: sha256(JSON.stringify({ preset: props.preset, width: props.width, height: props.height })),
    description: `пресет ${props.preset.name}, ${props.width}×${props.height}, ${props.fps} к/с, ${(props.durationInFrames / props.fps).toFixed(1)} с; слоты: ${slotList}`,
    preset: props.preset.name,
  };
}

async function planTimeline(repo: string, flags: RenderFlags): Promise<Plan> {
  if (!STYLE_NAMES.includes(flags.style as StyleName)) {
    throw new UsageError(`Неизвестный стиль «${flags.style}». Доступны: ${STYLE_NAMES.join(", ")}`);
  }
  if (flags.slot.length > 0) throw new UsageError("--slot используется только вместе с --preset");
  const timeline = flags.timeline
    ? loadTimeline(resolve(flags.timeline))
    : timelineFromCapture(repo, captureRunDir(repo, flags.capture), {
        style: flags.style as StyleName,
        width: positiveNumber(flags.width ?? "1280", "--width"),
        height: positiveNumber(flags.height ?? "720", "--height"),
        fps: positiveNumber(flags.fps ?? "30", "--fps"),
        zoom: flags.zoom,
        zoomScale: flags.zoomScale ? positiveNumber(flags.zoomScale, "--zoom-scale") : undefined,
        title: flags.title,
      });
  const { props, sources, warnings } = await resolveTimeline(repo, timeline);
  const timelineJson = JSON.stringify(timeline, null, 2) + "\n";
  const cameraMoves = props.scenes.reduce((sum, s) => sum + Math.max(0, s.camera.length - 2), 0);
  return {
    mode: "timeline",
    job: { compositionId: COMPOSITION_ID, inputProps: props, files: sources.map((source, index) => ({ source, name: props.scenes[index].src })) },
    width: props.width,
    height: props.height,
    fps: props.fps,
    durationInFrames: props.durationInFrames,
    warnings,
    artifacts: [writeArtifact(repo, "timeline.json", timelineJson, "timeline", flags.dryRun)],
    recipeSha256: sha256(timelineJson),
    description: `${props.width}×${props.height}, ${props.fps} к/с, ${(props.durationInFrames / props.fps).toFixed(2)} с, стиль ${timeline.style}, сцен ${props.scenes.length}, ключевых кадров камеры ${cameraMoves}`,
    timeline,
  };
}

function record(repo: string, plan: Plan, outputs: OutputInfo[]): void {
  const createdAt = new Date().toISOString();
  const derivedFrom = [...new Set(plan.job.files.map((f) => fileSha256(f.source))), plan.recipeSha256];
  recordMedia(repo, outputs.map((o): MediaEntry => ({
    path: repoRelative(repo, o.path),
    sha256: fileSha256(o.path),
    kind: o.kind,
    createdAt,
    tool: { name: "repokit studio", version: VERSION },
    derivedFrom,
  })));
}

async function render(flags: RenderFlags): Promise<CommandResult<RenderData>> {
  const repo = resolveRepo(flags.repo);
  if (!flags.out) throw new UsageError("Укажите, куда сохранить результат: --out docs/media/hero.mp4");
  const output = resolve(repo, flags.out);
  if (extname(output).toLowerCase() !== ".mp4") throw new UsageError("--out должен указывать на файл .mp4; GIF и WebP создаются рядом по флагам --gif и --webp");
  const budget = positiveNumber(flags.gifBudgetMb, "--gif-budget-mb") * MEGABYTE;

  requireTool("ffmpeg");
  requireTool("ffprobe");
  const plan = flags.preset ? await planPreset(repo, flags) : await planTimeline(repo, flags);
  const durationSeconds = Math.round((plan.durationInFrames / plan.fps) * 100) / 100;
  const identity = { mode: plan.mode, ...(plan.timeline ? { timeline: plan.timeline } : {}), ...(plan.preset ? { preset: plan.preset } : {}) };
  const warnings = plan.warnings;

  if (flags.dryRun) {
    return {
      data: { ...identity, durationSeconds, outputs: [] },
      warnings, artifacts: plan.artifacts,
      summary: [`dry-run: ${plan.description}`, "рендер не выполнялся"],
    };
  }

  let lastReported = -10;
  await renderVideo(plan.job, output, (percent) => {
    if (flags.verbose && percent >= lastReported + 10) {
      say(`[studio render] ${percent}%`);
      lastReported = percent;
    }
  });

  const base = output.slice(0, -".mp4".length);
  const outputs: OutputInfo[] = [{ path: output, kind: "render", bytes: statSync(output).size }];
  outputs.push({ path: `${base}.png`, kind: "poster", bytes: await encodePoster(output, `${base}.png`, durationSeconds * POSTER_POSITION) });
  let gif: GifResult | undefined;
  if (flags.gif) {
    gif = await encodeGif(output, `${base}.gif`, plan.width, plan.fps, budget);
    outputs.push({ path: `${base}.gif`, kind: "gif", bytes: gif.bytes });
    if (!gif.withinBudget) warnings.push(`GIF не уложился в бюджет даже на минимальных настройках: ${(gif.bytes / MEGABYTE).toFixed(1)} МБ. Сократите ролик.`);
  }
  if (flags.webp) outputs.push({ path: `${base}.webp`, kind: "webp", bytes: await encodeWebp(output, `${base}.webp`, plan.width, plan.fps) });
  record(repo, plan, outputs);

  const relative = outputs.map((o) => ({ ...o, path: repoRelative(repo, o.path) }));
  return {
    data: { ...identity, durationSeconds, outputs: relative, ...(gif ? { gif } : {}) },
    exitCode: gif && !gif.withinBudget ? ExitCode.CheckFailed : ExitCode.Ok,
    warnings,
    artifacts: plan.artifacts,
    summary: [
      plan.description,
      ...relative.map((o) => `${o.path} — ${(o.bytes / MEGABYTE).toFixed(2)} МБ`),
      ...(gif ? [`GIF: ${gif.width}px, ${gif.fps} к/с, ${gif.colors} цветов (попытка ${gif.attempts})`] : []),
    ],
  };
}

interface StillFlags extends SourceFlags {
  frame: string;
}

async function still(flags: StillFlags): Promise<CommandResult<{ preset: string; frame: number; output: OutputInfo | null }>> {
  const repo = resolveRepo(flags.repo);
  if (!flags.preset) throw new UsageError("Укажите пресет: --preset <имя>");
  if (!flags.out) throw new UsageError("Укажите, куда сохранить кадр: --out docs/media/hero.png");
  const output = resolve(repo, flags.out);
  if (extname(output).toLowerCase() !== ".png") throw new UsageError("--out должен указывать на файл .png");
  requireTool("ffprobe");
  const plan = await planPreset(repo, flags);
  const frame = Number(flags.frame);
  if (!Number.isInteger(frame) || frame < 0 || frame >= plan.durationInFrames) {
    throw new UsageError(`--frame: ожидается кадр от 0 до ${plan.durationInFrames - 1}, получено «${flags.frame}»`);
  }
  if (flags.dryRun) {
    return { data: { preset: plan.preset!, frame, output: null }, warnings: plan.warnings, summary: [`dry-run: ${plan.description}, кадр ${frame}`] };
  }
  await renderStills(plan.job, [{ frame, output }]);
  const info: OutputInfo = { path: output, kind: "poster", bytes: statSync(output).size };
  record(repo, plan, [info]);
  const path = repoRelative(repo, output);
  return {
    data: { preset: plan.preset!, frame, output: { ...info, path } },
    warnings: plan.warnings,
    summary: [`${plan.description}, кадр ${frame}`, `${path} — ${(info.bytes / MEGABYTE).toFixed(2)} МБ`],
  };
}

function styles(): CommandResult<{ styles: { name: StyleName; description: string }[] }> {
  const list = STYLE_NAMES.map((name) => ({ name, description: STYLE_DESCRIPTIONS[name] }));
  return { data: { styles: list }, summary: list.map((s) => `${s.name} — ${s.description}`) };
}

interface PresetSummary {
  name: string;
  title: string;
  description: string;
  durationSeconds: number;
  aspectRatios: string[];
  slots: PresetDefinition["slots"];
  preview: string | null;
}

const summarize = (info: ReturnType<typeof listPresets>[number]): PresetSummary => ({
  name: info.preset.name,
  title: info.preset.title,
  description: info.preset.description,
  durationSeconds: info.preset.durationInFrames / info.preset.fps,
  aspectRatios: info.preset.aspectRatios,
  slots: info.preset.slots,
  preview: info.preview,
});

function presetsList(): CommandResult<{ presets: PresetSummary[] }> {
  const presets = listPresets().map(summarize);
  return {
    data: { presets },
    summary: presets.map((p) => `${p.name} — ${p.title}; слоты: ${p.slots.map((s) => `${s.id} (${s.type}, ${s.aspect.toFixed(2)})`).join(", ")}; ${p.aspectRatios.join(", ")}`),
  };
}

function presetsPreview(name: string): CommandResult<PresetSummary> {
  const preset = summarize(findPreset(name));
  return {
    data: preset,
    warnings: preset.preview ? [] : [`у пресета «${name}» пока нет preview.gif`],
    summary: [
      `${preset.name} — ${preset.title}`,
      preset.description,
      `длительность ${preset.durationSeconds} с; соотношения сторон: ${preset.aspectRatios.join(", ")}`,
      ...preset.slots.map((s) => `слот ${s.id}: ${s.type}, пропорции ${s.aspect.toFixed(2)}, fit ${s.fit}${s.description ? ` — ${s.description}` : ""}`),
      ...(preset.preview ? [`превью: ${preset.preview}`] : []),
    ],
  };
}

export function registerStudio(program: Command): void {
  const studio = program.command("studio").description("монтаж записей: оформление, авто-зум, 3D-пресеты, GIF");
  const jsonOnly = (c: Command) => c.option("--json", "один JSON-документ в stdout");
  const presetSource = (c: Command) =>
    commonFlags(c)
      .option("--preset <name>", "3D-пресет; см. studio presets list")
      .option("--slot <id=file>", "медиа для слота пресета; можно указать несколько раз", collect, [])
      .option("--aspect <w:h>", "соотношение сторон вывода для пресета, например 16:9")
      .option("--width <px>", "ширина кадра (по умолчанию 1280)")
      .option("--gl <backend>", "как рисовать WebGL: angle (GPU, по умолчанию) или swangle (без GPU)");

  jsonOnly(studio.command("styles").description("список 2D-стилей оформления"))
    .action((flags: { json?: boolean }) => runCommand("studio", "styles", flags, styles));

  const presets = studio.command("presets").description("3D-пресеты: устройства со слотами для ваших скриншотов и записей");
  jsonOnly(presets.command("list").description("все пресеты, их слоты и соотношения сторон"))
    .action((flags: { json?: boolean }) => runCommand("studio", "presets list", flags, presetsList));
  jsonOnly(presets.command("preview <name>").description("описание пресета и путь к его preview.gif"))
    .action((name: string, flags: { json?: boolean }) => runCommand("studio", "presets preview", flags, () => presetsPreview(name)));

  presetSource(studio.command("render").description("смонтировать MP4 (и GIF/WebP): запись с авто-зумом или 3D-пресет"))
    .option("--timeline <file>", "готовый timeline.json; без него таймлайн строится из записи")
    .option("--capture <run>", "запись capture: идентификатор или latest", "latest")
    .option("--style <name>", `2D-стиль: ${STYLE_NAMES.join(", ")}`, "light")
    .option("--height <px>", "высота кадра для 2D (по умолчанию 720)")
    .option("--fps <n>", "частота кадров для 2D (по умолчанию 30)")
    .option("--no-zoom", "без авто-зума")
    .option("--zoom-scale <n>", "кратность зума (по умолчанию 1.8)")
    .option("--title <text>", "заголовок над окном")
    .option("--out <file>", "итоговый файл .mp4, например docs/media/hero.mp4")
    .option("--gif", "дополнительно создать GIF в пределах бюджета")
    .option("--webp", "дополнительно создать анимированный WebP")
    .option("--gif-budget-mb <n>", "максимальный размер GIF в мегабайтах", String(DEFAULT_GIF_BUDGET_BYTES / MEGABYTE))
    .action((flags: RenderFlags) => runCommand("studio", "render", flags, () => render(flags)));

  presetSource(studio.command("still").description("один кадр 3D-пресета в PNG"))
    .option("--frame <n>", "номер кадра", "0")
    .option("--out <file>", "итоговый файл .png")
    .action((flags: StillFlags) => runCommand("studio", "still", flags, () => still(flags)));
}
