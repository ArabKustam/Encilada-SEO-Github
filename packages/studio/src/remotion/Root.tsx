import type { FC } from "react";
import { Composition } from "remotion";
import { Preset3D, PRESET_COMPOSITION_ID } from "@repokit/presets";
import type { PresetProps } from "@repokit/presets/types";
import { Demo } from "./Demo.js";
import { COMPOSITION_ID, type DemoProps } from "./props.js";

const SIZE = { width: 1280, height: 720, fps: 30, durationInFrames: 1 };
const DEMO_PLACEHOLDER: DemoProps = { ...SIZE, style: "light", scenes: [] };
// Replaced by real input props at render time; a preset cannot render without media.
const PRESET_PLACEHOLDER = { ...SIZE, slots: {} } as unknown as PresetProps;

/** Size and length always come from the input props, i.e. from what is being rendered. */
const metadata = ({ props }: { props: { width: number; height: number; fps: number; durationInFrames: number } }) => ({
  width: props.width,
  height: props.height,
  fps: props.fps,
  durationInFrames: props.durationInFrames,
});

export const Root: FC = () => (
  <>
    <Composition id={COMPOSITION_ID} component={Demo} defaultProps={DEMO_PLACEHOLDER} {...SIZE} calculateMetadata={metadata} />
    <Composition id={PRESET_COMPOSITION_ID} component={Preset3D} defaultProps={PRESET_PLACEHOLDER} {...SIZE} calculateMetadata={metadata} />
  </>
);
