import { renameSync, rmSync, statSync } from "node:fs";
import { runTool } from "@repokit/core";

export interface SoundTrack {
  /** Moments of clicks, seconds from the start of the video. */
  clickTimes: number[];
  clickVolume: number;
  /** Absolute path of a music file, if any. */
  music?: string;
  musicVolume: number;
}

export const SOUND_DEFAULTS = { clickVolume: 0.7, musicVolume: 0.25 };
const SAMPLE_RATE = 48_000;
/** ffmpeg takes one input per click; a demo never needs more. */
const MAX_CLICKS = 80;
const MUSIC_FADE_SECONDS = 1.5;
/**
 * A click made of a short high tick and a softer low thump, both decaying within a tenth of a second.
 * It is synthesised by ffmpeg, so no sound file is shipped with repokit.
 */
const CLICK = "0.6*sin(2*PI*1900*t)*exp(-t*90)+0.5*sin(2*PI*240*t)*exp(-t*45)";

export const hasSound = (track: SoundTrack) => track.clickTimes.length > 0 || Boolean(track.music);

/** ffmpeg arguments that build the sound track; exported separately so the filter graph can be tested without ffmpeg. */
export function soundArgs(track: SoundTrack, duration: number): { inputs: string[]; filter: string } {
  const clicks = track.clickTimes.filter((t) => t >= 0 && t < duration).slice(0, MAX_CLICKS);
  const inputs = ["-f", "lavfi", "-t", duration.toFixed(3), "-i", `anullsrc=r=${SAMPLE_RATE}:cl=stereo`];
  const parts: string[] = [];
  const mixed = ["[0:a]"];
  let next = 1;
  if (clicks.length > 0) {
    inputs.push("-f", "lavfi", "-i", `aevalsrc='${CLICK}':d=0.12:s=${SAMPLE_RATE}`);
    const source = next++;
    parts.push(`[${source}:a]aformat=channel_layouts=stereo,volume=${track.clickVolume},asplit=${clicks.length}${clicks.map((_, i) => `[c${i}]`).join("")}`);
    clicks.forEach((t, i) => {
      const delay = Math.round(t * 1000);
      parts.push(`[c${i}]adelay=${delay}|${delay}[d${i}]`);
      mixed.push(`[d${i}]`);
    });
  }
  if (track.music) {
    inputs.push("-stream_loop", "-1", "-i", track.music);
    const source = next++;
    const fadeStart = Math.max(0, duration - MUSIC_FADE_SECONDS);
    parts.push(`[${source}:a]aformat=sample_rates=${SAMPLE_RATE}:channel_layouts=stereo,atrim=0:${duration.toFixed(3)},volume=${track.musicVolume},afade=t=in:st=0:d=0.5,afade=t=out:st=${fadeStart.toFixed(3)}:d=${MUSIC_FADE_SECONDS}[music]`);
    mixed.push("[music]");
  }
  // normalize=0 keeps every source at its own volume instead of dividing by the number of inputs.
  parts.push(`${mixed.join("")}amix=inputs=${mixed.length}:normalize=0:duration=first,alimiter=limit=0.95[out]`);
  return { inputs, filter: parts.join(";") };
}

/** Add a sound track to an MP4 in place. */
export async function addSound(video: string, track: SoundTrack, duration: number): Promise<void> {
  const { inputs, filter } = soundArgs(track, duration);
  const temporary = `${video}.sound.mp4`;
  await runTool("ffmpeg", ["-y", "-i", video, ...inputs.map((arg, index) => arg), "-filter_complex", shiftInputs(filter), "-map", "0:v", "-map", "[out]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-shortest", temporary]);
  rmSync(video);
  renameSync(temporary, video);
}

/** The filter graph numbers its inputs from 0; in `addSound` the video comes first, so every audio input moves by one. */
const shiftInputs = (filter: string) => filter.replace(/\[(\d+):a\]/g, (_, index: string) => `[${Number(index) + 1}:a]`);

/** Encode a WebM (VP9, plus Opus when the source has sound) from the rendered MP4. */
export async function encodeWebm(input: string, output: string): Promise<number> {
  await runTool("ffmpeg", [
    "-y", "-i", input,
    "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "32", "-row-mt", "1", "-deadline", "good", "-cpu-used", "2", "-pix_fmt", "yuv420p",
    "-c:a", "libopus", "-b:a", "128k",
    output,
  ]);
  return statSync(output).size;
}
