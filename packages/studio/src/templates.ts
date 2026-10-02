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
  /** Length of a scene that shows a single page, in seconds. */
  duration: number;
}

export type TemplateGroup = "pages" | "layout" | "single";

export const GROUP_TITLES: Record<TemplateGroup, string> = {
  pages: "страницы сменяют друг друга",
  layout: "страницы стоят вместе, движется камера",
  single: "одна запись или один скриншот",
};

export interface SceneTemplate {
  name: string;
  group: TemplateGroup;
  title: string;
  description: string;
  minPages: number;
  maxPages: number;
  build: (options: TemplateOptions) => Scene;
}

type Pose = { position: Vec3; rotation: Vec3; scale?: number };
type CameraKeys = NonNullable<NonNullable<Scene["camera"]>["keyframes"]>;
type SceneObject = NonNullable<Scene["objects"]>[number];

const SCREEN_WIDTH = 4.4;
/** Height of a 16:10 page of that width; layouts only need it roughly. */
const SCREEN_HEIGHT = 2.75;
const CAMERA: Vec3 = [0, 0.2, 7.8];
const ORIGIN: Vec3 = [0, 0, 0];
const round = (n: number) => Math.round(n * 1000) / 1000;
const vec = (v: Vec3): Vec3 => [round(v[0]), round(v[1]), round(v[2])];
const degrees = (radians: number) => (radians * 180) / Math.PI;

function scene(options: TemplateOptions, duration: number, objects: SceneObject[], keyframes: CameraKeys): Scene {
  return {
    schemaVersion: 1,
    output: { width: 1280, height: 720, fps: 30, duration: round(duration) },
    background: options.background,
    objects,
    camera: { fov: 30, keyframes: keyframes.map((k) => ({ ...k, at: round(k.at) })) },
    effects: [],
    captions: [],
  };
}

/** A camera that stays where it is and drifts a little, so a still composition is not a frozen picture. */
const drifting = (duration: number, from: Vec3, drift: Vec3, lookAt: Vec3 = ORIGIN): CameraKeys => [
  { at: 0, position: vec(from), lookAt },
  { at: duration, position: vec([from[0] + drift[0], from[1] + drift[1], from[2] + drift[2]]), lookAt, ease: "inOut" },
];

/**
 * Pages take turns in front. `pose(slot)` says where a page stands when it is `slot` turns
 * away from the front: 0 is in front, positive is still waiting, negative has been shown.
 */
function turnTaking(options: TemplateOptions, pose: (slot: number, count: number) => Pose, drift: Vec3, ease: TransformKey["ease"] = "inOut"): Scene {
  const { pages, hold, move } = options;
  const count = pages.length;
  const duration = count * hold + (count - 1) * move;
  const objects = pages.map((media, index) => {
    const at = (step: number) => {
      const p = pose(index - step, count);
      return { position: vec(p.position), rotation: vec(p.rotation), scale: p.scale ?? 1 };
    };
    const keyframes: TransformKey[] = [];
    for (let step = 0; step < count - 1; step++) {
      const start = round(hold + step * (hold + move));
      // Hold still until the change begins, then travel to the next place.
      keyframes.push({ at: start, ...at(step) }, { at: round(start + move), ...at(step + 1), ease });
    }
    return { id: `page${index + 1}`, device: options.device, media, width: SCREEN_WIDTH, ...at(0), keyframes };
  });
  return scene(options, duration, objects, drifting(duration, CAMERA, drift));
}

/** Pages stand still; the camera visits each in turn. `overview` opens with all of them in the frame. */
function tour(options: TemplateOptions, poses: Pose[], view: { zoom: number; yaw: number; pitch: number }, overview?: { position: Vec3; lookAt: Vec3 }): Scene {
  const { pages, hold, move } = options;
  const lead = overview ? hold * 0.8 + move : 0;
  const duration = lead + pages.length * hold + (pages.length - 1) * move;
  const keyframes: CameraKeys = overview ? [{ at: 0, ...overview }, { at: hold * 0.8, ...overview }] : [];
  pages.forEach((_, index) => {
    const start = lead + index * (hold + move);
    // Each page is looked at from a slightly different side, so the row reads as depth.
    const focus = { object: `page${index + 1}`, zoom: view.zoom, yaw: index % 2 === 0 ? -view.yaw : view.yaw, pitch: view.pitch };
    keyframes.push({ at: start, focus, ease: "inOut" }, { at: start + hold, focus: { ...focus, zoom: view.zoom * 1.12 } });
  });
  const objects = pages.map((media, index) => ({
    id: `page${index + 1}`, device: options.device, media, width: SCREEN_WIDTH,
    position: vec(poses[index].position), rotation: vec(poses[index].rotation), scale: poses[index].scale ?? 1,
  }));
  return scene(options, duration, objects, keyframes);
}

/** One page: `motion` gives its start, its keyframes and the camera. */
function single(options: TemplateOptions, motion: (duration: number) => { start: Pose; keyframes: TransformKey[]; camera: CameraKeys }): Scene {
  const { start, keyframes, camera } = motion(options.duration);
  const object: SceneObject = {
    id: "app", device: options.device, media: options.pages[0],
    position: vec(start.position), rotation: vec(start.rotation), scale: start.scale ?? 1,
    keyframes: keyframes.map((k) => ({ ...k, at: round(k.at) })),
  };
  return scene(options, options.duration, [object], camera);
}

const still: Pose = { position: ORIGIN, rotation: ORIGIN };
const centred = (count: number, index: number) => index - (count - 1) / 2;

const TEMPLATES: SceneTemplate[] = [
  // --- pages take turns
  {
    name: "carousel", group: "pages", title: "Карусель", minPages: 2, maxPages: 8,
    description: "текущая страница впереди, соседние стоят по бокам вполоборота; ряд сдвигается, и вперёд выходит следующая",
    build: (options) => turnTaking(options, (slot) => {
      if (slot === 0) return still;
      // Neighbours stand to the sides, turned towards the viewer; the rest queue up behind them.
      const side = Math.sign(slot);
      const far = Math.abs(slot) - 1;
      return { position: [side * (4.5 + far * 1.5), 0, -2.4 - far * 1.1], rotation: [0, -side * 52, 0], scale: 0.92 };
    }, [0.4, 0.2, -0.5]),
  },
  {
    name: "stack", group: "pages", title: "Стопка", minPages: 2, maxPages: 6,
    description: "страницы лежат стопкой в глубину; верхняя улетает в сторону, следующая выходит вперёд",
    build: (options) => turnTaking(options, (slot) =>
      slot < 0 ? { position: [-8.5, 0.9, 1.2], rotation: [4, 58, -9] } : { position: [0.42 * slot, 0.3 * slot, -1.25 * slot], rotation: [0, -7, 0] },
    [-0.6, 0.2, -0.3]),
  },
  {
    name: "swap", group: "pages", title: "Двери", minPages: 2, maxPages: 8,
    description: "страница уходит влево, разворачиваясь как дверь, а справа так же входит следующая",
    build: (options) => turnTaking(options, (slot) =>
      slot === 0 ? still : { position: [Math.sign(slot) * 6.6, 0, -3], rotation: [0, -Math.sign(slot) * 72, 0], scale: 0.9 },
    [0, 0.15, -0.5]),
  },
  {
    name: "slide", group: "pages", title: "Лента", minPages: 2, maxPages: 8,
    description: "страницы стоят в одной плоскости и сдвигаются влево, как кадры плёнки",
    build: (options) => turnTaking(options, (slot) => ({ position: [slot * SCREEN_WIDTH * 1.12, 0, -Math.abs(slot) * 0.5], rotation: [0, -slot * 4, 0] }), [0.3, 0.1, -0.3]),
  },
  {
    name: "cube", group: "pages", title: "Куб", minPages: 2, maxPages: 4,
    description: "страницы — грани куба; куб поворачивается вокруг вертикальной оси",
    build: (options) => {
      const radius = SCREEN_WIDTH / 2;
      return turnTaking(options, (slot) => {
        const angle = (slot * Math.PI) / 2;
        return { position: [radius * Math.sin(angle), 0, radius * Math.cos(angle) - radius], rotation: [0, degrees(angle), 0] };
      }, [0.5, 0.3, 0.6]);
    },
  },
  {
    name: "tumble", group: "pages", title: "Барабан", minPages: 2, maxPages: 4,
    description: "страницы — грани барабана; он проворачивается вверх, как перекидной календарь",
    build: (options) => {
      const radius = SCREEN_HEIGHT / 2;
      return turnTaking(options, (slot) => {
        const angle = (slot * Math.PI) / 2;
        return { position: [0, -radius * Math.sin(angle), radius * Math.cos(angle) - radius], rotation: [degrees(angle), 0, 0] };
      }, [0.4, 0.2, 0.4]);
    },
  },
  {
    name: "flip", group: "pages", title: "Переворот", minPages: 2, maxPages: 8,
    description: "страница переворачивается на месте, как карточка, и открывает следующую",
    build: (options) => turnTaking(options, (slot) =>
      slot === 0 ? still : { position: [0, 0, -1.2], rotation: [0, -Math.sign(slot) * 180, 0], scale: 0.86 },
    [0.3, 0.15, -0.3]),
  },
  {
    name: "rise", group: "pages", title: "Подъём", minPages: 2, maxPages: 8,
    description: "текущая страница уходит вверх, следующая поднимается снизу",
    build: (options) => turnTaking(options, (slot) =>
      slot === 0 ? still : { position: [0, -Math.sign(slot) * 5.6, -1.5], rotation: [Math.sign(slot) * 28, 0, 0], scale: 0.9 },
    [0.3, 0.2, -0.4]),
  },
  {
    name: "drop", group: "pages", title: "Падение", minPages: 2, maxPages: 8,
    description: "следующая страница падает сверху и встаёт на место с пружинкой, прежняя проваливается вниз",
    build: (options) => turnTaking(options, (slot) =>
      slot === 0 ? still : { position: [0, Math.sign(slot) * 5.8, -0.8], rotation: [-Math.sign(slot) * 16, 0, Math.sign(slot) * 3], scale: 0.94 },
    [-0.3, 0.15, -0.3], "back"),
  },
  {
    name: "fly-through", group: "pages", title: "Пролёт", minPages: 2, maxPages: 8,
    description: "страница летит на зрителя и проходит мимо камеры, из глубины подлетает следующая",
    build: (options) => turnTaking(options, (slot) =>
      slot === 0 ? still : slot < 0 ? { position: [-2.6, 0.4, 9.5], rotation: [0, 18, 0] } : { position: [0.5 * slot, 0.2 * slot, -9 - 3 * slot], rotation: [0, 0, 0] },
    [0, 0.1, -0.2]),
  },
  {
    name: "fan", group: "pages", title: "Веер", minPages: 2, maxPages: 6,
    description: "страницы разложены веером, как карты; верхняя соскальзывает вниз, веер поворачивается",
    build: (options) => turnTaking(options, (slot) =>
      slot < 0 ? { position: [-6.5, -4.6, 0.6], rotation: [0, 20, 40] } : { position: [0.95 * slot, 0.12 * slot, -0.45 * slot], rotation: [0, 0, -7 * slot], scale: 1 - 0.03 * slot },
    [0.4, 0.2, -0.3]),
  },
  {
    name: "spiral", group: "pages", title: "Спираль", minPages: 2, maxPages: 8,
    description: "страницы стоят на винтовой лестнице; лестница поворачивается и опускает следующую к зрителю",
    build: (options) => {
      const radius = 4.2;
      return turnTaking(options, (slot) => {
        const angle = (slot * Math.PI) / 3.4;
        return { position: [radius * Math.sin(angle), slot * 1.35, radius * Math.cos(angle) - radius], rotation: [0, degrees(angle), 0], scale: slot === 0 ? 1 : 0.9 };
      }, [0.5, 0.4, -0.2]);
    },
  },
  {
    name: "shuffle", group: "pages", title: "Перетасовка", minPages: 2, maxPages: 6,
    description: "верхняя страница отъезжает вправо и уходит в конец стопки, остальные подвигаются вперёд",
    build: (options) => turnTaking(options, (slot, count) =>
      slot < 0 ? { position: [0.28 * (count + slot), 0.2 * (count + slot), -0.9 * (count + slot) - 0.6], rotation: [0, -5, 0] } : { position: [0.28 * slot, 0.2 * slot, -0.9 * slot], rotation: [0, -5, 0] },
    [-0.5, 0.2, -0.2], "back"),
  },

  // --- pages stand together, the camera moves
  {
    name: "wall", group: "layout", title: "Стена", minPages: 2, maxPages: 8,
    description: "страницы стоят в ряд; камера проезжает вдоль и останавливается у каждой",
    build: (options) => tour(options, options.pages.map((_, index) => ({ position: [index * SCREEN_WIDTH * 1.18, 0, 0], rotation: ORIGIN })), { zoom: 0.62, yaw: 14, pitch: 5 }),
  },
  {
    name: "grid", group: "layout", title: "Сетка", minPages: 3, maxPages: 8,
    description: "страницы висят сеткой в два ряда; сначала общий план, потом камера подлетает к каждой",
    build: (options) => {
      const columns = Math.ceil(options.pages.length / 2);
      const [gapX, gapY] = [SCREEN_WIDTH * 1.15, SCREEN_HEIGHT * 1.22];
      const poses = options.pages.map((_, index): Pose => ({
        position: [centred(columns, index % columns) * gapX, (index < columns ? 0.5 : -0.5) * gapY, 0], rotation: ORIGIN,
      }));
      const distance = Math.max((columns * gapX) / 0.95, (2 * gapY) / 0.53) * 1.08;
      return tour(options, poses, { zoom: 0.7, yaw: 12, pitch: 6 }, { position: [0, 0.6, distance], lookAt: ORIGIN });
    },
  },
  {
    name: "arc", group: "layout", title: "Панорама", minPages: 2, maxPages: 7,
    description: "страницы стоят дугой вокруг зрителя; камера поворачивается от одной к другой",
    build: (options) => {
      const radius = 7;
      const step = Math.PI / 4.6;
      const poses = options.pages.map((_, index): Pose => {
        const angle = centred(options.pages.length, index) * step;
        return { position: [radius * Math.sin(angle), 0, -radius * Math.cos(angle)], rotation: [0, -degrees(angle), 0] };
      });
      const { pages, hold, move } = options;
      const keyframes: CameraKeys = [];
      poses.forEach((pose, index) => {
        const start = index * (hold + move);
        keyframes.push({ at: start, position: [0, 0.15, 0.6], lookAt: vec(pose.position), ease: "inOut" }, { at: start + hold, position: [0, 0.15, 0.2], lookAt: vec(pose.position) });
      });
      const objects = pages.map((media, index) => ({ id: `page${index + 1}`, device: options.device, media, width: SCREEN_WIDTH, position: vec(poses[index].position), rotation: vec(poses[index].rotation) }));
      return scene(options, pages.length * hold + (pages.length - 1) * move, objects, keyframes);
    },
  },
  {
    name: "cascade", group: "layout", title: "Каскад", minPages: 2, maxPages: 6,
    description: "страницы стоят лесенкой по диагонали вглубь; камера медленно объезжает их сбоку",
    build: (options) => {
      const count = options.pages.length;
      const duration = Math.max(4, options.hold * count);
      const objects = options.pages.map((media, index) => ({
        id: `page${index + 1}`, device: options.device, media, width: SCREEN_WIDTH,
        position: vec([centred(count, index) * 1.7, -centred(count, index) * 0.55, -index * 1.7]), rotation: [0, -26, 0] as Vec3,
      }));
      const centre: Vec3 = [0, 0, -((count - 1) * 1.7) / 2];
      return scene(options, duration, objects, [
        { at: 0, position: [-4.6, 1.3, 7.4], lookAt: centre },
        { at: duration, position: [-1.2, 0.8, 8.4], lookAt: centre, ease: "inOut" },
      ]);
    },
  },
  {
    name: "layers", group: "layout", title: "Слои", minPages: 2, maxPages: 6,
    description: "страницы лежат плашмя одна над другой и раздвигаются, как слои в разрезе",
    build: (options) => {
      const count = options.pages.length;
      const duration = Math.max(4.5, options.hold * 2.5);
      const tilt: Vec3 = [-62, 0, 34];
      const objects = options.pages.map((media, index) => ({
        id: `page${index + 1}`, device: "screen" as StageDevice, media, width: SCREEN_WIDTH,
        position: vec([0, centred(count, index) * 0.12, 0]), rotation: tilt,
        keyframes: [{ at: 0.4, position: vec([0, centred(count, index) * 0.12, 0]) }, { at: round(duration * 0.55), position: vec([0, centred(count, index) * 1.25, 0]), ease: "out" as const }],
      }));
      return scene(options, duration, objects, [
        { at: 0, position: [0.5, 2.2, 9.4], lookAt: ORIGIN },
        { at: duration, position: [-0.8, 1.6, 8.8], lookAt: ORIGIN, ease: "inOut" },
      ]);
    },
  },
  {
    name: "duo", group: "layout", title: "Ноутбук и телефон", minPages: 2, maxPages: 2,
    description: "десктопная версия на ноутбуке и мобильная на телефоне рядом; камера медленно обходит их",
    build: (options) => {
      const duration = Math.max(4, options.hold * 3);
      return scene(options, duration, [
        { id: "desktop", device: "laptop", media: options.pages[0], position: [-0.75, 0.1, 0], rotation: [0, 16, 0], keyframes: [{ at: duration, position: [-0.75, 0.18, 0], rotation: [0, 10, 0], ease: "inOut" }] },
        { id: "mobile", device: "phone", media: options.pages[1], position: [1.75, 0.05, 0.9], rotation: [0, -22, 2], keyframes: [{ at: duration, position: [1.75, 0.15, 0.9], rotation: [0, -14, 0], ease: "inOut" }] },
      ], [
        { at: 0, position: [-1.6, 0.9, 8.2], lookAt: [0.3, 0, 0] },
        { at: duration, position: [1.5, 0.6, 7.4], lookAt: [0.3, 0, 0], ease: "inOut" },
      ]);
    },
  },
  {
    name: "trio", group: "layout", title: "Три устройства", minPages: 3, maxPages: 3,
    description: "окно браузера, ноутбук и телефон вместе: три экрана одного продукта",
    build: (options) => {
      const duration = Math.max(4.5, options.hold * 3);
      return scene(options, duration, [
        { id: "browser", device: "browser", media: options.pages[0], width: 3.4, position: [-3.4, 0.5, -1.6], rotation: [0, 26, 0] },
        { id: "desktop", device: "laptop", media: options.pages[1], position: [0.1, -0.1, 0], rotation: [0, -4, 0] },
        { id: "mobile", device: "phone", media: options.pages[2], position: [2.5, 0, 1], rotation: [0, -24, 2] },
      ], [
        { at: 0, position: [1.8, 0.9, 9.2], lookAt: [-0.2, 0.1, 0] },
        { at: duration, position: [-1.6, 0.7, 8.6], lookAt: [-0.2, 0.1, 0], ease: "inOut" },
      ]);
    },
  },
  {
    name: "phone-row", group: "layout", title: "Ряд телефонов", minPages: 2, maxPages: 5,
    description: "мобильные экраны в ряд телефонов, развёрнутых к центру; телефоны по очереди приподнимаются",
    build: (options) => {
      const count = options.pages.length;
      const duration = Math.max(4, count * options.hold);
      const objects = options.pages.map((media, index) => {
        const offset = centred(count, index);
        const base: Vec3 = [offset * 1.95, 0, -Math.abs(offset) * 0.5];
        const beat = (duration / count) * index;
        return {
          id: `page${index + 1}`, device: "phone" as StageDevice, media, position: vec(base), rotation: vec([0, -offset * 13, 0]),
          keyframes: [
            { at: round(beat), position: vec(base) },
            { at: round(beat + duration / count / 2), position: vec([base[0], 0.32, base[2] + 0.35]), ease: "out" as const },
            { at: round(beat + duration / count), position: vec(base), ease: "inOut" as const },
          ],
        };
      });
      return scene(options, duration, objects, drifting(duration, [-0.8, 0.5, 8.4], [1.6, -0.1, -0.4]));
    },
  },

  // --- one page
  {
    name: "reveal", group: "single", title: "Появление", minPages: 1, maxPages: 1,
    description: "окно влетает из глубины под углом и встаёт перед зрителем с пружинкой",
    build: (options) => single(options, (duration) => ({
      start: { position: [0.6, -0.9, -4], rotation: [16, -42, -4], scale: 0.8 },
      keyframes: [{ at: 1.4, position: ORIGIN, rotation: ORIGIN, scale: 1, ease: "back" }],
      camera: drifting(duration, [0, 0.2, 7.2], [0.5, 0.1, -0.6]),
    })),
  },
  {
    name: "orbit", group: "single", title: "Облёт", minPages: 1, maxPages: 1,
    description: "устройство стоит на месте, камера облетает его по дуге слева направо",
    build: (options) => single(options, (duration) => {
      const radius = 7.8;
      const at = (degree: number): Vec3 => vec([radius * Math.sin((degree * Math.PI) / 180), 0.7, radius * Math.cos((degree * Math.PI) / 180)]);
      return {
        start: still, keyframes: [],
        camera: [{ at: 0, position: at(-34), lookAt: ORIGIN }, { at: duration / 2, position: at(0), lookAt: ORIGIN, ease: "linear" }, { at: duration, position: at(34), lookAt: ORIGIN, ease: "linear" }],
      };
    }),
  },
  {
    name: "float", group: "single", title: "Парение", minPages: 1, maxPages: 1,
    description: "устройство висит в воздухе и плавно покачивается",
    build: (options) => single(options, (duration) => {
      const quarter = duration / 4;
      const sway = (at: number, y: number, pitch: number, yaw: number): TransformKey => ({ at, position: [0, y, 0], rotation: [pitch, yaw, 0], ease: "inOut" });
      return {
        start: { position: [0, -0.08, 0], rotation: [2, -12, 0] },
        keyframes: [sway(quarter, 0.1, -1, -6), sway(quarter * 2, -0.06, 2, 4), sway(quarter * 3, 0.1, -1, 10), sway(duration, -0.04, 1, 14)],
        camera: drifting(duration, [0, 0.3, 7.6], [0, 0, -0.3]),
      };
    }),
  },
  {
    name: "push-in", group: "single", title: "Наезд", minPages: 1, maxPages: 1,
    description: "камера начинает с общего плана сбоку и подъезжает вплотную к экрану",
    build: (options) => single(options, (duration) => ({
      start: still, keyframes: [],
      camera: [
        { at: 0, focus: { object: "app", zoom: 0.6, yaw: -22, pitch: 9 } },
        { at: duration * 0.75, focus: { object: "app", zoom: 1.25, yaw: 6, pitch: 3 }, ease: "inOut" },
        { at: duration, focus: { object: "app", zoom: 1.32, yaw: 9, pitch: 3 }, ease: "linear" },
      ],
    })),
  },
  {
    name: "flyover", group: "single", title: "Пролёт над столом", minPages: 1, maxPages: 1,
    description: "экран лежит плашмя, камера летит над ним; затем экран поднимается и встаёт лицом к зрителю",
    build: (options) => single(options, (duration) => ({
      start: { position: [0, -0.9, 0.4], rotation: [-74, 0, 0] },
      keyframes: [{ at: duration * 0.45, position: [0, -0.9, 0.4], rotation: [-74, 0, 0] }, { at: duration * 0.8, position: ORIGIN, rotation: ORIGIN, ease: "out" }],
      camera: [
        { at: 0, position: [-1.8, 0.9, 5.2], lookAt: [0, -0.9, 0] },
        { at: duration * 0.45, position: [1.2, 1.1, 5.6], lookAt: [0, -0.8, 0], ease: "inOut" },
        { at: duration * 0.8, position: [0, 0.2, 7.3], lookAt: ORIGIN, ease: "inOut" },
        { at: duration, position: [0.3, 0.2, 7], lookAt: ORIGIN, ease: "linear" },
      ],
    })),
  },
  {
    name: "spin-in", group: "single", title: "Раскрутка", minPages: 1, maxPages: 1,
    description: "маленькое окно вылетает из центра, делает оборот и вырастает до полного размера",
    build: (options) => single(options, (duration) => ({
      start: { position: [0, 0, -2], rotation: [0, -360, 0], scale: 0.25 },
      keyframes: [{ at: 1.7, position: ORIGIN, rotation: ORIGIN, scale: 1, ease: "out" }],
      camera: drifting(duration, [0, 0.2, 7.3], [-0.5, 0.1, -0.5]),
    })),
  },
  {
    name: "pendulum", group: "single", title: "Маятник", minPages: 1, maxPages: 1,
    description: "окно качается из стороны в сторону вокруг вертикальной оси, показывая себя с обеих сторон",
    build: (options) => single(options, (duration) => {
      const swing = (at: number, yaw: number): TransformKey => ({ at, rotation: [0, yaw, 0], ease: "inOut" });
      return {
        start: { position: ORIGIN, rotation: [0, -30, 0] },
        keyframes: [swing(duration / 3, 26), swing((duration * 2) / 3, -18), swing(duration, 0)],
        camera: drifting(duration, [0, 0.35, 7.6], [0, -0.1, -0.5]),
      };
    }),
  },
];

export const listSceneTemplates = (): SceneTemplate[] => TEMPLATES;

export function findSceneTemplate(name: string): SceneTemplate {
  const template = TEMPLATES.find((t) => t.name === name);
  if (!template) throw new UsageError(`Шаблон сцены «${name}» не найден. Доступны: ${TEMPLATES.map((t) => t.name).join(", ")}`);
  return template;
}

export const pagesRange = (template: SceneTemplate) =>
  template.minPages === template.maxPages ? `ровно ${template.minPages}` : `от ${template.minPages} до ${template.maxPages}`;

export function buildFromTemplate(name: string, options: TemplateOptions): Scene {
  const template = findSceneTemplate(name);
  const count = options.pages.length;
  if (count < template.minPages || count > template.maxPages) {
    throw new UsageError(`Шаблону «${name}» нужно страниц: ${pagesRange(template)}; передано ${count} (--pages a.png,b.png,…)`);
  }
  return template.build(options);
}

/** A moment of the scene worth a still: in the middle of the first change of page, or two thirds into a single shot. */
export function previewMoment(template: SceneTemplate, options: TemplateOptions, scene: Scene): number {
  if (template.group === "pages") return round(options.hold + options.move * 0.45);
  return round(scene.output.duration * (template.group === "single" ? 0.3 : 0.5));
}
