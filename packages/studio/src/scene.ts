import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { assertValid, findProvenance, insideRepo, runTool, UsageError } from "@repokit/core";
import type { Ease, TransformKey } from "@repokit/presets/motion";
import type { CameraKey, MediaBox, MediaPoint, StageCard, StageDevice, StageEffect, StageLink, StageObject, StageProps } from "@repokit/presets/stage-types";
import type { Vec3 } from "@repokit/presets/types";
import { buildCamera, type TimedEvent } from "./camera.js";
import { resolveIcon } from "./icons.js";

/** A scene as written by its author; see schemas/scene.schema.json. */
export interface Scene {
  schemaVersion: 1;
  output: { width?: number; height?: number; fps?: number; duration: number };
  background?: BackgroundName | { css: string; captionColor?: string };
  objects?: {
    id: string;
    device: StageDevice;
    media: string;
    events?: string;
    mediaStart?: number;
    mediaSpeed?: number;
    fit?: "cover" | "contain";
    width?: number;
    position?: Vec3;
    rotation?: Vec3;
    scale?: number;
    keyframes?: TransformKey[];
    cursor?: boolean;
    effects?: { ripple?: boolean; sparks?: boolean; popOut?: boolean };
  }[];
  camera?: {
    fov?: number;
    auto?: { object: string; zoom?: number; wide?: number; yaw?: number; pitch?: number };
    keyframes?: (Omit<CameraKey, "focus"> & { focus?: { object: string; point?: MediaPoint; zoom?: number; yaw?: number; pitch?: number } })[];
  };
  /** Plates with an icon and text: services, modules, steps of an explanation. */
  cards?: {
    id: string;
    title: string;
    subtitle?: string;
    /** A generic icon name or a technology's simple-icons slug. */
    icon?: string;
    color?: string;
    theme?: "light" | "dark";
    width?: number;
    position?: Vec3;
    rotation?: Vec3;
    scale?: number;
    keyframes?: TransformKey[];
    enterAt?: number;
    exitAt?: number;
  }[];
  /** Lines between objects or cards, with pulses that show a call or a data flow. */
  links?: { from: string; to: string; at?: number; color?: string; pulses?: number[] }[];
  effects?: StageEffect[];
  captions?: { from: number; to: number; text: string; position?: "top" | "bottom" }[];
  audio?: SceneAudio;
}

export interface SceneAudio {
  /** A short synthesised click at every click of the recordings. */
  clicks?: boolean;
  clickVolume?: number;
  /** A music file inside the repository; looped or cut to the length of the scene. */
  music?: string;
  musicVolume?: number;
}

const BACKGROUNDS = {
  light: { css: "radial-gradient(120% 120% at 12% 8%, #dbe6ff 0%, rgba(219,230,255,0) 55%), radial-gradient(110% 110% at 92% 94%, #ffe1ee 0%, rgba(255,225,238,0) 55%), #f2f3f8", caption: "#1c2333" },
  dark: { css: "radial-gradient(120% 120% at 12% 8%, #2b3170 0%, rgba(43,49,112,0) 55%), radial-gradient(110% 110% at 92% 94%, #4d2152 0%, rgba(77,33,82,0) 55%), #0c0e18", caption: "#eef0f7" },
  glass: { css: "linear-gradient(135deg, #5b7cfa 0%, #a56cc1 55%, #ff9a8b 100%)", caption: "#ffffff" },
  sunset: { css: "linear-gradient(160deg, #ffb88c 0%, #de6262 55%, #5b247a 100%)", caption: "#ffffff" },
  mint: { css: "radial-gradient(110% 110% at 85% 10%, #c9f7e4 0%, rgba(201,247,228,0) 55%), linear-gradient(160deg, #e9fbf4 0%, #dfeeff 100%)", caption: "#12332a" },
  mono: { css: "radial-gradient(100% 100% at 50% 30%, #2a2c33 0%, #0e0f12 100%)", caption: "#f2f2f4" },
} as const;
export type BackgroundName = keyof typeof BACKGROUNDS;
export const BACKGROUND_NAMES = Object.keys(BACKGROUNDS) as BackgroundName[];

const DEFAULT_WIDTH: Record<StageDevice, number> = { browser: 4.4, screen: 4.4, laptop: 3.06, phone: 1.44 };
const DEFAULT_OUTPUT = { width: 1280, height: 720, fps: 30 };
const DEFAULT_FOV = 30;
/** Defaults of the automatic camera: an overview with some air around the device, and a real push-in on each action. */
const AUTO = { zoom: 2.2, wide: 0.76, yaw: -10, pitch: 5 };
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const VIDEO_EXT = new Set([".mp4", ".webm", ".mov"]);

interface EventsDoc {
  viewport: { width: number; height: number };
  events: (TimedEvent & { box?: { x: number; y: number; width: number; height: number } })[];
}

export function loadScene(file: string): Scene {
  if (!existsSync(file)) throw new UsageError(`Сцена не найдена: ${file}`);
  let scene: Scene;
  try {
    scene = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new UsageError(`Сцена ${file}: некорректный JSON`);
  }
  assertValid("scene", scene);
  return scene;
}

async function probe(file: string): Promise<{ width: number; height: number; duration: number }> {
  const out = await runTool("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", file]);
  const info = JSON.parse(out);
  if (!info.streams?.[0]) throw new UsageError(`Не удалось прочитать медиафайл: ${file}`);
  return { width: info.streams[0].width, height: info.streams[0].height, duration: Number(info.format?.duration ?? 0) };
}

export interface ResolvedScene {
  props: StageProps;
  files: { source: string; name: string }[];
  warnings: string[];
  /** Moments of clicks on the scene clock, for the sound track. */
  clickTimes: number[];
}

const DARK_BACKGROUNDS = new Set<string>(["dark", "mono"]);
const CARD_DEFAULTS = { width: 2.6, color: "#3157d5", linkColor: "#8ea6ff" };

/** Check a scene against the files it refers to and turn it into render props. */
export async function resolveScene(repo: string, scene: Scene): Promise<ResolvedScene> {
  assertValid("scene", scene);
  const output = { ...DEFAULT_OUTPUT, ...scene.output };
  const { duration } = scene.output;
  const warnings: string[] = [];
  const files: ResolvedScene["files"] = [];
  const ids = new Set<string>();
  const objects: StageObject[] = [];
  /** Recording events on the scene clock, per object; the automatic camera is planned from these. */
  const timelines = new Map<string, { events: TimedEvent[]; viewport: { width: number; height: number } }>();

  if (!scene.objects?.length && !scene.cards?.length) throw new UsageError("В сцене нет ни объектов, ни карточек — показывать нечего");
  for (const item of scene.objects ?? []) {
    if (ids.has(item.id)) throw new UsageError(`Объект «${item.id}» объявлен дважды`);
    ids.add(item.id);
    const source = insideRepo(repo, item.media);
    if (!existsSync(source)) throw new UsageError(`Объект «${item.id}»: файл не найден — ${item.media}`);
    const extension = extname(source).toLowerCase();
    const kind = IMAGE_EXT.has(extension) ? "image" : VIDEO_EXT.has(extension) ? "video" : null;
    if (!kind) throw new UsageError(`Объект «${item.id}»: неподдерживаемый формат ${extension}`);
    if (!findProvenance(repo, source)) warnings.push(`объект «${item.id}»: происхождение неизвестно — ${item.media} не записан через repokit capture`);

    const media = await probe(source);
    const start = item.mediaStart ?? 0;
    const speed = item.mediaSpeed ?? 1;
    if (kind === "video" && start + duration * speed > media.duration + 0.05) {
      throw new UsageError(
        `Объект «${item.id}»: сцене нужно ${(start + duration * speed).toFixed(1)} с записи, а в ней ${media.duration.toFixed(1)} с. Уменьшите output.duration или mediaStart.`,
      );
    }

    let events: EventsDoc | null = null;
    if (item.events) {
      const file = insideRepo(repo, item.events);
      if (!existsSync(file)) throw new UsageError(`Объект «${item.id}»: лог событий не найден — ${item.events}`);
      events = JSON.parse(readFileSync(file, "utf8"));
      assertValid("events", events);
    }
    const wantsEffects = item.effects?.ripple || item.effects?.sparks || item.effects?.popOut;
    if (!events && (wantsEffects || item.cursor)) warnings.push(`объект «${item.id}»: без лога событий (events) нет ни курсора, ни эффектов по кликам`);

    // Recording time → scene time; anything outside the scene is dropped.
    const onScene = (t: number) => (t - start) / speed;
    const inScene = (t: number) => onScene(t) >= -1 && onScene(t) <= duration + 1;
    const list = (events?.events ?? []).filter((e) => inScene(e.t));
    const located = list.filter((e) => e.x !== undefined && e.y !== undefined);
    const viewport = events?.viewport ?? { width: media.width, height: media.height };
    timelines.set(item.id, { viewport, events: list.map((e) => ({ ...e, t: onScene(e.t), duration: e.duration === undefined ? undefined : e.duration / speed })) });

    const fileName = `object-${item.id}${extension}`;
    files.push({ source, name: fileName });
    objects.push({
      id: item.id,
      device: item.device,
      width: item.width ?? DEFAULT_WIDTH[item.device],
      fit: item.fit ?? "cover",
      media: { src: fileName, kind, viewWidth: viewport.width, viewHeight: viewport.height, startFrame: Math.round(start * output.fps), playbackRate: speed },
      base: { position: item.position ?? [0, 0, 0], rotation: item.rotation ?? [0, 0, 0], scale: item.scale ?? 1 },
      keyframes: item.keyframes ?? [],
      cursor: item.cursor === false ? [] : located.filter((e) => ["move", "click", "hover"].includes(e.type)).map((e) => ({ t: onScene(e.t), x: e.x!, y: e.y! })),
      clicks: located.filter((e) => e.type === "click").map((e) => ({ t: onScene(e.t), x: e.x!, y: e.y!, ...(e.box ? { box: [e.box.x, e.box.y, e.box.width, e.box.height] as MediaBox } : {}) })),
      effects: { ripple: item.effects?.ripple ?? Boolean(events), sparks: item.effects?.sparks ?? false, popOut: item.effects?.popOut ?? false },
    });
  }

  const darkScene = typeof scene.background === "string" ? DARK_BACKGROUNDS.has(scene.background) : false;
  const cards: StageCard[] = [];
  for (const item of scene.cards ?? []) {
    if (ids.has(item.id)) throw new UsageError(`Объект «${item.id}» объявлен дважды`);
    ids.add(item.id);
    const icon = item.icon ? await resolveIcon(item.icon) : null;
    if (item.icon && !icon) warnings.push(`карточка «${item.id}»: значок «${item.icon}» не найден — карточка будет без значка`);
    cards.push({
      id: item.id,
      title: item.title,
      ...(item.subtitle ? { subtitle: item.subtitle } : {}),
      ...(icon ? { icon: { path: icon.path, viewBox: icon.viewBox } } : {}),
      color: item.color ?? (icon?.hex ? `#${icon.hex}` : CARD_DEFAULTS.color),
      theme: item.theme ?? (darkScene ? "dark" : "light"),
      width: item.width ?? CARD_DEFAULTS.width,
      base: { position: item.position ?? [0, 0, 0], rotation: item.rotation ?? [0, 0, 0], scale: item.scale ?? 1 },
      keyframes: item.keyframes ?? [],
      enterAt: item.enterAt ?? 0,
      ...(item.exitAt !== undefined ? { exitAt: item.exitAt } : {}),
    });
  }

  const known = (id: string, where: string) => {
    if (!ids.has(id)) throw new UsageError(`${where}: объекта «${id}» нет в сцене. Объекты: ${[...ids].join(", ")}`);
  };
  for (const effect of scene.effects ?? []) {
    known(effect.object, `Эффект ${effect.type}`);
    if (!objects.some((o) => o.id === effect.object)) throw new UsageError(`Эффект ${effect.type}: «${effect.object}» — карточка, а эффекты ставятся на экраны устройств`);
  }
  const links: StageLink[] = (scene.links ?? []).map((link) => {
    known(link.from, "Связь");
    known(link.to, "Связь");
    return { from: link.from, to: link.to, at: link.at ?? 0, color: link.color ?? CARD_DEFAULTS.linkColor, pulses: link.pulses ?? [] };
  });

  let keys: CameraKey[];
  const camera = scene.camera ?? {};
  if (camera.keyframes?.length) {
    if (camera.auto) warnings.push("в camera заданы и auto, и keyframes — используются keyframes");
    keys = camera.keyframes.map(({ focus, ...key }): CameraKey => {
      if (focus) known(focus.object, "Камера");
      if (!focus && !key.position) throw new UsageError(`Кадр камеры at=${key.at}: укажите focus или position`);
      return { ...key, ...(focus ? { focus: { ...focus, zoom: focus.zoom ?? 1 } } : {}) };
    }).sort((a, b) => a.at - b.at);
  } else if (objects.length === 0) {
    // Only cards: stand back far enough to see all of them.
    const fov = camera.fov ?? DEFAULT_FOV;
    const xs = cards.flatMap((c) => [c.base.position[0] - c.width / 2, c.base.position[0] + c.width / 2]);
    const ys = cards.flatMap((c) => [c.base.position[1] - c.width * 0.2, c.base.position[1] + c.width * 0.2]);
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const vertical = Math.tan((fov * Math.PI) / 360);
    const distance = Math.max((maxX - minX) / (2 * vertical * (output.width / output.height)), (maxY - minY) / (2 * vertical)) * 1.25;
    const centre: Vec3 = [(minX + maxX) / 2, (minY + maxY) / 2, 0];
    keys = [{ at: 0, position: [centre[0], centre[1], Math.max(...cards.map((c) => c.base.position[2])) + distance], lookAt: centre }];
  } else {
    const auto = { ...AUTO, object: objects[0].id, ...camera.auto };
    known(auto.object, "Камера (auto)");
    const timeline = timelines.get(auto.object)!;
    // The 2D auto-zoom planner decides where to look and when; here its result drives a real camera.
    const plan = buildCamera(timeline.events, duration, { ...timeline.viewport, scale: auto.zoom });
    keys = plan.map((k) => ({
      at: k.t,
      ease: "inOut" as Ease,
      focus: { object: auto.object, point: [k.x, k.y] as MediaPoint, zoom: auto.wide * k.scale, yaw: k.scale > 1 ? auto.yaw * 0.4 : auto.yaw, pitch: k.scale > 1 ? auto.pitch * 0.4 : auto.pitch },
    }));
    if (plan.every((k) => k.scale === 1) && !camera.auto) warnings.push("у объекта нет лога событий — камера стоит на общем плане; задайте camera.keyframes");
  }

  const background = typeof scene.background === "object"
    ? { css: scene.background.css, caption: scene.background.captionColor ?? "#ffffff" }
    : BACKGROUNDS[scene.background ?? "light"];

  for (const caption of scene.captions ?? []) if (caption.to <= caption.from) throw new UsageError(`Подпись «${caption.text}»: to должно быть больше from`);

  return {
    props: {
      width: output.width,
      height: output.height,
      fps: output.fps,
      durationInFrames: Math.max(1, Math.round(duration * output.fps)),
      background: background.css,
      captionColor: background.caption,
      objects,
      cards,
      links,
      camera: { fov: camera.fov ?? DEFAULT_FOV, keys },
      effects: scene.effects ?? [],
      captions: (scene.captions ?? []).map((c) => ({ ...c, position: c.position ?? "bottom" })),
    },
    files,
    warnings,
    clickTimes: objects.flatMap((o) => o.clicks.map((c) => c.t)).filter((t) => t >= 0 && t <= duration).sort((a, b) => a - b),
  };
}

/** A ready-to-edit scene for one recording: automatic camera, every click effect switched on. */
export function starterScene(media: string, events: string | null, device: StageDevice, duration: number): Scene {
  return {
    schemaVersion: 1,
    output: { width: 1280, height: 720, fps: 30, duration: Math.round(duration * 10) / 10 },
    background: "light",
    objects: [{
      id: "app",
      device,
      media,
      ...(events ? { events, cursor: true, effects: { ripple: true, sparks: true, popOut: true } } : {}),
      rotation: [0, 0, 0],
    }],
    camera: { fov: DEFAULT_FOV, auto: { object: "app", ...AUTO } },
    effects: [],
    captions: [],
  };
}
