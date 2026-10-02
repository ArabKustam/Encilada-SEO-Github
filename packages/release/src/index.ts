import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import {
  commonFlags, ExitCode, NeedsHumanError, readArtifact, redact, REPOKIT_DIR, resolveRepo, runCommand, UsageError, writeArtifact,
  type CommandResult, type CommonFlags, type HumanTodo,
} from "@repokit/core";
import { detectStack, loadContext, loadOptions } from "@repokit/readme";

const NOTES_FILE = "release.md";
const DEFAULT_TAG = "v0.1.0";
/** Files worth attaching to a release when they exist. */
const ASSET_CANDIDATES = ["docs/media/hero.mp4", "docs/media/hero.webm", "docs/media/hero-3d.mp4", "docs/media/how-it-works.mp4", "docs/media/banner.png", "docs/slides/slides.pdf"];
const TAG_PATTERN = /^v?\d+\.\d+\.\d+([-.][0-9A-Za-z.]+)?$/;

export interface ReleasePlan {
  tag: string;
  title: string;
  notes: string;
  assets: string[];
  /** The tag already exists in the local repository. */
  tagExists: boolean;
  github: { owner: string; repo: string } | null;
}

/** Runs a command of the user's CLI. Injected so that releases can be tested without touching GitHub. */
export type Executor = (command: string[], cwd: string) => { code: number; output: string };

const realExecutor: Executor = (command, cwd) => {
  const result = spawnSync(command[0], command.slice(1), { cwd, encoding: "utf8", shell: process.platform === "win32" });
  return { code: result.error ? 127 : result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
};

const git = (repo: string, args: string[]): string | null => {
  try {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};

/** Version declared by the project itself: package.json or pyproject.toml. */
function declaredVersion(repo: string): string | null {
  if (existsSync(join(repo, "package.json"))) {
    try {
      const version = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version;
      if (typeof version === "string") return version;
    } catch {
      // Fall through to the other manifest.
    }
  }
  if (existsSync(join(repo, "pyproject.toml"))) {
    return readFileSync(join(repo, "pyproject.toml"), "utf8").match(/^version\s*=\s*["']([^"']+)["']/m)?.[1] ?? null;
  }
  return null;
}

/** What a release would contain, built only from what is known about the project. */
export function planRelease(repo: string, requestedTag?: string): { plan: ReleasePlan; humanTodo: HumanTodo[] } {
  const context = loadContext(repo, loadOptions(repo));
  const { human, scan } = context;
  const version = declaredVersion(repo);
  const tag = requestedTag ?? (version ? `v${version.replace(/^v/, "")}` : DEFAULT_TAG);
  if (!TAG_PATTERN.test(tag)) throw new UsageError(`Тег «${tag}» не похож на версию. Ожидается вид v1.2.3`);
  const title = human.title ?? scan.project.name;
  const humanTodo: HumanTodo[] = [];
  if (!requestedTag && !version) humanTodo.push({ id: "release.tag", text: `Версия проекта нигде не объявлена — предложен тег ${DEFAULT_TAG}. Задайте свой: --tag v1.0.0` });

  const proven = context.claims.filter((c) => (c.status === "implemented" || c.status === "partial") && c.evidence.length > 0);
  const gaps = context.claims.filter((c) => c.status === "mock" || (c.status === "partial" && c.note));
  const stack = detectStack(scan, context.files).map((t) => t.name);
  const live = human.demoUrl ?? context.deployment?.url;
  const { commands } = scan.project;

  const sections: string[] = [];
  if (human.tagline) sections.push(human.tagline);
  else humanTodo.push({ id: "release.tagline", text: "В описании релиза нет вступления: заполните поле tagline в .repokit/readme.human.yaml" });
  if (proven.length > 0) {
    sections.push(`## Что работает\n\n${proven.map((c) => `- ${c.text}${c.status === "partial" && c.note ? ` (частично: ${c.note})` : ""}`).join("\n")}`);
  } else {
    humanTodo.push({ id: "release.claims", text: "Нет утверждений, подтверждённых кодом — раздел «Что работает» в релиз не попал" });
  }
  // The same honesty as in the README: what is a stub is said to be a stub.
  if (gaps.length > 0) sections.push(`## Известные ограничения\n\n${gaps.map((c) => `- ${c.text} — ${c.status === "mock" ? "пока заглушка" : c.note}`).join("\n")}`);
  if (commands.run) {
    sections.push(`## Как запустить\n\n\`\`\`bash\n${[commands.install, commands.run].filter(Boolean).join("\n")}\n\`\`\``);
  }
  if (stack.length > 0) sections.push(`## Технологии\n\n${stack.join(", ")}`);
  if (live) sections.push(`## Ссылки\n\n- Работающая версия: ${live}`);

  return {
    plan: {
      tag,
      title: `${title} ${tag}`,
      notes: sections.join("\n\n") + "\n",
      assets: ASSET_CANDIDATES.filter((path) => existsSync(join(repo, path))),
      tagExists: (git(repo, ["tag", "--list", tag]) ?? "") !== "",
      github: context.github,
    },
    humanTodo,
  };
}

export interface ReleaseOutcome {
  created: boolean;
  /** Why nothing was created, when nothing was. */
  reason?: string;
  url?: string;
  output: string;
}

/** Create the release on GitHub through the user's own `gh`, unless one with this tag is already there. */
export function createRelease(repo: string, plan: ReleasePlan, notesFile: string, options: { draft?: boolean } = {}, execute: Executor = realExecutor): ReleaseOutcome {
  if (!plan.github) throw new NeedsHumanError("У репозитория нет origin на GitHub. Создайте репозиторий на GitHub и запушьте в него код.");
  const who = execute(["gh", "auth", "status"], repo);
  if (who.code !== 0) {
    throw new NeedsHumanError(
      who.code === 127 || /not found|not recognized|не является/i.test(who.output)
        ? "Не найден gh. Установите его (https://cli.github.com) и войдите: gh auth login"
        : "Вы не вошли в GitHub CLI. Выполните сами: gh auth login",
    );
  }
  const existing = execute(["gh", "release", "view", plan.tag], repo);
  if (existing.code === 0) {
    return { created: false, reason: `релиз ${plan.tag} уже существует`, output: "", url: existing.output.match(/https:\/\/github\.com\/\S+\/releases\/tag\/\S+/)?.[0] };
  }
  const command = ["gh", "release", "create", plan.tag, "--title", plan.title, "--notes-file", notesFile, ...(options.draft ? ["--draft"] : []), ...plan.assets];
  const result = execute(command, repo);
  const output = redact(result.output.trim()).slice(-1500);
  if (result.code !== 0) return { created: false, reason: "gh завершился с ошибкой", output };
  return { created: true, output, url: result.output.match(/https:\/\/github\.com\/\S+/)?.[0] };
}

interface ReleaseFlags extends CommonFlags {
  tag?: string;
  confirm?: boolean;
  draft?: boolean;
}

function plan(flags: ReleaseFlags): CommandResult<ReleasePlan> {
  const repo = resolveRepo(flags.repo);
  const { plan: built, humanTodo } = planRelease(repo, flags.tag);
  return {
    data: built,
    humanTodo,
    warnings: built.tagExists ? [`тег ${built.tag} уже есть в репозитории — релиз будет привязан к нему`] : [],
    artifacts: [writeArtifact(repo, NOTES_FILE, built.notes, "release-notes", flags.dryRun)],
    summary: [
      `релиз ${built.title}; файлов для прикрепления: ${built.assets.length}${built.assets.length ? ` (${built.assets.join(", ")})` : ""}`,
      `описание: ${REPOKIT_DIR}/${NOTES_FILE} — его можно править перед созданием релиза`,
      ...built.notes.trimEnd().split("\n").map((line) => `  ${line}`),
    ],
  };
}

function create(flags: ReleaseFlags): CommandResult<ReleaseOutcome | { wouldRun: string }> {
  const repo = resolveRepo(flags.repo);
  const { plan: built, humanTodo } = planRelease(repo, flags.tag);
  // Notes edited by the author after `release plan` are used as they are.
  const notes = readArtifact(repo, NOTES_FILE) ?? built.notes;
  const command = `gh release create ${built.tag}${flags.draft ? " --draft" : ""}${built.assets.map((a) => ` ${a}`).join("")}`;
  if (flags.dryRun) return { data: { wouldRun: command }, humanTodo, summary: ["dry-run: релиз не создавался", `  ${command}`] };
  // A release is public and notifies watchers: it never happens on a plain invocation.
  if (!flags.confirm) {
    throw new NeedsHumanError(`Релиз ${built.tag} станет виден всем${flags.draft ? " после публикации черновика" : ""}. Будет выполнено: ${command}. Подтвердить: repokit release create --confirm`);
  }
  const artifact = writeArtifact(repo, NOTES_FILE, notes, "release-notes");
  const head = git(repo, ["rev-parse", "HEAD"]);
  const pushed = head && git(repo, ["branch", "-r", "--contains", head]);
  const warnings = pushed ? [] : ["последний коммит не запушен — релиз будет привязан к тому, что уже есть на GitHub"];
  const outcome = createRelease(repo, built, join(repo, REPOKIT_DIR, NOTES_FILE), { draft: flags.draft });
  return {
    data: outcome,
    exitCode: outcome.created || outcome.reason?.includes("уже существует") ? ExitCode.Ok : ExitCode.CheckFailed,
    warnings,
    humanTodo,
    artifacts: [artifact],
    summary: [outcome.created ? `релиз создан${outcome.url ? `: ${outcome.url}` : ""}` : `релиз не создан — ${outcome.reason}${outcome.output ? `: ${outcome.output}` : ""}`],
  };
}

export function registerRelease(program: Command): void {
  const release = program.command("release").description("релиз на GitHub: описание из фактов о проекте, создание через ваш gh");
  const flags = (c: Command) => commonFlags(c).option("--tag <tag>", "тег релиза, например v1.0.0 (по умолчанию — версия из манифеста проекта)");
  flags(release.command("plan").description("собрать описание релиза → .repokit/release.md"))
    .action((f: ReleaseFlags) => runCommand("release", "plan", f, () => plan(f)));
  flags(release.command("create").description("создать релиз, если его ещё нет — только с --confirm"))
    .option("--confirm", "подтверждаю публикацию релиза")
    .option("--draft", "создать черновик, не публикуя")
    .action((f: ReleaseFlags) => runCommand("release", "create", f, () => create(f)));
}
