import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CDPSession } from "playwright";
import { runTool } from "@repokit/core";
import type { Viewport } from "./scenario.js";

const JPEG_QUALITY = 92;
const FRAMES_DIR = "frames";
export const OUTPUT_FPS = 30;
const CAPTURE_TIMEOUT_MS = 2000;

interface Frame {
  file: string;
  /** Seconds since recording started. */
  t: number;
}

/**
 * Records the page as a sequence of screenshots at device-pixel resolution.
 * CDP screencast would be simpler, but it ignores the device scale factor and
 * delivers ~13 fps; a screenshot loop gives crisp frames at 20–45 fps.
 */
export class FrameRecorder {
  private frames: Frame[] = [];
  private running = false;
  private loop: Promise<void> = Promise.resolve();
  private startedAt = 0;
  private readonly writes: Promise<void>[] = [];

  constructor(
    private readonly cdp: CDPSession,
    private readonly dir: string,
    private readonly viewport: Viewport,
    /** Where the page is scrolled to right now; see `scrollOf` in session.ts. */
    private readonly scroll: () => { x: number; y: number } = () => ({ x: 0, y: 0 }),
  ) {}

  /** Seconds on the recording clock; events are stamped with this. */
  now(): number {
    return (performance.now() - this.startedAt) / 1000;
  }

  /** One capture of the visible area, or null if the browser did not answer in time. */
  private screenshot(format: "jpeg" | "png"): Promise<{ data: string } | null> {
    const { width, height, deviceScaleFactor } = this.viewport;
    // The clip is in document coordinates: on a scrolled page it has to follow the visible area.
    const { x, y } = this.scroll();
    const capture = this.cdp.send("Page.captureScreenshot", {
      format,
      ...(format === "jpeg" ? { quality: JPEG_QUALITY } : {}),
      optimizeForSpeed: format === "jpeg",
      // Without an explicit clip scale the capture comes back at CSS-pixel size.
      clip: { x, y, width, height, scale: deviceScaleFactor },
    });
    // A capture requested just as the page navigates away may never be answered:
    // its clip belongs to a document that no longer exists. The frame is skipped, the recording goes on.
    let timer: NodeJS.Timeout;
    const expired = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), CAPTURE_TIMEOUT_MS)));
    return Promise.race([capture.catch(() => null), expired]).finally(() => clearTimeout(timer));
  }

  start(): void {
    mkdirSync(join(this.dir, FRAMES_DIR), { recursive: true });
    this.startedAt = performance.now();
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        const requested = this.now();
        const shot = await this.screenshot("jpeg");
        if (!shot) {
          // Nothing came back: give the browser a moment instead of asking again at once.
          await new Promise((resolve) => setTimeout(resolve, 50));
          continue;
        }
        const { data } = shot;
        // The frame shows the page at some moment between request and response.
        const t = this.frames.length === 0 ? 0 : (requested + this.now()) / 2;
        const file = `${FRAMES_DIR}/${String(this.frames.length + 1).padStart(6, "0")}.jpg`;
        this.frames.push({ file, t });
        this.writes.push(writeFile(join(this.dir, file), Buffer.from(data, "base64")));
      }
    })();
  }

  /** A lossless still of the current page, for scenario marks. */
  async still(file: string): Promise<void> {
    const shot = (await this.screenshot("png")) ?? (await this.screenshot("png"));
    if (!shot) throw new Error(`Браузер не отдал кадр для ${file}`);
    writeFileSync(file, Buffer.from(shot.data, "base64"));
  }

  /** Stop taking frames without producing a video: the scenario failed, and the process must be able to exit. */
  async abort(): Promise<void> {
    this.running = false;
    await this.loop.catch(() => undefined);
  }

  /** Stop recording and encode the frames into a constant-frame-rate MP4. Returns duration in seconds. */
  async finish(output: string): Promise<number> {
    this.running = false;
    await this.loop;
    await Promise.all(this.writes);
    const duration = this.now();

    const list: string[] = [];
    this.frames.forEach((frame, index) => {
      const next = this.frames[index + 1]?.t ?? duration;
      list.push(`file '${frame.file}'`, `duration ${Math.max(next - frame.t, 0.001).toFixed(4)}`);
    });
    // The concat demuxer ignores the last duration unless the last file is repeated.
    list.push(`file '${this.frames[this.frames.length - 1].file}'`);
    writeFileSync(join(this.dir, "frames.txt"), list.join("\n") + "\n");

    await runTool("ffmpeg", [
      "-y", "-f", "concat", "-safe", "0", "-i", "frames.txt",
      "-vf", `fps=${OUTPUT_FPS},format=yuv420p`,
      "-c:v", "libx264", "-crf", "14", "-preset", "medium", "-movflags", "+faststart",
      output,
    ], this.dir);

    rmSync(join(this.dir, FRAMES_DIR), { recursive: true, force: true });
    rmSync(join(this.dir, "frames.txt"), { force: true });
    return duration;
  }

  get frameCount(): number {
    return this.frames.length;
  }
}
