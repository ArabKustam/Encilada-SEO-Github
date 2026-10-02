import { useThree } from "@react-three/fiber";
import { ThreeCanvas } from "@remotion/three";
import { createContext, useContext, useLayoutEffect, useMemo, type FC, type ReactNode } from "react";
import { AbsoluteFill, interpolate, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import * as THREE from "three";
import { BROWSER_SCREEN, BrowserWindow } from "../browser-tilt/Scene.js";
import { Laptop, LAPTOP_SCREEN } from "../laptop-orbit/Scene.js";
import { Phone, PHONE_SCREEN } from "../phone-float/Scene.js";
import { FrameSync, MediaMaterial, roundedRect, SoftShadow, useImageTexture, useVideoFrameTexture } from "./engine.js";
import { popLift, segmentAt, SPARK_SECONDS, sparkAt, sparkBurst, transformAt, EASE } from "./motion.js";
import { fitMedia } from "./path.js";
import type { CameraFocus, CameraKey, MediaBox, StageEffect, StageObject, StageProps } from "./stage-types.js";

/** What the camera needs to know about a screen in order to aim at a point of the page shown on it. */
interface SurfaceHandle {
  group: THREE.Group;
  width: number;
  height: number;
  toLocal: (x: number, y: number) => [number, number];
}

const Registry = createContext<Map<string, SurfaceHandle> | null>(null);

const RADIANS = Math.PI / 180;
const RIPPLE_SECONDS = 0.55;
const SPARK_COUNT = 26;
// Saturated colours with ordinary blending: additive sparks vanish on a white page.
const SPARK_COLORS = ["#ffb703", "#fb5607", "#ff006e", "#8338ec", "#3a86ff"];
/** Elements covering more of the screen than this are not lifted: popping out the whole page shows nothing. */
const MAX_POP_AREA = 0.12;
/** Wide elements such as text fields are not lifted either: a floating input reads as a glitch, not as a press. */
const MAX_POP_WIDTH = 0.3;
/** Sizes relative to the screen width, so effects look the same on a phone and on a laptop. */
const POP_DEPTH = 0.035;
const CURSOR_PIXELS = 30;
const SCREEN_ONLY = { width: 4.4, radius: 0.08 };

/** Geometry for a part of the screen: a rounded rectangle at (cx, cy) showing exactly what is under it. */
function patchGeometry(cx: number, cy: number, width: number, height: number, radius: number, uvOf: (x: number, y: number) => [number, number]): THREE.ShapeGeometry {
  const geometry = new THREE.ShapeGeometry(roundedRect(width, height, radius), 8);
  const position = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  for (let i = 0; i < position.count; i++) {
    const [u, v] = uvOf(cx + position.getX(i), cy + position.getY(i));
    uv.setXY(i, u, v);
  }
  uv.needsUpdate = true;
  return geometry;
}

const CURSOR_SHAPE = (() => {
  // The same original arrow as in the 2D style, in a 24-unit box with its tip at (4, 2); y points down there.
  const points: [number, number][] = [[4, 2], [4, 19.5], [8.6, 15.4], [11.7, 22], [14.6, 20.7], [11.6, 14.2], [17.8, 14.2]];
  const shape = new THREE.Shape();
  points.forEach(([x, y], index) => (index === 0 ? shape.moveTo(x - 4, 2 - y) : shape.lineTo(x - 4, 2 - y)));
  shape.closePath();
  return shape;
})();

interface LayersProps {
  object: StageObject;
  effects: StageEffect[];
  texture: THREE.Texture | null;
  width: number;
  aspect: number;
  radius: number;
}

/** Everything drawn on and above a screen: the page itself, lifted elements, ripples, sparks, the cursor. */
const Layers: FC<LayersProps> = ({ object, effects, texture, width, aspect, radius }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const registry = useContext(Registry);
  const { media } = object;
  const height = width / aspect;
  const fit = fitMedia(media.viewWidth / media.viewHeight, aspect, object.fit);
  const planeWidth = width * fit.planeWidth;
  const planeHeight = height * fit.planeHeight;
  /** Scene units per CSS pixel of the page. */
  const unit = planeWidth / fit.uvWidth / media.viewWidth;

  const geometry = useMemo(() => {
    const toLocal = (x: number, y: number): [number, number] => [(x - media.viewWidth / 2) * unit, (media.viewHeight / 2 - y) * unit];
    const uvOf = (lx: number, ly: number): [number, number] => [0.5 + (lx / planeWidth) * fit.uvWidth, 0.5 + (ly / planeHeight) * fit.uvHeight];
    const full = fit.planeWidth === 1 && fit.planeHeight === 1;
    return {
      toLocal,
      uvOf,
      backing: new THREE.ShapeGeometry(roundedRect(width, height, radius), 12),
      page: patchGeometry(0, 0, planeWidth, planeHeight, full ? radius : 0, uvOf),
      cursor: new THREE.ShapeGeometry(CURSOR_SHAPE),
    };
  }, [width, height, radius, unit, planeWidth, planeHeight, fit.uvWidth, fit.uvHeight, fit.planeWidth, fit.planeHeight, media.viewWidth, media.viewHeight]);

  // Elements that lift off the screen: clicked ones (automatic) and those the scene asks for explicitly.
  const pops = useMemo(() => {
    const visible = (box: MediaBox) => (box[2] * box[3]) / (media.viewWidth * media.viewHeight) <= MAX_POP_AREA && box[2] / media.viewWidth <= MAX_POP_WIDTH && box[2] > 0 && box[3] > 0;
    const make = (box: MediaBox) => {
      const [cx, cy] = geometry.toLocal(box[0] + box[2] / 2, box[1] + box[3] / 2);
      const w = box[2] * unit;
      const h = box[3] * unit;
      return { cx, cy, w, h, geometry: patchGeometry(cx, cy, w, h, Math.min(w, h) * 0.18, geometry.uvOf) };
    };
    const automatic = !object.effects.popOut ? [] : object.clicks.filter((c) => c.box && visible(c.box)).map((c) => ({ ...make(c.box!), lift: (time: number) => popLift(time, c.t), depth: POP_DEPTH }));
    const manual = effects.flatMap((e) => {
      if (e.type !== "popOut" || e.object !== object.id || !visible(e.box)) return [];
      const ramp = Math.min(0.4, (e.to - e.from) / 2);
      const lift = (time: number) => (time < e.from || time > e.to ? 0 : Math.min(EASE.out(Math.min(1, (time - e.from) / ramp)), EASE.out(Math.min(1, (e.to - time) / ramp))));
      return [{ ...make(e.box), lift, depth: e.depth ?? POP_DEPTH }];
    });
    return [...automatic, ...manual];
  }, [object, effects, geometry, unit, media.viewWidth, media.viewHeight]);

  const bursts = useMemo(() => {
    const automatic = object.effects.sparks ? object.clicks.map((c) => ({ at: c.t, x: c.x, y: c.y, count: SPARK_COUNT })) : [];
    const manual = effects.flatMap((e) => (e.type === "sparks" && e.object === object.id ? [{ at: e.at, x: e.point[0], y: e.point[1], count: e.count ?? SPARK_COUNT }] : []));
    return [...automatic, ...manual].map((burst, index) => ({ ...burst, sparks: sparkBurst(index, burst.count) }));
  }, [object, effects]);

  const ripples = useMemo(
    () => [
      ...(object.effects.ripple ? object.clicks.map((c) => ({ at: c.t, x: c.x, y: c.y })) : []),
      ...effects.flatMap((e) => (e.type === "ripple" && e.object === object.id ? [{ at: e.at, x: e.point[0], y: e.point[1] }] : [])),
    ],
    [object, effects],
  );

  const lifted = pops.map((pop) => ({ pop, lift: pop.lift(t) })).filter((p) => p.lift > 0.001);
  const highest = lifted.reduce((max, p) => Math.max(max, p.lift * p.pop.depth * width), 0);

  let cursor: [number, number] | null = null;
  if (object.cursor.length > 0) {
    const samples = object.cursor;
    const next = samples.findIndex((s) => s.t > t);
    const to = samples[next === -1 ? samples.length - 1 : next];
    const from = samples[Math.max(0, (next === -1 ? samples.length : next) - 1)];
    const p = to.t === from.t ? 1 : Math.min(1, Math.max(0, (t - from.t) / (to.t - from.t)));
    cursor = geometry.toLocal(from.x + (to.x - from.x) * p, from.y + (to.y - from.y) * p);
  }
  const pressed = object.clicks.some((c) => t >= c.t && t - c.t < 0.14);
  const cursorSize = (CURSOR_PIXELS * unit) / 24;

  return (
    <group
      ref={(group) => {
        if (group && registry) registry.set(object.id, { group, width, height, toLocal: geometry.toLocal });
      }}
    >
      <mesh geometry={geometry.backing}>
        <meshBasicMaterial color="#000" />
      </mesh>
      <mesh geometry={geometry.page} position={[0, 0, 0.002]}>
        <MediaMaterial texture={texture} />
      </mesh>

      {ripples.map((ripple, index) => {
        const age = (t - ripple.at) / RIPPLE_SECONDS;
        if (age < 0 || age > 1) return null;
        const [x, y] = geometry.toLocal(ripple.x, ripple.y);
        const size = width * (0.012 + 0.05 * EASE.out(age));
        return (
          <mesh key={index} position={[x, y, 0.004 + highest]} scale={size}>
            <ringGeometry args={[0.78, 1, 48]} />
            <meshBasicMaterial color="#3b6cf6" transparent opacity={0.75 * (1 - age)} depthWrite={false} toneMapped={false} />
          </mesh>
        );
      })}

      {lifted.map(({ pop, lift }, index) => {
        const z = lift * pop.depth * width;
        const grow = 1 + 0.06 * lift;
        return (
          <group key={index}>
            {/* The shadow stays on the page while the element rises, which is what makes the lift readable. */}
            <SoftShadow width={pop.w * 1.15 + z * 3} height={pop.h * 1.3 + z * 3} opacity={0.3 * lift} position={[pop.cx, pop.cy - z * 0.5, 0.003]} />
            <group position={[pop.cx, pop.cy, 0.004 + z]} scale={grow}>
              <mesh geometry={pop.geometry}>
                <MediaMaterial texture={texture} />
              </mesh>
            </group>
          </group>
        );
      })}

      {bursts.map((burst, burstIndex) => {
        const age = t - burst.at;
        if (age < 0 || age > SPARK_SECONDS) return null;
        const [x, y] = geometry.toLocal(burst.x, burst.y);
        return burst.sparks.map((spark, index) => {
          const state = sparkAt(spark, age);
          if (!state) return null;
          const reach = width * 0.15;
          return (
            <mesh key={`${burstIndex}-${index}`} position={[x + state.offset[0] * reach, y + state.offset[1] * reach, 0.01 + highest + state.offset[2] * reach]} scale={width * 0.0055 * state.size}>
              <circleGeometry args={[1, 10]} />
              <meshBasicMaterial color={SPARK_COLORS[spark.color % SPARK_COLORS.length]} transparent opacity={state.opacity} depthWrite={false} toneMapped={false} />
            </mesh>
          );
        });
      })}

      {cursor && (
        <group position={[cursor[0], cursor[1], 0.012 + highest]} scale={cursorSize * (pressed ? 0.86 : 1)}>
          <mesh geometry={geometry.cursor} position={[0, 0, -0.001]} scale={1.16}>
            <meshBasicMaterial color="#ffffff" toneMapped={false} />
          </mesh>
          <mesh geometry={geometry.cursor} position={[0.6, -0.9, 0]}>
            <meshBasicMaterial color="#111111" toneMapped={false} />
          </mesh>
        </group>
      )}
    </group>
  );
};

const ImageSurface: FC<Omit<LayersProps, "texture">> = (props) => <Layers {...props} texture={useImageTexture(props.object.media.src)} />;
const VideoSurface: FC<Omit<LayersProps, "texture">> = (props) => <Layers {...props} texture={useVideoFrameTexture(props.object.media.src, props.object.media.playbackRate)} />;

const Surface: FC<Omit<LayersProps, "texture">> = (props) =>
  props.object.media.kind === "video" ? (
    // A negative start shifts the video so that the scene begins `startFrame` frames into the recording.
    <Sequence from={-props.object.media.startFrame} layout="none">
      <VideoSurface {...props} />
    </Sequence>
  ) : (
    <ImageSurface {...props} />
  );

const ObjectView: FC<{ object: StageObject; effects: StageEffect[] }> = ({ object, effects }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const transform = transformAt(object.base, object.keyframes, frame / fps);
  const mediaAspect = object.media.viewWidth / object.media.viewHeight;
  const surface = (width: number, aspect: number, radius: number): ReactNode => <Surface object={object} effects={effects} width={width} aspect={aspect} radius={radius} />;

  let canonical: number;
  let device: ReactNode;
  if (object.device === "laptop") {
    canonical = LAPTOP_SCREEN.width;
    device = <Laptop>{(width) => surface(width, LAPTOP_SCREEN.aspect, LAPTOP_SCREEN.radius)}</Laptop>;
  } else if (object.device === "phone") {
    canonical = PHONE_SCREEN.width;
    device = <Phone>{(width) => surface(width, PHONE_SCREEN.aspect, PHONE_SCREEN.radius)}</Phone>;
  } else if (object.device === "browser") {
    canonical = BROWSER_SCREEN.width;
    // The window takes the shape of the recording, so nothing of the page is cropped.
    device = <BrowserWindow aspect={mediaAspect}>{(width) => surface(width, mediaAspect, BROWSER_SCREEN.radius)}</BrowserWindow>;
  } else {
    canonical = SCREEN_ONLY.width;
    device = (
      <>
        <SoftShadow width={SCREEN_ONLY.width * 1.4} height={(SCREEN_ONLY.width / mediaAspect) * 1.5} opacity={0.4} position={[0.2, -0.35, -0.4]} />
        {surface(SCREEN_ONLY.width, mediaAspect, SCREEN_ONLY.radius)}
      </>
    );
  }
  const [rx, ry, rz] = transform.rotation;
  return (
    <group position={transform.position} rotation={[rx * RADIANS, ry * RADIANS, rz * RADIANS]} scale={(object.width / canonical) * transform.scale}>
      {device}
    </group>
  );
};

const StageCamera: FC<{ camera: StageProps["camera"] }> = ({ camera: config }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const registry = useContext(Registry)!;
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;

  // Runs after the objects of this frame are placed, so the camera aims at where they are now.
  useLayoutEffect(() => {
    const verticalHalf = Math.tan((config.fov * RADIANS) / 2);
    const horizontalHalf = verticalHalf * (width / height);

    const resolveFocus = (focus: CameraFocus): { position: THREE.Vector3; target: THREE.Vector3 } => {
      const handle = registry.get(focus.object);
      if (!handle) throw new Error(`Camera focuses on object "${focus.object}", which is not in the scene`);
      handle.group.updateWorldMatrix(true, false);
      const [lx, ly] = focus.point ? handle.toLocal(focus.point[0], focus.point[1]) : [0, 0];
      const target = handle.group.localToWorld(new THREE.Vector3(lx, ly, 0));
      const axis = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).transformDirection(handle.group.matrixWorld);
      const scale = handle.group.getWorldScale(new THREE.Vector3()).x;
      // The distance at which the whole screen just fits the frame, divided by the zoom.
      const fitDistance = Math.max((handle.width * scale) / (2 * horizontalHalf), (handle.height * scale) / (2 * verticalHalf));
      const yaw = (focus.yaw ?? 0) * RADIANS;
      const pitch = (focus.pitch ?? 0) * RADIANS;
      const direction = axis(0, 0, 1).multiplyScalar(Math.cos(yaw) * Math.cos(pitch))
        .add(axis(1, 0, 0).multiplyScalar(Math.sin(yaw) * Math.cos(pitch)))
        .add(axis(0, 1, 0).multiplyScalar(Math.sin(pitch)));
      return { position: target.clone().add(direction.multiplyScalar(fitDistance / focus.zoom)), target };
    };
    const resolve = (key: CameraKey) =>
      key.focus ? resolveFocus(key.focus) : { position: new THREE.Vector3(...(key.position ?? [0, 0, 8])), target: new THREE.Vector3(...(key.lookAt ?? [0, 0, 0])) };

    const { from, to, progress } = segmentAt(config.keys, frame / fps);
    const a = resolve(from);
    const b = resolve(to);
    camera.position.copy(a.position.lerp(b.position, progress));
    camera.lookAt(a.target.lerp(b.target, progress));
    camera.fov = config.fov;
    camera.updateProjectionMatrix();
  });
  return null;
};

const Captions: FC<{ captions: StageProps["captions"]; color: string }> = ({ captions, color }) => {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const t = frame / fps;
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {captions.map((caption, index) => {
        if (t < caption.from || t > caption.to) return null;
        const fade = Math.min(0.3, (caption.to - caption.from) / 2);
        const opacity = interpolate(t, [caption.from, caption.from + fade, caption.to - fade, caption.to], [0, 1, 1, 0]);
        return (
          <div
            key={index}
            style={{
              position: "absolute", left: 0, right: 0, [caption.position]: height * 0.06, textAlign: "center", opacity,
              transform: `translateY(${(1 - opacity) * (caption.position === "top" ? -8 : 8)}px)`,
              font: `650 ${Math.round(height * 0.05)}px -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`,
              letterSpacing: "-0.01em", color,
            }}
          >
            {caption.text}
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

/** A directed 3D scene: devices showing real recordings, a camera that can travel to any point of the page, click effects. */
export const Stage3D: FC<StageProps> = ({ width, height, background, captionColor, objects, camera, effects, captions }) => {
  const registry = useMemo(() => new Map<string, SurfaceHandle>(), []);
  return (
    <AbsoluteFill style={{ background }}>
      <ThreeCanvas width={width} height={height} camera={{ fov: camera.fov, near: 0.05, far: 200 }} gl={{ antialias: true }}>
        <Registry.Provider value={registry}>
          <ambientLight intensity={1.25} />
          <directionalLight intensity={2} position={[4, 6, 6]} />
          <directionalLight intensity={0.7} position={[-5, 2, 3]} color="#cdd8ff" />
          {objects.map((object) => (
            <ObjectView key={object.id} object={object} effects={effects} />
          ))}
          <StageCamera camera={camera} />
          <FrameSync />
        </Registry.Provider>
      </ThreeCanvas>
      <Captions captions={captions} color={captionColor} />
    </AbsoluteFill>
  );
};
