import type { Ease, Transform, TransformKey } from "./motion.js";
import type { Vec3 } from "./types.js";

export const STAGE_COMPOSITION_ID = "Stage3D";
export const STAGE_DEVICES = ["browser", "laptop", "phone", "screen"] as const;
export type StageDevice = (typeof STAGE_DEVICES)[number];

/** A point of the recorded page, in CSS pixels of the recording viewport — the same space the event log uses. */
export type MediaPoint = [number, number];
/** A rectangle of the recorded page: x, y, width, height in CSS pixels. */
export type MediaBox = [number, number, number, number];

export type StageMedia = {
  /** File name inside the bundle's public directory. */
  src: string;
  kind: "image" | "video";
  /** Size of the coordinate space that points and boxes refer to. */
  viewWidth: number;
  viewHeight: number;
  /** For video: which output frame of the source the scene starts at, and how fast it plays. */
  startFrame: number;
  playbackRate: number;
};

export type StageClick = { t: number; x: number; y: number; box?: MediaBox };

export type StageObject = {
  id: string;
  device: StageDevice;
  /** Width of the device's screen in scene units. */
  width: number;
  fit: "cover" | "contain";
  media: StageMedia;
  base: Transform;
  keyframes: TransformKey[];
  /** Pointer positions over time, in media coordinates; empty when there is no cursor to show. */
  cursor: { t: number; x: number; y: number }[];
  clicks: StageClick[];
  effects: { ripple: boolean; sparks: boolean; popOut: boolean };
};

export type CameraFocus = {
  object: string;
  /** Point of the page to look at; the centre of the screen when omitted. */
  point?: MediaPoint;
  /** 1 fits the whole screen into the frame; 2 shows half of it; below 1 leaves space around the device. */
  zoom: number;
  /** Degrees to the side of and above the screen's normal. */
  yaw?: number;
  pitch?: number;
};

export type CameraKey = { at: number; ease?: Ease; position?: Vec3; lookAt?: Vec3; focus?: CameraFocus };

export type StageEffect =
  | { type: "sparks"; object: string; at: number; point: MediaPoint; count?: number }
  | { type: "ripple"; object: string; at: number; point: MediaPoint }
  | { type: "popOut"; object: string; box: MediaBox; from: number; to: number; depth?: number };

export type StageCaption = { from: number; to: number; text: string; position: "top" | "bottom" };

// A type alias, not an interface: Remotion requires props assignable to Record<string, unknown>.
export type StageProps = {
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  /** CSS background behind the 3D scene. */
  background: string;
  captionColor: string;
  objects: StageObject[];
  camera: { fov: number; keys: CameraKey[] };
  effects: StageEffect[];
  captions: StageCaption[];
};
