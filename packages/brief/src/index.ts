import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import {
  assertValid, commonFlags, ExitCode, readArtifact, REPOKIT_DIR, resolveRepo, runCommand, sha256, UsageError, writeArtifact,
  type CommandResult, type CommonFlags, type EvidenceKind, type HumanTodo, type ReadmeSlotId,
} from "@repokit/core";

export interface Criterion {
  id: string;
  title: string;
  weight?: number;
  quote?: string;
}

export interface Brief {
  schemaVersion: 1;
  source: { kind: "file" | "url" | "text" | "default-profile"; ref: string; sha256: string };
  isDefaultProfile: boolean;
  criteria: Criterion[];
  submission: { id: string; title: string; required: boolean; constraint?: string; quote?: string }[];
  deadlines: { id: string; title: string; date: string; quote?: string }[];
  restrictions: { id: string; title: string; quote?: string }[];
  matrix: { criterionId: string; evidenceKinds: EvidenceKind[]; readmeSlot: ReadmeSlotId }[];
}

const BRIEF_FILE = "brief.json";
const SOURCE_FILE = "brief.source.txt";
const WEIGHT_TOLERANCE = 0.01;
const FETCH_TIMEOUT_MS = 20_000;
const HINT_PATTERN = /критери|оценк|балл|жюри|дедлайн|срок|обязательн|запрещ|criteria|judg|score|points|deadline|submission|required|must|\d+\s?%/i;
const MAX_HINTS = 40;

/** Used when a hackathon published no rules. Typical criteria, clearly marked as an assumption. */
const DEFAULT_PROFILE: Pick<Brief, "criteria" | "matrix"> = {
  criteria: [
    { id: "idea", title: "Идея и польза" },
    { id: "implementation", title: "Техническая реализация" },
    { id: "completeness", title: "Работоспособность и завершённость" },
    { id: "ux", title: "Дизайн и удобство" },
    { id: "presentation", title: "Подача и документация" },
  ],
  matrix: [
    { criterionId: "idea", evidenceKinds: ["docs"], readmeSlot: "problem" },
    { criterionId: "implementation", evidenceKinds: ["feature", "architecture", "tests"], readmeSlot: "features" },
    { criterionId: "completeness", evidenceKinds: ["demo", "deploy"], readmeSlot: "demo" },
    { criterionId: "ux", evidenceKinds: ["demo"], readmeSlot: "hero" },
    { criterionId: "presentation", evidenceKinds: ["docs"], readmeSlot: "quickstart" },
  ],
};

const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };

/** Plain text of an HTML page: enough to quote rules from, not a faithful rendering. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#39|[a-z]+);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match)
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*/g, "\n\n")
    .trim();
}

/** Whitespace, case and typographic quotes/dashes are ignored when looking for a quote in the rules. */
const normalize = (text: string) => text.toLowerCase().replace(/[«»“”„"']/g, '"').replace(/[–—−]/g, "-").replace(/\s+/g, " ").trim();

export function loadBrief(repo: string): Brief | null {
  const text = readArtifact(repo, BRIEF_FILE);
  if (text === null) return null;
  let brief: Brief;
  try {
    brief = JSON.parse(text);
  } catch {
    throw new UsageError(`${REPOKIT_DIR}/${BRIEF_FILE}: некорректный JSON`);
  }
  assertValid("brief", brief);
  return brief;
}

/** Problems that make a brief unusable: invented criteria, broken references, missing matrix rows. */
export function validateBrief(brief: Brief, sourceText: string | null): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const ids = new Set<string>();
  for (const criterion of brief.criteria) {
    if (ids.has(criterion.id)) problems.push(`критерий «${criterion.id}» повторяется`);
    ids.add(criterion.id);
  }
  if (brief.criteria.length === 0) problems.push("нет ни одного критерия: заполните criteria или используйте brief init --default");

  if (!brief.isDefaultProfile) {
    if (sourceText === null) problems.push(`нет ${REPOKIT_DIR}/${SOURCE_FILE}: нечем подтвердить цитаты (repokit brief extract)`);
    const haystack = normalize(sourceText ?? "");
    const quoted: [string, { id: string; quote?: string }[]][] = [
      ["критерий", brief.criteria], ["требование к подаче", brief.submission], ["срок", brief.deadlines], ["ограничение", brief.restrictions],
    ];
    for (const [kind, items] of quoted) {
      for (const item of items) {
        if (!item.quote) problems.push(`${kind} «${item.id}»: нет цитаты из правил`);
        else if (sourceText !== null && !haystack.includes(normalize(item.quote))) problems.push(`${kind} «${item.id}»: цитата не найдена в тексте правил`);
      }
    }
  }

  const weights = brief.criteria.map((c) => c.weight).filter((w): w is number => w !== undefined);
  if (weights.length > 0 && weights.length < brief.criteria.length) warnings.push("веса указаны не у всех критериев");
  if (weights.length === brief.criteria.length && weights.length > 0) {
    const sum = weights.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1) > WEIGHT_TOLERANCE) warnings.push(`сумма весов ${sum.toFixed(2)}, а не 1`);
  }

  for (const row of brief.matrix) if (!ids.has(row.criterionId)) problems.push(`матрица ссылается на неизвестный критерий «${row.criterionId}»`);
  const covered = new Set(brief.matrix.map((row) => row.criterionId));
  for (const id of ids) if (!covered.has(id)) problems.push(`критерий «${id}» не покрыт матрицей: укажите, чем он подтверждается`);
  return { problems, warnings };
}

interface ExtractFlags extends CommonFlags {
  file?: string;
  text?: string;
  url?: string;
}

async function extract(flags: ExtractFlags): Promise<CommandResult<{ sha256: string; chars: number; hints: string[] }>> {
  const repo = resolveRepo(flags.repo);
  const given = [flags.file, flags.text, flags.url].filter((v) => v !== undefined);
  if (given.length !== 1) throw new UsageError("Укажите ровно один источник правил: --file <путь>, --text <текст> или --url <адрес>");

  let kind: Brief["source"]["kind"];
  let ref: string;
  let text: string;
  if (flags.file !== undefined) {
    const file = resolve(flags.file);
    if (!existsSync(file)) throw new UsageError(`Файл не найден: ${flags.file}`);
    const raw = readFileSync(file, "utf8");
    kind = "file";
    ref = flags.file;
    text = /\.html?$/i.test(file) ? htmlToText(raw) : raw;
  } else if (flags.url !== undefined) {
    // The only network request in this service, made only because --url was passed.
    if (!/^https?:\/\//.test(flags.url)) throw new UsageError("--url должен начинаться с http:// или https://");
    let response: Response;
    try {
      response = await fetch(flags.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (error) {
      throw new UsageError(`Не удалось загрузить ${flags.url}: ${(error as Error).message}`);
    }
    if (!response.ok) throw new UsageError(`Не удалось загрузить ${flags.url}: HTTP ${response.status}`);
    const raw = await response.text();
    kind = "url";
    ref = flags.url;
    text = /html/i.test(response.headers.get("content-type") ?? "") ? htmlToText(raw) : raw;
  } else {
    kind = "text";
    ref = "inline";
    text = flags.text!;
  }
  text = text.replace(/\r\n/g, "\n").trim() + "\n";
  if (text.trim().length === 0) throw new UsageError("Текст правил пуст.");

  const hash = sha256(text);
  const hints = text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0 && HINT_PATTERN.test(line)).slice(0, MAX_HINTS);
  const artifacts = [writeArtifact(repo, SOURCE_FILE, text, "brief-source", flags.dryRun)];
  if (readArtifact(repo, BRIEF_FILE) === null) {
    const skeleton: Brief = {
      schemaVersion: 1, source: { kind, ref, sha256: hash }, isDefaultProfile: false,
      criteria: [], submission: [], deadlines: [], restrictions: [], matrix: [],
    };
    artifacts.push(writeArtifact(repo, BRIEF_FILE, json(skeleton), "brief", flags.dryRun));
  }
  return {
    data: { sha256: hash, chars: text.length, hints },
    artifacts,
    summary: [
      `текст правил: ${text.length} символов; строк-подсказок с критериями, сроками и требованиями: ${hints.length}`,
      `заполните ${REPOKIT_DIR}/${BRIEF_FILE} по тексту правил (каждый пункт — с дословной цитатой), затем: repokit brief validate`,
    ],
  };
}

function init(flags: CommonFlags & { default?: boolean; force?: boolean }): CommandResult<Brief> {
  const repo = resolveRepo(flags.repo);
  if (!flags.default) throw new UsageError("Без правил используйте: repokit brief init --default. С правилами: repokit brief extract");
  if (readArtifact(repo, BRIEF_FILE) !== null && !flags.force) {
    throw new UsageError(`${REPOKIT_DIR}/${BRIEF_FILE} уже существует. Перезаписать: --force`);
  }
  const brief: Brief = {
    schemaVersion: 1,
    source: { kind: "default-profile", ref: "repokit", sha256: sha256(JSON.stringify(DEFAULT_PROFILE)) },
    isDefaultProfile: true,
    ...DEFAULT_PROFILE,
    submission: [], deadlines: [], restrictions: [],
  };
  assertValid("brief", brief);
  return {
    data: brief,
    artifacts: [writeArtifact(repo, BRIEF_FILE, json(brief), "brief", flags.dryRun)],
    humanTodo: [{ id: "brief.default", text: "Критерии взяты из профиля по умолчанию, а не из правил хакатона. Если правила есть — передайте их в repokit brief extract." }],
    summary: [`профиль по умолчанию: критериев ${brief.criteria.length}; это допущение, а не правила хакатона`],
  };
}

function requireBrief(repo: string): Brief {
  const brief = loadBrief(repo);
  if (!brief) throw new UsageError(`Нет ${REPOKIT_DIR}/${BRIEF_FILE}. Сначала: repokit brief extract или repokit brief init --default`);
  return brief;
}

function validate(flags: CommonFlags): CommandResult<{ problems: string[]; criteria: number; isDefaultProfile: boolean }> {
  const repo = resolveRepo(flags.repo);
  const brief = requireBrief(repo);
  const { problems, warnings } = validateBrief(brief, readArtifact(repo, SOURCE_FILE));
  const humanTodo: HumanTodo[] = brief.isDefaultProfile
    ? [{ id: "brief.default", text: "Критерии — профиль по умолчанию. Сверьте с реальными правилами хакатона." }]
    : [];
  return {
    data: { problems, criteria: brief.criteria.length, isDefaultProfile: brief.isDefaultProfile },
    exitCode: problems.length > 0 ? ExitCode.CheckFailed : ExitCode.Ok,
    warnings,
    humanTodo,
    summary: [`критериев: ${brief.criteria.length}, требований к подаче: ${brief.submission.length}, проблем: ${problems.length}`, ...problems.map((p) => `  ${p}`)],
  };
}

function matrix(flags: CommonFlags): CommandResult<{ rows: { criterion: string; weight: number | null; evidenceKinds: string[]; readmeSlot: string }[] }> {
  const brief = requireBrief(resolveRepo(flags.repo));
  const rows = brief.matrix.map((row) => {
    const criterion = brief.criteria.find((c) => c.id === row.criterionId);
    return { criterion: criterion?.title ?? row.criterionId, weight: criterion?.weight ?? null, evidenceKinds: row.evidenceKinds, readmeSlot: row.readmeSlot };
  });
  return {
    data: { rows },
    warnings: brief.isDefaultProfile ? ["критерии — профиль по умолчанию, а не правила хакатона"] : [],
    summary: rows.map((r) => `${r.criterion}${r.weight !== null ? ` (${Math.round(r.weight * 100)}%)` : ""} → раздел README «${r.readmeSlot}»; подтверждается: ${r.evidenceKinds.join(", ")}`),
  };
}

export function registerBrief(program: Command): void {
  const brief = program.command("brief").description("разбор правил хакатона: критерии, требования, матрица доказательств");

  commonFlags(brief.command("extract").description("сохранить текст правил → .repokit/brief.source.txt и заготовку brief.json"))
    .option("--file <path>", "файл с правилами (txt, md, html)")
    .option("--text <text>", "текст правил")
    .option("--url <url>", "страница с правилами; единственная команда сервиса, которая обращается к сети")
    .action((flags: ExtractFlags) => runCommand("brief", "extract", flags, () => extract(flags)));

  commonFlags(brief.command("init").description("создать brief.json без правил — из профиля по умолчанию"))
    .option("--default", "использовать профиль критериев по умолчанию")
    .option("--force", "перезаписать существующий brief.json")
    .action((flags: CommonFlags & { default?: boolean; force?: boolean }) => runCommand("brief", "init", flags, () => init(flags)));

  commonFlags(brief.command("validate").description("проверить brief.json: схема, цитаты из правил, полнота матрицы"))
    .action((flags: CommonFlags) => runCommand("brief", "validate", flags, () => validate(flags)));

  commonFlags(brief.command("matrix").description("показать матрицу «критерий → чем подтвердить»"))
    .action((flags: CommonFlags) => runCommand("brief", "matrix", flags, () => matrix(flags)));
}
