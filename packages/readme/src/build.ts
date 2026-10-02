import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileSha256, type HumanTodo, type MediaEntry, type ReadmeSlotId } from "@repokit/core";
import type { Claim } from "@repokit/scan";
import { buildGraph, mermaid } from "./architecture.js";
import { HUMAN_FILE, type Context, type ReadmePreset, type TemplateSlot } from "./context.js";
import { badgeMarkdown, detectStack, technologyByName } from "./stack.js";

export type SlotStatus = "filled" | "empty" | "omitted";

export interface SlotResult {
  id: ReadmeSlotId;
  status: SlotStatus;
  /** Where the content came from, or what is needed to fill the slot. */
  note: string;
  markdown: string;
}

export interface BuiltReadme {
  markdown: string;
  slots: SlotResult[];
  humanTodo: HumanTodo[];
  warnings: string[];
}

const HERO_WIDTH = 820;
const MAX_ROUTES = 40;
const HUMAN_PATH = `.repokit/${HUMAN_FILE}`;
/** Names for slots that have no heading of their own. */
const SLOT_LABELS: Partial<Record<ReadmeSlotId, string>> = { header: "шапка", hero: "главное изображение" };

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to hyphens. */
export const slug = (heading: string) => heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\- _]/gu, "").replace(/ /g, "-");

const fill = (id: string, hint: string) => `<!-- FILL: ${id} — ${hint} -->`;
const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeCell = (text: string) => text.replace(/\|/g, "\\|");

function evidenceLinks(claim: Claim): string {
  return claim.evidence
    .map((e) => {
      const [from, to] = e.lines;
      const range = from === to ? `${from}` : `${from}–${to}`;
      return `[\`${e.file}:${range}\`](${encodeURI(e.file)}#L${from}${to !== from ? `-L${to}` : ""})`;
    })
    .join(", ");
}

/** Manifest record for a file, matched by content so that a copy in docs/ keeps its provenance. */
function provenance(ctx: Context, path: string): MediaEntry | null {
  const hash = fileSha256(join(ctx.repo, path));
  return ctx.manifest.media.find((m) => m.sha256 === hash) ?? null;
}

/** Whether a media file was made from a recording flagged as demo data. */
function showsDemoData(ctx: Context, entry: MediaEntry | null): boolean {
  if (!entry) return false;
  if (entry.demoData) return true;
  return ctx.manifest.media.some((m) => m.demoData && entry.derivedFrom?.includes(m.sha256));
}

export function buildReadme(ctx: Context, preset: ReadmePreset): BuiltReadme {
  const { scan, human, i18n: { headings, phrases } } = ctx;
  const humanTodo: HumanTodo[] = [];
  const warnings: string[] = ctx.staleClaims.map((s) => `утверждение не попало в README — доказательство не прошло проверку: ${s}`);
  const title = human.title ?? scan.project.name;
  const phrase = (key: string, values: Record<string, string> = {}) =>
    Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, value), phrases[key]);
  const heading = (id: string) => `## ${headings[id]}`;
  const skipped = new Set(human.skip ?? []);
  const inPreset = new Set(preset.slots.map((s) => s.id));

  const proven = ctx.claims.filter((c) => (c.status === "implemented" || c.status === "partial") && c.evidence.length > 0);

  /** Slots already rendered with content; lets one section link to another only when it exists. */
  const present = new Set<ReadmeSlotId>();
  type Render = (slot: TemplateSlot) => Omit<SlotResult, "id">;
  const filled = (markdown: string, note: string): Omit<SlotResult, "id"> => ({ status: "filled", note, markdown });
  const omitted = (note: string): Omit<SlotResult, "id"> => ({ status: "omitted", note, markdown: "" });
  const empty = (id: string, hint: string, withHeading = true): Omit<SlotResult, "id"> => ({
    status: "empty",
    note: hint,
    markdown: `${withHeading && headings[id] ? `${heading(id)}\n\n` : ""}${fill(id, hint)}`,
  });

  const badgeNames: string[] = [];
  function badges(): string[] {
    const out: string[] = [];
    if (ctx.license?.name) badgeNames.push("лицензия");
    if (ctx.github && ctx.workflows.length > 0) badgeNames.push("CI");
    if (ctx.license?.name) out.push(`![${headings.license}: ${ctx.license.name}](https://img.shields.io/badge/license-${encodeURIComponent(ctx.license.name.replace(/-/g, "--"))}-blue)`);
    if (ctx.github && ctx.workflows.length > 0) {
      const workflow = ctx.workflows[0].split("/").pop();
      const base = `https://github.com/${ctx.github.owner}/${ctx.github.repo}/actions`;
      out.push(`[![CI](${base}/workflows/${workflow}/badge.svg)](${base})`);
    }
    // With a tech-stack section in the preset the language is shown there, with its logo.
    const language = inPreset.has("stack") && !skipped.has("stack") ? undefined : scan.project.languages.find((l) => !["HTML", "CSS"].includes(l.name));
    if (language) badgeNames.push("язык");
    if (language) out.push(`![${language.name}](https://img.shields.io/badge/${encodeURIComponent(language.name)}-informational)`);
    return out;
  }

  const renderers: Record<ReadmeSlotId, Render> = {
    header: (slot) => {
      const tagline = human.tagline ? `**${human.tagline}**` : fill("tagline", `одна фраза о проекте — поле tagline в ${HUMAN_PATH}`);
      const body = [`# ${title}`, tagline, badges().join(" ")].filter(Boolean).join("\n\n");
      const markdown = slot.options.variant === "centered" ? `<div align="center">\n\n${body}\n\n</div>` : body;
      return human.tagline
        ? filled(markdown, `название: ${human.title ? HUMAN_PATH : "имя проекта"}; тэглайн: ${HUMAN_PATH}; бейджи: ${badgeNames.join(", ") || "нет"}`)
        : { status: "empty", note: `нужен тэглайн — поле tagline в ${HUMAN_PATH}`, markdown };
    },

    hero: () => {
      const hero = ctx.options.hero;
      if (!hero) return empty("hero", "снимите демо (capture run, studio render) и укажите файл: readme plan --hero docs/media/hero.gif", false);
      for (const path of [hero, ctx.options.heroDark].filter((p): p is string => Boolean(p))) {
        if (!existsSync(join(ctx.repo, path))) return empty("hero", `файл не найден: ${path}`, false);
        if (!provenance(ctx, path)) warnings.push(`медиа ${path}: происхождение неизвестно — файл не создан через repokit`);
      }
      const alt = escapeHtml(human.heroAlt ?? phrase("heroAlt", { title }));
      const img = `<img src="${hero}" alt="${alt}" width="${HERO_WIDTH}">`;
      const picture = ctx.options.heroDark
        ? `<picture>\n  <source media="(prefers-color-scheme: dark)" srcset="${ctx.options.heroDark}">\n  ${img}\n</picture>`
        : img;
      const caption = showsDemoData(ctx, provenance(ctx, hero)) ? `\n\n<p align="center"><sub>${phrases.demoData}</sub></p>` : "";
      return filled(`<p align="center">\n${picture}\n</p>${caption}`, `медиа: ${hero}${ctx.options.heroDark ? ` и ${ctx.options.heroDark} для тёмной темы` : ""}`);
    },

    stack: () => {
      const detected = detectStack(scan, ctx.files);
      const names = new Set(detected.map((t) => t.name.toLowerCase()));
      const added = (human.stack ?? []).map(technologyByName).filter((t) => !names.has(t.name.toLowerCase()));
      if (added.length > 0) warnings.push(`технологии добавлены автором и не подтверждены зависимостями или файлами проекта: ${added.map((t) => t.name).join(", ")}`);
      const all = [...detected, ...added];
      if (all.length === 0) return omitted("технологии не определены");
      return filled(`${heading("stack")}\n\n${all.map(badgeMarkdown).join(" ")}`, `определено по коду и зависимостям: ${detected.map((t) => t.name).join(", ") || "—"}${added.length ? `; добавлено автором: ${added.map((t) => t.name).join(", ")}` : ""}`);
    },

    problem: () => (human.problem ? filled(`${heading("problem")}\n\n${human.problem.trim()}`, HUMAN_PATH) : empty("problem", `какую проблему решает проект — поле problem в ${HUMAN_PATH}`)),
    solution: () => (human.solution ? filled(`${heading("solution")}\n\n${human.solution.trim()}`, HUMAN_PATH) : empty("solution", `как проект её решает — поле solution в ${HUMAN_PATH}`)),

    features: () => {
      if (proven.length === 0) return empty("features", "нет утверждений, подтверждённых кодом: repokit scan claims extract → разметьте claims.json → claims pin");
      const items = proven.map((c) => `- **${c.text}**${c.status === "partial" ? ` *(${phrases.partial}${c.note ? `: ${c.note}` : ""})*` : ""} — ${evidenceLinks(c)}`);
      return filled(`${heading("features")}\n\n${items.join("\n")}`, `claims.json: ${proven.length} утверждений с доказательствами`);
    },

    demo: () => {
      const live = human.demoUrl ?? ctx.deployment?.url;
      const sleepy = ctx.deployment?.sleeps && live === ctx.deployment.url ? ` — ${phrases.coldStart}` : "";
      const links = [
        live ? `- [${phrases.liveDemo}](${live})${sleepy}` : "",
        human.videoUrl ? `- [${phrases.watchVideo}](${human.videoUrl})` : "",
      ].filter(Boolean);
      return links.length > 0 ? filled(`${heading("demo")}\n\n${links.join("\n")}`, human.demoUrl ? HUMAN_PATH : "deploy.json: адрес, проверенный deploy check") : omitted(`нет ссылок на демо: поля demoUrl и videoUrl в ${HUMAN_PATH}`);
    },

    architecture: (slot) => {
      const graph = buildGraph(ctx.repo, scan, ctx.files);
      if (graph.nodes.length < 2) return omitted("в проекте меньше двух связанных модулей — схема была бы пустой");
      const diagram = `${phrases.architectureIntro}\n\n\`\`\`mermaid\n${mermaid(graph, phrases)}\n\`\`\``;
      const body = slot.options.collapsible ? `<details>\n<summary>${phrases.details}</summary>\n\n${diagram}\n\n</details>` : diagram;
      return filled(`${heading("architecture")}\n\n${body}`, `импорты и обращения к API в коде: ${graph.nodes.length} модулей, ${graph.edges.length} связей`);
    },

    routes: (slot) => {
      const routes = scan.routes.slice(0, MAX_ROUTES);
      if (routes.length === 0) return omitted("роуты не найдены");
      const rows = routes.map((r) => `| ${r.method} | \`${escapeCell(r.path)}\` | [\`${r.file}:${r.line}\`](${encodeURI(r.file)}#L${r.line}) |`);
      const table = [`| ${phrases.method} | ${phrases.path} | ${phrases.where} |`, "|---|---|---|", ...rows].join("\n");
      const body = slot.options.collapsible ? `<details>\n<summary>${phrases.details}</summary>\n\n${table}\n\n</details>` : table;
      return filled(`${heading("routes")}\n\n${body}`, `scan: ${routes.length} роутов`);
    },

    quickstart: () => {
      const { commands, packageManager, types } = scan.project;
      if (!commands.run && !types.includes("static-site")) return empty("quickstart", "команда запуска не определена — опишите, как запустить проект");
      const block = (label: string, command?: string) => (command ? `${label}:\n\n\`\`\`bash\n${command}\n\`\`\`` : "");
      const runtime = packageManager === "pip" ? "Python 3" : packageManager ? "Node.js" : "";
      const staticNote = !commands.run ? "Откройте `index.html` в браузере." : "";
      const parts = [
        runtime ? `${phrases.requirements}: ${runtime}.` : "",
        block(phrases.install, commands.install),
        block(phrases.run, commands.run),
        staticNote,
        block(phrases.test, commands.test),
      ].filter(Boolean);
      return filled(`${heading("quickstart")}\n\n${parts.join("\n\n")}`, "scan: команды установки, запуска и тестов");
    },

    judges: () => {
      const brief = ctx.brief;
      if (!brief) return omitted("нет brief.json: repokit brief extract или brief init --default");
      const rows = brief.criteria.map((criterion) => {
        const matrixRow = brief.matrix.find((m) => m.criterionId === criterion.id);
        const proofs = proven.filter((c) => c.criteria?.includes(criterion.id)).map((c) => `${c.text} (${evidenceLinks(c)})`);
        const target = matrixRow?.readmeSlot;
        if (target && headings[target] && present.has(target)) proofs.push(`[${phrase("seeSection", { name: headings[target] })}](#${slug(headings[target])})`);
        const weight = criterion.weight !== undefined ? `${Math.round(criterion.weight * 100)}%` : "—";
        return `| ${escapeCell(criterion.title)} | ${weight} | ${proofs.map(escapeCell).join("<br>") || "—"} |`;
      });
      const table = [`| ${phrases.criterion} | ${phrases.weight} | ${phrases.proof} |`, "|---|---|---|", ...rows].join("\n");
      const submission = brief.submission.length > 0
        ? `\n\n**${phrases.submission}**\n\n${brief.submission.map((s) => `- ${s.title}${s.constraint ? ` — ${s.constraint}` : ""}`).join("\n")}`
        : "";
      const note = brief.isDefaultProfile ? `\n\n> ${phrases.defaultProfile}` : "";
      return filled(`${heading("judges")}\n\n${table}${submission}${note}`, `brief.json: ${brief.criteria.length} критериев${brief.isDefaultProfile ? " (профиль по умолчанию)" : ""}`);
    },

    limitations: () => {
      const items: string[] = [];
      for (const claim of ctx.claims) {
        const links = claim.evidence.length > 0 ? ` (${evidenceLinks(claim)})` : "";
        if (claim.status === "mock") items.push(`- ${phrase("mockItem", { text: claim.text })}${links}${claim.note ? `. ${claim.note}` : ""}`);
        if (claim.status === "partial" && claim.note) items.push(`- ${phrase("partialItem", { text: claim.text })}: ${claim.note}`);
      }
      if (!scan.repoHealth.hasTests) items.push(`- ${phrases.noTests}`);
      const roadmap = (human.roadmap ?? []).map((item) => `- ${item}`);
      if (items.length === 0 && roadmap.length === 0) return empty("limitations", `перечислите известные ограничения и планы — поле roadmap в ${HUMAN_PATH}`);
      const body = [items.join("\n"), roadmap.length > 0 ? `**${phrases.roadmap}**\n\n${roadmap.join("\n")}` : ""].filter(Boolean).join("\n\n");
      return filled(`${heading("limitations")}\n\n${body}`, "claims.json (заглушки и частичные), scan, поле roadmap");
    },

    team: () => {
      const team = human.team ?? [];
      if (team.length === 0) return omitted(`состав команды — поле team в ${HUMAN_PATH}`);
      const items = team.map((m) => `- **${m.link ? `[${m.name}](${m.link})` : m.name}**${m.role ? ` — ${m.role}` : ""}`);
      return filled(`${heading("team")}\n\n${items.join("\n")}`, HUMAN_PATH);
    },

    license: () => {
      if (!ctx.license) return empty("license", "в репозитории нет файла лицензии — выберите лицензию и добавьте LICENSE");
      const line = ctx.license.name ? phrase("licenseLine", { name: ctx.license.name, file: ctx.license.file }) : phrase("licenseUnknown", { file: ctx.license.file });
      return filled(`${heading("license")}\n\n${line.replaceAll("{file}", ctx.license.file)}`, ctx.license.file);
    },
  };

  const renderSlot = (slot: TemplateSlot): SlotResult => {
    if (skipped.has(slot.id)) return { id: slot.id, status: "omitted", note: `пропущен автором (skip в ${HUMAN_PATH})`, markdown: "" };
    const result = { id: slot.id, ...renderers[slot.id](slot) };
    // An optional slot with nothing to say is left out rather than shown as a blank to fill.
    if (result.status === "empty" && !preset.required.includes(slot.id)) return { ...result, status: "omitted" as const, markdown: "" };
    if (result.status === "filled") present.add(slot.id);
    return result;
  };
  // The judges table refers to other sections, so it is rendered after all of them.
  const rendered = new Map<TemplateSlot, SlotResult>();
  for (const slot of preset.slots) if (slot.id !== "judges") rendered.set(slot, renderSlot(slot));
  for (const slot of preset.slots) if (slot.id === "judges") rendered.set(slot, renderSlot(slot));
  const slots = preset.slots.map((slot) => rendered.get(slot)!);

  for (const slot of slots) {
    if (slot.status === "empty") humanTodo.push({ id: `readme.${slot.id}`, text: `README, ${SLOT_LABELS[slot.id] ?? `раздел «${headings[slot.id]}»`}: ${slot.note}` });
  }
  const undecided = ctx.claims.filter((c) => c.status === "unverified");
  if (undecided.length > 0) {
    humanTodo.push({
      id: "readme.unverified",
      text: `Не подтверждены кодом и не попали в README: ${undecided.map((c) => `«${c.text}»`).join(", ")}. Решите: доделать, убрать или перенести в планы.`,
    });
  }
  if (!human.team?.length && inPreset.has("team") && !skipped.has("team")) {
    humanTodo.push({ id: "readme.team", text: `Состав команды не указан — поле team в ${HUMAN_PATH} (или добавьте team в skip).` });
  }

  return { markdown: slots.map((s) => s.markdown).filter(Boolean).join("\n\n") + "\n", slots, humanTodo, warnings };
}
