import { useMemo, type FC, type ReactNode } from "react";
import * as THREE from "three";
import { RoundedSlab, roundedRect, Screen, SoftShadow } from "../_engine/engine.js";
import type { SceneComponent } from "../_engine/types.js";

/** A generic browser window: three neutral dots and an empty address pill, no real browser's chrome. */
export const BROWSER_SCREEN = { width: 4.4, aspect: 1.6, radius: 0.05 };
const BAR_HEIGHT = 0.26;
const FRAME = { margin: 0.06, depth: 0.06, radius: 0.1 };
const TILT: [number, number, number] = [0.1, -0.36, 0.015];
/** Decorative shapes at different depths; they drift against the window as the camera moves. */
const BACKDROP = [
  { position: [-3.3, 1.5, -2.6], radius: 0.95, color: "#b9c8ff" },
  { position: [3.5, -1.3, -3.4], radius: 1.3, color: "#ffc9dd" },
  { position: [2.9, 1.9, 1.5], radius: 0.26, color: "#c9d4ff" },
  { position: [-2.9, -1.6, 1.9], radius: 0.2, color: "#ffd6e6" },
] as const;

/**
 * The window itself, sized for a viewport of the given aspect ratio.
 * `children` receives the viewport width and renders whatever goes inside the window.
 */
export const BrowserWindow: FC<{ aspect?: number; shadow?: boolean; children: (screenWidth: number) => ReactNode }> = ({ aspect = BROWSER_SCREEN.aspect, shadow = true, children }) => {
  const screenWidth = BROWSER_SCREEN.width;
  const screenHeight = screenWidth / aspect;
  const frameWidth = screenWidth + FRAME.margin;
  const frameHeight = screenHeight + BAR_HEIGHT + FRAME.margin;
  const pill = useMemo(() => new THREE.ShapeGeometry(roundedRect(screenWidth * 0.5, BAR_HEIGHT * 0.5, BAR_HEIGHT * 0.25), 8), [screenWidth]);
  const front = FRAME.depth / 2 + 0.002;

  return (
    <>
      {shadow && <SoftShadow width={frameWidth * 1.45} height={frameHeight * 1.5} opacity={0.4} position={[0.25, -0.4, -0.5]} />}
      <RoundedSlab width={frameWidth} height={frameHeight} depth={FRAME.depth} radius={FRAME.radius}>
        <meshStandardMaterial color="#f3f4f7" roughness={0.6} />
      </RoundedSlab>

      {/* Title bar */}
      <group position={[0, screenHeight / 2, front]}>
        <mesh position={[0, 0, -0.001]}>
          <planeGeometry args={[screenWidth, BAR_HEIGHT - 0.02]} />
          <meshBasicMaterial color="#f4f5f8" toneMapped={false} />
        </mesh>
        {[0, 1, 2].map((i) => (
          <mesh key={i} position={[-screenWidth / 2 + 0.16 + i * 0.13, 0, 0]}>
            <circleGeometry args={[0.04, 24]} />
            <meshBasicMaterial color="#c4c9d3" toneMapped={false} />
          </mesh>
        ))}
        <mesh geometry={pill}>
          <meshBasicMaterial color="#e4e7ec" toneMapped={false} />
        </mesh>
      </group>

      <group position={[0, -BAR_HEIGHT / 2, front]}>{children(screenWidth)}</group>
    </>
  );
};

export const Scene: SceneComponent = () => (
  <>
    {BACKDROP.map((shape, index) => (
      <mesh key={index} position={[...shape.position]}>
        <sphereGeometry args={[shape.radius, 48, 48]} />
        <meshStandardMaterial color={shape.color} roughness={0.9} transparent opacity={0.75} />
      </mesh>
    ))}
    <group rotation={TILT}>
      <BrowserWindow>{(width) => <Screen slot="main" width={width} radius={BROWSER_SCREEN.radius} />}</BrowserWindow>
    </group>
  </>
);
