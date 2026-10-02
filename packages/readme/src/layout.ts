import type { ReadmeSlotId } from "@repokit/core";
import { buildGraph } from "./architecture.js";
import type { Context, ReadmePreset } from "./context.js";
import { KIND_TITLES, STRATEGIES, STYLES, type DemoKind, type Priority, type ProjectKind, type Style } from "./profile.js";

export interface LayoutSection {
  id: ReadmeSlotId;
  /** `omit` keeps the decision visible: the section was considered and left out, with the reason. */
  priority: Priority | "omit";
  reason: string;
  collapsible?: boolean;
}

export interface ExistingSection {
  heading: string;
  lines: number;
  words: number;
  /** The generated section that covers the same ground, if any. */
  slot: ReadmeSlotId | null;
}

/** The plan of a README, made before any of it is written. */
export interface Layout {
  schemaVersion: 1;
  projectType: ProjectKind;
  confidence: number;
  signals: string[];
  alternatives: ProjectKind[];
  style: Style;
  audience: string[];
  primaryAction: "open-demo" | "install" | "quick-start" | "read-docs";
  hero: boolean;
  demo: DemoKind;
  screenshots: number;
  architectureDiagram: boolean;
  quickStart: boolean;
  usageExamples: boolean;
  comparisonTable: boolean;
  sections: LayoutSection[];
  /** What is already written. A substantial README is improved, not regenerated. */
  existing: { lines: number; sections: ExistingSection[] } | null;
  mode: "generate" | "improve";
}

/** A README this long, with this many sections, is somebody's work: it is edited, not replaced. */
const SUBSTANTIAL = { lines: 60, sections: 4 };
/** Above these sizes a section goes into a collapsible block. */
const COLLAPSE = { configuration: 8, routes: 10, commands: 14 };
/** Which priorities each style keeps. */
const STYLE_KEEPS: Record<Style, Set<Priority>> = {
  minimal: new Set(["must"]),
  developer: new Set(["must", "should"]),
  product: new Set(["must", "should"]),
  showcase: new Set(["must", "should", "optional"]),
  research: new Set(["must", "should"]),
  docs: new Set(["must", "should", "optional"]),
};
const CENTERED_STYLES = new Set<Style>(["showcase", "product"]);

const SLOT_BY_HEADING: [RegExp, ReadmeSlotId][] = [
  [/quick ?start|getting started|install|setup|установк|запуск|быстрый старт|начало работы/i, "quickstart"],
  [/usage|example|how to use|использовани|пример/i, "usage"],
  [/features|highlights|возможност|функци|что умеет/i, "features"],
  [/config|environment|settings|настройк|переменные|конфигураци/i, "configuration"],
  [/architecture|how it works|design|архитектур|как устроен|как это работает/i, "architecture"],
  [/commands|cli|команд/i, "commands"],
  [/api|endpoints|routes|роут|эндпоинт/i, "routes"],
  [/demo|screenshots?|preview|демо|скриншот/i, "demo"],
  [/tech stack|built with|технолог|стек/i, "stack"],
  [/limitations|roadmap|known issues|todo|ограничени|планы/i, "limitations"],
  [/team|authors|maintainers|команда|авторы/i, "team"],
  [/licen[sc]e|лицензи/i, "license"],
  [/packages|пакеты/i, "packages"],
];

/** What the existing README consists of, section by section. */
export function analyzeExisting(markdown: string | null): Layout["existing"] {
  if (!markdown) return null;
  const lines = markdown.split(/\r?\n/);
  const sections: ExistingSection[] = [];
  let current: { heading: string; body: string[] } | null = null;
  let fence = false;
  const close = () => {
    if (!current) return;
    const body = current.body.join("\n");
    sections.push({
      heading: current.heading,
      lines: current.body.filter((l) => l.trim()).length,
      words: body.split(/\s+/).filter(Boolean).length,
      slot: SLOT_BY_HEADING.find(([pattern]) => pattern.test(current!.heading))?.[1] ?? null,
    });
  };
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const heading = fence ? null : line.match(/^##\s+(.+?)\s*#*\s*$/);
    if (heading) {
      close();
      current = { heading: heading[1], body: [] };
    } else current?.body.push(line);
  }
  close();
  return { lines: lines.filter((l) => l.trim()).length, sections };
}

/**
 * Decide what the README should contain and in what order, from the kind of project
 * and from what the repository actually has to show.
 */
export function planLayout(ctx: Context, existingReadme: string | null, styleOverride?: Style): Layout {
  const { profile, scan, human, examples } = ctx;
  const strategy = STRATEGIES[profile.kind];
  const style = styleOverride ?? strategy.style;
  const graph = buildGraph(ctx.repo, scan, ctx.files);
  const live = human.demoUrl ?? ctx.deployment?.url;
  const runnable = Boolean(scan.project.commands.run) || scan.project.types.includes("static-site");
  const cliEntries = examples.commands.length + examples.options.length;
  const gaps = ctx.claims.some((c) => c.status === "mock" || (c.status === "partial" && c.note)) || Boolean(human.roadmap?.length);

  // Why a section the strategy asks for has nothing to show; null when it does.
  const nothingToShow: Partial<Record<ReadmeSlotId, () => string | null>> = {
    hero: () => (ctx.options.hero ? null : strategy.demo === "none" ? "для такого проекта картинка в начале не нужна" : null),
    usage: () => (examples.examples.length > 0 ? null : "в репозитории не найдено примеров использования (папка examples, документация, тесты)"),
    commands: () => (cliEntries >= 2 ? null : "команд и опций командной строки не найдено"),
    configuration: () => (ctx.envVars.length > 0 ? null : "код не читает переменных окружения"),
    routes: () => (scan.routes.some((r) => r.framework !== "static") ? null : "роутов не найдено"),
    architecture: () => (graph.nodes.length >= 3 ? null : "меньше трёх связанных модулей — схема ничего не объяснит"),
    packages: () => (ctx.packages.length >= 2 ? null : "в репозитории один пакет"),
    demo: () => (live || human.videoUrl ? null : "нет ссылки на работающую версию или видео"),
    limitations: () => (gaps || !scan.repoHealth.hasTests ? null : "известных ограничений не записано"),
  };

  const sections: LayoutSection[] = strategy.sections.map(([id, priority]) => {
    const missing = nothingToShow[id]?.();
    // A section that must be there stays even when empty: the blank is a task for the author.
    if (missing && (priority !== "must" || id === "commands" || id === "packages" || id === "routes" || id === "configuration")) return { id, priority: "omit", reason: missing };
    const collapsible =
      (id === "configuration" && ctx.envVars.length > COLLAPSE.configuration) ||
      (id === "routes" && scan.routes.length > COLLAPSE.routes) ||
      (id === "commands" && cliEntries > COLLAPSE.commands) ||
      (id === "architecture" && priority !== "must" && style === "docs");
    return { id, priority, reason: `${KIND_TITLES[profile.kind]}: ${priority === "must" ? "без этого раздела README не отвечает на главный вопрос" : priority === "should" ? "полезно большинству читателей" : "по желанию"}`, ...(collapsible ? { collapsible: true } : {}) };
  });

  // Sections that exist only because the author or a hackathon brief gave something to put there.
  const insertAfter = (anchor: ReadmeSlotId, section: LayoutSection) => {
    if (sections.some((s) => s.id === section.id)) return;
    const index = sections.findIndex((s) => s.id === anchor);
    sections.splice(index === -1 ? sections.length - 1 : index + 1, 0, section);
  };
  if (human.solution) insertAfter(sections.some((s) => s.id === "hero") ? "hero" : "header", { id: "solution", priority: "should", reason: "автор описал решение" });
  if (human.problem) insertAfter(sections.some((s) => s.id === "hero") ? "hero" : "header", { id: "problem", priority: "should", reason: "автор описал проблему" });
  const beforeLicense = (section: LayoutSection) => {
    if (sections.some((s) => s.id === section.id)) return;
    const index = sections.findIndex((s) => s.id === "license");
    sections.splice(index === -1 ? sections.length : index, 0, section);
  };
  if (ctx.brief) beforeLicense({ id: "judges", priority: "should", reason: "есть разбор правил хакатона (brief.json)" });
  if (human.team?.length) beforeLicense({ id: "team", priority: "should", reason: "автор указал команду" });

  const kept = STYLE_KEEPS[style];
  for (const section of sections) {
    if (section.priority !== "omit" && !kept.has(section.priority)) {
      section.reason = `стиль «${style}» оставляет только ${[...kept].join(" и ")}; этот раздел — ${section.priority}`;
      section.priority = "omit";
    }
  }
  for (const id of human.skip ?? []) {
    const section = sections.find((s) => s.id === id);
    if (section) Object.assign(section, { priority: "omit", reason: "автор исключил раздел (skip)" });
  }

  const existing = analyzeExisting(existingReadme);
  const present = (id: ReadmeSlotId) => sections.some((s) => s.id === id && s.priority !== "omit");
  const brief = ctx.brief ? ["жюри хакатона"] : [];
  return {
    schemaVersion: 1,
    projectType: profile.kind,
    confidence: profile.confidence,
    signals: profile.signals,
    alternatives: profile.alternatives,
    style,
    audience: [...strategy.audience, ...brief],
    primaryAction: strategy.primaryAction === "open-demo" && !live ? (runnable ? "quick-start" : "install") : strategy.primaryAction,
    hero: present("hero"),
    demo: present("hero") ? strategy.demo : "none",
    screenshots: present("hero") ? strategy.screenshots : 0,
    architectureDiagram: present("architecture"),
    quickStart: present("quickstart"),
    usageExamples: present("usage"),
    // A comparison needs facts about other projects, which a repository does not contain.
    comparisonTable: false,
    sections,
    existing,
    mode: existing && existing.lines >= SUBSTANTIAL.lines && existing.sections.length >= SUBSTANTIAL.sections ? "improve" : "generate",
  };
}

/** The sections of a layout as the list the README builder works through. */
export function presetFromLayout(layout: Layout): ReadmePreset {
  const included = layout.sections.filter((s) => s.priority !== "omit");
  return {
    name: `layout:${layout.projectType}`,
    title: KIND_TITLES[layout.projectType],
    description: `структура для проекта типа «${KIND_TITLES[layout.projectType]}», стиль ${layout.style}`,
    required: included.filter((s) => s.priority === "must").map((s) => s.id),
    slots: included.map((s) => ({
      id: s.id,
      options: {
        ...(s.collapsible ? { collapsible: "true" } : {}),
        ...(s.id === "header" && CENTERED_STYLES.has(layout.style) ? { variant: "centered" } : {}),
      },
    })),
  };
}

export const isStyle = (value: string): value is Style => (STYLES as readonly string[]).includes(value);
