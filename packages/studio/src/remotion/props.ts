import type { CursorSample, Keyframe } from "../camera.js";

export const STYLE_NAMES = ["light", "dark", "glass"] as const;
export type StyleName = (typeof STYLE_NAMES)[number];

/** One recording placed on the output timeline, fully resolved for rendering. */
export type SceneProps = {
  /** File name inside the bundle's public directory. */
  src: string;
  durationInFrames: number;
  /** Seconds into the source where this scene starts. */
  in: number;
  speed: number;
  /** Source viewport in CSS pixels; event coordinates are in this space. */
  sourceWidth: number;
  sourceHeight: number;
  camera: Keyframe[];
  cursor: CursorSample[];
  clicks: CursorSample[];
  title?: string;
};

// A type alias, not an interface: Remotion requires props assignable to Record<string, unknown>.
export type DemoProps = {
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  style: StyleName;
  scenes: SceneProps[];
};

export const COMPOSITION_ID = "Demo";
export const DECK_COMPOSITION_ID = "Deck";
