import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { assertValid, findProvenance, insideRepo, readManifest, UsageError, type HumanTodo } from "@repokit/core";
import { detectStack, loadContext, loadOptions, technologyByName } from "@repokit/readme";
import type { DeckChip, DeckLayout, DeckProps, DeckSlide, DeckTheme } from "./remotion/Deck.js";
import type { BackgroundName } from "./scene.js";

/** A deck as written by its author; see schemas/deck.schema.json. */
export interface Deck {
  schemaVersion: 1;
  size?: { width: number; height: number };
  theme?: BackgroundName;
  footer?: string;
  slides: {
    layout: DeckLayout;
    kicker?: string;
    heading?: string;
    body?: string;
    bullets?: string[];
    image?: string;
    frame?: "browser" | "phone" | "none";
    caption?: string;
    chips?: (string | DeckChip)[];
  }[];
}

export const DECK_SIZES = { slides: { width: 1920, height: 1080 }, banner: { width: 1280, height: 640 } } as const;
export type DeckKind = keyof typeof DECK_SIZES;

const THEMES: Record<BackgroundName, DeckTheme> = {
  light: { background: "radial-gradient(120% 120% at 12% 8%, #dbe6ff 0%, rgba(219,230,255,0) 55%), radial-gradient(110% 110% at 92% 94%, #ffe1ee 0%, rgba(255,225,238,0) 55%), #f2f3f8", text: "#141a2b", muted: "#4b5670", accent: "#3157d5", card: "#ffffff", border: "rgba(20,26,43,0.12)" },
  dark: { background: "radial-gradient(120% 120% at 12% 8%, #2b3170 0%, rgba(43,49,112,0) 55%), radial-gradient(110% 110% at 92% 94%, #4d2152 0%, rgba(77,33,82,0) 55%), #0c0e18", text: "#f1f3fa", muted: "#aab2c8", accent: "#8ea6ff", card: "rgba(255,255,255,0.08)", border: "rgba(255,255,255,0.16)" },
  glass: { background: "linear-gradient(135deg, #5b7cfa 0%, #a56cc1 55%, #ff9a8b 100%)", text: "#ffffff", muted: "rgba(255,255,255,0.86)", accent: "#fff3c4", card: "rgba(255,255,255,0.2)", border: "rgba(255,255,255,0.4)" },
  sunset: { background: "linear-gradient(160deg, #ffb88c 0%, #de6262 55%, #5b247a 100%)", text: "#ffffff", muted: "rgba(255,255,255,0.88)", accent: "#ffe9a8", card: "rgba(255,255,255,0.2)", border: "rgba(255,255,255,0.4)" },
  mint: { background: "radial-gradient(110% 110% at 85% 10%, #c9f7e4 0%, rgba(201,247,228,0) 55%), linear-gradient(160deg, #e9fbf4 0%, #dfeeff 100%)", text: "#10302a", muted: "#3f5f58", accent: "#0f8a6a", card: "#ffffff", border: "rgba(16,48,42,0.14)" },
  mono: { background: "radial-gradient(100% 100% at 50% 30%, #2a2c33 0%, #0e0f12 100%)", text: "#f4f4f6", muted: "#a9abb3", accent: "#f4f4f6", card: "rgba(255,255,255,0.08)", border: "rgba(255,255,255,0.18)" },
};

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const MAX_FEATURES = 6;
const MAX_SHOTS = 3;

export function loadDeck(file: string): Deck {
  if (!existsSync(file)) throw new UsageError(`Файл не найден: ${file}`);
  let deck: Deck;
  try {
    deck = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new UsageError(`${file}: некорректный JSON`);
  }
  assertValid("deck", deck);
  return deck;
}

export interface ResolvedDeck {
  props: DeckProps;
  files: { source: string; name: string }[];
  warnings: string[];
}

/** Check a deck against the files it refers to and turn it into render props. */
export function resolveDeck(repo: string, deck: Deck, kind: DeckKind = "slides"): ResolvedDeck {
  const size = deck.size ?? DECK_SIZES[kind];
  const warnings: string[] = [];
  const files: ResolvedDeck["files"] = [];
  const slides: DeckSlide[] = deck.slides.map((slide, index) => {
    let image: string | undefined;
    if (slide.image) {
      const source = insideRepo(repo, slide.image);
      if (!existsSync(source)) throw new UsageError(`Слайд ${index + 1}: изображение не найдено — ${slide.image}`);
      const extension = extname(source).toLowerCase();
      if (!IMAGE_EXT.has(extension)) throw new UsageError(`Слайд ${index + 1}: ${slide.image} — не изображение`);
      if (!findProvenance(repo, source)) warnings.push(`слайд ${index + 1}: происхождение неизвестно — ${slide.image} не снят через repokit capture`);
      image = `slide-${index + 1}${extension}`;
      files.push({ source, name: image });
    }
    if ((slide.layout === "image") && !slide.image) throw new UsageError(`Слайд ${index + 1}: для layout image нужно изображение`);
    return {
      ...slide,
      image,
      chips: slide.chips?.map((chip) => (typeof chip === "string" ? { label: chip, color: technologyByName(chip).color === "555555" ? undefined : technologyByName(chip).color } : chip)),
    };
  });
  return {
    props: { ...size, fps: 1, durationInFrames: slides.length, theme: THEMES[deck.theme ?? "light"], footer: deck.footer ?? "", slides },
    files,
    warnings,
  };
}

/** Screenshots of the most recent capture run, in the order they were taken. */
function recentScreenshots(repo: string): { path: string; phone: boolean }[] {
  let media;
  try {
    media = readManifest(repo).media;
  } catch {
    return [];
  }
  const shots = media.filter((m) => m.kind === "screenshot" && existsSync(insideRepo(repo, m.path)));
  const lastRun = shots[shots.length - 1]?.source?.runId;
  return shots.filter((m) => m.source?.runId === lastRun).map((m) => ({ path: m.path, phone: /-mobile-/.test(m.path) }));
}

export interface DraftDeck {
  deck: Deck;
  humanTodo: HumanTodo[];
}

/**
 * A deck assembled from what is known about the project: the author's own words,
 * claims backed by code, detected technologies, real screenshots. Nothing is written for the author.
 */
export function deckFromFacts(repo: string, kind: DeckKind, theme: BackgroundName = "light"): DraftDeck {
  const context = loadContext(repo, loadOptions(repo));
  const { human, scan } = context;
  const title = human.title ?? scan.project.name;
  const humanTodo: HumanTodo[] = [];
  const need = (id: string, what: string) => humanTodo.push({ id: `deck.${id}`, text: `Презентация: ${what} — заполните в .repokit/readme.human.yaml` });
  const shots = recentScreenshots(repo);
  const desktop = shots.filter((s) => !s.phone);
  const stack = detectStack(scan, context.files).filter((t) => !["HTML5", "CSS3"].includes(t.name));
  const chips = stack.map((t) => t.name);
  const proven = context.claims.filter((c) => (c.status === "implemented" || c.status === "partial") && c.evidence.length > 0);
  const gaps = context.claims.filter((c) => c.status === "mock" || (c.status === "partial" && c.note));
  const cover = desktop[desktop.length - 1] ?? shots[shots.length - 1];
  if (!human.tagline) need("tagline", "нет тэглайна (поле tagline)");
  if (!cover) humanTodo.push({ id: "deck.shots", text: "Презентация: нет скриншотов — снимите их: repokit capture run или capture shots" });

  const titleSlide: Deck["slides"][number] = {
    layout: "title",
    heading: title,
    ...(human.tagline ? { body: human.tagline } : {}),
    ...(cover ? { image: cover.path, frame: cover.phone ? "phone" : "browser" } : {}),
    ...(kind === "banner" && chips.length ? { chips } : {}),
  };
  if (kind === "banner") return { deck: { schemaVersion: 1, size: DECK_SIZES.banner, theme, slides: [titleSlide] }, humanTodo };

  const slides: Deck["slides"] = [titleSlide];
  // The first sentence becomes the heading; the rest, if any, the body.
  const textSlide = (kicker: string, text: string): Deck["slides"][number] => {
    const [first, ...rest] = text.trim().split(/(?<=[.!?])\s+/);
    return { layout: "text", kicker, heading: first, ...(rest.length ? { body: rest.join(" ") } : {}) };
  };
  if (human.problem) slides.push(textSlide(context.i18n.headings.problem, human.problem));
  else need("problem", "нет описания проблемы (поле problem)");
  if (human.solution) slides.push(textSlide(context.i18n.headings.solution, human.solution));
  else need("solution", "нет описания решения (поле solution)");
  if (proven.length > 0) slides.push({ layout: "bullets", kicker: context.i18n.headings.features, heading: "Что уже работает", bullets: proven.slice(0, MAX_FEATURES).map((c) => c.text) });
  else humanTodo.push({ id: "deck.claims", text: "Презентация: нет утверждений, подтверждённых кодом — слайд о возможностях пропущен" });
  for (const shot of shots.slice(0, MAX_SHOTS)) slides.push({ layout: "image", image: shot.path, frame: shot.phone ? "phone" : "browser" });
  if (chips.length > 0) slides.push({ layout: "chips", kicker: context.i18n.headings.stack, heading: "На чём сделано", chips });
  // The deck says what is not done yet, the same way the README does.
  if (gaps.length > 0) slides.push({ layout: "bullets", kicker: context.i18n.headings.limitations, heading: "Что ещё не готово", bullets: gaps.map((c) => (c.status === "mock" ? `${c.text} — пока заглушка` : `${c.text} — ${c.note}`)) });
  if (human.team?.length) slides.push({ layout: "bullets", kicker: context.i18n.headings.team, heading: "Кто это сделал", bullets: human.team.map((m) => (m.role ? `${m.name} — ${m.role}` : m.name)) });
  const links = [
    context.github ? `github.com/${context.github.owner}/${context.github.repo}` : "",
    human.demoUrl ?? context.deployment?.url ?? "",
  ].filter(Boolean);
  if (links.length > 0) slides.push({ layout: "bullets", kicker: "Ссылки", heading: title, bullets: links });
  return { deck: { schemaVersion: 1, size: DECK_SIZES.slides, theme, footer: title, slides }, humanTodo };
}

/** A PDF with one JPEG per page, written by hand: there is nothing in it but the images. */
export function imagesToPdf(pages: { jpeg: Buffer; width: number; height: number }[]): Buffer {
  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;
  const write = (data: string | Buffer) => {
    const buffer = typeof data === "string" ? Buffer.from(data, "latin1") : data;
    chunks.push(buffer);
    length += buffer.length;
  };
  const object = (id: number, body: string, stream?: Buffer) => {
    offsets[id] = length;
    write(`${id} 0 obj\n${body}\n`);
    if (stream) {
      write("stream\n");
      write(stream);
      write("\nendstream\n");
    }
    write("endobj\n");
  };

  write("%PDF-1.4\n");
  // Objects: 1 catalog, 2 page tree, then per page: page, content stream, image.
  const pageIds = pages.map((_, index) => 3 + index * 3);
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  pages.forEach((page, index) => {
    const id = pageIds[index];
    const content = Buffer.from(`q ${page.width} 0 0 ${page.height} 0 0 cm /Im0 Do Q`, "latin1");
    object(id, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}] /Resources << /XObject << /Im0 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`);
    object(id + 1, `<< /Length ${content.length} >>`, content);
    object(id + 2, `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>`, page.jpeg);
  });
  const count = 3 + pages.length * 3;
  const xref = length;
  write(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let id = 1; id < count; id++) write(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  write(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(chunks);
}
