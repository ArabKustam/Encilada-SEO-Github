import { statSync } from "node:fs";
import { runTool } from "@repokit/core";

export const DEFAULT_GIF_BUDGET_BYTES = 8 * 1024 * 1024;

export interface GifVariant {
  width: number;
  fps: number;
  colors: number;
}

/** Quality steps from best to smallest; the first one within budget wins. */
const GIF_LADDER: GifVariant[] = [
  { width: 960, fps: 15, colors: 256 },
  { width: 800, fps: 15, colors: 256 },
  { width: 800, fps: 12, colors: 128 },
  { width: 640, fps: 12, colors: 128 },
  { width: 640, fps: 10, colors: 64 },
  { width: 480, fps: 10, colors: 64 },
  { width: 400, fps: 8, colors: 48 },
];

/** Ladder steps that make sense for a source of the given size and frame rate. */
export function gifLadder(sourceWidth: number, sourceFps: number): GifVariant[] {
  const steps = GIF_LADDER.map((v) => ({ ...v, width: Math.min(v.width, sourceWidth), fps: Math.min(v.fps, sourceFps) }));
  return steps.filter((v, i) => i === 0 || JSON.stringify(v) !== JSON.stringify(steps[i - 1]));
}

export interface GifResult extends GifVariant {
  bytes: number;
  withinBudget: boolean;
  attempts: number;
}

/** Encode a GIF, stepping down the ladder until it fits the budget. Uses ffmpeg's palette filters. */
export async function encodeGif(input: string, output: string, sourceWidth: number, sourceFps: number, budgetBytes: number): Promise<GifResult> {
  const ladder = gifLadder(sourceWidth, sourceFps);
  let result: GifResult | null = null;
  for (const [index, variant] of ladder.entries()) {
    const filter =
      `fps=${variant.fps},scale=${variant.width}:-2:flags=lanczos,split[a][b];` +
      `[a]palettegen=max_colors=${variant.colors}:stats_mode=diff[p];` +
      `[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;
    await runTool("ffmpeg", ["-y", "-i", input, "-filter_complex", filter, "-loop", "0", output]);
    const bytes = statSync(output).size;
    result = { ...variant, bytes, withinBudget: bytes <= budgetBytes, attempts: index + 1 };
    if (result.withinBudget) break;
  }
  return result!;
}

export async function encodeWebp(input: string, output: string, sourceWidth: number, sourceFps: number): Promise<number> {
  const filter = `fps=${Math.min(20, sourceFps)},scale=${Math.min(960, sourceWidth)}:-2:flags=lanczos`;
  await runTool("ffmpeg", ["-y", "-i", input, "-vf", filter, "-c:v", "libwebp", "-q:v", "72", "-compression_level", "5", "-loop", "0", "-an", output]);
  return statSync(output).size;
}

/** A still frame for the video poster, taken from the given moment. */
export async function encodePoster(input: string, output: string, atSeconds: number): Promise<number> {
  await runTool("ffmpeg", ["-y", "-ss", atSeconds.toFixed(2), "-i", input, "-frames:v", "1", output]);
  return statSync(output).size;
}
