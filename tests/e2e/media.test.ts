import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { validate } from "../../packages/core/src/index.js";

/**
 * Records and renders a real demo. Needs a Chromium-family browser, ffmpeg and
 * Python with the fixture's requirements, so it only runs when asked:
 * REPOKIT_E2E_MEDIA=1 pnpm test
 */
const enabled = process.env.REPOKIT_E2E_MEDIA === "1";
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BIN = join(ROOT, "packages/cli/dist/bin.js");
const GIF_BUDGET_BYTES = 8 * 1024 * 1024;

const repo = mkdtempSync(join(tmpdir(), "repokit-media-"));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

function repokit(args: string[]) {
  const result = spawnSync(process.execPath, [BIN, ...args, "--repo", repo, "--json"], { encoding: "utf8" });
  if (!result.stdout) throw new Error(`repokit ${args.join(" ")} printed no JSON:\n${result.stderr}`);
  return { code: result.status, envelope: JSON.parse(result.stdout), stderr: result.stderr };
}

describe.skipIf(!enabled)("capture → studio on the FastAPI fixture", () => {
  cpSync(join(ROOT, "examples/web-app"), repo, { recursive: true, filter: (source) => !source.includes(".repokit") });
  const manifest = () => JSON.parse(readFileSync(join(repo, ".repokit/media.manifest.json"), "utf8"));
  let video = "";

  it("records the scenario against the real app", () => {
    const { code, envelope, stderr } = repokit(["capture", "run", "--scenario", join(repo, "demo.scenario.yaml")]);
    expect(code, stderr).toBe(0);
    video = envelope.data.video;
    expect(envelope.data.shots).toHaveLength(2);
    expect(envelope.data.duration).toBeGreaterThan(5);

    const events = JSON.parse(readFileSync(join(repo, envelope.data.events), "utf8"));
    expect(validate("events", events)).toEqual({ valid: true, errors: [] });
    expect(events.events.filter((e: { type: string }) => e.type === "click")).toHaveLength(6);
    // What was typed must not be stored anywhere in the event log.
    expect(JSON.stringify(events)).not.toContain("Record the demo");
  }, 120_000);

  it("writes provenance for the recording", () => {
    const entry = manifest().media.find((m: { path: string }) => m.path === video);
    expect(entry).toMatchObject({ kind: "video", demoData: true, masks: ["input[type=password]"] });
    expect(entry.source).toMatchObject({ scenario: "demo.scenario.yaml", baseUrl: "http://127.0.0.1:8017" });
  });

  it("renders a styled GIF within the size budget, linked to its source", () => {
    const { code, envelope, stderr } = repokit([
      "studio", "render", "--out", "docs/media/hero.mp4", "--gif", "--style", "dark", "--width", "640", "--height", "360", "--fps", "15",
    ]);
    expect(code, stderr).toBe(0);
    expect(envelope.warnings).toEqual([]);
    expect(envelope.data.gif.withinBudget).toBe(true);
    expect(statSync(join(repo, "docs/media/hero.gif")).size).toBeLessThanOrEqual(GIF_BUDGET_BYTES);
    expect(existsSync(join(repo, "docs/media/hero.png"))).toBe(true);

    const media = manifest().media;
    const source = media.find((m: { path: string }) => m.path === video);
    const gif = media.find((m: { path: string }) => m.path === "docs/media/hero.gif");
    expect(gif.derivedFrom).toContain(source.sha256);
  }, 600_000);

  it("warns when a source did not come from capture", () => {
    copyFileSync(join(repo, "docs/media/hero.mp4"), join(repo, "stranger.mp4"));
    rmSync(join(repo, ".repokit/media.manifest.json"));
    const timeline = JSON.stringify({ schemaVersion: 1, output: { width: 640, height: 360, fps: 15 }, style: "light", scenes: [{ source: "stranger.mp4" }] });
    const file = join(repo, "timeline.json");
    writeFileSync(file, timeline);
    const { envelope } = repokit(["studio", "render", "--timeline", file, "--out", "out.mp4", "--dry-run"]);
    expect(envelope.warnings.join(" ")).toContain("происхождение неизвестно");
  }, 60_000);
});
