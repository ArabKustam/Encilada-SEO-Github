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

  it("puts the recording on a 3D device, keeping the link to its source", () => {
    const { code, envelope, stderr } = repokit([
      "studio", "render", "--preset", "browser-tilt", "--slot", `main=${video}`, "--width", "480", "--gl", "swangle",
      "--out", "docs/media/hero-3d.mp4", "--gif",
    ]);
    expect(code, stderr).toBe(0);
    expect(envelope.data).toMatchObject({ mode: "preset", preset: "browser-tilt" });
    // The only warning allowed is about fitting 16:9 footage onto a 16:10 screen — not about unknown origin.
    expect(envelope.warnings.every((w: string) => w.includes("пропорции"))).toBe(true);
    const media = manifest().media;
    const gif = media.find((m: { path: string }) => m.path === "docs/media/hero-3d.gif");
    expect(gif.derivedFrom).toContain(media.find((m: { path: string }) => m.path === video).sha256);
  }, 600_000);

  it("puts the rendered demo into a README draft and shows it the way GitHub would", () => {
    const planned = repokit(["readme", "plan", "--preset", "showcase", "--hero", "docs/media/hero.gif"]);
    expect(planned.code, planned.stderr).toBe(0);
    expect(planned.envelope.data.slots.find((s: { id: string }) => s.id === "hero")).toMatchObject({ status: "filled" });
    // The hero was rendered by studio from a capture, so its origin is known.
    expect(planned.envelope.warnings.filter((w: string) => w.includes("происхождение"))).toEqual([]);
    const draft = readFileSync(join(repo, ".repokit/readme.draft.md"), "utf8");
    expect(draft).toContain('<img src="docs/media/hero.gif" alt="Демонстрация работы');
    // The recording was flagged as demo data in the scenario, and the README says so.
    expect(draft).toContain("Демонстрационные данные");

    const shots = repokit(["preview", "shot", "--themes", "light,dark", "--widths", "1280"]);
    expect(shots.code, shots.stderr).toBe(0);
    expect(shots.envelope.data.shots).toEqual([".repokit/preview/readme-draft-light-1280.png", ".repokit/preview/readme-draft-dark-1280.png"]);
    for (const shot of shots.envelope.data.shots) expect(statSync(join(repo, shot)).size).toBeGreaterThan(20_000);

    const checked = repokit(["preview", "check"]);
    const kinds = checked.envelope.data.issues.map((i: { kind: string }) => i.kind);
    expect(kinds).not.toContain("broken-image");
    expect(kinds).not.toContain("mermaid");
    // The draft still has blanks only a person can fill, so the check must fail.
    expect(kinds).toContain("fill");
    expect(checked.code).toBe(1);
    expect(checked.envelope.data.firstScreen[0].images).toBeGreaterThan(0);
  }, 300_000);

  it("renders a directed scene: a camera that travels to each click, lifted elements, sparks", () => {
    const init = repokit(["studio", "scene", "init", "--out", "demo.scene.json"]);
    expect(init.code, init.stderr).toBe(0);
    const file = join(repo, "demo.scene.json");
    const scene = JSON.parse(readFileSync(file, "utf8"));
    expect(scene.objects[0]).toMatchObject({ device: "browser", media: video, effects: { ripple: true, sparks: true, popOut: true } });

    // The scene is plain JSON: shorten it, tilt the window and add an effect by hand, as an author would.
    Object.assign(scene.output, { width: 480, height: 270, fps: 15, duration: 4 });
    scene.objects[0].keyframes = [{ at: 0, rotation: [6, -25, 0], scale: 0.85 }, { at: 1.2, rotation: [0, 0, 0], scale: 1, ease: "back" }];
    scene.effects = [{ type: "sparks", object: "app", at: 0.5, point: [640, 360] }];
    writeFileSync(file, JSON.stringify(scene));

    const rendered = repokit(["studio", "render", "--scene", file, "--gl", "swangle", "--out", "docs/media/scene.mp4", "--gif", "--webm", "--click-sounds"]);
    expect(rendered.code, rendered.stderr).toBe(0);
    expect(rendered.envelope.data).toMatchObject({ mode: "scene", scene: "demo.scene.json", durationSeconds: 4 });
    expect(rendered.envelope.warnings).toEqual([]);
    expect(statSync(join(repo, "docs/media/scene.gif")).size).toBeLessThanOrEqual(GIF_BUDGET_BYTES);

    // Both files carry a sound track with the clicks: AAC in the MP4, Opus in the WebM.
    const streams = (name: string) =>
      spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name", "-of", "csv=p=0", join(repo, "docs/media", name)], { encoding: "utf8" }).stdout.split(/[\s,]+/).filter(Boolean).sort();
    expect(streams("scene.mp4")).toEqual(["aac", "h264"]);
    expect(streams("scene.webm")).toEqual(["opus", "vp9"]);
  }, 600_000);

  it("renders a walk-through of how the project is built, from its imports and API calls", () => {
    const made = repokit(["studio", "explain", "--out", "explain.scene.json"]);
    expect(made.code, made.stderr).toBe(0);
    expect(made.envelope.data.facts).toEqual({ modules: 3, links: 3, services: [] });
    const file = join(repo, "explain.scene.json");
    const scene = JSON.parse(readFileSync(file, "utf8"));
    Object.assign(scene.output, { width: 480, height: 270, fps: 10 });
    writeFileSync(file, JSON.stringify(scene));

    const rendered = repokit(["studio", "render", "--scene", file, "--gl", "swangle", "--out", "docs/media/how-it-works.mp4"]);
    expect(rendered.code, rendered.stderr).toBe(0);
    // No recordings are involved, so there is nothing whose origin could be unknown.
    expect(rendered.envelope.warnings).toEqual([]);
    expect(statSync(join(repo, "docs/media/how-it-works.mp4")).size).toBeGreaterThan(20_000);
  }, 600_000);

  it("makes a banner and slides from facts, and binds the slides into a PDF", () => {
    const banner = repokit(["studio", "banner", "--out", "docs/media/banner.png", "--width", "640"]);
    expect(banner.code, banner.stderr).toBe(0);
    // The cover image is a screenshot from the capture above, so its origin is known.
    expect(banner.envelope.warnings).toEqual([]);
    expect(banner.envelope.data.deck.slides[0].image).toMatch(/shots\/tasks\.png$/);

    const init = repokit(["studio", "deck", "init", "--out", "slides.deck.json"]);
    expect(init.code, init.stderr).toBe(0);
    const rendered = repokit(["studio", "deck", "render", "--deck", join(repo, "slides.deck.json"), "--out-dir", "docs/slides", "--width", "640", "--pdf"]);
    expect(rendered.code, rendered.stderr).toBe(0);
    const outputs = rendered.envelope.data.outputs.map((o: { path: string }) => o.path);
    expect(outputs).toContain("docs/slides/slide-01.png");
    expect(outputs[outputs.length - 1]).toBe("docs/slides/slides.pdf");
    expect(readFileSync(join(repo, "docs/slides/slides.pdf")).subarray(0, 8).toString("latin1")).toBe("%PDF-1.4" );
  }, 600_000);

  it("refuses to render a preset with an empty slot", () => {
    const { code, envelope } = repokit(["studio", "render", "--preset", "laptop-orbit", "--out", "x.mp4"]);
    expect(code).toBe(2);
    expect(envelope.error.message).toContain("Слоты без медиа");
  });

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

describe.skipIf(!enabled)("repokit run, start to finish", () => {
  const project = mkdtempSync(join(tmpdir(), "repokit-run-media-"));
  afterAll(() => rmSync(project, { recursive: true, force: true }));
  cpSync(join(ROOT, "examples/web-app"), project, { recursive: true, filter: (source) => !source.includes(".repokit") && !source.includes("docs") });
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [BIN, "run", project, "--json", ...args], { encoding: "utf8" });
    return { code: result.status, envelope: JSON.parse(result.stdout), stderr: result.stderr };
  };

  it("with the author's input and approvals, produces a README, a hero GIF, a 3D version and passes verification", () => {
    expect(run("--default-brief").code).toBe(3);
    const claims = join(project, ".repokit/claims.json");
    const doc = JSON.parse(readFileSync(claims, "utf8"));
    Object.assign(doc.claims[0], { status: "implemented", evidence: [{ file: "app/main.py", lines: [44, 47] }] });
    Object.assign(doc.claims[1], { status: "implemented", evidence: [{ file: "app/store.py", lines: [26, 30] }] });
    Object.assign(doc.claims[2], { status: "mock", evidence: [{ file: "app/main.py", lines: [65, 68] }] });
    writeFileSync(claims, JSON.stringify(doc));
    writeFileSync(join(project, ".repokit/readme.human.yaml"), "tagline: Список задач на один экран\nproblem: Нужен общий список дел.\nsolution: Одна страница.\nskip: [team]\n");
    writeFileSync(join(project, "LICENSE"), "MIT License\n");

    // Nothing is recorded or written until each step is approved.
    const waiting = run();
    expect(waiting.code).toBe(3);
    expect(existsSync(join(project, "docs/media/hero.gif"))).toBe(false);

    const { code, envelope, stderr } = run("--approve", "demo", "--approve", "readme");
    expect(code, stderr).toBe(0);
    expect(envelope.data.steps.map((s: { status: string }) => s.status)).toEqual(["done", "done", "done", "done", "done", "done", "done"]);
    expect(statSync(join(project, "docs/media/hero.gif")).size).toBeLessThanOrEqual(GIF_BUDGET_BYTES);
    expect(statSync(join(project, "docs/media/hero-3d.gif")).size).toBeLessThanOrEqual(GIF_BUDGET_BYTES);

    const readme = readFileSync(join(project, "README.md"), "utf8");
    expect(readme).toContain('<img src="docs/media/hero.gif"');
    expect(readme).toContain("**Список задач на один экран**");
    expect(readme).not.toContain("FILL");
    expect(readFileSync(join(project, ".repokit/human-todo.md"), "utf8")).toContain("профиль по умолчанию");
    expect(JSON.parse(readFileSync(join(project, ".repokit/verify.json"), "utf8")).ok).toBe(true);
  }, 900_000);
});

