import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertValid, findProvenance, insideRepo, REPOKIT_DIR, repoRelative, runTool, UsageError } from "@repokit/core";
import { buildCamera, type CursorSample, type TimedEvent } from "./camera.js";
import type { DemoProps, SceneProps, StyleName } from "./remotion/props.js";

export interface TimelineScene {
  source: string;
  events?: string;
  in?: number;
  out?: number;
  speed?: number;
  zoom?: { mode: "auto" | "off"; scale?: number };
  cursor?: boolean;
  title?: string;
}

export interface Timeline {
  schemaVersion: 1;
  output: { width: number; height: number; fps: number };
  style: StyleName;
  scenes: TimelineScene[];
}

interface EventsDoc {
  viewport: { width: number; height: number };
  duration: number;
  events: (TimedEvent & { type: string })[];
}

const CAPTURE_RUN = /^\d{8}-\d{6}$/;

/** Directory of a capture run: a run id, or `latest` for the most recent one. */
export function captureRunDir(repo: string, run: string): string {
  const root = join(repo, REPOKIT_DIR, "capture");
  const runs = existsSync(root)
    ? readdirSync(root).filter((name) => CAPTURE_RUN.test(name) && existsSync(join(root, name, "video.mp4"))).sort()
    : [];
  if (runs.length === 0) throw new UsageError("Записей нет. Сначала: repokit capture run --scenario <файл>");
  const name = run === "latest" ? runs[runs.length - 1] : run;
  if (!runs.includes(name)) throw new UsageError(`Запись не найдена: ${run}. Есть: ${runs.join(", ")}`);
  return join(root, name);
}

export interface TimelineDefaults {
  style: StyleName;
  width: number;
  height: number;
  fps: number;
  zoom: boolean;
  zoomScale?: number;
  title?: string;
}

/** The simplest timeline for one capture run: the whole recording, one scene. */
export function timelineFromCapture(repo: string, runDir: string, defaults: TimelineDefaults): Timeline {
  return {
    schemaVersion: 1,
    output: { width: defaults.width, height: defaults.height, fps: defaults.fps },
    style: defaults.style,
    scenes: [{
      source: repoRelative(repo, join(runDir, "video.mp4")),
      events: repoRelative(repo, join(runDir, "events.json")),
      zoom: defaults.zoom ? { mode: "auto", ...(defaults.zoomScale ? { scale: defaults.zoomScale } : {}) } : { mode: "off" },
      cursor: true,
      ...(defaults.title ? { title: defaults.title } : {}),
    }],
  };
}

export function loadTimeline(file: string): Timeline {
  if (!existsSync(file)) throw new UsageError(`Таймлайн не найден: ${file}`);
  let timeline: Timeline;
  try {
    timeline = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new UsageError(`Таймлайн ${file}: некорректный JSON`);
  }
  assertValid("timeline", timeline);
  return timeline;
}

async function probe(file: string): Promise<{ width: number; height: number; duration: number }> {
  const out = await runTool("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", file]);
  const info = JSON.parse(out);
  return { width: info.streams[0].width, height: info.streams[0].height, duration: Number(info.format.duration) };
}

export interface ResolvedTimeline {
  props: DemoProps;
  /** Absolute source path for each scene, in order. */
  sources: string[];
  warnings: string[];
}

/** Turn a timeline into render props: check sources, read event logs, plan the camera. */
export async function resolveTimeline(repo: string, timeline: Timeline): Promise<ResolvedTimeline> {
  const { fps } = timeline.output;
  const warnings: string[] = [];
  const sources: string[] = [];
  const scenes: SceneProps[] = [];

  for (const [index, scene] of timeline.scenes.entries()) {
    const source = insideRepo(repo, scene.source);
    if (!existsSync(source)) throw new UsageError(`Сцена ${index + 1}: источник не найден — ${scene.source}`);
    if (!findProvenance(repo, source)) {
      warnings.push(`сцена ${index + 1}: происхождение неизвестно — ${scene.source} не записан через repokit capture`);
    }
    const video = await probe(source);

    let events: EventsDoc | null = null;
    if (scene.events) {
      const file = insideRepo(repo, scene.events);
      if (!existsSync(file)) throw new UsageError(`Сцена ${index + 1}: лог событий не найден — ${scene.events}`);
      events = JSON.parse(readFileSync(file, "utf8"));
      assertValid("events", events);
    }

    const start = scene.in ?? 0;
    const end = Math.min(scene.out ?? video.duration, video.duration);
    if (end <= start) throw new UsageError(`Сцена ${index + 1}: пустой фрагмент (in=${start}, out=${end})`);
    const speed = scene.speed ?? 1;
    const sourceWidth = events?.viewport.width ?? video.width;
    const sourceHeight = events?.viewport.height ?? video.height;
    const zoomOn = (scene.zoom?.mode ?? "auto") === "auto" && events !== null;
    if ((scene.zoom?.mode ?? "auto") === "auto" && !events) warnings.push(`сцена ${index + 1}: нет лога событий — авто-зум и курсор отключены`);

    const list = events?.events ?? [];
    const points = (type: string): CursorSample[] =>
      list.filter((e) => e.type === type && e.x !== undefined && e.y !== undefined).map((e) => ({ t: e.t, x: e.x!, y: e.y! }));
    // Clicks are pointer positions too: without them a `fast` recording would have no cursor path.
    const cursor = scene.cursor === false ? [] : [...points("move"), ...points("click"), ...points("hover")].sort((a, b) => a.t - b.t);

    sources.push(source);
    scenes.push({
      src: `scene-${index + 1}.mp4`,
      durationInFrames: Math.max(1, Math.round(((end - start) / speed) * fps)),
      in: start,
      speed,
      sourceWidth,
      sourceHeight,
      camera: buildCamera(zoomOn ? list : [], video.duration, { width: sourceWidth, height: sourceHeight, scale: scene.zoom?.scale }),
      cursor,
      clicks: scene.cursor === false ? [] : points("click"),
      ...(scene.title ? { title: scene.title } : {}),
    });
  }

  return {
    props: {
      ...timeline.output,
      style: timeline.style,
      durationInFrames: scenes.reduce((sum, s) => sum + s.durationInFrames, 0),
      scenes,
    },
    sources,
    warnings,
  };
}
