import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { validate } from "@repokit/core";
import { EASE, popLift, POP, segmentAt, sparkAt, sparkBurst, transformAt, type Transform } from "@repokit/presets/motion";
import { resolveScene, starterScene, type Scene } from "../src/scene.js";

const FIXTURES = fileURLToPath(new URL("../../../tests/fixtures/slots/", import.meta.url));
const hasFfprobe = spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0;

describe("motion", () => {
  const base: Transform = { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 };

  it("keeps an object still when it has no keyframes", () => {
    expect(transformAt(base, [], 3)).toEqual(base);
  });

  it("moves between keyframes, carrying over what a keyframe does not mention", () => {
    const keys = [{ at: 2, position: [4, 0, 0] as [number, number, number], ease: "linear" as const }, { at: 4, scale: 2, ease: "linear" as const }];
    expect(transformAt(base, keys, 1).position).toEqual([2, 0, 0]);
    expect(transformAt(base, keys, 2)).toEqual({ position: [4, 0, 0], rotation: [0, 0, 0], scale: 1 });
    // The second keyframe only scales: the position reached earlier stays.
    expect(transformAt(base, keys, 3)).toEqual({ position: [4, 0, 0], rotation: [0, 0, 0], scale: 1.5 });
    expect(transformAt(base, keys, 99).scale).toBe(2);
  });

  it("orders keyframes by time whatever order they are written in", () => {
    const keys = [{ at: 4, scale: 3, ease: "linear" as const }, { at: 2, scale: 2, ease: "linear" as const }];
    expect(transformAt(base, keys, 3).scale).toBe(2.5);
  });

  it("starts and ends every easing exactly, and lets `back` overshoot", () => {
    for (const ease of Object.values(EASE)) {
      expect(ease(0)).toBeCloseTo(0);
      expect(ease(1)).toBeCloseTo(1);
    }
    expect(Math.max(...[0.6, 0.7, 0.8, 0.9].map(EASE.back))).toBeGreaterThan(1);
  });

  it("finds the camera segment for a moment in time", () => {
    const keys = [{ at: 1 }, { at: 3, ease: "linear" as const }];
    expect(segmentAt(keys, 0)).toMatchObject({ from: keys[0], to: keys[0] });
    expect(segmentAt(keys, 2)).toMatchObject({ from: keys[0], to: keys[1], progress: 0.5 });
    expect(segmentAt(keys, 9)).toMatchObject({ from: keys[1], to: keys[1] });
  });

  it("lifts a clicked element before the click, presses it at the click and puts it back afterwards", () => {
    const click = 5;
    expect(popLift(click - POP.leadIn - 0.1, click)).toBe(0);
    expect(popLift(click - 0.05, click)).toBeCloseTo(1);
    // Just after the click the element is pushed most of the way down…
    expect(popLift(click + POP.press, click)).toBeCloseTo(POP.pressedDepth);
    // …then springs back up and finally settles into the page.
    expect(popLift(click + POP.press + POP.release + 0.1, click)).toBe(1);
    expect(popLift(click + 5, click)).toBe(0);
  });

  it("produces the same sparks for the same seed, and different ones for another", () => {
    expect(sparkBurst(3, 20)).toEqual(sparkBurst(3, 20));
    expect(sparkBurst(3, 20)).not.toEqual(sparkBurst(4, 20));
    expect(sparkBurst(3, 20)).toHaveLength(20);
  });

  it("sends sparks out of the screen and lets them burn out", () => {
    const [spark] = sparkBurst(1, 1);
    expect(sparkAt(spark, -0.1)).toBeNull();
    const early = sparkAt(spark, 0.05)!;
    const late = sparkAt(spark, 0.3)!;
    expect(late.offset[2]).toBeGreaterThan(early.offset[2]);
    expect(late.opacity).toBeLessThan(early.opacity);
    expect(sparkAt(spark, 5)).toBeNull();
  });
});

describe("scene schema", () => {
  const minimal: Scene = { schemaVersion: 1, output: { duration: 3 }, objects: [{ id: "app", device: "browser", media: "screen.png" }] };

  it("accepts a minimal scene and the generated starter scene", () => {
    expect(validate("scene", minimal)).toEqual({ valid: true, errors: [] });
    expect(validate("scene", starterScene("video.mp4", "events.json", "laptop", 9.5)).valid).toBe(true);
  });

  it("rejects unknown devices, effects and properties", () => {
    expect(validate("scene", { ...minimal, objects: [{ id: "app", device: "hologram", media: "a.png" }] }).valid).toBe(false);
    expect(validate("scene", { ...minimal, effects: [{ type: "explosion", object: "app", at: 1, point: [1, 1] }] }).valid).toBe(false);
    expect(validate("scene", { ...minimal, sound: "boom.mp3" }).valid).toBe(false);
  });
});

describe.skipIf(!hasFfprobe)("resolveScene", () => {
  const repo = mkdtempSync(join(tmpdir(), "repokit-scene-"));
  afterAll(() => rmSync(repo, { recursive: true, force: true }));
  copyFileSync(join(FIXTURES, "pattern-16x10.png"), join(repo, "screen.png"));
  copyFileSync(join(FIXTURES, "pattern-16x10.mp4"), join(repo, "clip.mp4"));
  writeFileSync(join(repo, "events.json"), JSON.stringify({
    schemaVersion: 1, viewport: { width: 640, height: 400, deviceScaleFactor: 1 }, duration: 2, fps: 30,
    events: [
      { t: 0, type: "nav", url: "/" },
      { t: 0.2, type: "move", x: 100, y: 100 },
      { t: 1, type: "click", x: 320, y: 200, selector: "#go", box: { x: 280, y: 180, width: 80, height: 40 } },
    ],
  }));
  const scene = (patch: Partial<Scene> = {}): Scene => ({
    schemaVersion: 1,
    output: { duration: 1.8 },
    objects: [{ id: "app", device: "browser", media: "clip.mp4", events: "events.json", effects: { popOut: true, sparks: true } }],
    ...patch,
  });

  it("plans a camera that pushes in on the click when asked to follow automatically", async () => {
    const { props } = await resolveScene(repo, scene({ camera: { auto: { object: "app", zoom: 2, wide: 0.8 } } }));
    const zooms = props.camera.keys.map((k) => k.focus!.zoom);
    expect(Math.min(...zooms)).toBeCloseTo(0.8);
    expect(Math.max(...zooms)).toBeCloseTo(1.6);
    // While pushed in, the camera looks at the place that was clicked.
    expect(props.camera.keys.find((k) => k.focus!.zoom > 1)!.focus!.point).toEqual([320, 200]);
  });

  it("puts clicks, their element boxes and the cursor path on the scene clock", async () => {
    const { props } = await resolveScene(repo, scene({ objects: [{ id: "app", device: "browser", media: "clip.mp4", events: "events.json", mediaStart: 0.5, effects: { popOut: true } }], output: { duration: 1.2 } }));
    const [object] = props.objects;
    expect(object.clicks).toEqual([{ t: 0.5, x: 320, y: 200, box: [280, 180, 80, 40] }]);
    expect(object.cursor.map((c) => c.t)).toEqual([-0.3, 0.5]);
    expect(object.media).toMatchObject({ kind: "video", startFrame: 15, viewWidth: 640, viewHeight: 400 });
    expect(object.effects).toEqual({ ripple: true, sparks: false, popOut: true });
  });

  it("honours a hand-written camera and hand-placed effects", async () => {
    const { props, warnings } = await resolveScene(repo, scene({
      camera: { keyframes: [{ at: 1.5, focus: { object: "app", point: [320, 200], zoom: 3 } }, { at: 0, focus: { object: "app" } }] },
      effects: [{ type: "sparks", object: "app", at: 1, point: [10, 10] }, { type: "popOut", object: "app", box: [0, 0, 50, 20], from: 0.2, to: 1 }],
    }));
    expect(props.camera.keys.map((k) => [k.at, k.focus!.zoom])).toEqual([[0, 1], [1.5, 3]]);
    expect(props.effects).toHaveLength(2);
    expect(warnings.filter((w) => !w.includes("происхождение"))).toEqual([]);
  });

  it("refuses a scene longer than its recording", async () => {
    await expect(resolveScene(repo, scene({ output: { duration: 5 } }))).rejects.toThrow(/Уменьшите output.duration/);
  });

  it("refuses references to objects that are not in the scene", async () => {
    await expect(resolveScene(repo, scene({ camera: { keyframes: [{ at: 0, focus: { object: "phone" } }] } }))).rejects.toThrow(/объекта «phone» нет/);
    await expect(resolveScene(repo, scene({ effects: [{ type: "ripple", object: "nope", at: 1, point: [1, 1] }] }))).rejects.toThrow(/объекта «nope» нет/);
  });

  it("refuses missing media and duplicate ids", async () => {
    await expect(resolveScene(repo, scene({ objects: [{ id: "app", device: "phone", media: "missing.png" }] }))).rejects.toThrow(/файл не найден/);
    const twin = { id: "app", device: "screen" as const, media: "screen.png" };
    await expect(resolveScene(repo, scene({ objects: [twin, twin] }))).rejects.toThrow(/объявлен дважды/);
  });

  it("says so when effects are requested without an event log", async () => {
    const { warnings, props } = await resolveScene(repo, scene({ objects: [{ id: "app", device: "screen", media: "screen.png", effects: { sparks: true } }] }));
    expect(warnings.some((w) => w.includes("без лога событий"))).toBe(true);
    expect(props.objects[0].clicks).toEqual([]);
  });

  it("flags media that repokit did not record", async () => {
    const { warnings } = await resolveScene(repo, scene());
    expect(warnings.some((w) => w.includes("происхождение неизвестно"))).toBe(true);
  });
});
