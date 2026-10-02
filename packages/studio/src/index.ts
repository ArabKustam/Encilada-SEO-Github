import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import type { Command } from "commander";
import {
  commonFlags, ExitCode, fileSha256, recordMedia, repoRelative, requireTool, resolveRepo, runCommand, runTool, say, sha256, UsageError, VERSION,
  writeArtifact,
  type Artifact, type CommandResult, type CommonFlags, type MediaEntry,
} from "@repokit/core";
import { STAGE_COMPOSITION_ID, STAGE_DEVICES, type StageDevice } from "@repokit/presets/stage-types";
import { PRESET_COMPOSITION_ID, type PresetDefinition } from "@repokit/presets/types";
import { addSound, encodeWebm, hasSound, SOUND_DEFAULTS, type SoundTrack } from "./audio.js";
import { deckFromFacts, DECK_SIZES, imagesToPdf, loadDeck, resolveDeck, type Deck, type DeckKind } from "./deck.js";
import { DEFAULT_GIF_BUDGET_BYTES, encodeGif, encodePoster, encodeWebp, type GifResult } from "./encode.js";
import { explainScene } from "./explain.js";
import { GENERIC_ICONS } from "./icons.js";
import { findPreset, listPresets, resolvePreset } from "./presets.js";
import { glBackend, renderStills, renderVideo, type RenderJob } from "./render.js";
import { COMPOSITION_ID, DECK_COMPOSITION_ID, STYLE_NAMES, type StyleName } from "./remotion/props.js";
import { BACKGROUND_NAMES, loadScene, resolveScene, starterScene, type BackgroundName, type Scene } from "./scene.js";
import { buildFromTemplate, listSceneTemplates } from "./templates.js";
import { captureRunDir, loadTimeline, resolveTimeline, timelineFromCapture, type Timeline } from "./timeline.js";

export { buildFromTemplate, listSceneTemplates } from "./templates.js";
export { buildCamera, cameraAt, cursorAt, ripplesAt } from "./camera.js";
export { soundArgs } from "./audio.js";
export { deckFromFacts, imagesToPdf, loadDeck, resolveDeck } from "./deck.js";
export type { Deck } from "./deck.js";
export { gifLadder } from "./encode.js";
export { explainScene } from "./explain.js";
export { GENERIC_ICONS, resolveIcon } from "./icons.js";
export { findPreset, listPresets, resolvePreset } from "./presets.js";
export { glBackend, renderStills, renderVideo } from "./render.js";
export type { RenderJob } from "./render.js";
export { BACKGROUND_NAMES, loadScene, resolveScene, starterScene } from "./scene.js";
export type { Scene } from "./scene.js";
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
  scene?: string;
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
  webm?: boolean;
  clickSounds?: boolean;
  music?: string;
  musicVolume?: string;
  gifBudgetMb: string;
}

interface OutputInfo {
  path: string;
  kind: MediaEntry["kind"];
  bytes: number;
}

interface RenderData {
  mode: "timeline" | "preset" | "scene";
  scene?: string;
  timeline?: Timeline;
  preset?: string;
  durationSeconds: number;
  outputs: OutputInfo[];
  gif?: GifResult;
}

/** Everything needed to render, whichever way the content was specified. */
interface Plan {
  mode: "timeline" | "preset" | "scene";
  scene?: string;
  job: RenderJob;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  warnings: string[];
  artifacts: Artifact[];
  /** Hashes for `derivedFrom`, beyond the media files themselves. */
  recipeSha256: string;
  /** Moments of clicks in the output, seconds; the sound track is built from them. */
  clickTimes: number[];
  /** Sound settings written in the scene file, if any. */
  audio?: { clicks?: boolean; clickVolume?: number; music?: string; musicVolume?: number };
  description: string;
  timeline?: Timeline;
  preset?: string;
}

function positiveNumber(value: string, flag: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new UsageError(`${flag}: ожидается положительное число, получено «${value}»`);
  return number;
}

function positiveOrZero(value: string, flag: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new UsageError(`${flag}: ожидается неотрицательное число, получено «${value}»`);
  return number;
}

const readFileUtf8 = (file: string) => readFileSync(file, "utf8");

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
    clickTimes: [],
    description: `пресет ${props.preset.name}, ${props.width}×${props.height}, ${props.fps} к/с, ${(props.durationInFrames / props.fps).toFixed(1)} с; слоты: ${slotList}`,
    preset: props.preset.name,
  };
}

async function planScene(repo: string, flags: SourceFlags): Promise<Plan> {
  const file = resolve(flags.scene!);
  const scene = loadScene(file);
  const { props, files, warnings, clickTimes } = await resolveScene(repo, scene);
  const effects = props.objects.reduce((sum, o) => sum + (o.effects.popOut || o.effects.sparks ? o.clicks.length : 0), 0) + props.effects.length;
  const extras = [props.cards.length ? `карточек ${props.cards.length}` : "", props.links.length ? `связей ${props.links.length}` : ""].filter(Boolean).join(", ");
  return {
    mode: "scene",
    job: { compositionId: STAGE_COMPOSITION_ID, inputProps: props, files, gl: glBackend(flags.gl) },
    width: props.width,
    height: props.height,
    fps: props.fps,
    durationInFrames: props.durationInFrames,
    warnings,
    artifacts: [],
    recipeSha256: sha256(JSON.stringify(scene)),
    clickTimes,
    audio: scene.audio,
    description: `сцена ${repoRelative(repo, file)}: ${props.width}×${props.height}, ${props.fps} к/с, ${(props.durationInFrames / props.fps).toFixed(1)} с; объектов ${props.objects.length}${extras ? `, ${extras}` : ""}, кадров камеры ${props.camera.keys.length}, эффектов ${effects}`,
    scene: repoRelative(repo, file),
  };
}

/** Whichever way the content was specified: a directed scene, a preset, or a 2D timeline. */
const planFor = (repo: string, flags: RenderFlags): Promise<Plan> =>
  flags.scene ? planScene(repo, flags) : flags.preset ? planPreset(repo, flags) : planTimeline(repo, flags);

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
    // Clicks of each scene, moved from the recording's clock to the output's.
    clickTimes: props.scenes.flatMap((scene, index) => {
      const offset = props.scenes.slice(0, index).reduce((sum, s) => sum + s.durationInFrames, 0) / props.fps;
      const length = scene.durationInFrames / props.fps;
      return scene.clicks.map((c) => (c.t - scene.in) / scene.speed).filter((t) => t >= 0 && t <= length).map((t) => offset + t);
    }),
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
  const plan = await planFor(repo, flags);
  const durationSeconds = Math.round((plan.durationInFrames / plan.fps) * 100) / 100;
  const identity = { mode: plan.mode, ...(plan.timeline ? { timeline: plan.timeline } : {}), ...(plan.preset ? { preset: plan.preset } : {}), ...(plan.scene ? { scene: plan.scene } : {}) };
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

  // Sound: clicks where the recording has clicks, and music if a file was given. Flags override the scene file.
  const wantClicks = flags.clickSounds ?? plan.audio?.clicks ?? false;
  const musicPath = flags.music ?? plan.audio?.music;
  const track: SoundTrack = {
    clickTimes: wantClicks ? plan.clickTimes : [],
    clickVolume: plan.audio?.clickVolume ?? SOUND_DEFAULTS.clickVolume,
    musicVolume: flags.musicVolume ? positiveOrZero(flags.musicVolume, "--music-volume") : plan.audio?.musicVolume ?? SOUND_DEFAULTS.musicVolume,
  };
  if (musicPath) {
    track.music = resolve(repo, musicPath);
    if (!existsSync(track.music)) throw new UsageError(`Музыкальный файл не найден: ${musicPath}`);
    warnings.push("музыка добавлена из вашего файла — убедитесь, что у вас есть право её использовать");
  }
  if (wantClicks && plan.clickTimes.length === 0) warnings.push("звуки кликов запрошены, но в ролике нет кликов — дорожка без щелчков");
  if (hasSound(track)) await addSound(output, track, durationSeconds);

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
  if (flags.webm) outputs.push({ path: `${base}.webm`, kind: "render", bytes: await encodeWebm(output, `${base}.webm`) });
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
  at?: string;
}

async function still(flags: StillFlags): Promise<CommandResult<{ source: string; frame: number; output: OutputInfo | null }>> {
  const repo = resolveRepo(flags.repo);
  if (!flags.preset && !flags.scene) throw new UsageError("Укажите, что снимать: --scene <файл> или --preset <имя>");
  if (!flags.out) throw new UsageError("Укажите, куда сохранить кадр: --out docs/media/hero.png");
  const output = resolve(repo, flags.out);
  if (extname(output).toLowerCase() !== ".png") throw new UsageError("--out должен указывать на файл .png");
  requireTool("ffprobe");
  const plan = flags.scene ? await planScene(repo, flags) : await planPreset(repo, flags);
  const source = plan.scene ?? plan.preset!;
  // --at is in seconds, which is how scenes are written; --frame counts frames.
  const frame = flags.at !== undefined ? Math.min(plan.durationInFrames - 1, Math.round(positiveOrZero(flags.at, "--at") * plan.fps)) : Number(flags.frame);
  if (!Number.isInteger(frame) || frame < 0 || frame >= plan.durationInFrames) {
    throw new UsageError(`--frame: ожидается кадр от 0 до ${plan.durationInFrames - 1}, получено «${flags.frame}»`);
  }
  if (flags.dryRun) {
    return { data: { source, frame, output: null }, warnings: plan.warnings, summary: [`dry-run: ${plan.description}, кадр ${frame}`] };
  }
  await renderStills(plan.job, [{ frame, output }]);
  const info: OutputInfo = { path: output, kind: "poster", bytes: statSync(output).size };
  record(repo, plan, [info]);
  const path = repoRelative(repo, output);
  return {
    data: { source, frame, output: { ...info, path } },
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

interface SceneMakeFlags extends CommonFlags {
  template?: string;
  pages?: string;
  device: string;
  background: string;
  hold: string;
  move: string;
  out: string;
  force?: boolean;
}

function sceneTemplates(): CommandResult<{ templates: { name: string; title: string; description: string; pages: string }[] }> {
  const templates = listSceneTemplates().map((t) => ({ name: t.name, title: t.title, description: t.description, pages: t.minPages === t.maxPages ? String(t.minPages) : `${t.minPages}–${t.maxPages}` }));
  return { data: { templates }, summary: templates.map((t) => `${t.name} — ${t.title}: ${t.description}. Страниц: ${t.pages}`) };
}

async function sceneMake(flags: SceneMakeFlags): Promise<CommandResult<{ file: string; template: string; scene: Scene }>> {
  const repo = resolveRepo(flags.repo);
  if (!flags.template) throw new UsageError(`Укажите шаблон: --template ${listSceneTemplates().map((t) => t.name).join(" | ")}`);
  if (!STAGE_DEVICES.includes(flags.device as StageDevice)) throw new UsageError(`--device: ожидается одно из ${STAGE_DEVICES.join(", ")}`);
  if (!BACKGROUND_NAMES.includes(flags.background as BackgroundName)) throw new UsageError(`--background: ожидается одно из ${BACKGROUND_NAMES.join(", ")}`);
  const hold = Number(flags.hold);
  const move = Number(flags.move);
  if (!(hold >= 0.5 && hold <= 10) || !(move >= 0.3 && move <= 4)) throw new UsageError("--hold: от 0.5 до 10 секунд; --move: от 0.3 до 4 секунд");
  const pages = (flags.pages ?? "").split(",").map((p) => p.trim().split("\\").join("/")).filter(Boolean);
  const target = resolve(repo, flags.out);
  if (existsSync(target) && !flags.force) throw new UsageError(`${flags.out} уже существует. Перезаписать: --force`);
  const scene = buildFromTemplate(flags.template, { pages, device: flags.device as StageDevice, background: flags.background as BackgroundName, hold, move });
  requireTool("ffprobe");
  const { warnings } = await resolveScene(repo, scene);
  if (!flags.dryRun) writeFileSync(target, JSON.stringify(scene, null, 2) + "\n");
  return {
    data: { file: repoRelative(repo, target), template: flags.template, scene },
    warnings,
    summary: [
      `${flags.dryRun ? "dry-run: была бы создана" : "создана"} сцена ${repoRelative(repo, target)} по шаблону «${flags.template}»: страниц ${pages.length}, ${scene.output.duration} с`,
      "это обычная сцена: позиции, повороты, камеру и длительность можно править в файле",
      `посмотреть кадр: repokit studio still --scene ${flags.out} --at 1 --out .repokit/out/look.png`,
      `рендер: repokit studio render --scene ${flags.out} --out docs/media/pages.mp4 --gif`,
    ],
  };
}

interface SceneInitFlags extends CommonFlags {
  capture: string;
  media?: string;
  device: string;
  out: string;
  force?: boolean;
}

async function sceneInit(flags: SceneInitFlags): Promise<CommandResult<{ file: string; scene: ReturnType<typeof starterScene> }>> {
  const repo = resolveRepo(flags.repo);
  if (!STAGE_DEVICES.includes(flags.device as StageDevice)) throw new UsageError(`--device: ожидается одно из ${STAGE_DEVICES.join(", ")}`);
  const target = resolve(repo, flags.out);
  if (existsSync(target) && !flags.force) throw new UsageError(`${flags.out} уже существует. Перезаписать: --force`);

  let media: string;
  let events: string | null = null;
  let duration = 6;
  if (flags.media) {
    media = flags.media;
  } else {
    const run = captureRunDir(repo, flags.capture);
    media = repoRelative(repo, join(run, "video.mp4"));
    events = repoRelative(repo, join(run, "events.json"));
    duration = JSON.parse(readFileUtf8(join(run, "events.json"))).duration;
  }
  const scene = starterScene(media, events, flags.device as StageDevice, Math.floor(duration * 10) / 10);
  requireTool("ffprobe");
  const { warnings } = await resolveScene(repo, scene);
  if (!flags.dryRun) writeFileSync(target, JSON.stringify(scene, null, 2) + "\n");
  return {
    data: { file: repoRelative(repo, target), scene },
    warnings,
    summary: [
      `${flags.dryRun ? "dry-run: была бы создана" : "создана"} сцена ${repoRelative(repo, target)}: устройство ${flags.device}, ${scene.output.duration} с`,
      "правьте файл: объекты (position, rotation, scale, keyframes), camera (auto или keyframes с focus), effects, captions",
      `посмотреть кадр: repokit studio still --scene ${flags.out} --at 2 --out .repokit/out/look.png`,
    ],
  };
}

interface ExplainFlags extends CommonFlags {
  out: string;
  theme: string;
  force?: boolean;
}

async function explainInit(flags: ExplainFlags): Promise<CommandResult<{ file: string; scene: ReturnType<typeof explainScene>["scene"]; facts: ReturnType<typeof explainScene>["facts"] }>> {
  const repo = resolveRepo(flags.repo);
  if (!BACKGROUND_NAMES.includes(flags.theme as BackgroundName)) throw new UsageError(`--theme: ожидается одно из ${BACKGROUND_NAMES.join(", ")}`);
  const target = resolve(repo, flags.out);
  if (existsSync(target) && !flags.force) throw new UsageError(`${flags.out} уже существует. Перезаписать: --force`);
  const { scene, humanTodo, facts } = explainScene(repo, flags.theme as BackgroundName);
  const { warnings } = await resolveScene(repo, scene);
  if (!flags.dryRun) writeFileSync(target, JSON.stringify(scene, null, 2) + "\n");
  return {
    data: { file: repoRelative(repo, target), scene, facts },
    warnings,
    humanTodo,
    summary: [
      `${flags.dryRun ? "dry-run: был бы создан" : "создан"} разбор ${repoRelative(repo, target)}: модулей ${facts.modules}, связей ${facts.links}${facts.services.length ? `, сервисы: ${facts.services.join(", ")}` : ""}; ${scene.output.duration} с`,
      "карточки и связи взяты из кода: импорты, обращения к API, объявленные зависимости. Подписи можно уточнять, но только тем, что есть в коде",
      `рендер: repokit studio render --scene ${flags.out} --out docs/media/how-it-works.mp4 --webm`,
    ],
  };
}

async function sceneValidate(flags: SourceFlags): Promise<CommandResult<{ objects: number; cameraKeys: number; durationSeconds: number }>> {
  const repo = resolveRepo(flags.repo);
  if (!flags.scene) throw new UsageError("Укажите сцену: --scene <файл>");
  requireTool("ffprobe");
  const plan = await planScene(repo, flags);
  const props = plan.job.inputProps as { objects: unknown[]; camera: { keys: unknown[] } };
  return {
    data: { objects: props.objects.length, cameraKeys: props.camera.keys.length, durationSeconds: plan.durationInFrames / plan.fps },
    warnings: plan.warnings,
    summary: [`сцена корректна — ${plan.description}`, `фоны: ${BACKGROUND_NAMES.join(", ")}`],
  };
}

interface DeckFlags extends CommonFlags {
  deck?: string;
  kind: string;
  theme: string;
  out?: string;
  outDir: string;
  pdf?: boolean;
  size: string;
  width?: string;
  force?: boolean;
}

function deckKind(flags: DeckFlags): DeckKind {
  if (!(flags.kind in DECK_SIZES)) throw new UsageError(`--kind: ожидается одно из ${Object.keys(DECK_SIZES).join(", ")}`);
  return flags.kind as DeckKind;
}

function deckTheme(flags: DeckFlags): BackgroundName {
  if (!BACKGROUND_NAMES.includes(flags.theme as BackgroundName)) throw new UsageError(`--theme: ожидается одно из ${BACKGROUND_NAMES.join(", ")}`);
  return flags.theme as BackgroundName;
}

async function deckInit(flags: DeckFlags): Promise<CommandResult<{ file: string; deck: Deck }>> {
  const repo = resolveRepo(flags.repo);
  const kind = deckKind(flags);
  const target = resolve(repo, flags.out ?? (kind === "banner" ? "banner.deck.json" : "slides.deck.json"));
  if (existsSync(target) && !flags.force) throw new UsageError(`${repoRelative(repo, target)} уже существует. Перезаписать: --force`);
  const { deck, humanTodo } = deckFromFacts(repo, kind, deckTheme(flags));
  const { warnings } = await resolveDeck(repo, deck, kind);
  if (!flags.dryRun) writeFileSync(target, JSON.stringify(deck, null, 2) + "\n");
  return {
    data: { file: repoRelative(repo, target), deck },
    warnings,
    humanTodo,
    summary: [
      `${flags.dryRun ? "dry-run: был бы создан" : "создан"} ${repoRelative(repo, target)}: слайдов ${deck.slides.length} (${deck.slides.map((s) => s.layout).join(", ")})`,
      "тексты взяты из полей автора, подтверждённых утверждений и найденных технологий; правьте файл и рендерите: repokit studio deck render",
    ],
  };
}

/** Render every slide of a deck to PNG, optionally binding them into a PDF. */
async function renderDeck(repo: string, deck: Deck, kind: DeckKind, targets: string[], flags: DeckFlags): Promise<{ outputs: OutputInfo[]; warnings: string[] }> {
  const size = deck.size ?? DECK_SIZES[kind];
  const width = flags.width ? positiveNumber(flags.width, "--width") : size.width;
  const scaled = { ...deck, size: { width: Math.round(width / 2) * 2, height: Math.round((width * size.height) / size.width / 2) * 2 } };
  const { props, files, warnings } = await resolveDeck(repo, scaled, kind);
  const job: RenderJob = { compositionId: DECK_COMPOSITION_ID, inputProps: props, files };
  await renderStills(job, targets.map((output, frame) => ({ frame, output })));
  const outputs: OutputInfo[] = targets.map((path) => ({ path, kind: "poster", bytes: statSync(path).size }));

  if (flags.pdf) {
    requireTool("ffmpeg");
    const pages = [];
    for (const target of targets) {
      const jpeg = `${target}.jpg`;
      await runTool("ffmpeg", ["-y", "-i", target, "-q:v", "2", jpeg]);
      pages.push({ jpeg: readFileSync(jpeg), width: props.width, height: props.height });
      rmSync(jpeg);
    }
    const pdf = join(dirname(targets[0]), "slides.pdf");
    writeFileSync(pdf, imagesToPdf(pages));
    outputs.push({ path: pdf, kind: "poster", bytes: statSync(pdf).size });
  }
  const createdAt = new Date().toISOString();
  const derivedFrom = [...new Set(files.map((f) => fileSha256(f.source))), sha256(JSON.stringify(deck))];
  recordMedia(repo, outputs.map((o): MediaEntry => ({ path: repoRelative(repo, o.path), sha256: fileSha256(o.path), kind: "poster", createdAt, tool: { name: "repokit studio", version: VERSION }, derivedFrom })));
  return { outputs, warnings };
}

async function deckRender(flags: DeckFlags): Promise<CommandResult<{ outputs: OutputInfo[] }>> {
  const repo = resolveRepo(flags.repo);
  if (!flags.deck) throw new UsageError("Укажите файл: --deck slides.deck.json (создать: repokit studio deck init)");
  const deck = loadDeck(resolve(flags.deck));
  const kind = deckKind(flags);
  const dir = resolve(repo, flags.outDir);
  const targets = deck.slides.map((_, index) => join(dir, `slide-${String(index + 1).padStart(2, "0")}.png`));
  if (flags.dryRun) {
    const { warnings } = await resolveDeck(repo, deck, kind);
    return { data: { outputs: [] }, warnings, summary: [`dry-run: слайдов ${deck.slides.length} → ${repoRelative(repo, dir)}`] };
  }
  const { outputs, warnings } = await renderDeck(repo, deck, kind, targets, flags);
  const relative = outputs.map((o) => ({ ...o, path: repoRelative(repo, o.path) }));
  return { data: { outputs: relative }, warnings, summary: [`слайдов: ${deck.slides.length} → ${repoRelative(repo, dir)}`, ...relative.map((o) => `  ${o.path} — ${(o.bytes / MEGABYTE).toFixed(2)} МБ`)] };
}

async function banner(flags: DeckFlags): Promise<CommandResult<{ output: OutputInfo | null; deck: Deck }>> {
  const repo = resolveRepo(flags.repo);
  if (!flags.out) throw new UsageError("Укажите, куда сохранить баннер: --out docs/media/banner.png");
  const target = resolve(repo, flags.out);
  if (extname(target).toLowerCase() !== ".png") throw new UsageError("--out должен указывать на файл .png");
  if (flags.size !== "banner" && flags.size !== "wide") throw new UsageError("--size: ожидается banner (1280×640, обложка репозитория) или wide (1600×520, полоса для README)");
  const size: DeckKind = flags.size;
  const { deck, humanTodo } = flags.deck ? { deck: loadDeck(resolve(flags.deck)), humanTodo: [] } : deckFromFacts(repo, size, deckTheme(flags));
  if (flags.dryRun) {
    const { warnings } = await resolveDeck(repo, deck, size);
    return { data: { output: null, deck }, warnings, humanTodo, summary: ["dry-run: баннер не рендерился"] };
  }
  const { outputs, warnings } = await renderDeck(repo, { ...deck, slides: deck.slides.slice(0, 1) }, size, [target], { ...flags, pdf: false });
  const output = { ...outputs[0], path: repoRelative(repo, outputs[0].path) };
  return { data: { output, deck }, warnings, humanTodo, summary: [`баннер: ${output.path} — ${(output.bytes / MEGABYTE).toFixed(2)} МБ`] };
}

export function registerStudio(program: Command): void {
  const studio = program.command("studio").description("монтаж записей: оформление, авто-зум, 3D-пресеты, GIF");
  const jsonOnly = (c: Command) => c.option("--json", "один JSON-документ в stdout");
  const presetSource = (c: Command) =>
    commonFlags(c)
      .option("--scene <file>", "режиссёрская сцена (JSON): свои объекты, камера, эффекты")
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

  const scene = studio.command("scene").description("режиссёрские 3D-сцены: свои объекты, движение камеры, эффекты");
  commonFlags(scene.command("init").description("заготовка сцены из записи: авто-камера и эффекты по кликам включены"))
    .option("--capture <run>", "запись capture: идентификатор или latest", "latest")
    .option("--media <file>", "вместо записи — произвольное видео или изображение из репозитория")
    .option("--device <name>", `устройство: ${STAGE_DEVICES.join(", ")}`, "browser")
    .option("--out <file>", "куда сохранить сцену", "demo.scene.json")
    .option("--force", "перезаписать существующий файл")
    .action((flags: SceneInitFlags) => runCommand("studio", "scene init", flags, () => sceneInit(flags)));
  jsonOnly(scene.command("templates").description("готовые постановки для нескольких страниц: карусель, стопка, смена страниц, стена, ноутбук и телефон"))
    .action((flags: { json?: boolean }) => runCommand("studio", "scene templates", flags, sceneTemplates));
  commonFlags(scene.command("make").description("собрать сцену по шаблону из скриншотов страниц"))
    .option("--template <name>", "шаблон; см. studio scene templates")
    .option("--pages <files>", "скриншоты или записи страниц через запятую, в порядке показа")
    .option("--device <name>", `устройство: ${STAGE_DEVICES.join(", ")}`, "browser")
    .option("--background <name>", `фон: ${BACKGROUND_NAMES.join(", ")}`, "light")
    .option("--hold <sec>", "сколько секунд страница стоит впереди", "1.8")
    .option("--move <sec>", "сколько секунд длится смена страницы", "0.9")
    .option("--out <file>", "куда сохранить сцену", "pages.scene.json")
    .option("--force", "перезаписать существующий файл")
    .action((flags: SceneMakeFlags) => runCommand("studio", "scene make", flags, () => sceneMake(flags)));
  commonFlags(scene.command("validate").description("проверить сцену: схема, файлы, длительность, ссылки на объекты"))
    .option("--scene <file>", "файл сцены")
    .action((flags: SourceFlags) => runCommand("studio", "scene validate", flags, () => sceneValidate(flags)));

  commonFlags(studio.command("explain").description("видеоразбор устройства проекта: карточки модулей и сервисов, связи из кода, камера идёт по пути запроса"))
    .option("--out <file>", "куда сохранить сцену разбора", "explain.scene.json")
    .option("--theme <name>", `оформление: ${BACKGROUND_NAMES.join(", ")}`, "dark")
    .option("--force", "перезаписать существующий файл")
    .action((flags: ExplainFlags) => runCommand("studio", "explain", flags, () => explainInit(flags)));
  studio.command("icons").description("значки для карточек сцен").option("--json", "один JSON-документ в stdout")
    .action((flags: { json?: boolean }) => runCommand("studio", "icons", flags, () => ({
      data: { generic: GENERIC_ICONS },
      summary: [`общие: ${GENERIC_ICONS.join(", ")}`, "логотипы технологий — по slug из simple-icons: python, fastapi, postgresql, redis, docker, react, …"],
    })));

  const deck = studio.command("deck").description("слайды презентации из фактов о проекте");
  const deckFlags = (c: Command) =>
    commonFlags(c)
      .option("--kind <kind>", `что собирать: ${Object.keys(DECK_SIZES).join(", ")}`, "slides")
      .option("--theme <name>", `оформление: ${BACKGROUND_NAMES.join(", ")}`, "light");
  deckFlags(deck.command("init").description("собрать черновик слайдов из полей автора, утверждений, технологий и скриншотов"))
    .option("--out <file>", "куда сохранить описание слайдов")
    .option("--force", "перезаписать существующий файл")
    .action((flags: DeckFlags) => runCommand("studio", "deck init", flags, () => deckInit(flags)));
  deckFlags(deck.command("render").description("отрендерить слайды в PNG, по желанию — собрать PDF"))
    .option("--deck <file>", "описание слайдов (JSON)")
    .option("--out-dir <dir>", "папка для слайдов", "docs/slides")
    .option("--width <px>", "ширина слайда (по умолчанию 1920)")
    .option("--pdf", "дополнительно собрать slides.pdf")
    .action((flags: DeckFlags) => runCommand("studio", "deck render", flags, () => deckRender(flags)));
  deckFlags(studio.command("banner").description("баннер проекта: название, тэглайн, технологии с логотипами и настоящий скриншот"))
    .option("--deck <file>", "своё описание баннера вместо собранного из фактов")
    .option("--size <kind>", "banner — 1280×640, обложка репозитория; wide — 1600×520, полоса для верха README", "banner")
    .option("--out <file>", "итоговый файл .png")
    .option("--width <px>", "ширина баннера (по умолчанию 1280)")
    .action((flags: DeckFlags) => runCommand("studio", "banner", flags, () => banner(flags)));

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
    .option("--webm", "дополнительно создать WebM (VP9; со звуком, если он есть)")
    .option("--click-sounds", "звук щелчка на каждый клик записи")
    .option("--no-click-sounds", "без щелчков, даже если они включены в сцене")
    .option("--music <file>", "музыкальный файл из репозитория: зацикливается или обрезается по длине ролика")
    .option("--music-volume <n>", "громкость музыки, 0–2 (по умолчанию 0.25)")
    .option("--gif-budget-mb <n>", "максимальный размер GIF в мегабайтах", String(DEFAULT_GIF_BUDGET_BYTES / MEGABYTE))
    .action((flags: RenderFlags) => runCommand("studio", "render", flags, () => render(flags)));

  presetSource(studio.command("still").description("один кадр сцены или 3D-пресета в PNG — быстрый взгляд на результат"))
    .option("--frame <n>", "номер кадра", "0")
    .option("--at <sec>", "момент времени в секундах (вместо --frame)")
    .option("--out <file>", "итоговый файл .png")
    .action((flags: StillFlags) => runCommand("studio", "still", flags, () => still(flags)));
}
