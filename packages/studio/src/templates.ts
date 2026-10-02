import type { TransformKey } from "@repokit/presets/motion";
import type { StageDevice } from "@repokit/presets/stage-types";
import type { Vec3 } from "@repokit/presets/types";
import { UsageError } from "@repokit/core";
import type { BackgroundName, Scene } from "./scene.js";

export interface TemplateOptions {
  /** Screenshots or recordings of the application's pages, in the order they are shown. */
  pages: string[];
  device: StageDevice;
  background: BackgroundName;
  /** Seconds each page stays in front. */
  hold: number;
  /** Seconds a change of page takes. */
  move: number;
}

export interface SceneTemplate {
  name: string;
  title: string;
  description: string;
  minPages: number;
  maxPages: number;
  build: (options: TemplateOptions) => Scene;
}

type Pose = { position: Vec3; rotation: Vec3; scale?: number };

const SCREEN_WIDTH = 4.4;
const CAMERA: Vec3 = [0, 0.2, 7.8];
const round = (n: number) => Math.round(n * 1000) / 1000;
const vec = (v: Vec3): Vec3 => [round(v[0]), round(v[1]), round(v[2])];

/**
 * Pages take turns in front. `pose(slot)` says where a page stands when it is `slot` turns
 * away from the front: 0 is in front, positive is still waiting, negative has been shown.
 */
function turnTaking(options: TemplateOptions, pose: (slot: number, count: number) => Pose, drift: Vec3): Scene {
  const { pages, hold, move } = options;
  const count = pages.length;
  const duration = round(count * hold + (count - 1) * move);
  const objects = pages.map((media, index) => {
    const at = (step: number) => {
      const p = pose(index - step, count);
      return { position: vec(p.position), rotation: vec(p.rotation), scale: p.scale ?? 1 };
    };
    const keyframes: TransformKey[] = [];
    for (let step = 0; step < count - 1; step++) {
      const start = round(hold + step * (hold + move));
      // Hold still until the change begins, then travel to the next place.
      keyframes.push({ at: start, ...at(step) }, { at: round(start + move), ...at(step + 1), ease: "inOut" });
    }
    return { id: `page${index + 1}`, device: options.device, media, width: SCREEN_WIDTH, ...at(0), keyframes };
  });
  return {
    schemaVersion: 1,
    output: { width: 1280, height: 720, fps: 30, duration },
    background: options.background,
    objects,
    camera: {
      fov: 30,
      keyframes: [
        { at: 0, position: CAMERA, lookAt: [0, 0, 0] },
        { at: duration, position: vec([CAMERA[0] + drift[0], CAMERA[1] + drift[1], CAMERA[2] + drift[2]]), lookAt: [0, 0, 0], ease: "inOut" },
      ],
    },
    effects: [],
    captions: [],
  };
}

const TEMPLATES: SceneTemplate[] = [
  {
    name: "carousel",
    title: "Карусель",
    description: "текущая страница впереди, соседние стоят по бокам вполоборота; ряд сдвигается, и вперёд выходит следующая",
    minPages: 2,
    maxPages: 8,
    build: (options) => turnTaking(options, (slot) => {
      if (slot === 0) return { position: [0, 0, 0], rotation: [0, 0, 0] };
      // Neighbours stand to the sides, turned towards the viewer; the rest queue up behind them.
      const side = Math.sign(slot);
      const far = Math.abs(slot) - 1;
      return { position: [side * (4.5 + far * 1.5), 0, -2.4 - far * 1.1], rotation: [0, -side * 52, 0], scale: 0.92 };
    }, [0.4, 0.2, -0.5]),
  },
  {
    name: "stack",
    title: "Стопка",
    description: "страницы лежат стопкой в глубину; верхняя улетает в сторону, следующая выходит вперёд",
    minPages: 2,
    maxPages: 6,
    build: (options) => turnTaking(options, (slot) =>
      slot < 0
        ? { position: [-8.5, 0.9, 1.2], rotation: [4, 58, -9] }
        : { position: [0.42 * slot, 0.3 * slot, -1.25 * slot], rotation: [0, -7, 0], scale: 1 },
    [-0.6, 0.2, -0.3]),
  },
  {
    name: "swap",
    title: "Смена страниц",
    description: "страница уходит влево, разворачиваясь как дверь, а справа так же входит следующая",
    minPages: 2,
    maxPages: 8,
    build: (options) => turnTaking(options, (slot) =>
      slot === 0 ? { position: [0, 0, 0], rotation: [0, 0, 0] }
        : slot > 0 ? { position: [6.6, 0, -3], rotation: [0, -72, 0], scale: 0.9 }
        : { position: [-6.6, 0, -3], rotation: [0, 72, 0], scale: 0.9 },
    [0, 0.15, -0.5]),
  },
  {
    name: "wall",
    title: "Стена",
    description: "страницы стоят в ряд; камера проезжает вдоль и останавливается у каждой",
    minPages: 2,
    maxPages: 8,
    build: ({ pages, device, background, hold, move }) => {
      const gap = SCREEN_WIDTH * 1.18;
      const duration = round(pages.length * hold + (pages.length - 1) * move);
      const keyframes: NonNullable<NonNullable<Scene["camera"]>["keyframes"]> = [];
      pages.forEach((_, index) => {
        const start = round(index * (hold + move));
        // The camera looks at each page from a slightly different side, so the row reads as depth, not as a strip.
        const focus = { object: `page${index + 1}`, zoom: 0.62, yaw: index % 2 === 0 ? -14 : 12, pitch: 5 };
        keyframes.push({ at: start, focus, ease: "inOut" }, { at: round(start + hold), focus: { ...focus, zoom: 0.7 } });
      });
      return {
        schemaVersion: 1,
        output: { width: 1280, height: 720, fps: 30, duration },
        background,
        objects: pages.map((media, index) => ({ id: `page${index + 1}`, device, media, width: SCREEN_WIDTH, position: vec([index * gap, 0, 0]), rotation: [0, 0, 0] as Vec3 })),
        camera: { fov: 30, keyframes },
        effects: [],
        captions: [],
      };
    },
  },
  {
    name: "duo",
    title: "Ноутбук и телефон",
    description: "десктопная версия на ноутбуке и мобильная на телефоне рядом; камера медленно обходит их",
    minPages: 2,
    maxPages: 2,
    build: ({ pages, background, hold }) => {
      const duration = round(Math.max(4, hold * 3));
      return {
        schemaVersion: 1,
        output: { width: 1280, height: 720, fps: 30, duration },
        background,
        objects: [
          {
            id: "desktop", device: "laptop", media: pages[0], position: [-0.75, 0.1, 0], rotation: [0, 16, 0],
            keyframes: [{ at: duration, position: [-0.75, 0.18, 0], rotation: [0, 10, 0], ease: "inOut" }],
          },
          {
            id: "mobile", device: "phone", media: pages[1], position: [1.75, 0.05, 0.9], rotation: [0, -22, 2],
            keyframes: [{ at: duration, position: [1.75, 0.15, 0.9], rotation: [0, -14, 0], ease: "inOut" }],
          },
        ],
        camera: {
          fov: 30,
          keyframes: [
            { at: 0, position: [-1.6, 0.9, 8.2], lookAt: [0.3, 0, 0] },
            { at: duration, position: [1.5, 0.6, 7.4], lookAt: [0.3, 0, 0], ease: "inOut" },
          ],
        },
        effects: [],
        captions: [],
      };
    },
  },
];

export const listSceneTemplates = (): SceneTemplate[] => TEMPLATES;

export function buildFromTemplate(name: string, options: TemplateOptions): Scene {
  const template = TEMPLATES.find((t) => t.name === name);
  if (!template) throw new UsageError(`Шаблон сцены «${name}» не найден. Доступны: ${TEMPLATES.map((t) => t.name).join(", ")}`);
  const count = options.pages.length;
  if (count < template.minPages || count > template.maxPages) {
    const range = template.minPages === template.maxPages ? `ровно ${template.minPages}` : `от ${template.minPages} до ${template.maxPages}`;
    throw new UsageError(`Шаблону «${name}» нужно страниц: ${range}; передано ${count} (--pages a.png,b.png,…)`);
  }
  return template.build(options);
}
