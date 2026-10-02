import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, posix } from "node:path";
import { PNG } from "pngjs";
import type { Context } from "./context.js";
import type { Layout } from "./layout.js";
import { checkReadme } from "./merge.js";

export type AuditCategory = "clarity" | "first-viewport" | "visuals" | "quick-start" | "examples" | "claims" | "formatting" | "assets";

export const CATEGORY_TITLES: Record<AuditCategory, string> = {
  clarity: "Понятность",
  "first-viewport": "Первый экран",
  visuals: "Визуалы",
  "quick-start": "Быстрый старт",
  examples: "Примеры",
  claims: "Утверждения",
  formatting: "Оформление",
  assets: "Файлы",
};

export interface AuditCheck {
  id: string;
  category: AuditCategory;
  ok: boolean;
  /** A failed `error` makes the audit fail; a `warn` is advice. */
  severity: "error" | "warn";
  message: string;
  /** Line of the README the finding refers to, when there is one. */
  line?: number;
  /** `auto` — `readme audit --fix` can repair it safely; `edit` — the text has to be rewritten. */
  fix?: "auto" | "edit";
}

/**
 * Thresholds drawn from well-kept open-source READMEs: a median of three badges on the
 * first screen, about 160 lines and six sections overall.
 */
export const LIMITS = {
  badgesWarn: 6,
  badgesFail: 10,
  firstViewportLines: 45,
  descriptionMin: 30,
  descriptionMax: 320,
  paragraphWords: 120,
  codeBlockLines: 60,
  sectionsWarn: 14,
  linesWarn: 500,
  tableColumns: 6,
  imageBytes: 1024 * 1024,
  gifBytes: 8 * 1024 * 1024,
};

/** Words that promise without saying anything. Each needs a concrete fact next to it, or to go. */
const HYPE: RegExp[] = [
  /\b(powerful|revolutionary|next[- ]generation|cutting[- ]edge|state[- ]of[- ]the[- ]art|seamless(ly)?|game[- ]chang(er|ing)|world[- ]class|best[- ]in[- ]class|supercharge[ds]?|unleash|effortless(ly)?|robust solution|innovative solution|one[- ]stop)\b/i,
  /(мощн(ый|ое|ая|ые)|революционн\p{L}*|нового поколения|передов\p{L}*|инновационн\p{L}*|бесшовн\p{L}*|уникальн\p{L}* решени\p{L}*|лучш(ий|ее|ая) в своём классе|не имеющ\p{L}* аналогов)/iu,
];
/** Qualities that are measurable: stating them calls for a number or a link. */
const UNMEASURED: [RegExp, string][] = [
  [/\b(blazing(ly)? fast|lightning[- ]fast|ultra[- ]fast|super[- ]fast|very fast)\b|молниеносн\p{L}*|сверхбыстр\p{L}*|очень быстр\p{L}*/iu, "скорость"],
  [/\b(highly scalable|infinitely scalable|production[- ]ready|enterprise[- ]grade|battle[- ]tested)\b|промышленного уровня|готов\p{L}* к продакшену/iu, "зрелость"],
  [/\b(100% secure|fully secure|military[- ]grade|unbreakable)\b|абсолютно безопасн\p{L}*|полностью безопасн\p{L}*/iu, "безопасность"],
];
const EVIDENCE_NEARBY = /benchmark|бенчмарк|замер|\d+(\.\d+)?\s?(ms|мс|s|сек|x|×|%|rps|req\/s)|\]\(/i;
const GENERIC_OPENING = /^(welcome to|this (is a|project|repo(sitory)?) (is|contains)|a (simple|powerful|modern) (project|app|application|tool|solution)\b|добро пожаловать|это (проект|репозиторий)|данный (проект|репозиторий))/i;
const BADGE = /img\.shields\.io|badge\.svg|badgen\.net|\/badge\/|badge\.fury\.io|codecov\.io|actions\/workflows\/[^)\s"]+\/badge/i;
const IMAGE = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?[^)]*\)|<img\b[^>]*\bsrc="([^"]+)"[^>]*>/g;
const ACTION_LINK = /demo|live|docs|documentation|install|get started|quick ?start|try|website|демо|документаци|установ|попробовать|быстрый старт|сайт/i;
const INSTALL_HEADING = /install|quick ?start|getting started|usage|установк|быстрый старт|запуск|начало работы/i;
const VISUAL_KINDS = new Set(["web-app", "mobile-app", "desktop-app", "game"]);
const MOTION = /\.(gif|mp4|webm)(?=[?#"')\s]|$)|user-attachments|<video/i;
const ASSET_DIRS = /^(docs\/(assets|media|images|img|screenshots)|\.github\/(assets|images)|assets|media|images|screenshots)\//i;
const MEDIA_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".mp4", ".webm"]);
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

/**
 * A picture with a transparent background shows the page behind it. If what is drawn is
 * all dark, it disappears on GitHub's dark theme; all light — on the light one.
 */
export function themeProblem(file: string): "dark" | "light" | null {
  let png: PNG;
  try {
    png = PNG.sync.read(readFileSync(file));
  } catch {
    return null;
  }
  const pixels = png.width * png.height;
  const step = Math.max(1, Math.floor(pixels / 40000));
  let transparent = 0;
  let opaque = 0;
  let luminance = 0;
  for (let i = 0; i < pixels; i += step) {
    const at = i * 4;
    if (png.data[at + 3] < 32) transparent++;
    else {
      opaque++;
      luminance += (0.2126 * png.data[at] + 0.7152 * png.data[at + 1] + 0.0722 * png.data[at + 2]) / 255;
    }
  }
  if (opaque === 0 || transparent / (transparent + opaque) < 0.2) return null;
  const mean = luminance / opaque;
  return mean < 0.25 ? "dark" : mean > 0.85 ? "light" : null;
}

interface Line {
  text: string;
  number: number;
  inFence: boolean;
}

function parse(markdown: string): Line[] {
  let fence = false;
  return markdown.split(/\r?\n/).map((text, index) => {
    const toggles = /^\s*(```|~~~)/.test(text);
    const inFence = fence || toggles;
    if (toggles) fence = !fence;
    return { text, number: index + 1, inFence };
  });
}

const isLocal = (target: string) => !/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target);
const megabytes = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

/** Plain prose of a line: no markup, images, badges or links' targets. */
const prose = (text: string) =>
  text.replace(/<[^>]+>/g, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`#>|]/g, " ").replace(/\s+/g, " ").trim();

/** Check how a README presents its project. Looks only at the text and the repository: no network, no browser. */
export function auditReadme(markdown: string, ctx: Context, layout: Layout): AuditCheck[] {
  const checks: AuditCheck[] = [];
  const add = (category: AuditCategory, id: string, ok: boolean, message: string, extra: Partial<AuditCheck> = {}) =>
    checks.push({ id, category, ok, severity: "warn", message, ...extra });
  const lines = parse(markdown);
  const body = lines.filter((l) => !l.inFence);
  const firstH2 = body.find((l) => /^##\s/.test(l.text))?.number ?? lines.length + 1;
  const top = body.filter((l) => l.number < firstH2);
  const topText = top.map((l) => l.text).join("\n");
  const images = [...markdown.matchAll(IMAGE)].map((m) => ({ alt: m[1] ?? "", target: m[2] ?? m[3], raw: m[0] }));
  const kind = layout.projectType;

  // --- Clarity
  const title = top.find((l) => /^#\s+\S/.test(l.text)) ?? top.find((l) => /<h1[\s>]/i.test(l.text));
  const paragraphs = top.map((l) => ({ ...l, plain: prose(l.text) })).filter((l) => l.plain.length >= 12 && !/^#/.test(l.text) && !BADGE.test(l.text));
  const description = paragraphs[0];
  add("clarity", "title", Boolean(title), title ? "есть название" : "нет заголовка первого уровня с названием проекта", { severity: "error", fix: "edit" });
  if (!description) {
    add("clarity", "description", false, "в начале нет ни одного предложения о том, что это за проект", { severity: "error", fix: "edit" });
  } else {
    const length = description.plain.length;
    add("clarity", "description", length >= LIMITS.descriptionMin, length >= LIMITS.descriptionMin ? "есть описание проекта" : `описание слишком короткое (${length} символов): не ясно, что проект делает`, { line: description.number, fix: "edit" });
    add("clarity", "description-length", length <= LIMITS.descriptionMax, length <= LIMITS.descriptionMax ? "описание читается с одного взгляда" : `первый абзац длинный (${length} символов): суть должна умещаться в одно-два предложения`, { line: description.number, fix: "edit" });
    add("clarity", "opening", !GENERIC_OPENING.test(description.plain), GENERIC_OPENING.test(description.plain) ? "описание начинается общей фразой — начните с того, что проект делает" : "описание начинается по делу", { line: description.number, fix: "edit" });
  }
  const hype = body.flatMap((l) => HYPE.flatMap((pattern) => (pattern.test(l.text) ? [{ line: l.number, word: l.text.match(pattern)![0] }] : [])));
  add("clarity", "hype", hype.length === 0, hype.length === 0 ? "нет пустых рекламных слов" : `рекламные слова без содержания: ${[...new Set(hype.map((h) => `«${h.word}»`))].join(", ")} — замените фактом или уберите`, { line: hype[0]?.line, fix: "edit" });

  // --- First viewport
  const topLines = top.filter((l) => l.text.trim()).length;
  const topBadges = [...topText.matchAll(IMAGE)].filter((m) => BADGE.test(m[0])).length;
  const topVisual = [...topText.matchAll(IMAGE)].some((m) => !BADGE.test(m[0]));
  const firstHeadings = body.filter((l) => /^##\s/.test(l.text)).slice(0, 2).map((l) => l.text);
  const hasAction = [...topText.matchAll(/\[([^\]]+)\]\(([^)]+)\)|<a\s[^>]*>([^<]+)<\/a>/g)].some((m) => ACTION_LINK.test(m[1] ?? m[3] ?? "")) || firstHeadings.some((h) => INSTALL_HEADING.test(h));
  add("first-viewport", "length", topLines <= LIMITS.firstViewportLines, topLines <= LIMITS.firstViewportLines ? "до первого раздела недалеко" : `до первого раздела ${topLines} строк — читатель не доберётся до сути`, { fix: "edit" });
  add("first-viewport", "badges", topBadges <= LIMITS.badgesWarn, topBadges <= LIMITS.badgesWarn ? `бейджей в начале: ${topBadges}` : `${topBadges} бейджей в начале создают шум — оставьте те, что сообщают полезное (сборка, версия, лицензия)`, { severity: topBadges > LIMITS.badgesFail ? "error" : "warn", fix: "edit" });
  if (VISUAL_KINDS.has(kind)) {
    add("first-viewport", "visual", topVisual, topVisual ? "в начале есть изображение" : `для проекта типа «${kind}» в начале нужен скриншот или демо: что это, должно быть видно сразу`, { fix: "edit" });
  }
  add("first-viewport", "primary-action", hasAction, hasAction ? "понятно, что делать дальше" : "не видно, что делать дальше: дайте ссылку на демо или документацию, либо начните с установки", { fix: "edit" });
  const toc = top.find((l) => /table of contents|содержание|оглавление/i.test(l.text));
  add("first-viewport", "no-junk", !toc || Boolean(description && description.number < toc.number), toc && !(description && description.number < toc.number) ? "оглавление стоит раньше описания проекта" : "в начале нет лишнего", { line: toc?.number, fix: "edit" });

  // --- Visuals
  const local = images.filter((i) => isLocal(i.target) && !BADGE.test(i.raw));
  const contentImages = images.filter((i) => !BADGE.test(i.raw));
  if (VISUAL_KINDS.has(kind)) {
    add("visuals", "present", contentImages.length > 0, contentImages.length > 0 ? `изображений: ${contentImages.length}` : "нет ни одного изображения интерфейса", { fix: "edit" });
    const motion = MOTION.test(markdown);
    add("visuals", "interaction", motion, motion ? "есть демо в движении" : "нет демонстрации главного действия (GIF или видео): repokit capture run + studio render", { fix: "edit" });
  } else if (kind === "cli" || kind === "dev-tool") {
    const shown = contentImages.length > 0 || lines.some((l) => l.inFence && /^\s*\$\s|^\s*>\s/.test(l.text));
    add("visuals", "present", shown, shown ? "показано, как инструмент выглядит в работе" : "не показано, как инструмент выглядит в работе: запись терминала или блок с командой и её выводом", { fix: "edit" });
  }
  const heavy: string[] = [];
  for (const image of local) {
    const path = image.target.split(/[?#]/)[0];
    const file = join(ctx.repo, path);
    if (!existsSync(file)) continue;
    const size = statSync(file).size;
    const limit = extname(path).toLowerCase() === ".gif" ? LIMITS.gifBytes : LIMITS.imageBytes;
    if (size > limit) heavy.push(`${path} — ${megabytes(size)} МБ`);
  }
  add("visuals", "weight", heavy.length === 0, heavy.length === 0 ? "изображения не тяжёлые" : `тяжёлые изображения: ${heavy.join(", ")} — repokit assets optimize`, { fix: "auto" });
  // Images inside <picture> already have a variant per theme.
  const themed = new Set([...markdown.matchAll(/<picture>[\s\S]*?<\/picture>/gi)].flatMap((m) => [...m[0].matchAll(/(?:src|srcset)="([^"\s]+)/g)].map((s) => s[1])));
  const vanishing: string[] = [];
  for (const image of local) {
    const path = image.target.split(/[?#]/)[0];
    const file = join(ctx.repo, path);
    if (themed.has(image.target) || extname(path).toLowerCase() !== ".png" || !existsSync(file) || statSync(file).size > 6 * 1024 * 1024) continue;
    const problem = themeProblem(file);
    if (problem) vanishing.push(`${path} — ${problem === "dark" ? "тёмный рисунок на прозрачном фоне не виден в тёмной теме" : "светлый рисунок на прозрачном фоне не виден в светлой теме"}`);
  }
  add("visuals", "themes", vanishing.length === 0, vanishing.length === 0 ? "изображения видны в обеих темах" : `${vanishing.join("; ")} — дайте вариант для второй темы (--hero-dark, <picture>) или непрозрачный фон`, { fix: "edit" });
  const noAlt = images.filter((i) => !BADGE.test(i.raw) && (i.raw.startsWith("<img") ? !/\balt="[^"]+"/.test(i.raw) : !i.alt.trim()));
  add("visuals", "alt", noAlt.length === 0, noAlt.length === 0 ? "у изображений есть описания" : `изображений без alt-текста: ${noAlt.length}`, { severity: "error", fix: "edit" });

  // --- Quick start
  const headings = body.filter((l) => /^#{2,3}\s/.test(l.text));
  const quick = headings.find((l) => INSTALL_HEADING.test(l.text));
  add("quick-start", "present", Boolean(quick), quick ? "есть раздел о запуске" : "нет раздела о том, как установить или запустить проект", { severity: "error", fix: "edit" });
  const hasCommands = lines.some((l) => l.inFence && l.text.trim() && !/^\s*(```|~~~)/.test(l.text));
  add("quick-start", "commands", hasCommands, hasCommands ? "есть команды" : "в README нет ни одного блока с командами", { fix: "edit" });
  const undocumented = ctx.envVars.filter((v) => !markdown.includes(v.name));
  add("quick-start", "env", undocumented.length === 0,
    undocumented.length === 0 ? (ctx.envVars.length ? "переменные окружения описаны" : "переменные окружения не нужны")
      : `код читает переменные окружения, о которых README молчит: ${undocumented.map((v) => `${v.name} (${v.file}:${v.line}${v.optional ? ", необязательная" : ""})`).join(", ")}`,
    // Without a required variable the quick start fails; an optional one is only worth a mention.
    { severity: undocumented.some((v) => !v.optional) ? "error" : "warn", fix: "edit" });
  const envExample = [...ctx.files].find((f) => /^\.env\.(example|sample|template)$/.test(f));
  if (envExample) add("quick-start", "env-example", markdown.includes(envExample), markdown.includes(envExample) ? `упомянут ${envExample}` : `в репозитории есть ${envExample}, но README не говорит скопировать его`, { fix: "edit" });

  // --- Examples
  const codeBlocks = lines.filter((l) => /^\s*(```|~~~)\s*(python|py|js|javascript|ts|typescript|tsx|go|rust|java|ruby|php)\b/i.test(l.text)).length;
  const wantsExample = ["library", "sdk", "cli", "dev-tool", "ai-agent", "ml-research", "api"].includes(kind);
  if (wantsExample) {
    const blank = /<!--\s*FILL:?\s*usage/.test(markdown);
    const usage = codeBlocks > 0 || (!blank && headings.some((l) => /usage|example|использовани|пример/i.test(l.text)));
    add("examples", "present", usage, usage ? "есть пример использования" : "нет примера использования — для такого проекта это главный раздел", { severity: "error", fix: "edit" });
  }
  const real = ctx.examples.examples.filter((e) => e.kind !== "documentation");
  if (real.length > 0) {
    const used = real.some((e) => e.code.split("\n").filter((l) => l.trim().length > 12).slice(0, 3).some((l) => markdown.includes(l.trim())));
    add("examples", "real", used || codeBlocks > 0, used ? "пример взят из репозитория" : codeBlocks > 0 ? "есть примеры кода; сверьте их с реальными (repokit examples extract)" : `в репозитории есть готовые примеры (${real[0].file}), а в README их нет`, { fix: "edit" });
  }

  // --- Claims
  const unmeasured = body.flatMap((l) => UNMEASURED.flatMap(([pattern, quality]) => (pattern.test(l.text) && !EVIDENCE_NEARBY.test(l.text) ? [{ line: l.number, word: l.text.match(pattern)![0], quality }] : [])));
  add("claims", "measured", unmeasured.length === 0, unmeasured.length === 0 ? "нет громких заявлений без цифр" : `заявления без подтверждения: ${unmeasured.map((u) => `«${u.word}» (${u.quality}, строка ${u.line})`).join(", ")} — дайте замер или уберите`, { line: unmeasured[0]?.line, fix: "edit" });
  add("claims", "backed", ctx.staleClaims.length === 0, ctx.staleClaims.length === 0 ? "утверждения из claims.json подтверждены кодом" : `доказательства устарели: ${ctx.staleClaims.join("; ")}`, { severity: "error", fix: "edit" });

  // --- Formatting
  const h1 = body.filter((l) => /^#\s+\S/.test(l.text));
  add("formatting", "single-h1", h1.length <= 1, h1.length <= 1 ? "один заголовок первого уровня" : `заголовков первого уровня: ${h1.length} — должен быть один, название проекта`, { line: h1[1]?.number, fix: "auto" });
  let previous = 1;
  let skipped: Line | undefined;
  for (const l of body) {
    const level = l.text.match(/^(#{1,6})\s+\S/)?.[1].length;
    if (!level) continue;
    if (level > previous + 1 && !skipped) skipped = l;
    previous = level;
  }
  add("formatting", "hierarchy", !skipped, skipped ? `уровень заголовка перескакивает (строка ${skipped.number}: «${prose(skipped.text)}»)` : "уровни заголовков идут по порядку", { line: skipped?.number, fix: "auto" });
  const sections = body.filter((l) => /^##\s/.test(l.text));
  add("formatting", "sections", sections.length <= LIMITS.sectionsWarn, sections.length <= LIMITS.sectionsWarn ? `разделов: ${sections.length}` : `${sections.length} разделов — часть стоит объединить, свернуть или перенести в docs/`, { fix: "edit" });
  add("formatting", "length", lines.length <= LIMITS.linesWarn, lines.length <= LIMITS.linesWarn ? `строк: ${lines.length}` : `${lines.length} строк — подробности лучше свернуть в <details> или вынести в документацию`, { fix: "edit" });
  const emojiHeadings = sections.filter((l) => EMOJI.test(l.text)).length;
  add("formatting", "emoji", emojiHeadings <= sections.length / 2 || emojiHeadings <= 2, emojiHeadings > 2 && emojiHeadings > sections.length / 2 ? `эмодзи в ${emojiHeadings} заголовках из ${sections.length} — в ухоженных README их в заголовках нет` : "заголовки без лишних эмодзи", { fix: "edit" });

  // Tables: worth it from three rows; unreadable beyond six columns.
  const tableProblems: string[] = [];
  body.forEach((l, index) => {
    if (!/^\s*\|?\s*:?-{3,}/.test(l.text) || !l.text.includes("|")) return;
    const columns = l.text.split("|").filter((cell) => cell.trim()).length;
    let rows = 0;
    while (body[index + 1 + rows]?.text.includes("|") && body[index + 1 + rows].text.trim()) rows++;
    // A table that holds pictures is a grid for laying them out side by side, not data.
    const grid = /!\[|<img/.test(body[index + 1]?.text ?? "");
    if (rows > 0 && rows < 3 && columns <= 2 && !grid) tableProblems.push(`строка ${l.number}: таблица из ${rows} строк — хватит списка`);
    if (columns > LIMITS.tableColumns) tableProblems.push(`строка ${l.number}: ${columns} колонок — на телефоне не поместится`);
  });
  add("formatting", "tables", tableProblems.length === 0, tableProblems.length === 0 ? "таблицы к месту" : tableProblems.join("; "), { fix: "edit" });

  // Walls of text and long code outside collapsible blocks.
  const walls: number[] = [];
  let paragraph: Line[] = [];
  const flush = () => {
    if (paragraph.map((l) => prose(l.text)).join(" ").split(/\s+/).filter(Boolean).length > LIMITS.paragraphWords) walls.push(paragraph[0].number);
    paragraph = [];
  };
  for (const l of body) {
    if (!l.text.trim() || /^(#|\s*[-*+]\s|\s*\d+\.\s|\||<)/.test(l.text)) flush();
    else paragraph.push(l);
  }
  flush();
  add("formatting", "walls", walls.length === 0, walls.length === 0 ? "нет стен текста" : `абзацы длиннее ${LIMITS.paragraphWords} слов (строки ${walls.join(", ")}) — разбейте или сократите`, { line: walls[0], fix: "edit" });
  let run = 0;
  let inDetails = 0;
  const longBlocks: number[] = [];
  for (const l of lines) {
    if (/<details/i.test(l.text)) inDetails++;
    if (/<\/details/i.test(l.text)) inDetails = Math.max(0, inDetails - 1);
    if (l.inFence) run++;
    else {
      if (run - 2 > LIMITS.codeBlockLines && inDetails === 0) longBlocks.push(l.number - run);
      run = 0;
    }
  }
  add("formatting", "long-code", longBlocks.length === 0, longBlocks.length === 0 ? "нет гигантских блоков кода" : `блоки кода длиннее ${LIMITS.codeBlockLines} строк (строки ${longBlocks.join(", ")}) — сверните в <details> или сократите до сути`, { fix: "edit" });

  // --- Assets
  const structural = checkReadme(markdown, ctx.files);
  const missing = structural.filter((p) => p.kind === "missing-file");
  add("assets", "exist", missing.length === 0, missing.length === 0 ? "все файлы, на которые ссылается README, существуют" : missing.map((p) => `строка ${p.line}: ${p.message}`).join("; "), { severity: "error", line: missing[0]?.line, fix: "edit" });
  const fill = structural.filter((p) => p.kind === "fill");
  add("assets", "no-blanks", fill.length === 0, fill.length === 0 ? "нет незаполненных мест" : `незаполненных мест: ${fill.length} (строки ${fill.map((p) => p.line).join(", ")})`, { severity: "error", line: fill[0]?.line, fix: "edit" });
  const referenced = new Set<string>();
  for (const m of markdown.matchAll(/(?:src|srcset|href)="([^"\s]+)|\]\(\s*<?([^)\s>]+)/g)) referenced.add(posix.normalize((m[1] ?? m[2]).split(/[?#]/)[0]));
  const unused = [...ctx.files].filter((f) => ASSET_DIRS.test(f) && MEDIA_EXT.has(posix.extname(f).toLowerCase()) && !referenced.has(f) && !ctx.referencedElsewhere.has(f));
  add("assets", "unused", unused.length === 0, unused.length === 0 ? "нет неиспользуемых медиафайлов" : `медиафайлы, на которые никто не ссылается: ${unused.slice(0, 6).join(", ")}${unused.length > 6 ? ` и ещё ${unused.length - 6}` : ""} — repokit assets prune`, { fix: "auto" });
  const badNames = local.map((i) => i.target).filter((t) => /[A-Z\s%]/.test(posix.basename(t.split(/[?#]/)[0])));
  add("assets", "names", badNames.length === 0, badNames.length === 0 ? "имена файлов аккуратные" : `имена с пробелами или заглавными буквами: ${[...new Set(badNames)].join(", ")} — repokit assets normalize`, { fix: "auto" });

  return checks;
}

/** The checks of the first screen only: what a visitor sees before scrolling. */
export const heroChecks = (checks: AuditCheck[]) => checks.filter((c) => c.category === "first-viewport" || (c.category === "clarity" && c.id !== "hype"));

export function renderAudit(checks: AuditCheck[]): string[] {
  const out: string[] = [];
  for (const category of Object.keys(CATEGORY_TITLES) as AuditCategory[]) {
    const own = checks.filter((c) => c.category === category);
    if (own.length === 0) continue;
    out.push(CATEGORY_TITLES[category]);
    for (const check of own) out.push(`  ${check.ok ? "✓" : "✗"} ${check.message}`);
  }
  return out;
}
