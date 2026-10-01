import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { UsageError } from "@repokit/core";
import { aspectMismatch, cameraAtFrame, fitMedia, fovForAspect, parseAspect } from "@repokit/presets/path";
import { listPresets, resolvePreset } from "../src/presets.js";

const FIXTURES = fileURLToPath(new URL("../../../tests/fixtures/slots/", import.meta.url));
// Reading media dimensions needs ffprobe, which plain CI runners do not have.
const hasFfprobe = spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0;

describe("preset definitions", () => {
  const presets = listPresets();

  it("ships the first three presets, each valid against the schema", () => {
    expect(presets.map((p) => p.preset.name)).toEqual(["browser-tilt", "laptop-orbit", "phone-float"]);
  });

  it.each(presets.map((p) => [p.preset.name, p] as const))("%s has a preview and a camera move that fits its length", (_, info) => {
    const { preset } = info;
    expect(info.preview, "preview.gif is missing").not.toBeNull();
    const frames = preset.camera.keyframes.map((k) => k.frame);
    expect(frames).toEqual([...frames].sort((a, b) => a - b));
    expect(frames[frames.length - 1]).toBeLessThanOrEqual(preset.durationInFrames);
    expect(new Set(preset.slots.map((s) => s.id)).size).toBe(preset.slots.length);
  });
});

describe("path math", () => {
  const keyframes = [
    { frame: 0, position: [0, 0, 0] as [number, number, number], target: [0, 0, 0] as [number, number, number] },
    { frame: 50, position: [10, 0, 0] as [number, number, number], target: [0, 0, 0] as [number, number, number] },
    { frame: 100, position: [10, 10, 0] as [number, number, number], target: [0, 2, 0] as [number, number, number] },
  ];

  it("starts and ends exactly on the keyframes and clamps outside them", () => {
    expect(cameraAtFrame(keyframes, 0).position).toEqual([0, 0, 0]);
    expect(cameraAtFrame(keyframes, 100).position).toEqual([10, 10, 0]);
    expect(cameraAtFrame(keyframes, 500).position).toEqual([10, 10, 0]);
  });

  it("passes through the middle keyframe without stopping", () => {
    expect(cameraAtFrame(keyframes, 50).position[0]).toBeCloseTo(10);
    const before = cameraAtFrame(keyframes, 49).position;
    const after = cameraAtFrame(keyframes, 51).position;
    expect(before[0]).toBeLessThan(10);
    expect(after[1]).toBeGreaterThan(0);
  });

  it("widens the vertical field of view for narrower outputs only", () => {
    expect(fovForAspect(30, 16 / 9, 16 / 9)).toBe(30);
    expect(fovForAspect(30, 16 / 9, 2)).toBe(30);
    expect(fovForAspect(30, 16 / 9, 1)).toBeGreaterThan(30);
  });

  it("fits media by cropping (cover) or letterboxing (contain)", () => {
    expect(fitMedia(16 / 9, 1.6, "cover")).toEqual({ planeWidth: 1, planeHeight: 1, uvWidth: 1.6 / (16 / 9), uvHeight: 1 });
    expect(fitMedia(1, 1.6, "contain")).toEqual({ planeWidth: 1 / 1.6, planeHeight: 1, uvWidth: 1, uvHeight: 1 });
    expect(fitMedia(1.6, 1.6, "cover")).toEqual({ planeWidth: 1, planeHeight: 1, uvWidth: 1, uvHeight: 1 });
  });

  it("parses aspect ratios", () => {
    expect(parseAspect("16:9")).toBeCloseTo(1.7778, 4);
    expect(() => parseAspect("wide")).toThrow();
    expect(aspectMismatch(1.6, 1.6)).toBe(0);
  });
});

describe.skipIf(!hasFfprobe)("resolvePreset", () => {
  const repo = mkdtempSync(join(tmpdir(), "repokit-presets-"));
  copyFileSync(join(FIXTURES, "pattern-16x10.png"), join(repo, "screen.png"));
  copyFileSync(join(FIXTURES, "pattern-phone.png"), join(repo, "phone.png"));
  copyFileSync(join(FIXTURES, "pattern-16x10.mp4"), join(repo, "clip.mp4"));
  writeFileSync(join(repo, "notes.txt"), "not media");
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("refuses an unknown preset, an unknown slot and a slot left empty", async () => {
    await expect(resolvePreset(repo, "hologram", { slots: [] })).rejects.toThrow(UsageError);
    await expect(resolvePreset(repo, "laptop-orbit", { slots: ["side=screen.png"] })).rejects.toThrow(/нет слота/);
    await expect(resolvePreset(repo, "laptop-orbit", { slots: [] })).rejects.toThrow(/Слоты без медиа: main/);
  });

  it("refuses missing files, unsupported formats and paths outside the repository", async () => {
    await expect(resolvePreset(repo, "laptop-orbit", { slots: ["main=nope.png"] })).rejects.toThrow(/файл не найден/);
    await expect(resolvePreset(repo, "laptop-orbit", { slots: ["main=notes.txt"] })).rejects.toThrow(/неподдерживаемый формат/);
    await expect(resolvePreset(repo, "laptop-orbit", { slots: ["main=../screen.png"] })).rejects.toThrow(UsageError);
  });

  it("refuses an aspect ratio the preset was not designed for", async () => {
    await expect(resolvePreset(repo, "laptop-orbit", { slots: ["main=screen.png"], aspect: "9:16" })).rejects.toThrow(/не поддерживает/);
  });

  it("flags media that repokit did not record", async () => {
    const { warnings } = await resolvePreset(repo, "laptop-orbit", { slots: ["main=screen.png"] });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("происхождение неизвестно");
  });

  it("warns about mismatched proportions and says how they will be fitted", async () => {
    const { warnings } = await resolvePreset(repo, "laptop-orbit", { slots: ["main=phone.png"] });
    expect(warnings.some((w) => w.includes("пропорции") && w.includes("fit: cover"))).toBe(true);
  });

  it("computes output size from the aspect ratio, with even dimensions", async () => {
    const square = await resolvePreset(repo, "phone-float", { slots: ["main=phone.png"], aspect: "1:1", width: 601 });
    expect(square.props).toMatchObject({ width: 602, height: 602, fps: 30, durationInFrames: 150 });
    expect(square.props.slots.main).toMatchObject({ kind: "image", width: 780, height: 1690 });
  });

  it("loops a video shorter than the preset and says so", async () => {
    const { props, warnings } = await resolvePreset(repo, "browser-tilt", { slots: ["main=clip.mp4"] });
    expect(props.slots.main).toMatchObject({ kind: "video", durationInFrames: 60 });
    expect(warnings.some((w) => w.includes("зациклено"))).toBe(true);
  });
});
