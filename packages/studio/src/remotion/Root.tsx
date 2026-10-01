import type { FC } from "react";
import { Composition } from "remotion";
import { Demo } from "./Demo.js";
import { COMPOSITION_ID, type DemoProps } from "./props.js";

const PLACEHOLDER: DemoProps = { width: 1280, height: 720, fps: 30, durationInFrames: 1, style: "light", scenes: [] };

/** Size and length come from the input props, i.e. from the timeline being rendered. */
export const Root: FC = () => (
  <Composition
    id={COMPOSITION_ID}
    component={Demo}
    defaultProps={PLACEHOLDER}
    width={PLACEHOLDER.width}
    height={PLACEHOLDER.height}
    fps={PLACEHOLDER.fps}
    durationInFrames={PLACEHOLDER.durationInFrames}
    calculateMetadata={({ props }) => ({
      width: props.width,
      height: props.height,
      fps: props.fps,
      durationInFrames: props.durationInFrames,
    })}
  />
);
