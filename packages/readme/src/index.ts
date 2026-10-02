import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import {
  commonFlags, diffStats, ExitCode, formatDiff, lineDiff, readArtifact, REPOKIT_DIR, resolveRepo, runCommand, UsageError, writeArtifact,
  type CommandResult, type CommonFlags, type HumanTodo, type ReadmeSlotId,
} from "@repokit/core";
import { buildReadme, type SlotResult } from "./build.js";
import {
  findReadmePreset, HUMAN_FILE, LANGUAGES, listReadmePresets, loadContext, loadOptions, OPTIONS_FILE,
  type Context, type Language, type Options,
} from "./context.js";
import { checkReadme, mergeCustomSections, type ReadmeProblem } from "./merge.js";

export { buildReadme, slug } from "./build.js";
export type { SlotResult, SlotStatus } from "./build.js";
export { buildGraph, mermaid } from "./architecture.js";
export { DEFAULT_OPTIONS, findReadmePreset, HUMAN_FILE, LANGUAGES, listReadmePresets, loadContext, loadHuman, loadOptions } from "./context.js";
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
  plan: Plan;
}

/** Build the README for a repository without writing anything. */
export function draftReadme(repo: string, options: Options): Draft {
  const preset = findReadmePreset(options.preset);
  const context = loadContext(repo, options);
  const built = buildReadme(context, preset);
  const readmePath = join(repo, README);
  const current = existsSync(readmePath) ? readFileSync(readmePath, "utf8") : null;
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
    plan: {
      schemaVersion: 1,
      preset: preset.name,
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
}

/** Options from disk, overridden by any flags given on this run. */
function resolveOptions(repo: string, flags: PlanFlags): Options {
  const saved = loadOptions(repo);
  if (flags.lang && !LANGUAGES.includes(flags.lang as Language)) throw new UsageError(`Язык «${flags.lang}» не поддерживается. Доступны: ${LANGUAGES.join(", ")}`);
  return {
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
  const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
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
      `пресет ${options.preset}, язык ${options.language}; разделов: ${draft.plan.slots.length}, пустых: ${empty}`,
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

  const artifacts = [];
  if (changed && !flags.dryRun) {
    // The previous README is never lost: it is kept next to the other artifacts.
    if (draft.current !== null) artifacts.push(writeArtifact(repo, BACKUP_FILE, draft.current, "readme-backup"));
    writeFileSync(join(repo, README), draft.markdown);
  }
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
      .option("--preset <name>", "пресет оформления; см. readme presets")
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
  planFlags(readme.command("apply").description("записать README.md; --dry-run показывает diff"))
    .action((flags: PlanFlags) => runCommand("readme", "apply", flags, () => apply(flags)));
  commonFlags(readme.command("check").description("проверить README.md: незаполненные места, битые ссылки, alt-тексты"))
    .action((flags: CommonFlags) => runCommand("readme", "check", flags, () => check(flags)));
}
