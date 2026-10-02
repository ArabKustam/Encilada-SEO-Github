import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Command } from "commander";
import { ExitCode, NeedsHumanError, runCommand, say, UsageError, VERSION, type CommandResult } from "@repokit/core";

/** Services that need a browser engine and a video renderer: too large to ship inside the plugin. */
export const MEDIA_SERVICES = ["capture", "studio", "preview"] as const;
const SOURCE = "https://github.com/ArabKustam/Encilada-SEO-Github.git";
const PNPM_VERSION = "12.5.1";
const BIN = join("packages", "cli", "dist", "bin.js");

/** Where the full build lives: next to nothing of the user's, and outside the plugin, which is replaced on update. */
export const runtimeDir = () => process.env.REPOKIT_RUNTIME || join(process.env.REPOKIT_HOME || join(homedir(), ".repokit"), "runtime", VERSION);

/** The full command-line entry, if the media services have been set up. */
export function runtimeBin(): string | null {
  const bin = join(runtimeDir(), BIN);
  return existsSync(bin) ? bin : null;
}

export const SETUP_HINT = "Запись демо, монтаж и предпросмотр требуют разовой установки: repokit setup (скачивает браузерный движок и рендерер, около 1 ГБ).";

/** Hand a media command over to the full build, with the same arguments and the same terminal. */
export function delegate(service: string): void {
  const bin = runtimeBin();
  const args = process.argv.slice(2);
  if (!bin) {
    const json = args.includes("--json");
    void runCommand(service, args.find((a, i) => i > 0 && !a.startsWith("-")) ?? "", { json }, () => {
      throw new NeedsHumanError(SETUP_HINT);
    });
    return;
  }
  // The full build reads its own data files, not the packaged copy.
  const { REPOKIT_RESOURCES: _, ...env } = process.env;
  const result = spawnSync(process.execPath, [bin, ...args], { stdio: "inherit", env });
  process.exitCode = result.status ?? ExitCode.CheckFailed;
}

interface SetupFlags {
  json?: boolean;
  dryRun?: boolean;
  source?: string;
  force?: boolean;
}

interface SetupData {
  dir: string;
  installed: boolean;
  steps: string[];
}

function setup(flags: SetupFlags): CommandResult<SetupData> {
  const dir = runtimeDir();
  if (runtimeBin() && !flags.force) {
    return { data: { dir, installed: true, steps: [] }, summary: [`медиа-сервисы уже установлены: ${dir}`] };
  }
  const works = (command: string) => spawnSync(command, { shell: true, stdio: "ignore" }).status === 0;
  if (!works("git --version")) throw new NeedsHumanError("Не найден git. Установите его: https://git-scm.com/downloads");
  const pnpm = works("pnpm --version") ? "pnpm" : works("corepack --version") ? "corepack pnpm" : `npx -y pnpm@${PNPM_VERSION}`;
  const source = flags.source ?? SOURCE;
  const tag = `v${VERSION}`;
  const steps = [
    `git clone --depth 1 --branch ${tag} "${source}" "${dir}"  (нет такой метки — берётся основная ветка)`,
    `${pnpm} install --frozen-lockfile`,
    `${pnpm} build`,
  ];
  if (flags.dryRun) {
    return { data: { dir, installed: false, steps }, summary: ["dry-run: были бы выполнены команды (нужна сеть, около 1 ГБ на диске):", ...steps.map((s) => `  ${s}`)] };
  }

  // Everything the child prints goes to stderr: stdout stays clean for --json.
  const run = (command: string, cwd?: string) => {
    say(`[repokit setup] ${command}`);
    return spawnSync(command, { cwd, shell: true, stdio: ["ignore", 2, 2] }).status === 0;
  };
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dirname(dir), { recursive: true });
  const warnings: string[] = [];
  if (!run(`git clone --depth 1 --branch ${tag} "${source}" "${dir}"`)) {
    rmSync(dir, { recursive: true, force: true });
    if (!run(`git clone --depth 1 "${source}" "${dir}"`)) throw new UsageError(`Не удалось получить исходники из ${source}. Проверьте сеть и доступ к репозиторию.`);
    warnings.push(`метки ${tag} в репозитории нет — установлена основная ветка; версия может отличаться от версии плагина`);
  }
  if (!run(`${pnpm} install --frozen-lockfile`, dir) || !run(`${pnpm} build`, dir) || !runtimeBin()) {
    throw new UsageError(`Установка не завершилась. Папка ${dir} оставлена для разбора; повторить с нуля: repokit setup --force`);
  }
  return {
    data: { dir, installed: true, steps },
    warnings,
    summary: [`медиа-сервисы установлены: ${dir}`, "теперь доступны: repokit capture, repokit studio, repokit preview", "проверить внешние инструменты (ffmpeg, Chrome): repokit doctor"],
  };
}

export function registerSetup(program: Command): void {
  program
    .command("setup")
    .description("разовая установка медиа-сервисов (capture, studio, preview) в ~/.repokit — нужна сеть")
    .option("--json", "один JSON-документ в stdout")
    .option("--dry-run", "показать, что будет сделано, и ничего не скачивать")
    .option("--source <url>", "откуда брать исходники (по умолчанию — репозиторий repokit на GitHub)")
    .option("--force", "переустановить с нуля")
    .action((flags: SetupFlags) => runCommand("repokit", "setup", flags, () => setup(flags)));
}
