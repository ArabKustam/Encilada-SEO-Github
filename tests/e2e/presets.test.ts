import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Visual snapshots of the 3D presets. Rendering needs a browser and ffprobe, so the suite
 * only runs with REPOKIT_E2E_MEDIA=1. Baselines are made with the software GL renderer
 * (`swangle`) so they do not depend on the GPU; refresh them with REPOKIT_UPDATE_SNAPSHOTS=1.
 */
const enabled = process.env.REPOKIT_E2E_MEDIA === "1";
const update = process.env.REPOKIT_UPDATE_SNAPSHOTS === "1";
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SNAPSHOTS = join(ROOT, "tests/snapshots");
const FIXTURES = join(ROOT, "tests/fixtures/slots");

const WIDTH = 480;
/** Per-pixel colour tolerance and the share of pixels allowed to differ (antialiasing varies between machines). */
const PIXEL_THRESHOLD = 0.15;
const MAX_DIFF_RATIO = 0.02;

const CASES: { preset: string; media: string; frames: number[] }[] = [
  { preset: "laptop-orbit", media: "pattern-16x10.png", frames: [0, 90, 179] },
  { preset: "phone-float", media: "pattern-phone.png", frames: [0, 75, 149] },
  { preset: "browser-tilt", media: "pattern-16x10.png", frames: [0, 75, 149] },
];

const repo = mkdtempSync(join(tmpdir(), "repokit-snapshots-"));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe.skipIf(!enabled)("3D preset snapshots", () => {
  it.each(CASES)("$preset matches its baseline frames", async ({ preset, media, frames }) => {
    // The built package is used on purpose: the Remotion entry point exists only after compilation.
    const studio = await import("../../packages/studio/dist/index.js");
    copyFileSync(join(FIXTURES, media), join(repo, media));
    const { props, files } = await studio.resolvePreset(repo, preset, { slots: [`main=${media}`], width: WIDTH });
    const job = { compositionId: "Preset3D", inputProps: props, files, gl: studio.glBackend("swangle") };
    const outputs = frames.map((frame) => ({ frame, output: join(repo, `${preset}-${frame}.png`) }));
    await studio.renderStills(job, outputs);

    for (const { frame, output } of outputs) {
      const baselineFile = join(SNAPSHOTS, `${preset}-${String(frame).padStart(3, "0")}.png`);
      if (update || !existsSync(baselineFile)) {
        mkdirSync(SNAPSHOTS, { recursive: true });
        copyFileSync(output, baselineFile);
        continue;
      }
      const actual = PNG.sync.read(readFileSync(output));
      const baseline = PNG.sync.read(readFileSync(baselineFile));
      expect([actual.width, actual.height], `${preset} frame ${frame}: size`).toEqual([baseline.width, baseline.height]);
      const diff = new PNG({ width: actual.width, height: actual.height });
      const differing = pixelmatch(actual.data, baseline.data, diff.data, actual.width, actual.height, { threshold: PIXEL_THRESHOLD });
      const ratio = differing / (actual.width * actual.height);
      if (ratio > MAX_DIFF_RATIO) {
        const failed = join(SNAPSHOTS, "__failed__");
        mkdirSync(failed, { recursive: true });
        copyFileSync(output, join(failed, `${preset}-${frame}.actual.png`));
        writeFileSync(join(failed, `${preset}-${frame}.diff.png`), PNG.sync.write(diff));
      }
      expect(ratio, `${preset} frame ${frame}: ${(ratio * 100).toFixed(2)}% of pixels differ`).toBeLessThanOrEqual(MAX_DIFF_RATIO);
    }
  }, 300_000);

  it("the media in the slot is really on screen", async () => {
    // The test pattern is saturated; a preset that failed to show it would render only greys and pastels.
    const image = PNG.sync.read(readFileSync(join(SNAPSHOTS, "laptop-orbit-090.png")));
    let saturated = 0;
    for (let i = 0; i < image.data.length; i += 4) {
      const [r, g, b] = [image.data[i], image.data[i + 1], image.data[i + 2]];
      if (Math.max(r, g, b) - Math.min(r, g, b) > 150) saturated++;
    }
    expect(saturated / (image.width * image.height)).toBeGreaterThan(0.03);
  });
});
