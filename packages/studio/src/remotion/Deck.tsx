import type { CSSProperties, FC, ReactNode } from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";

export const DECK_LAYOUTS = ["title", "text", "bullets", "image", "split", "chips"] as const;
export type DeckLayout = (typeof DECK_LAYOUTS)[number];

export type DeckChip = { label: string; color?: string };

/** One still image: a slide of a presentation or a banner. */
export type DeckSlide = {
  layout: DeckLayout;
  /** Small label above the heading. */
  kicker?: string;
  heading?: string;
  body?: string;
  bullets?: string[];
  /** File name inside the bundle's public directory. */
  image?: string;
  /** How the image is framed: a browser window, a phone, or as is. */
  frame?: "browser" | "phone" | "none";
  caption?: string;
  chips?: DeckChip[];
};

export type DeckTheme = { background: string; text: string; muted: string; accent: string; card: string; border: string };

// A type alias, not an interface: Remotion requires props assignable to Record<string, unknown>.
export type DeckProps = {
  width: number;
  height: number;
  fps: number;
  /** One frame per slide. */
  durationInFrames: number;
  theme: DeckTheme;
  footer: string;
  slides: DeckSlide[];
};

const FONT = "-apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

/** The image inside a neutral device frame drawn with CSS: no real browser's or phone's design. */
const Framed: FC<{ slide: DeckSlide; theme: DeckTheme; u: number; tilt?: boolean; maxHeight: number }> = ({ slide, theme, u, tilt, maxHeight }) => {
  if (!slide.image) return null;
  const image = <Img src={staticFile(slide.image)} style={{ display: "block", maxWidth: "100%", maxHeight: slide.frame === "browser" ? maxHeight - 44 * u : maxHeight }} />;
  const shadow = `0 ${40 * u}px ${90 * u}px ${-30 * u}px rgba(20, 24, 60, 0.55), 0 ${14 * u}px ${32 * u}px ${-14 * u}px rgba(20, 24, 60, 0.3)`;
  let framed: ReactNode;
  if (slide.frame === "phone") {
    framed = <div style={{ padding: 12 * u, borderRadius: 54 * u, background: "#22242b", boxShadow: shadow }}><div style={{ borderRadius: 42 * u, overflow: "hidden" }}>{image}</div></div>;
  } else if (slide.frame === "none") {
    framed = <div style={{ borderRadius: 18 * u, overflow: "hidden", boxShadow: shadow }}>{image}</div>;
  } else {
    framed = (
      <div style={{ borderRadius: 18 * u, overflow: "hidden", boxShadow: shadow, border: `1px solid ${theme.border}`, background: "#fff" }}>
        <div style={{ height: 44 * u, background: "#f4f5f8", display: "flex", alignItems: "center", gap: 10 * u, paddingLeft: 20 * u, borderBottom: "1px solid rgba(15,23,42,0.1)" }}>
          {[0, 1, 2].map((i) => <div key={i} style={{ width: 14 * u, height: 14 * u, borderRadius: "50%", background: "#cfd3db" }} />)}
        </div>
        {image}
      </div>
    );
  }
  return (
    <div style={{ display: "flex", justifyContent: "center", perspective: 2400 * u }}>
      <div style={{ transform: tilt ? "rotateY(-13deg) rotateX(4deg)" : undefined, transformOrigin: "left center" }}>{framed}</div>
    </div>
  );
};

const Chips: FC<{ chips: DeckChip[]; theme: DeckTheme; u: number; large?: boolean }> = ({ chips, theme, u, large }) => (
  <div style={{ display: "flex", flexWrap: "wrap", gap: (large ? 20 : 14) * u, justifyContent: large ? "center" : "flex-start" }}>
    {chips.map((chip, index) => (
      <div
        key={index}
        style={{
          padding: `${(large ? 18 : 10) * u}px ${(large ? 34 : 22) * u}px`, borderRadius: 999,
          font: `600 ${(large ? 40 : 26) * u}px ${FONT}`, letterSpacing: "0.01em",
          background: chip.color ? `#${chip.color}` : theme.card, color: chip.color ? "#fff" : theme.text,
          border: chip.color ? "none" : `1px solid ${theme.border}`,
        }}
      >
        {chip.label}
      </div>
    ))}
  </div>
);

const Slide: FC<{ slide: DeckSlide; theme: DeckTheme; u: number; width: number; height: number }> = ({ slide, theme, u, width, height }) => {
  const kicker = slide.kicker && <div style={{ font: `700 ${26 * u}px ${FONT}`, letterSpacing: "0.12em", textTransform: "uppercase", color: theme.accent, marginBottom: 22 * u }}>{slide.kicker}</div>;
  const heading = (size: number) => slide.heading && <div style={{ font: `750 ${size * u}px/1.08 ${FONT}`, letterSpacing: "-0.025em", color: theme.text }}>{slide.heading}</div>;
  const body = (size: number) => slide.body && <div style={{ font: `400 ${size * u}px/1.4 ${FONT}`, color: theme.muted, marginTop: 30 * u, whiteSpace: "pre-wrap" }}>{slide.body}</div>;
  const chips = slide.chips?.length ? <div style={{ marginTop: 44 * u }}><Chips chips={slide.chips} theme={theme} u={u} /></div> : null;
  const column: CSSProperties = { display: "flex", flexDirection: "column", justifyContent: "center", height: "100%" };

  switch (slide.layout) {
    case "split":
    case "title": {
      const hasImage = Boolean(slide.image);
      return (
        <div style={{ display: "flex", alignItems: "center", gap: 70 * u, height: "100%" }}>
          <div style={{ flex: hasImage ? "0 0 44%" : 1, textAlign: hasImage ? "left" : "center" }}>
            {kicker}
            {heading(slide.layout === "title" ? 104 : 80)}
            {body(slide.layout === "title" ? 46 : 40)}
            {chips}
          </div>
          {hasImage && <div style={{ flex: 1, minWidth: 0 }}><Framed slide={slide} theme={theme} u={u} tilt maxHeight={height * 0.72} /></div>}
        </div>
      );
    }
    case "bullets":
      return (
        <div style={column}>
          {kicker}
          {heading(72)}
          <div style={{ marginTop: 44 * u, display: "flex", flexDirection: "column", gap: 26 * u }}>
            {(slide.bullets ?? []).map((bullet, index) => (
              <div key={index} style={{ display: "flex", gap: 26 * u, alignItems: "baseline", font: `450 ${42 * u}px/1.3 ${FONT}`, color: theme.text }}>
                <div style={{ flex: "none", width: 16 * u, height: 16 * u, borderRadius: "50%", background: theme.accent, transform: `translateY(${-5 * u}px)` }} />
                <div>{bullet}</div>
              </div>
            ))}
          </div>
        </div>
      );
    case "image":
      return (
        <div style={{ ...column, alignItems: "center" }}>
          {(slide.kicker || slide.heading) && <div style={{ alignSelf: "stretch", marginBottom: 36 * u }}>{kicker}{heading(60)}</div>}
          <Framed slide={slide} theme={theme} u={u} maxHeight={height * (slide.heading ? 0.6 : 0.74)} />
          {slide.caption && <div style={{ marginTop: 28 * u, font: `400 ${30 * u}px ${FONT}`, color: theme.muted }}>{slide.caption}</div>}
        </div>
      );
    case "chips":
      return (
        <div style={{ ...column, alignItems: "center", textAlign: "center" }}>
          {kicker}
          {heading(72)}
          <div style={{ marginTop: 56 * u, maxWidth: width * 0.8 }}><Chips chips={slide.chips ?? []} theme={theme} u={u} large /></div>
        </div>
      );
    default:
      return (
        <div style={{ ...column, maxWidth: width * 0.78 }}>
          {kicker}
          {heading(76)}
          {body(46)}
        </div>
      );
  }
};

/** A set of still slides: frame N of the composition is slide N. */
export const Deck: FC<DeckProps> = ({ theme, slides, footer }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const slide = slides[Math.min(frame, slides.length - 1)];
  // All sizes are expressed for a 1920-wide slide and scale with the actual width.
  const u = width / 1920;
  if (!slide) return <AbsoluteFill style={{ background: theme.background }} />;
  return (
    <AbsoluteFill style={{ background: theme.background, padding: `${Math.min(90 * u, height * 0.11)}px ${110 * u}px`, boxSizing: "border-box" }}>
      <Slide slide={slide} theme={theme} u={u} width={width} height={height} />
      {slides.length > 1 && (
        <div style={{ position: "absolute", left: 110 * u, right: 110 * u, bottom: 40 * u, display: "flex", justifyContent: "space-between", font: `500 ${22 * u}px ${FONT}`, color: theme.muted, opacity: 0.8 }}>
          <span>{footer}</span>
          <span>{frame + 1} / {slides.length}</span>
        </div>
      )}
    </AbsoluteFill>
  );
};
