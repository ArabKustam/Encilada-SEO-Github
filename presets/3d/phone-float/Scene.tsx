import type { FC, ReactNode } from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { RoundedSlab, Screen, SoftShadow } from "../_engine/engine.js";
import type { SceneComponent } from "../_engine/types.js";

/** A generic slab phone: procedural, with no notch, logo or other brand-specific detail. */
const BODY = { width: 1.56, height: 3.3, depth: 0.16, radius: 0.24 };
export const PHONE_SCREEN = { width: 1.44, aspect: 0.4615, radius: 0.18 };
/** Float motion: one full sway over the length of the preset. */
const BOB_HEIGHT = 0.07;
const SWAY_YAW = 0.34;
const SWAY_PITCH = 0.06;

/** The phone itself. `children` receives the screen width and renders whatever goes on the screen. */
export const Phone: FC<{ children: (screenWidth: number) => ReactNode }> = ({ children }) => (
  <>
    <RoundedSlab width={BODY.width} height={BODY.height} depth={BODY.depth} radius={BODY.radius}>
      <meshStandardMaterial color="#2b2d33" metalness={0.6} roughness={0.35} />
    </RoundedSlab>
    <group position={[0, 0, BODY.depth / 2 + 0.002]}>{children(PHONE_SCREEN.width)}</group>
  </>
);

export const Scene: SceneComponent = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const phase = (frame / durationInFrames) * Math.PI * 2;

  return (
    <>
      <SoftShadow width={3.2} height={1.5} opacity={0.3} position={[0, -2.25, 0]} rotation={[-Math.PI / 2, 0, 0]} />
      <group position={[0, Math.sin(phase) * BOB_HEIGHT, 0]} rotation={[Math.sin(phase + 0.6) * SWAY_PITCH, Math.sin(phase) * SWAY_YAW, 0]}>
        <Phone>{(width) => <Screen slot="main" width={width} radius={PHONE_SCREEN.radius} />}</Phone>
      </group>
    </>
  );
};
