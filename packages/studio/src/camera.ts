/**
 * Auto-zoom: turns the capture event log into camera keyframes.
 * Pure functions — shared by the Node side (planning) and the Remotion composition (rendering).
 */

export interface TimedEvent {
  t: number;
  type: string;
  x?: number;
  y?: number;
  duration?: number;
}

export interface Keyframe {
  /** Seconds on the source recording clock. */
  t: number;
  scale: number;
  /** Centre of the view in source CSS pixels. */
  x: number;
  y: number;
}

export interface CameraOptions {
  width: number;
  height: number;
  /** Zoom factor while following an interaction. */
  scale?: number;
}

/** Seconds the camera arrives before an interaction, and lingers after it. */
const LEAD = 0.5;
const HOLD = 1.3;
/** Duration of a zoom in or out. */
const TRANSITION = 0.7;
/** Minimum time for a pan between two nearby interactions. */
const PAN = 0.45;
/** Interactions closer than this stay in one zoomed shot instead of zooming out and back in. */
const MERGE_GAP = 1.6;
const MIN_SEGMENT = 0.3;
const DEFAULT_SCALE = 1.8;
/** Fraction of the half-view around the centre where an interaction needs no camera move. */
const SAFE_ZONE = 0.55;
const FOCUS_TYPES = new Set(["click", "type", "hover"]);
/** Events during which a zoomed view would be disorienting: [seconds before, seconds after]. */
const OVERVIEW_TYPES: Record<string, [number, number]> = { scroll: [0.2, 0.3], nav: [0.1, 0.5] };

interface Segment {
  start: number;
  end: number;
  x: number;
  y: number;
}

export const easeInOutCubic = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function focusSegments(events: TimedEvent[], duration: number): Segment[] {
  let segments: Segment[] = events
    .filter((e) => FOCUS_TYPES.has(e.type) && e.x !== undefined && e.y !== undefined)
    .map((e) => ({ start: Math.max(0, e.t - LEAD), end: Math.min(duration, e.t + (e.duration ?? 0) + HOLD), x: e.x!, y: e.y! }));

  for (const event of events) {
    const padding = OVERVIEW_TYPES[event.type];
    if (!padding || event.t === 0) continue;
    const from = event.t - padding[0];
    const to = event.t + (event.duration ?? 0) + padding[1];
    for (const segment of segments) {
      if (segment.start < from && from < segment.end) segment.end = from;
      else if (from <= segment.start && segment.start < to) segment.start = to;
    }
  }
  segments = segments.filter((s) => s.end - s.start >= MIN_SEGMENT).sort((a, b) => a.start - b.start);
  return segments;
}

/**
 * Camera keyframes for a recording: an overview at rest, zooming in on each
 * cluster of interactions and panning between interactions inside a cluster.
 */
export function buildCamera(events: TimedEvent[], duration: number, options: CameraOptions): Keyframe[] {
  const scale = options.scale ?? DEFAULT_SCALE;
  const overview = { scale: 1, x: options.width / 2, y: options.height / 2 };
  const halfW = options.width / (2 * scale);
  const halfH = options.height / (2 * scale);
  // Keep the zoomed view inside the frame so no empty border is ever shown.
  const inFrame = (x: number, y: number) => ({ scale, x: clamp(x, halfW, options.width - halfW), y: clamp(y, halfH, options.height - halfH) });
  let current: { x: number; y: number } | null = null;
  /**
   * View for a segment. Inside a zoomed shot the camera moves only as far as needed
   * to bring the interaction into the central safe zone, instead of re-centring on every click.
   */
  const zoomed = (s: Segment, continuing: boolean) => {
    const centre = continuing && current
      ? { x: clamp(current.x, s.x - halfW * SAFE_ZONE, s.x + halfW * SAFE_ZONE), y: clamp(current.y, s.y - halfH * SAFE_ZONE, s.y + halfH * SAFE_ZONE) }
      : s;
    const view = inFrame(centre.x, centre.y);
    current = view;
    return view;
  };

  const keyframes: Keyframe[] = [{ t: 0, ...overview }];
  const push = (t: number, view: Omit<Keyframe, "t">) => {
    const last = keyframes[keyframes.length - 1];
    keyframes.push({ t: Math.max(t, last.t + 0.001), ...view });
  };
  const lastTime = () => keyframes[keyframes.length - 1].t;

  const segments = focusSegments(events, duration);
  if (scale <= 1 || segments.length === 0) return [...keyframes, { t: Math.max(duration, 0.001), ...overview }];

  segments.forEach((segment, index) => {
    const previous = segments[index - 1];
    const next = segments[index + 1];
    const joinsPrevious = previous !== undefined && segment.start - previous.end < MERGE_GAP;
    const joinsNext = next !== undefined && next.start - segment.end < MERGE_GAP;

    const view = zoomed(segment, joinsPrevious);
    if (joinsPrevious) {
      push(Math.max(segment.start, lastTime() + PAN), view);
    } else {
      push(Math.max(lastTime(), segment.start - TRANSITION), overview);
      push(segment.start, view);
    }
    // Leave early enough to reach the next interaction before it happens.
    push(joinsNext ? Math.min(segment.end, next.start - PAN) : segment.end, view);
    if (!joinsNext) push(lastTime() + TRANSITION, overview);
  });

  if (lastTime() < duration) push(duration, overview);
  return keyframes;
}

/** Camera view at a moment in time, eased between the surrounding keyframes. */
export function cameraAt(keyframes: Keyframe[], t: number): Omit<Keyframe, "t"> {
  const first = keyframes[0];
  const last = keyframes[keyframes.length - 1];
  if (t <= first.t) return first;
  if (t >= last.t) return last;
  const index = keyframes.findIndex((k) => k.t > t);
  const from = keyframes[index - 1];
  const to = keyframes[index];
  const p = easeInOutCubic((t - from.t) / (to.t - from.t));
  const mix = (a: number, b: number) => a + (b - a) * p;
  return { scale: mix(from.scale, to.scale), x: mix(from.x, to.x), y: mix(from.y, to.y) };
}

export interface CursorSample {
  t: number;
  x: number;
  y: number;
}

/** Pointer position at a moment in time, or null when the recording has no pointer data. */
export function cursorAt(samples: CursorSample[], t: number): { x: number; y: number } | null {
  if (samples.length === 0) return null;
  if (t <= samples[0].t) return samples[0];
  const last = samples[samples.length - 1];
  if (t >= last.t) return last;
  let low = 0;
  let high = samples.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (samples[mid].t <= t) low = mid;
    else high = mid;
  }
  const from = samples[low];
  const to = samples[high];
  const p = to.t === from.t ? 1 : (t - from.t) / (to.t - from.t);
  return { x: from.x + (to.x - from.x) * p, y: from.y + (to.y - from.y) * p };
}

export const RIPPLE_SECONDS = 0.5;

/** Click ripples visible at time `t`, with progress from 0 (just clicked) to 1 (gone). */
export function ripplesAt(clicks: CursorSample[], t: number): { x: number; y: number; progress: number }[] {
  return clicks
    .filter((c) => t >= c.t && t - c.t <= RIPPLE_SECONDS)
    .map((c) => ({ x: c.x, y: c.y, progress: (t - c.t) / RIPPLE_SECONDS }));
}
