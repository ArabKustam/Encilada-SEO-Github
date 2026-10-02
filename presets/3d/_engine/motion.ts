/**
 * Pure animation math for directed scenes: easing, keyframed transforms, click effects.
 * No three.js and no React here, so everything is unit-testable in Node.
 */
import type { Vec3 } from "./types.js";

export const EASINGS = ["linear", "in", "out", "inOut", "back"] as const;
export type Ease = (typeof EASINGS)[number];

const BACK_OVERSHOOT = 1.70158;

export const EASE: Record<Ease, (p: number) => number> = {
  linear: (p) => p,
  in: (p) => p * p * p,
  out: (p) => 1 - Math.pow(1 - p, 3),
  inOut: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
  // Overshoots slightly past the target and settles: reads as something springing into place.
  back: (p) => 1 + (BACK_OVERSHOOT + 1) * Math.pow(p - 1, 3) + BACK_OVERSHOOT * Math.pow(p - 1, 2),
};

const clamp01 = (p: number) => Math.min(1, Math.max(0, p));
const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
const lerp3 = (a: Vec3, b: Vec3, p: number): Vec3 => [lerp(a[0], b[0], p), lerp(a[1], b[1], p), lerp(a[2], b[2], p)];

export type Transform = { position: Vec3; rotation: Vec3; scale: number };

export type TransformKey = { at: number; position?: Vec3; rotation?: Vec3; scale?: number; ease?: Ease };

/**
 * Transform of an object at time `t`. A keyframe only needs to mention what changes;
 * everything else carries over from the previous keyframe (or from the object's base transform).
 */
export function transformAt(base: Transform, keys: TransformKey[], t: number): Transform {
  const sorted = [...keys].sort((a, b) => a.at - b.at);
  let previous: Transform & { at: number } = { at: 0, ...base };
  for (const key of sorted) {
    const next: Transform & { at: number } = {
      at: key.at,
      position: key.position ?? previous.position,
      rotation: key.rotation ?? previous.rotation,
      scale: key.scale ?? previous.scale,
    };
    if (t <= key.at) {
      const span = key.at - previous.at;
      const p = EASE[key.ease ?? "inOut"](span <= 0 ? 1 : clamp01((t - previous.at) / span));
      return { position: lerp3(previous.position, next.position, p), rotation: lerp3(previous.rotation, next.rotation, p), scale: lerp(previous.scale, next.scale, p) };
    }
    previous = next;
  }
  return { position: previous.position, rotation: previous.rotation, scale: previous.scale };
}

/** Index of the keyframe segment `t` falls into, and eased progress through it. */
export function segmentAt<K extends { at: number; ease?: Ease }>(keys: K[], t: number): { from: K; to: K; progress: number } {
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (t <= first.at) return { from: first, to: first, progress: 1 };
  if (t >= last.at) return { from: last, to: last, progress: 1 };
  const index = keys.findIndex((k) => k.at > t);
  const from = keys[index - 1];
  const to = keys[index];
  return { from, to, progress: EASE[to.ease ?? "inOut"](clamp01((t - from.at) / (to.at - from.at))) };
}

/** Timing of the "pop-out": an element lifts off the screen before a click, is pressed, springs back, then settles. */
export const POP = { leadIn: 0.5, press: 0.09, release: 0.22, hold: 0.35, settle: 0.45, pressedDepth: 0.2 };

/** How far a clicked element floats above the screen at time `t`, from 0 (flat) to 1 (fully lifted). */
export function popLift(t: number, clickAt: number): number {
  const dt = t - clickAt;
  if (dt < -POP.leadIn || dt > POP.press + POP.release + POP.hold + POP.settle) return 0;
  if (dt < 0) return EASE.out(clamp01((dt + POP.leadIn) / (POP.leadIn * 0.8)));
  if (dt < POP.press) return lerp(1, POP.pressedDepth, EASE.out(dt / POP.press));
  if (dt < POP.press + POP.release) return lerp(POP.pressedDepth, 1, EASE.back((dt - POP.press) / POP.release));
  if (dt < POP.press + POP.release + POP.hold) return 1;
  return 1 - EASE.inOut((dt - POP.press - POP.release - POP.hold) / POP.settle);
}

/** Small deterministic generator: the same seed always gives the same sparks, so renders are reproducible. */
function random(seed: number): () => number {
  let state = (seed * 2654435761) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let x = Math.imul(state ^ (state >>> 15), 1 | state);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export const SPARK_SECONDS = 0.75;
const SPARK_GRAVITY = 2.6;

export type Spark = { direction: Vec3; speed: number; size: number; life: number; color: number };

/** A burst of sparks flying up and out of the screen. Speeds and sizes are in units of the burst's `scale`. */
export function sparkBurst(seed: number, count: number): Spark[] {
  const next = random(seed + 1);
  return Array.from({ length: count }, () => {
    const angle = next() * Math.PI * 2;
    const spread = 0.35 + next() * 0.65;
    return {
      direction: [Math.cos(angle) * spread, Math.sin(angle) * spread, 0.35 + next() * 0.65] as Vec3,
      speed: 0.7 + next() * 1.1,
      size: 0.5 + next() * 0.7,
      life: 0.55 + next() * 0.45,
      color: Math.floor(next() * 1000),
    };
  });
}

/** Where a spark is `age` seconds after the burst, and how visible it still is; null once it has burnt out. */
export function sparkAt(spark: Spark, age: number): { offset: Vec3; opacity: number; size: number } | null {
  const lifetime = SPARK_SECONDS * spark.life;
  if (age < 0 || age > lifetime) return null;
  const p = age / lifetime;
  // Fast at first, slowing down as if through air; gravity pulls the spark down along the screen.
  const travelled = spark.speed * (1 - Math.pow(1 - p, 2)) * lifetime * 1.4;
  return {
    offset: [spark.direction[0] * travelled, spark.direction[1] * travelled - 0.5 * SPARK_GRAVITY * age * age * 0.25, spark.direction[2] * travelled],
    opacity: 1 - p * p,
    size: spark.size * (1 - 0.6 * p),
  };
}
