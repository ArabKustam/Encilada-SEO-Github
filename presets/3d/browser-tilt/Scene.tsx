import { useMemo } from "react";
import * as THREE from "three";
import { RoundedSlab, roundedRect, Screen, SoftShadow } from "../_engine/engine.js";
import type { SceneComponent } from "../_engine/types.js";

/** A generic browser window: three neutral dots and an empty address pill, no real browser's chrome. */
const SCREEN_WIDTH = 4.4;
const SCREEN_HEIGHT = SCREEN_WIDTH / 1.6;
const BAR_HEIGHT = 0.26;
const WINDOW = { width: SCREEN_WIDTH + 0.06, height: SCREEN_HEIGHT + BAR_HEIGHT + 0.06, depth: 0.06, radius: 0.1 };
const TILT: [number, number, number] = [0.1, -0.36, 0.015];
/** Decorative shapes at different depths; they drift against the window as the camera moves. */
const BACKDROP = [
  { position: [-3.3, 1.5, -2.6], radius: 0.95, color: "#b9c8ff" },
  { position: [3.5, -1.3, -3.4], radius: 1.3, color: "#ffc9dd" },
  { position: [2.9, 1.9, 1.5], radius: 0.26, color: "#c9d4ff" },
  { position: [-2.9, -1.6, 1.9], radius: 0.2, color: "#ffd6e6" },
] as const;

export const Scene: SceneComponent = () => {
  const pill = useMemo(() => new THREE.ShapeGeometry(roundedRect(SCREEN_WIDTH * 0.5, BAR_HEIGHT * 0.5, BAR_HEIGHT * 0.25), 8), []);
  const front = WINDOW.depth / 2 + 0.002;
  const barY = SCREEN_HEIGHT / 2;

  return (
    <>
      {BACKDROP.map((shape, index) => (
        <mesh key={index} position={[...shape.position]}>
          <sphereGeometry args={[shape.radius, 48, 48]} />
          <meshStandardMaterial color={shape.color} roughness={0.9} transparent opacity={0.75} />
        </mesh>
      ))}

      <group rotation={TILT}>
        <SoftShadow width={WINDOW.width * 1.45} height={WINDOW.height * 1.5} opacity={0.4} position={[0.25, -0.4, -0.5]} />
        <RoundedSlab width={WINDOW.width} height={WINDOW.height} depth={WINDOW.depth} radius={WINDOW.radius}>
          <meshStandardMaterial color="#f3f4f7" roughness={0.6} />
        </RoundedSlab>

        {/* Title bar */}
        <group position={[0, barY, front]}>
          <mesh position={[0, 0, -0.001]}>
            <planeGeometry args={[SCREEN_WIDTH, BAR_HEIGHT - 0.02]} />
            <meshBasicMaterial color="#f4f5f8" toneMapped={false} />
          </mesh>
          {[0, 1, 2].map((i) => (
            <mesh key={i} position={[-SCREEN_WIDTH / 2 + 0.16 + i * 0.13, 0, 0]}>
              <circleGeometry args={[0.04, 24]} />
              <meshBasicMaterial color="#c4c9d3" toneMapped={false} />
            </mesh>
          ))}
          <mesh geometry={pill}>
            <meshBasicMaterial color="#e4e7ec" toneMapped={false} />
          </mesh>
        </group>

        <group position={[0, -BAR_HEIGHT / 2, front]}>
          <Screen slot="main" width={SCREEN_WIDTH} radius={0.05} />
        </group>
      </group>
    </>
  );
};
