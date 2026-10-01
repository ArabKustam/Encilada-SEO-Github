import { describe, expect, it } from "vitest";
import { buildCamera, cameraAt, cursorAt, ripplesAt, type Keyframe, type TimedEvent } from "../src/camera.js";
import { gifLadder } from "../src/encode.js";

const VIEWPORT = { width: 1280, height: 720 };
const click = (t: number, x: number, y: number): TimedEvent => ({ t, type: "click", x, y });

function assertWellFormed(keyframes: Keyframe[], scale = 1.8) {
  const halfW = VIEWPORT.width / (2 * scale);
  const halfH = VIEWPORT.height / (2 * scale);
  for (const [index, k] of keyframes.entries()) {
    if (index > 0) expect(k.t).toBeGreaterThan(keyframes[index - 1].t);
    if (k.scale > 1) {
      // A zoomed view must never show anything outside the recorded frame.
      expect(k.x).toBeGreaterThanOrEqual(halfW - 1e-9);
      expect(k.x).toBeLessThanOrEqual(VIEWPORT.width - halfW + 1e-9);
      expect(k.y).toBeGreaterThanOrEqual(halfH - 1e-9);
      expect(k.y).toBeLessThanOrEqual(VIEWPORT.height - halfH + 1e-9);
    }
  }
}

describe("buildCamera", () => {
  it("stays on the overview when nothing is interacted with", () => {
    const keyframes = buildCamera([{ t: 0, type: "nav" }], 5, VIEWPORT);
    expect(keyframes.every((k) => k.scale === 1)).toBe(true);
    expect(cameraAt(keyframes, 2.5)).toMatchObject({ scale: 1, x: 640, y: 360 });
  });

  it("zooms in on a click and returns to the overview afterwards", () => {
    const keyframes = buildCamera([click(3, 640, 360)], 10, VIEWPORT);
    assertWellFormed(keyframes);
    expect(cameraAt(keyframes, 0).scale).toBe(1);
    expect(cameraAt(keyframes, 3)).toMatchObject({ scale: 1.8, x: 640, y: 360 });
    expect(cameraAt(keyframes, 9).scale).toBe(1);
  });

  it("arrives before the click happens", () => {
    const keyframes = buildCamera([click(3, 640, 360)], 10, VIEWPORT);
    expect(cameraAt(keyframes, 2.6).scale).toBeCloseTo(1.8);
  });

  it("keeps one zoomed shot for clicks that follow each other closely", () => {
    const keyframes = buildCamera([click(2, 400, 300), click(3.5, 420, 310), click(5, 900, 320)], 12, VIEWPORT);
    assertWellFormed(keyframes);
    for (const t of [2, 2.8, 3.5, 4.2, 5]) expect(cameraAt(keyframes, t).scale).toBeCloseTo(1.8);
  });

  it("does not move for a nearby click, and moves only as far as needed for a distant one", () => {
    const keyframes = buildCamera([click(2, 600, 300), click(3.5, 650, 310), click(5, 1000, 320)], 12, VIEWPORT);
    const first = cameraAt(keyframes, 2);
    expect(cameraAt(keyframes, 3.5)).toEqual(first);
    const third = cameraAt(keyframes, 5);
    expect(third.x).toBeGreaterThan(first.x);
    expect(third.x).toBeLessThan(1000);
  });

  it("zooms out between clicks that are far apart in time", () => {
    const keyframes = buildCamera([click(2, 400, 300), click(9, 800, 300)], 14, VIEWPORT);
    assertWellFormed(keyframes);
    expect(cameraAt(keyframes, 5.5).scale).toBe(1);
    expect(cameraAt(keyframes, 9).scale).toBeCloseTo(1.8);
  });

  it("clamps the view at the edges of the frame", () => {
    assertWellFormed(buildCamera([click(2, 5, 5), click(6, 1275, 715)], 10, VIEWPORT));
  });

  it("holds the zoom while text is being typed", () => {
    const keyframes = buildCamera([{ t: 2, type: "type", x: 600, y: 140, duration: 3 }], 10, VIEWPORT);
    expect(cameraAt(keyframes, 4.9).scale).toBeCloseTo(1.8);
  });

  it("returns to the overview for a scroll", () => {
    const keyframes = buildCamera([click(2, 600, 300), { t: 3, type: "scroll", duration: 0.6 }, click(5, 600, 500)], 10, VIEWPORT);
    assertWellFormed(keyframes);
    expect(cameraAt(keyframes, 3.3).scale).toBeLessThan(1.8);
  });

  it("can be switched off with scale 1", () => {
    expect(buildCamera([click(3, 640, 360)], 10, { ...VIEWPORT, scale: 1 }).every((k) => k.scale === 1)).toBe(true);
  });
});

describe("cursor", () => {
  const samples = [{ t: 0, x: 0, y: 0 }, { t: 1, x: 100, y: 50 }, { t: 2, x: 100, y: 50 }];

  it("interpolates between samples and holds at the ends", () => {
    expect(cursorAt(samples, 0.5)).toEqual({ x: 50, y: 25 });
    expect(cursorAt(samples, -1)).toMatchObject({ x: 0, y: 0 });
    expect(cursorAt(samples, 9)).toMatchObject({ x: 100, y: 50 });
    expect(cursorAt([], 1)).toBeNull();
  });

  it("shows a ripple only for half a second after a click", () => {
    const clicks = [{ t: 1, x: 10, y: 10 }];
    expect(ripplesAt(clicks, 0.9)).toEqual([]);
    expect(ripplesAt(clicks, 1.25)[0].progress).toBeCloseTo(0.5);
    expect(ripplesAt(clicks, 1.6)).toEqual([]);
  });
});

describe("gifLadder", () => {
  it("goes from best quality to smallest and never upscales", () => {
    const ladder = gifLadder(640, 12);
    expect(ladder[0]).toEqual({ width: 640, fps: 12, colors: 256 });
    expect(ladder.every((v) => v.width <= 640 && v.fps <= 12)).toBe(true);
    for (let i = 1; i < ladder.length; i++) {
      expect(ladder[i].width * ladder[i].fps * ladder[i].colors).toBeLessThanOrEqual(ladder[i - 1].width * ladder[i - 1].fps * ladder[i - 1].colors);
    }
  });
});
