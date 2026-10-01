import type { CSSProperties, FC } from "react";
import { AbsoluteFill, interpolate, OffthreadVideo, Series, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { cameraAt, cursorAt, ripplesAt } from "../camera.js";
import type { DemoProps, SceneProps, StyleName } from "./props.js";

interface Theme {
  background: string;
  bar: string;
  border: string;
  dot: string;
  shadow: string;
  title: string;
  /** Translucent frame around the window, used by the glass style. */
  frame?: { padding: number; background: string; border: string };
}

const THEMES: Record<StyleName, Theme> = {
  light: {
    background:
      "radial-gradient(120% 120% at 12% 8%, #dbe6ff 0%, rgba(219,230,255,0) 55%), radial-gradient(110% 110% at 92% 94%, #ffe1ee 0%, rgba(255,225,238,0) 55%), #f2f3f8",
    bar: "#f5f6f8",
    border: "rgba(15, 23, 42, 0.10)",
    dot: "#d3d7de",
    shadow: "0 50px 90px -30px rgba(40, 50, 110, 0.40), 0 18px 36px -18px rgba(40, 50, 110, 0.28)",
    title: "#1c2333",
  },
  dark: {
    background:
      "radial-gradient(120% 120% at 12% 8%, #2b3170 0%, rgba(43,49,112,0) 55%), radial-gradient(110% 110% at 92% 94%, #4d2152 0%, rgba(77,33,82,0) 55%), #0c0e18",
    bar: "#22242d",
    border: "rgba(255, 255, 255, 0.10)",
    dot: "#3e414c",
    shadow: "0 50px 90px -30px rgba(0, 0, 0, 0.75), 0 18px 36px -18px rgba(0, 0, 0, 0.6)",
    title: "#eef0f7",
  },
  glass: {
    background: "linear-gradient(135deg, #5b7cfa 0%, #a56cc1 55%, #ff9a8b 100%)",
    bar: "rgba(255, 255, 255, 0.72)",
    border: "rgba(255, 255, 255, 0.55)",
    dot: "rgba(60, 70, 110, 0.28)",
    shadow: "0 50px 90px -30px rgba(30, 20, 80, 0.55), 0 18px 36px -18px rgba(30, 20, 80, 0.35)",
    title: "#ffffff",
    frame: { padding: 12, background: "rgba(255, 255, 255, 0.22)", border: "rgba(255, 255, 255, 0.45)" },
  },
};

/** Share of the frame the window may occupy. */
const MAX_WINDOW_WIDTH = 0.84;
const MAX_WINDOW_HEIGHT = 0.8;
const BAR_HEIGHT = 0.05;
const TITLE_HEIGHT = 0.1;
const CORNER_RADIUS = 0.018;
const INTRO_FRAMES = 18;
/** Cursor and ripple sizes in source CSS pixels, so they scale with the recording. */
const CURSOR_SIZE = 26;
const RIPPLE_RADIUS = 34;
const FONT = "-apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

// An original arrow shape; not copied from any operating system.
const Cursor: FC<{ size: number }> = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: "block", filter: "drop-shadow(0 2px 3px rgba(0,0,0,0.35))" }}>
    <path d="M4 2 L4 19.5 L8.6 15.4 L11.7 22 L14.6 20.7 L11.6 14.2 L17.8 14.2 Z" fill="#111" stroke="#fff" strokeWidth="1.6" strokeLinejoin="round" />
  </svg>
);

const SceneView: FC<{ scene: SceneProps; theme: Theme; first: boolean }> = ({ scene, theme, first }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  const barHeight = Math.round(height * BAR_HEIGHT);
  const titleHeight = scene.title ? Math.round(height * TITLE_HEIGHT) : 0;
  const framePadding = theme.frame?.padding ?? 0;
  const aspect = scene.sourceWidth / scene.sourceHeight;
  const maxContentHeight = height * MAX_WINDOW_HEIGHT - barHeight - titleHeight - framePadding * 2;
  const contentWidth = Math.round(Math.min(width * MAX_WINDOW_WIDTH - framePadding * 2, maxContentHeight * aspect));
  const contentHeight = Math.round(contentWidth / aspect);
  const k = contentWidth / scene.sourceWidth;
  const radius = Math.round(width * CORNER_RADIUS);

  const t = scene.in + (frame / fps) * scene.speed;
  const camera = cameraAt(scene.camera, t);
  const cursor = cursorAt(scene.cursor, t);
  const ripples = ripplesAt(scene.clicks, t);
  const pressed = ripples.some((r) => r.progress < 0.3);

  const intro = first ? interpolate(frame, [0, INTRO_FRAMES], [0, 1], { extrapolateRight: "clamp" }) : 1;
  const introEased = 1 - Math.pow(1 - intro, 3);

  const view: CSSProperties = {
    width: contentWidth,
    height: contentHeight,
    transformOrigin: "0 0",
    transform: `translate(${contentWidth / 2 - camera.x * k * camera.scale}px, ${contentHeight / 2 - camera.y * k * camera.scale}px) scale(${camera.scale})`,
  };

  const windowNode = (
    <div style={{ borderRadius: radius, overflow: "hidden", boxShadow: theme.frame ? undefined : theme.shadow, border: `1px solid ${theme.border}` }}>
      <div style={{ height: barHeight, background: theme.bar, display: "flex", alignItems: "center", gap: barHeight * 0.22, paddingLeft: barHeight * 0.45, borderBottom: `1px solid ${theme.border}` }}>
        {[0, 1, 2].map((i) => (
          <div key={i} style={{ width: barHeight * 0.32, height: barHeight * 0.32, borderRadius: "50%", background: theme.dot }} />
        ))}
      </div>
      <div style={{ width: contentWidth, height: contentHeight, overflow: "hidden", position: "relative", background: "#fff" }}>
        <div style={view}>
          <OffthreadVideo
            src={staticFile(scene.src)}
            trimBefore={Math.round(scene.in * fps)}
            playbackRate={scene.speed}
            muted
            style={{ width: contentWidth, height: contentHeight, display: "block" }}
          />
          {ripples.map((ripple, index) => {
            const size = RIPPLE_RADIUS * 2 * k * (0.3 + 0.7 * ripple.progress);
            return (
              <div
                key={index}
                style={{
                  position: "absolute",
                  left: ripple.x * k - size / 2,
                  top: ripple.y * k - size / 2,
                  width: size,
                  height: size,
                  borderRadius: "50%",
                  background: "rgba(59, 108, 246, 0.22)",
                  border: `${Math.max(1, 2 * k)}px solid rgba(59, 108, 246, 0.65)`,
                  opacity: 1 - ripple.progress,
                }}
              />
            );
          })}
          {cursor && (
            <div
              style={{
                position: "absolute",
                // The arrow tip sits at (4, 2) in its 24-unit box.
                left: cursor.x * k - (4 / 24) * CURSOR_SIZE * k,
                top: cursor.y * k - (2 / 24) * CURSOR_SIZE * k,
                transform: `scale(${pressed ? 0.86 : 1})`,
                transformOrigin: "20% 10%",
              }}
            >
              <Cursor size={CURSOR_SIZE * k} />
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", flexDirection: "column", opacity: introEased, transform: `translateY(${(1 - introEased) * height * 0.03}px) scale(${0.97 + 0.03 * introEased})` }}>
      {scene.title && (
        <div style={{ height: titleHeight, display: "flex", alignItems: "center", fontFamily: FONT, fontWeight: 650, fontSize: Math.round(height * 0.048), color: theme.title, letterSpacing: "-0.01em" }}>
          {scene.title}
        </div>
      )}
      {theme.frame ? (
        <div style={{ padding: theme.frame.padding, borderRadius: radius + theme.frame.padding, background: theme.frame.background, border: `1px solid ${theme.frame.border}`, boxShadow: theme.shadow }}>
          {windowNode}
        </div>
      ) : (
        windowNode
      )}
    </AbsoluteFill>
  );
};

export const Demo: FC<DemoProps> = ({ style, scenes }) => {
  const theme = THEMES[style];
  return (
    <AbsoluteFill style={{ background: theme.background }}>
      <Series>
        {scenes.map((scene, index) => (
          <Series.Sequence key={index} durationInFrames={scene.durationInFrames}>
            <SceneView scene={scene} theme={theme} first={index === 0} />
          </Series.Sequence>
        ))}
      </Series>
    </AbsoluteFill>
  );
};
