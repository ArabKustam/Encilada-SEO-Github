/** Pure helpers for human-like pointer and scroll motion. */

export interface Point {
  x: number;
  y: number;
}

const STEP_MS = 16;
const MIN_MOVE_MS = 300;
const MAX_MOVE_MS = 900;
const MS_PER_PIXEL = 0.6;
/** How far the path bows away from a straight line, as a fraction of its length. */
const CURVE = 0.08;

export const easeInOutCubic = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

/** How long a pointer move of this distance should take at human pace. */
export function moveDuration(from: Point, to: Point): number {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  return Math.round(Math.min(MAX_MOVE_MS, Math.max(MIN_MOVE_MS, 250 + distance * MS_PER_PIXEL)));
}

/**
 * Points along an eased, slightly curved path from `from` to `to`, one per ~16 ms.
 * Deterministic: the same endpoints always give the same path.
 */
export function pointerPath(from: Point, to: Point): Point[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 1) return [to];
  const steps = Math.max(2, Math.round(moveDuration(from, to) / STEP_MS));
  // Control point offset perpendicular to the path gives a gentle arc.
  const control = { x: from.x + dx / 2 - dy * CURVE, y: from.y + dy / 2 + dx * CURVE };
  const points: Point[] = [];
  for (let i = 1; i <= steps; i++) {
    const p = easeInOutCubic(i / steps);
    const q = 1 - p;
    points.push({
      x: q * q * from.x + 2 * q * p * control.x + p * p * to.x,
      y: q * q * from.y + 2 * q * p * control.y + p * p * to.y,
    });
  }
  return points;
}

/** Wheel deltas for a smooth scroll of `total` pixels, summing exactly to `total`. */
export function scrollDeltas(total: number, steps = 30): number[] {
  const deltas: number[] = [];
  let done = 0;
  for (let i = 1; i <= steps; i++) {
    const target = Math.round(total * easeInOutCubic(i / steps));
    deltas.push(target - done);
    done = target;
  }
  return deltas.filter((d) => d !== 0);
}

export const STEP_INTERVAL_MS = STEP_MS;
