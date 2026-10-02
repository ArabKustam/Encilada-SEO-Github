import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import {
  commonFlags, diffStats, ExitCode, formatDiff, lineDiff, listFiles, readArtifact, REPOKIT_DIR, resolveRepo, runCommand, sha256, UsageError, writeArtifact,
  type CommandResult, type CommonFlags, type HumanTodo, type ReadmeSlotId,
} from "@repokit/core";
import { analyze } from "@repokit/scan";
import { buildGraph, groupGraph, MAX_BLOCKS, mermaid } from "./architecture.js";
import { auditReadme, heroChecks, renderAudit, type AuditCheck } from "./audit.js";
import { buildReadme, type SlotResult } from "./build.js";
import { extractExamples, type ExamplesDoc } from "./examples.js";
import { fixReadme } from "./fix.js";
import { isStyle, planLayout, presetFromLayout, type Layout } from "./layout.js";
import { KIND_TITLES, STYLE_TITLES, STYLES, type ProjectKind, type Style } from "./profile.js";
import {
  AUTO_PRESET, findReadmePreset, HUMAN_FILE, LANGUAGES, listReadmePresets, loadContext, loadOptions, OPTIONS_FILE,
  type Context, type Language, type Options,
} from "./context.js";
import { checkReadme, mergeCustomSections, type ReadmeProblem } from "./merge.js";

export { buildReadme, slug } from "./build.js";
export type { SlotResult, SlotStatus } from "./build.js";
export { buildGraph, groupGraph, mermaid } from "./architecture.js";
export { auditReadme, heroChecks, LIMITS, themeProblem } from "./audit.js";
export type { AuditCategory, AuditCheck } from "./audit.js";
export { bestExample, extractExamples } from "./examples.js";
export { fixReadme } from "./fix.js";
export type { Example, ExamplesDoc } from "./examples.js";
export { analyzeExisting, planLayout, presetFromLayout } from "./layout.js";
export type { Layout, LayoutSection } from "./layout.js";
export { detectProfile, KIND_TITLES, PROJECT_KINDS, STRATEGIES, STYLES } from "./profile.js";
export type { Profile, ProjectKind, Style } from "./profile.js";
export { AUTO_PRESET, DEFAULT_OPTIONS, findReadmePreset, HUMAN_FILE, LANGUAGES, listReadmePresets, loadContext, loadHuman, loadOptions } from "./context.js";
export type { Context, Human, Language, Options, ReadmePreset } from "./context.js";
export { checkReadme, mergeCustomSections } from "./merge.js";
export { badgeMarkdown, badgeUrl, detectStack, technologyByName } from "./stack.js";
export type { Technology } from "./stack.js";
export type { ReadmeProblem } from "./merge.js";

const README = "README.md";
const DRAFT_FILE = "readme.draft.md";
const PLAN_FILE = "readme.plan.json";
const BACKUP_FILE = "readme.backup.md";
const TODO_FILE = "human-todo.md";
const LAYOUT_FILE = "readme.layout.json";
const AUDIT_FILE = "readme.audit.json";
const APPLIED_FILE = "readme.applied.json";
const EXAMPLES_FILE = "examples.json";
const DIAGRAM_FILE = "architecture.mmd";

const HUMAN_TEMPLATE = `# Поля README, которые решает человек. repokit их не придумывает:
# пустое поле останется незаполненным и попадёт в список «для человека».

# Название проекта (по умолчанию — имя из манифеста или папки)
title:

# Одна фраза: что это и для кого
tagline:

# Какую проблему решает проект
problem:

# Как проект её решает
solution:

# Ссылка на работающую версию и на видео (если есть)
demoUrl:
videoUrl:

# Описание того, что видно на главном изображении (alt-текст)
heroAlt:

# Команда
team:
#  - name: Имя Фамилия
#    role: бэкенд
#    link: https://github.com/username

# Технологии, которые repokit не определил сам (он находит их по зависимостям и файлам)
stack: []

# Что планируется, но ещё не сделано
roadmap: []

# Разделы, которые не нужны: hero, problem, solution, demo, architecture, routes, judges, team …
skip: []
`;

export interface Plan {
  schemaVersion: 1;
  preset: string;
  /** What kind of project the structure was chosen for. */
  projectType: ProjectKind;
  style: Style;
  /** `improve`: the repository already has a README somebody wrote; it is edited, not replaced. */
  mode: Layout["mode"];
  language: Language;
  hero: string | null;
  heroDark: string | null;
  slots: Omit<SlotResult, "markdown">[];
  /** The author's own sections carried over from the existing README. */
  preserved: string[];
  problems: ReadmeProblem[];
  humanTodo: HumanTodo[];
  warnings: string[];
}

export interface Draft {
  context: Context;
  /** The README as it would be written, including preserved sections. */
  markdown: string;
  /** The current README.md, or null when there is none. */
  current: string | null;
  layout: Layout;
  plan: Plan;
}

/** Build the README for a repository without writing anything. */
export function draftReadme(repo: string, options: Options): Draft {
  const fixed = options.preset === AUTO_PRESET ? null : findReadmePreset(options.preset);
  const context = loadContext(repo, options);
  const readmePath = join(repo, README);
  const current = existsSync(readmePath) ? readFileSync(readmePath, "utf8") : null;
  const layout = resolveLayout(repo, context, current, options.style);
  // A named preset is a fixed template; otherwise the structure follows the kind of project.
  const preset = fixed ?? presetFromLayout(layout);
  const built = buildReadme(context, preset);
  const generatedHeadings = new Set(Object.values(context.i18n.headings).map((h) => h.toLowerCase()));
  for (const heading of context.allHeadings) generatedHeadings.add(heading);
  const merged = mergeCustomSections(current, built.markdown, generatedHeadings, context.i18n.headings.license);

  const humanTodo = [...built.humanTodo];
  if (merged.possibleDuplicates.length > 0) {
    humanTodo.push({
      id: "readme.duplicates",
      text: `Ваши разделы ${merged.possibleDuplicates.map((h) => `«${h}»`).join(", ")} сохранены, но могут повторять «${context.i18n.headings.quickstart}». Оставьте один вариант.`,
    });
  }
  // Media and files are checked against the working tree plus the files the plan itself references.
  const problems = checkReadme(merged.markdown, context.files);
  return {
    context,
    markdown: merged.markdown,
    current,
    layout,
    plan: {
      schemaVersion: 1,
      preset: preset.name,
      projectType: layout.projectType,
      style: layout.style,
      mode: layout.mode,
      language: options.language,
      hero: options.hero ?? null,
      heroDark: options.heroDark ?? null,
      slots: built.slots.map(({ markdown: _, ...slot }) => slot),
      preserved: merged.preserved,
      problems,
      humanTodo,
      warnings: built.warnings,
    },
  };
}

/**
 * The layout to build from: the saved one when somebody has edited it for this kind of
 * project and style, otherwise a fresh plan.
 */
function resolveLayout(repo: string, context: Context, current: string | null, style?: Style): Layout {
  const fresh = planLayout(context, current, style);
  const text = readArtifact(repo, LAYOUT_FILE);
  if (text === null) return fresh;
  let saved: Layout;
  try {
    saved = JSON.parse(text) as Layout;
  } catch (error) {
    throw new UsageError(`${REPOKIT_DIR}/${LAYOUT_FILE}: ${(error as Error).message}`);
  }
  if (!Array.isArray(saved.sections) || saved.style !== fresh.style) return fresh;
  // Only the decisions are taken from the file; facts about the repository are always current.
  return { ...fresh, projectType: saved.projectType in KIND_TITLES ? saved.projectType : fresh.projectType, sections: saved.sections };
}

/** Was the README in the repository written by `readme apply`? Then replacing it loses nothing. */
function writtenByRepokit(repo: string, current: string): boolean {
  const text = readArtifact(repo, APPLIED_FILE);
  if (text === null) return false;
  try {
    return (JSON.parse(text) as { sha256?: string }).sha256 === sha256(current);
  } catch {
    return false;
  }
}

/** Write the drafted README. The previous one is never lost: it is kept next to the other artifacts. */
export function writeReadme(repo: string, draft: Draft) {
  const artifacts = [];
  if (draft.current !== draft.markdown) {
    if (draft.current !== null) artifacts.push(writeArtifact(repo, BACKUP_FILE, draft.current, "readme-backup"));
    writeFileSync(join(repo, README), draft.markdown);
  }
  // Remembering what was written lets a later run tell its own README from the author's.
  artifacts.push(writeArtifact(repo, APPLIED_FILE, JSON.stringify({ schemaVersion: 1, sha256: sha256(draft.markdown) }, null, 2) + "\n", "readme-applied"));
  return artifacts;
}

export function renderTodo(todos: HumanTodo[]): string {
  if (todos.length === 0) return "# Для человека\n\nНичего не осталось.\n";
  return `# Для человека\n\nЭти решения repokit не принимает сам.\n\n${todos.map((t) => `- [ ] ${t.text}`).join("\n")}\n`;
}

interface PlanFlags extends CommonFlags {
  preset?: string;
  lang?: string;
  hero?: string;
  heroDark?: string;
  banner?: string;
  style?: string;
  regenerate?: boolean;
}

/** Options from disk, overridden by any flags given on this run. */
function resolveOptions(repo: string, flags: PlanFlags): Options {
  const saved = loadOptions(repo);
  if (flags.lang && !LANGUAGES.includes(flags.lang as Language)) throw new UsageError(`Язык «${flags.lang}» не поддерживается. Доступны: ${LANGUAGES.join(", ")}`);
  if (flags.style && !isStyle(flags.style)) throw new UsageError(`Стиль «${flags.style}» не поддерживается. Доступны: ${STYLES.join(", ")}`);
  return {
    style: (flags.style as Style | undefined) ?? saved.style,
    preset: flags.preset ?? saved.preset,
    language: (flags.lang as Language | undefined) ?? saved.language,
    hero: flags.hero ?? saved.hero,
    heroDark: flags.heroDark ?? saved.heroDark,
    banner: flags.banner ?? saved.banner,
  };
}

const statusMark: Record<string, string> = { filled: "готов", empty: "ПУСТО", omitted: "пропущен" };

function slotSummary(plan: Plan): string[] {
  return plan.slots.map((s) => `  ${statusMark[s.status].padEnd(8)} ${s.id.padEnd(12)} ${s.note}`);
}

function plan(flags: PlanFlags): CommandResult<Plan> {
  const repo = resolveRepo(flags.repo);
  const options = resolveOptions(repo, flags);
  const draft = draftReadme(repo, options);
  const empty = draft.plan.slots.filter((s) => s.status === "empty").length;
  return {
    data: draft.plan,
    warnings: draft.plan.warnings,
    humanTodo: draft.plan.humanTodo,
    artifacts: [
      writeArtifact(repo, OPTIONS_FILE, json(options), "readme-options", flags.dryRun),
      writeArtifact(repo, PLAN_FILE, json(draft.plan), "readme-plan", flags.dryRun),
      writeArtifact(repo, DRAFT_FILE, draft.markdown, "readme-draft", flags.dryRun),
      writeArtifact(repo, TODO_FILE, renderTodo(draft.plan.humanTodo), "human-todo", flags.dryRun),
    ],
    summary: [
      options.preset === AUTO_PRESET
        ? `тип проекта: ${KIND_TITLES[draft.layout.projectType]}, стиль ${draft.layout.style}, язык ${options.language}; разделов: ${draft.plan.slots.length}, пустых: ${empty}`
        : `пресет ${options.preset}, язык ${options.language}; разделов: ${draft.plan.slots.length}, пустых: ${empty}`,
      ...(draft.layout.mode === "improve" ? [`в репозитории уже есть содержательный README (${draft.layout.existing!.lines} строк) — его лучше улучшать, а не заменять: repokit readme audit`] : []),
      ...slotSummary(draft.plan),
      ...(draft.plan.preserved.length > 0 ? [`ваши разделы сохранены: ${draft.plan.preserved.join(", ")}`] : []),
      `черновик: ${REPOKIT_DIR}/${DRAFT_FILE}; посмотреть: repokit preview serve`,
    ],
  };
}

interface ApplyData {
  written: boolean;
  added: number;
  removed: number;
  diff: string;
  remainingFill: number;
}

function apply(flags: PlanFlags): CommandResult<ApplyData> {
  const repo = resolveRepo(flags.repo);
  const draft = draftReadme(repo, resolveOptions(repo, flags));
  const diff = lineDiff(draft.current ?? "", draft.markdown);
  const stats = diffStats(diff);
  const changed = draft.current !== draft.markdown;
  const remainingFill = draft.plan.problems.filter((p) => p.kind === "fill").length;
  const warnings = [...draft.plan.warnings];
  if (remainingFill > 0) warnings.push(`в README остаются незаполненные места: ${remainingFill}. До публикации их нужно заполнить (repokit readme check).`);

  // Somebody's own README is not overwritten on the way past: that takes an explicit decision.
  if (changed && !flags.dryRun && !flags.regenerate && draft.current !== null && draft.layout.mode === "improve" && !writtenByRepokit(repo, draft.current)) {
    const { lines, sections } = draft.layout.existing!;
    return {
      data: { written: false, ...stats, diff: formatDiff(diff), remainingFill },
      exitCode: ExitCode.NeedsHuman,
      warnings,
      humanTodo: [
        ...draft.plan.humanTodo,
        { id: "readme.existing", text: `В репозитории уже есть содержательный README (${lines} строк, разделов: ${sections.length}); заменять его целиком — решение автора. Что в нём стоит улучшить: repokit readme audit. Заменить черновиком ${REPOKIT_DIR}/${DRAFT_FILE}: repokit readme apply --regenerate (прежний сохранится в ${REPOKIT_DIR}/${BACKUP_FILE}).` },
      ],
      summary: [`README.md не тронут: в репозитории уже есть содержательный README (${lines} строк). Улучшить его: repokit readme audit; заменить: --regenerate`],
    };
  }

  const artifacts = flags.dryRun ? [] : writeReadme(repo, draft);
  return {
    data: { written: changed && !flags.dryRun, ...stats, diff: formatDiff(diff), remainingFill },
    warnings,
    humanTodo: draft.plan.humanTodo,
    artifacts,
    summary: [
      !changed ? "README уже соответствует плану — изменений нет"
        : flags.dryRun ? `dry-run: было бы изменено строк +${stats.added} −${stats.removed}; README не тронут`
        : `README.md записан: +${stats.added} −${stats.removed}${draft.current !== null ? `; прежняя версия — ${REPOKIT_DIR}/${BACKUP_FILE}` : ""}`,
      ...(flags.dryRun && changed ? formatDiff(diff).split("\n").map((l) => `  ${l}`) : []),
    ],
  };
}

function check(flags: CommonFlags): CommandResult<{ problems: ReadmeProblem[] }> {
  const repo = resolveRepo(flags.repo);
  const readmePath = join(repo, README);
  if (!existsSync(readmePath)) throw new UsageError("В репозитории нет README.md");
  const context = loadContext(repo, loadOptions(repo));
  const problems = checkReadme(readFileSync(readmePath, "utf8"), context.files);
  return {
    data: { problems },
    exitCode: problems.length > 0 ? ExitCode.CheckFailed : ExitCode.Ok,
    summary: [`проблем в README: ${problems.length}`, ...problems.map((p) => `  строка ${p.line}: ${p.message}`)],
  };
}

const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

function layoutCommand(flags: PlanFlags): CommandResult<Layout> {
  const repo = resolveRepo(flags.repo);
  const options = resolveOptions(repo, flags);
  const context = loadContext(repo, options);
  const readmePath = join(repo, README);
  const layout = planLayout(context, existsSync(readmePath) ? readFileSync(readmePath, "utf8") : null, options.style);
  const mark: Record<string, string> = { must: "MUST", should: "SHOULD", optional: "OPTIONAL", omit: "—" };
  const unsure = layout.confidence < 0.6;
  return {
    data: layout,
    artifacts: [writeArtifact(repo, LAYOUT_FILE, json(layout), "readme-layout", flags.dryRun)],
    humanTodo: unsure ? [{ id: "readme.project-type", text: `Тип проекта определён неуверенно (${KIND_TITLES[layout.projectType]}, ${Math.round(layout.confidence * 100)}%). Проверьте поле projectType в ${REPOKIT_DIR}/${LAYOUT_FILE}; возможные варианты: ${layout.alternatives.join(", ") || "нет"}.` }] : [],
    summary: [
      `тип проекта: ${KIND_TITLES[layout.projectType]} (${Math.round(layout.confidence * 100)}%) — ${layout.signals.slice(0, 3).join("; ")}`,
      `стиль: ${layout.style} — ${STYLE_TITLES[layout.style]}`,
      `читатель: ${layout.audience.join(", ")}; главное действие: ${layout.primaryAction}; демо: ${layout.demo}`,
      ...layout.sections.map((s) => `  ${mark[s.priority].padEnd(8)} ${s.id.padEnd(13)} ${s.reason}${s.collapsible ? " (свёрнут)" : ""}`),
      layout.mode === "improve"
        ? `режим: улучшить существующий README (${layout.existing!.lines} строк) — repokit readme audit`
        : "режим: собрать README — repokit readme plan",
      `план можно править: ${REPOKIT_DIR}/${LAYOUT_FILE} (priority: must | should | optional | omit)`,
    ],
  };
}

interface AuditData {
  /** Mechanical repairs made by --fix (or that it would make, on a dry run). */
  fixes: string[];
  file: string;
  projectType: ProjectKind;
  passed: number;
  failed: number;
  errors: number;
  checks: AuditCheck[];
}

interface AuditFlags extends CommonFlags {
  draft?: boolean;
  fix?: boolean;
}

function audit(flags: AuditFlags, only: (checks: AuditCheck[]) => AuditCheck[] = (c) => c): CommandResult<AuditData> {
  const repo = resolveRepo(flags.repo);
  const options = loadOptions(repo);
  const readmePath = join(repo, README);
  const draft = flags.draft ? readArtifact(repo, DRAFT_FILE) : null;
  if (flags.draft && draft === null) throw new UsageError(`Черновика нет: сначала repokit readme plan`);
  if (!flags.draft && !existsSync(readmePath)) throw new UsageError("В репозитории нет README.md. Собрать: repokit readme plan");
  if (flags.fix && flags.draft) throw new UsageError("--fix правит README.md; черновик пересобирается командой readme plan");
  let markdown = draft ?? readFileSync(readmePath, "utf8");
  const context = loadContext(repo, options);
  const artifacts = [];
  let fixes: string[] = [];
  if (flags.fix) {
    const fixed = fixReadme(markdown, context.i18n.phrases.showCode);
    fixes = fixed.fixes;
    if (fixed.markdown !== markdown && !flags.dryRun) {
      const own = writtenByRepokit(repo, markdown);
      artifacts.push(writeArtifact(repo, BACKUP_FILE, markdown, "readme-backup"));
      writeFileSync(readmePath, fixed.markdown);
      // A README repokit wrote stays recognisable as its own after the repair.
      if (own) artifacts.push(writeArtifact(repo, APPLIED_FILE, json({ schemaVersion: 1, sha256: sha256(fixed.markdown) }), "readme-applied"));
    }
    if (!flags.dryRun) markdown = fixed.markdown;
  }
  const layout = resolveLayout(repo, context, markdown, options.style);
  const checks = only(auditReadme(markdown, context, layout));
  const failed = checks.filter((c) => !c.ok);
  const errors = failed.filter((c) => c.severity === "error").length;
  const data: AuditData = { fixes, file: flags.draft ? `${REPOKIT_DIR}/${DRAFT_FILE}` : README, projectType: layout.projectType, passed: checks.length - failed.length, failed: failed.length, errors, checks };
  return {
    data,
    exitCode: errors > 0 ? ExitCode.CheckFailed : ExitCode.Ok,
    artifacts: [...artifacts, writeArtifact(repo, AUDIT_FILE, json(data), "readme-audit", flags.dryRun)],
    summary: [
      ...(flags.fix ? [fixes.length === 0 ? "исправлять автоматически нечего" : `${flags.dryRun ? "были бы исправлены" : "исправлено"}: ${fixes.length}${flags.dryRun ? "" : `; прежняя версия — ${REPOKIT_DIR}/${BACKUP_FILE}`}`, ...fixes.map((f) => `  ${f}`)] : []),
      `${data.file} — ${KIND_TITLES[layout.projectType]}: пройдено ${data.passed} из ${checks.length}, обязательных замечаний: ${errors}, советов: ${failed.length - errors}`,
      ...renderAudit(checks),
    ],
  };
}

function examplesExtract(flags: CommonFlags): CommandResult<ExamplesDoc> {
  const repo = resolveRepo(flags.repo);
  const files = new Set(listFiles(repo).files.map((f) => f.path));
  const doc = extractExamples(repo, analyze(repo), files);
  return {
    data: doc,
    artifacts: [writeArtifact(repo, EXAMPLES_FILE, json(doc), "examples", flags.dryRun)],
    humanTodo: doc.examples.length === 0 ? [{ id: "examples.none", text: "В репозитории не найдено примеров использования. Добавьте минимальный рабочий пример в папку examples/ — repokit не сочиняет примеры сам." }] : [],
    summary: [
      `примеров: ${doc.examples.length}, команд: ${doc.commands.length}, опций: ${doc.options.length}`,
      ...doc.examples.slice(0, 6).map((e) => `  ${e.score.toFixed(2)}  ${e.file}:${e.lines[0]}–${e.lines[1]}  ${e.kind}  ${e.title}`),
    ],
  };
}

interface DiagramData {
  blocks: number;
  edges: number;
  /** How many blocks there were before folding into directories. */
  unfolded: number;
  mermaid: string;
}

function diagramArchitecture(flags: CommonFlags & { maxBlocks?: string }): CommandResult<DiagramData> {
  const repo = resolveRepo(flags.repo);
  const max = flags.maxBlocks === undefined ? undefined : Number(flags.maxBlocks);
  if (max !== undefined && (!Number.isInteger(max) || max < 3 || max > 12)) throw new UsageError("--max-blocks: целое число от 3 до 12");
  const context = loadContext(repo, loadOptions(repo));
  const full = buildGraph(repo, context.scan, context.files);
  const graph = groupGraph(full, max);
  const text = mermaid(graph, context.i18n.phrases);
  const tooSmall = graph.nodes.length < 3;
  return {
    data: { blocks: graph.nodes.length, edges: graph.edges.length, unfolded: full.nodes.length, mermaid: text },
    artifacts: tooSmall ? [] : [writeArtifact(repo, DIAGRAM_FILE, text + "\n", "architecture-diagram", flags.dryRun)],
    warnings: tooSmall ? ["связанных модулей меньше трёх — схема ничего не объяснит, в README её лучше не ставить"] : [],
    summary: [`блоков: ${graph.nodes.length}${full.nodes.length > graph.nodes.length ? ` (свёрнуто из ${full.nodes.length})` : ""}, связей: ${graph.edges.length}`, ...(tooSmall ? [] : text.split("\n").map((l) => `  ${l}`))],
  };
}

function presets(): CommandResult<{ presets: { name: string; title: string; description: string; slots: ReadmeSlotId[]; required: ReadmeSlotId[] }[] }> {
  const list = listReadmePresets().map((p) => ({ name: p.name, title: p.title, description: p.description, slots: p.slots.map((s) => s.id), required: p.required }));
  return { data: { presets: list }, summary: list.map((p) => `${p.name} — ${p.title}. ${p.description} Разделы: ${p.slots.join(", ")}`) };
}

function humanInit(flags: CommonFlags): CommandResult<{ file: string; existed: boolean }> {
  const repo = resolveRepo(flags.repo);
  const existed = readArtifact(repo, HUMAN_FILE) !== null;
  const file = `${REPOKIT_DIR}/${HUMAN_FILE}`;
  return {
    data: { file, existed },
    artifacts: existed ? [] : [writeArtifact(repo, HUMAN_FILE, HUMAN_TEMPLATE, "readme-human", flags.dryRun)],
    humanTodo: [{ id: "readme.human", text: `Заполните ${file}: тэглайн, проблема, решение, команда. Или в интерфейсе: repokit preview serve` }],
    summary: [existed ? `${file} уже существует — не тронут` : `создан шаблон ${file}`],
  };
}

export function registerReadme(program: Command): void {
  const readme = program.command("readme").description("сборка README из подтверждённых фактов");
  const planFlags = (c: Command) =>
    commonFlags(c)
      .option("--preset <name>", "фиксированный шаблон вместо структуры по типу проекта; см. readme presets")
      .option("--style <name>", `стиль подачи: ${STYLES.join(", ")} (по умолчанию — по типу проекта)`)
      .option("--lang <code>", `язык README: ${LANGUAGES.join(", ")} (по умолчанию ru)`)
      .option("--hero <file>", "главное изображение или GIF, путь относительно репозитория")
      .option("--hero-dark <file>", "вариант главного изображения для тёмной темы")
      .option("--banner <file>", "баннер над названием (см. repokit studio banner --size wide)");

  readme.command("presets").description("список пресетов оформления").option("--json", "один JSON-документ в stdout")
    .action((flags: { json?: boolean }) => runCommand("readme", "presets", flags, presets));
  commonFlags(readme.command("human").description(`создать шаблон полей, которые решает человек → .repokit/${HUMAN_FILE}`))
    .action((flags: CommonFlags) => runCommand("readme", "human", flags, () => humanInit(flags)));
  planFlags(readme.command("plan").description("собрать черновик README и показать, чем заполнен каждый раздел"))
    .action((flags: PlanFlags) => runCommand("readme", "plan", flags, () => plan(flags)));
  planFlags(readme.command("layout").description(`определить тип проекта и спланировать структуру README → .repokit/${LAYOUT_FILE}`))
    .action((flags: PlanFlags) => runCommand("readme", "layout", flags, () => layoutCommand(flags)));
  planFlags(readme.command("generate").description("то же, что plan: собрать черновик README"))
    .action((flags: PlanFlags) => runCommand("readme", "generate", flags, () => plan(flags)));
  commonFlags(readme.command("audit").description("оценить README по категориям: понятность, первый экран, визуалы, запуск, примеры, утверждения, оформление, файлы"))
    .option("--draft", "проверить черновик .repokit/readme.draft.md вместо README.md")
    .option("--fix", "исправить механические проблемы: уровни заголовков, лишние пустые строки, очень длинные блоки кода")
    .action((flags: AuditFlags) => runCommand("readme", "audit", flags, () => audit(flags)));
  commonFlags(readme.command("hero-check").description("проверить первый экран README: что это, для кого, что делать дальше"))
    .option("--draft", "проверить черновик .repokit/readme.draft.md вместо README.md")
    .action((flags: AuditFlags) => runCommand("readme", "hero-check", flags, () => audit(flags, heroChecks)));
  planFlags(readme.command("apply").description("записать README.md; --dry-run показывает diff"))
    .option("--regenerate", "заменить существующий содержательный README, написанный не repokit")
    .action((flags: PlanFlags) => runCommand("readme", "apply", flags, () => apply(flags)));
  commonFlags(readme.command("check").description("проверить README.md: незаполненные места, битые ссылки, alt-тексты"))
    .action((flags: CommonFlags) => runCommand("readme", "check", flags, () => check(flags)));

  const examples = program.command("examples").description("реальные примеры использования из репозитория");
  commonFlags(examples.command("extract").description(`найти примеры в examples/, документации и тестах → .repokit/${EXAMPLES_FILE}`))
    .action((flags: CommonFlags) => runCommand("examples", "extract", flags, () => examplesExtract(flags)));
  const diagram = program.command("diagram").description("схемы, построенные по коду");
  commonFlags(diagram.command("architecture").description(`схема архитектуры в Mermaid, не больше ${MAX_BLOCKS} блоков → .repokit/${DIAGRAM_FILE}`))
    .option("--max-blocks <n>", "сколько блоков оставить: от 3 до 12")
    .action((flags: CommonFlags & { maxBlocks?: string }) => runCommand("diagram", "architecture", flags, () => diagramArchitecture(flags)));
}
