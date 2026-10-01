import type { FC } from "react";

export type Vec3 = [number, number, number];

/** A place in the scene where the user's own media is shown. */
export type SlotDefinition = {
  id: string;
  /** What the slot accepts. */
  type: "image" | "video" | "any";
  /** Name of the screen mesh in the scene; used to find it when debugging. */
  mesh: string;
  /** `cover` crops the media to fill the screen, `contain` letterboxes it. */
  fit: "cover" | "contain";
  /** Width divided by height of the screen. */
  aspect: number;
  description?: string;
};

export type CameraKeyframe = { frame: number; position: Vec3; target: Vec3 };

export type LightDefinition = {
  type: "ambient" | "directional" | "point";
  intensity: number;
  position?: Vec3;
  color?: string;
};

/** Contents of `preset.json`. */
export type PresetDefinition = {
  schemaVersion: 1;
  name: string;
  title: string;
  description: string;
  durationInFrames: number;
  fps: number;
  /** Supported output aspect ratios, e.g. "16:9". The first one is what the camera was designed for. */
  aspectRatios: string[];
  slots: SlotDefinition[];
  camera: { fov: number; keyframes: CameraKeyframe[] };
  lights: LightDefinition[];
  /** CSS background behind the 3D scene. */
  background: string;
};

/** A media file placed into a slot, resolved for rendering. */
export type SlotMedia = {
  /** File name inside the bundle's public directory. */
  src: string;
  kind: "image" | "video";
  width: number;
  height: number;
  /** Length of a video in output frames; it loops when shorter than the preset. */
  durationInFrames?: number;
};

// A type alias, not an interface: Remotion requires props assignable to Record<string, unknown>.
export type PresetProps = {
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  preset: PresetDefinition;
  slots: Record<string, SlotMedia>;
};

/** A preset scene: builds the device and places `<Screen>` elements for its slots. */
export type SceneComponent = FC<{ preset: PresetDefinition }>;

export const PRESET_COMPOSITION_ID = "Preset3D";
