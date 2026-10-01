import { useThree } from "@react-three/fiber";
import { ThreeCanvas, useOffthreadVideoTexture } from "@remotion/three";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type FC, type ReactNode } from "react";
import { AbsoluteFill, continueRender, delayRender, Loop, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import * as THREE from "three";
import { cameraAtFrame, fitMedia, fovForAspect, parseAspect } from "./path.js";
import type { PresetDefinition, PresetProps, SceneComponent, SlotDefinition, SlotMedia } from "./types.js";

const SlotContext = createContext<{ preset: PresetDefinition; media: Record<string, SlotMedia> } | null>(null);

/** Rounded rectangle centred on the origin. */
export function roundedRect(width: number, height: number, radius: number): THREE.Shape {
  const r = Math.min(radius, width / 2, height / 2);
  const x = -width / 2;
  const y = -height / 2;
  const shape = new THREE.Shape();
  shape.moveTo(x + r, y);
  shape.lineTo(x + width - r, y);
  shape.quadraticCurveTo(x + width, y, x + width, y + r);
  shape.lineTo(x + width, y + height - r);
  shape.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  shape.lineTo(x + r, y + height);
  shape.quadraticCurveTo(x, y + height, x, y + height - r);
  shape.lineTo(x, y + r);
  shape.quadraticCurveTo(x, y, x + r, y);
  return shape;
}

/** Flat rounded rectangle whose UVs show the centred `uvWidth × uvHeight` part of a texture. */
function screenGeometry(width: number, height: number, radius: number, uvWidth: number, uvHeight: number): THREE.ShapeGeometry {
  const geometry = new THREE.ShapeGeometry(roundedRect(width, height, radius), 12);
  const position = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  for (let i = 0; i < position.count; i++) {
    uv.setXY(i, 0.5 + (position.getX(i) / width) * uvWidth, 0.5 + (position.getY(i) / height) * uvHeight);
  }
  uv.needsUpdate = true;
  return geometry;
}

/** A slab with rounded corners in its face plane: device bodies, lids, windows. Faces +z, centred. */
export const RoundedSlab: FC<{ width: number; height: number; depth: number; radius: number; children?: ReactNode }> = ({ width, height, depth, radius, children }) => {
  const geometry = useMemo(() => {
    const bevel = Math.min(depth * 0.25, 0.02);
    const slab = new THREE.ExtrudeGeometry(roundedRect(width - bevel * 2, height - bevel * 2, radius), {
      depth: depth - bevel * 2,
      bevelEnabled: true,
      bevelThickness: bevel,
      bevelSize: bevel,
      bevelSegments: 3,
      curveSegments: 16,
    });
    slab.translate(0, 0, -depth / 2 + bevel);
    return slab;
  }, [width, height, depth, radius]);
  return <mesh geometry={geometry}>{children}</mesh>;
};

function useImageTexture(src: string): THREE.Texture | null {
  const [texture, setTexture] = useState<THREE.Texture | null>(null);
  // Hold the frame until the image is decoded, otherwise the first frames render an empty screen.
  const [handle] = useState(() => delayRender(`Loading slot image ${src}`));
  useEffect(() => {
    new THREE.TextureLoader().load(
      staticFile(src),
      (loaded) => {
        loaded.colorSpace = THREE.SRGBColorSpace;
        loaded.anisotropy = 8;
        setTexture(loaded);
      },
      undefined,
      () => {
        throw new Error(`Could not load slot image ${src}`);
      },
    );
  }, [src]);
  // Release the frame only once the texture is actually drawn: loading it, or even committing it
  // to the scene, is not enough, because the canvas is repainted on the next animation frame.
  const advance = useThree((state) => state.advance);
  useEffect(() => {
    if (!texture) return;
    advance(performance.now());
    continueRender(handle);
  }, [texture, handle, advance]);
  return texture;
}

interface MediaPlaneProps {
  media: SlotMedia;
  geometry: THREE.BufferGeometry;
}

// Screen content is unlit and not tone-mapped: the device must not tint or dim what the app really looks like.
// The keys force a new material once the texture arrives: a shader compiled without a map ignores one added later.
const MediaMaterial: FC<{ texture: THREE.Texture | null }> = ({ texture }) =>
  texture ? <meshBasicMaterial key="media" map={texture} toneMapped={false} /> : <meshBasicMaterial key="empty" color="#000" />;

const ImagePlane: FC<MediaPlaneProps> = ({ media, geometry }) => {
  const texture = useImageTexture(media.src);
  return (
    <mesh geometry={geometry} position={[0, 0, 0.002]}>
      <MediaMaterial texture={texture} />
    </mesh>
  );
};

const VideoPlane: FC<MediaPlaneProps> = ({ media, geometry }) => {
  const frame = useCurrentFrame();
  const texture = useOffthreadVideoTexture({ src: staticFile(media.src) });
  if (texture) texture.colorSpace = THREE.SRGBColorSpace;

  // The hook releases the frame as soon as the video frame is loaded, before it is drawn.
  // Hold every frame ourselves until its texture has been painted to the canvas.
  const advance = useThree((state) => state.advance);
  const pending = useRef<number | null>(null);
  useLayoutEffect(() => {
    pending.current = delayRender(`Drawing video frame ${frame} of ${media.src}`);
    return () => {
      if (pending.current !== null) continueRender(pending.current);
      pending.current = null;
    };
  }, [frame, media.src]);
  useEffect(() => {
    if (!texture || pending.current === null) return;
    advance(performance.now());
    continueRender(pending.current);
    pending.current = null;
  }, [texture, advance]);

  return (
    <mesh geometry={geometry} position={[0, 0, 0.002]}>
      <MediaMaterial texture={texture} />
    </mesh>
  );
};

/**
 * Paints the canvas for the current frame before Remotion captures it. Without this the
 * capture can run ahead of three.js, which repaints only on the next animation frame.
 */
const FrameSync: FC = () => {
  const frame = useCurrentFrame();
  const advance = useThree((state) => state.advance);
  const [handle] = useState(() => ({ current: null as number | null }));
  useLayoutEffect(() => {
    handle.current = delayRender(`Painting frame ${frame}`);
  }, [frame, handle]);
  useEffect(() => {
    advance(performance.now());
    if (handle.current !== null) continueRender(handle.current);
    handle.current = null;
  }, [frame, advance, handle]);
  return null;
};

/**
 * The screen of a device: shows the media assigned to a slot, fitted to the
 * slot's aspect ratio. Faces +z, centred on the origin; `width` is in scene units.
 */
export const Screen: FC<{ slot: string; width: number; radius?: number }> = ({ slot, width, radius = 0 }) => {
  const context = useContext(SlotContext);
  if (!context) throw new Error("<Screen> must be rendered inside a preset scene");
  const definition = context.preset.slots.find((s: SlotDefinition) => s.id === slot);
  const media = context.media[slot];
  if (!definition) throw new Error(`Preset ${context.preset.name} has no slot "${slot}"`);
  if (!media) throw new Error(`Slot "${slot}" has no media`);

  const height = width / definition.aspect;
  const fit = fitMedia(media.width / media.height, definition.aspect, definition.fit);
  const backing = useMemo(() => new THREE.ShapeGeometry(roundedRect(width, height, radius), 12), [width, height, radius]);
  const plane = useMemo(
    () => screenGeometry(width * fit.planeWidth, height * fit.planeHeight, fit.planeWidth === 1 && fit.planeHeight === 1 ? radius : 0, fit.uvWidth, fit.uvHeight),
    [width, height, radius, fit.planeWidth, fit.planeHeight, fit.uvWidth, fit.uvHeight],
  );

  return (
    <group name={definition.mesh}>
      <mesh geometry={backing}>
        <meshBasicMaterial color="#000" />
      </mesh>
      {media.kind === "video" ? (
        <Loop durationInFrames={Math.max(1, media.durationInFrames ?? 1)} layout="none">
          <VideoPlane media={media} geometry={plane} />
        </Loop>
      ) : (
        <ImagePlane media={media} geometry={plane} />
      )}
    </group>
  );
};

/** A soft dark blob that reads as a shadow under or behind a device. */
export const SoftShadow: FC<{ width: number; height: number; opacity?: number; position?: [number, number, number]; rotation?: [number, number, number] }> = ({
  width, height, opacity = 0.35, position, rotation,
}) => {
  const texture = useMemo(() => {
    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const context = canvas.getContext("2d")!;
    const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, "rgba(0,0,0,1)");
    gradient.addColorStop(0.55, "rgba(0,0,0,0.35)");
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
    return new THREE.CanvasTexture(canvas);
  }, []);
  return (
    <mesh position={position} rotation={rotation}>
      <planeGeometry args={[width, height]} />
      <meshBasicMaterial map={texture} transparent opacity={opacity} depthWrite={false} toneMapped={false} />
    </mesh>
  );
};

const PresetCamera: FC<{ preset: PresetDefinition }> = ({ preset }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  useLayoutEffect(() => {
    const { position, target } = cameraAtFrame(preset.camera.keyframes, frame);
    camera.position.set(...position);
    camera.lookAt(...target);
    camera.fov = fovForAspect(preset.camera.fov, parseAspect(preset.aspectRatios[0]), width / height);
    camera.updateProjectionMatrix();
  });
  return null;
};

const Lights: FC<{ preset: PresetDefinition }> = ({ preset }) => (
  <>
    {preset.lights.map((light, index) => {
      const common = { intensity: light.intensity, color: light.color ?? "#ffffff" };
      if (light.type === "ambient") return <ambientLight key={index} {...common} />;
      if (light.type === "point") return <pointLight key={index} {...common} position={light.position} decay={0} />;
      return <directionalLight key={index} {...common} position={light.position} />;
    })}
  </>
);

/** Wraps a preset scene into a Remotion composition component. */
export function createPresetComposition(scenes: Record<string, SceneComponent>): FC<PresetProps> {
  return ({ width, height, preset, slots }) => {
    const Scene = scenes[preset.name];
    if (!Scene) throw new Error(`Preset "${preset.name}" is not registered in presets/3d/index.ts`);
    return (
      <AbsoluteFill style={{ background: preset.background }}>
        <ThreeCanvas width={width} height={height} camera={{ fov: preset.camera.fov, near: 0.1, far: 100 }} gl={{ antialias: true }}>
          <SlotContext.Provider value={{ preset, media: slots }}>
            <PresetCamera preset={preset} />
            <Lights preset={preset} />
            <Scene preset={preset} />
            <FrameSync />
          </SlotContext.Provider>
        </ThreeCanvas>
      </AbsoluteFill>
    );
  };
}
