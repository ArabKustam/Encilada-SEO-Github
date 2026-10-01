import { RoundedSlab, Screen, SoftShadow } from "../_engine/engine.js";
import type { SceneComponent } from "../_engine/types.js";

/** Dimensions in scene units; the laptop is procedural and resembles no particular product. */
const BASE = { width: 3.3, depth: 2.25, thickness: 0.1, radius: 0.14 };
const LID = { height: 2.16, thickness: 0.07 };
const SCREEN_WIDTH = 3.06;
/** How far the lid leans back from vertical, in radians. */
const LID_TILT = 0.3;
const BODY_COLOR = "#c9ccd3";
const DARK = "#17181c";

export const Scene: SceneComponent = () => (
  <group position={[0, -0.75, 0]}>
    <SoftShadow width={5.6} height={4.2} opacity={0.42} position={[0, 0.001, 0.2]} rotation={[-Math.PI / 2, 0, 0]} />

    {/* Base: a slab lying flat, its face turned up. */}
    <group position={[0, BASE.thickness / 2, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <RoundedSlab width={BASE.width} height={BASE.depth} depth={BASE.thickness} radius={BASE.radius}>
        <meshStandardMaterial color={BODY_COLOR} metalness={0.55} roughness={0.38} />
      </RoundedSlab>
      {/* Keyboard well and trackpad, as flat insets on the top face. */}
      <mesh position={[0, 0.28, BASE.thickness / 2 + 0.002]}>
        <planeGeometry args={[2.8, 1.02]} />
        <meshStandardMaterial color={DARK} roughness={0.75} />
      </mesh>
      <mesh position={[0, -0.66, BASE.thickness / 2 + 0.002]}>
        <planeGeometry args={[1.1, 0.62]} />
        <meshStandardMaterial color="#b9bcc4" metalness={0.4} roughness={0.5} />
      </mesh>
    </group>

    {/* Lid: hinged at the back edge of the base. */}
    <group position={[0, BASE.thickness, -BASE.depth / 2 + 0.04]} rotation={[-LID_TILT, 0, 0]}>
      <group position={[0, LID.height / 2, 0]}>
        <RoundedSlab width={BASE.width} height={LID.height} depth={LID.thickness} radius={BASE.radius}>
          <meshStandardMaterial color={BODY_COLOR} metalness={0.55} roughness={0.38} />
        </RoundedSlab>
        {/* Bezel */}
        <mesh position={[0, 0, LID.thickness / 2 + 0.001]}>
          <planeGeometry args={[BASE.width - 0.08, LID.height - 0.08]} />
          <meshStandardMaterial color={DARK} roughness={0.6} />
        </mesh>
        <group position={[0, 0.02, LID.thickness / 2 + 0.003]}>
          <Screen slot="main" width={SCREEN_WIDTH} radius={0.03} />
        </group>
      </group>
    </group>
  </group>
);
