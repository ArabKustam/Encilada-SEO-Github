import type { CameraKeyframe, Vec3 } from "./types.js";

/** Pure math shared by the scenes and by tests: no three.js, no React. */

export const easeInOutSine = (p: number) => -(Math.cos(Math.PI * p) - 1) / 2;

const mix = (a: Vec3, b: Vec3, p: number): Vec3 => [a[0] + (b[0] - a[0]) * p, a[1] + (b[1] - a[1]) * p, a[2] + (b[2] - a[2]) * p];

/**
 * Camera position and target at a frame. Easing is applied to the whole move
 * rather than to each segment, so the camera never stalls at a middle keyframe.
 */
export function cameraAtFrame(keyframes: CameraKeyframe[], frame: number): { position: Vec3; target: Vec3 } {
  const first = keyframes[0];
  const last = keyframes[keyframes.length - 1];
  if (keyframes.length === 1 || last.frame === first.frame) return first;
  const progress = Math.min(1, Math.max(0, (frame - first.frame) / (last.frame - first.frame)));
  const eased = first.frame + easeInOutSine(progress) * (last.frame - first.frame);
  const index = Math.max(1, keyframes.findIndex((k) => k.frame >= eased));
  const from = keyframes[index - 1];
  const to = keyframes[index];
  const p = to.frame === from.frame ? 1 : (eased - from.frame) / (to.frame - from.frame);
  return { position: mix(from.position, to.position, p), target: mix(from.target, to.target, p) };
}

export function parseAspect(ratio: string): number {
  const match = ratio.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!match) throw new Error(`Invalid aspect ratio: ${ratio}`);
  return Number(match[1]) / Number(match[2]);
}

/**
 * Vertical field of view for an output narrower than the one the camera was
 * designed for, keeping the horizontal view so the device is not cropped at the sides.
 */
export function fovForAspect(designFov: number, designAspect: number, outputAspect: number): number {
  if (outputAspect >= designAspect) return designFov;
  const half = Math.tan((designFov * Math.PI) / 360);
  return (Math.atan((half * designAspect) / outputAspect) * 360) / Math.PI;
}

export interface FitResult {
  /** Size of the plane showing the media, as fractions of the screen size. */
  planeWidth: number;
  planeHeight: number;
  /** Visible part of the media, as fractions of its width and height. */
  uvWidth: number;
  uvHeight: number;
}

/** How media of one aspect ratio is placed on a screen of another. */
export function fitMedia(mediaAspect: number, screenAspect: number, fit: "cover" | "contain"): FitResult {
  const wider = mediaAspect > screenAspect;
  if (fit === "cover") {
    return wider
      ? { planeWidth: 1, planeHeight: 1, uvWidth: screenAspect / mediaAspect, uvHeight: 1 }
      : { planeWidth: 1, planeHeight: 1, uvWidth: 1, uvHeight: mediaAspect / screenAspect };
  }
  return wider
    ? { planeWidth: 1, planeHeight: screenAspect / mediaAspect, uvWidth: 1, uvHeight: 1 }
    : { planeWidth: mediaAspect / screenAspect, planeHeight: 1, uvWidth: 1, uvHeight: 1 };
}

/** Relative difference between two aspect ratios; 0.03 means 3 %. */
export const aspectMismatch = (a: number, b: number) => Math.abs(a - b) / Math.max(a, b);
