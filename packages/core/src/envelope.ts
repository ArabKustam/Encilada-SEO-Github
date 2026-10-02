import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import { ExitCode, NeedsHumanError, UsageError } from "./exit.js";
import { redact } from "./redact.js";

/** Kept equal to `version` in the root package.json; `scripts/build-plugin.mjs` refuses to build otherwise. */
export const VERSION = "0.2.0";

/** Something only a person can do or decide; collected into the "for human" checklist. */
export interface HumanTodo {
  id: string;
  text: string;
}

export interface Artifact {
  path: string;
  kind: string;
  /** False when the file was already up to date or the run was `--dry-run`. */
  written: boolean;
}

/** The single JSON document a command prints to stdout with `--json`. */
export interface Envelope<T = unknown> {
  service: string;
  command: string;
  version: string;
  ok: boolean;
  exitCode: ExitCode;
  data: T | null;
  warnings: string[];
  humanTodo: HumanTodo[];
  artifacts: Artifact[];
  error?: { message: string };
}

export interface CommandResult<T> {
  data: T;
  exitCode?: ExitCode;
  warnings?: string[];
  humanTodo?: HumanTodo[];
  artifacts?: Artifact[];
  /** Short human-readable lines for stderr. */
  summary?: string[];
}

export interface CommonFlags {
  repo: string;
  json?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
}

export function commonFlags(command: Command): Command {
  return command
    .option("--repo <path>", "целевой репозиторий", ".")
    .option("--json", "один JSON-документ в stdout")
    .option("--dry-run", "ничего не записывать")
    .option("--verbose", "подробный вывод в stderr");
}

/** Human-facing output: always stderr, always redacted. */
export function say(line: string): void {
  process.stderr.write(redact(line) + "\n");
}

function logRun(flags: Partial<CommonFlags>, envelope: Envelope, durationMs: number): void {
  if (flags.dryRun || !flags.repo) return;
  const dir = join(resolve(flags.repo), ".repokit");
  if (!existsSync(dir)) return;
  const entry = {
    ts: new Date().toISOString(),
    service: envelope.service,
    command: envelope.command,
    exitCode: envelope.exitCode,
    durationMs,
    warnings: envelope.warnings.length,
  };
  try {
    mkdirSync(join(dir, "logs"), { recursive: true });
    appendFileSync(join(dir, "logs", "repokit.jsonl"), redact(JSON.stringify(entry)) + "\n");
  } catch {
    // Logging must never break a command.
  }
}

/**
 * Run a command body under the shared contract: build the envelope, map errors
 * to exit codes, print JSON to stdout (with `--json`) and a summary to stderr.
 */
export async function runCommand<T>(
  service: string,
  command: string,
  flags: Partial<CommonFlags>,
  body: () => CommandResult<T> | Promise<CommandResult<T>>,
): Promise<void> {
  const started = Date.now();
  let envelope: Envelope<T>;
  let summary: string[] = [];
  try {
    const result = await body();
    const exitCode = result.exitCode ?? ExitCode.Ok;
    summary = result.summary ?? [];
    envelope = {
      service, command, version: VERSION,
      ok: exitCode === ExitCode.Ok,
      exitCode,
      data: result.data,
      warnings: result.warnings ?? [],
      humanTodo: result.humanTodo ?? [],
      artifacts: result.artifacts ?? [],
    };
  } catch (error) {
    // An unexpected failure still honours the contract: one JSON document, a non-zero exit code.
    const expected = error instanceof UsageError || error instanceof NeedsHumanError;
    const message = error instanceof Error ? error.message : String(error);
    envelope = {
      service, command, version: VERSION,
      ok: false,
      exitCode: error instanceof UsageError ? ExitCode.Usage : error instanceof NeedsHumanError ? ExitCode.NeedsHuman : ExitCode.CheckFailed,
      data: null, warnings: [], humanTodo: [], artifacts: [],
      error: { message: expected ? message : `внутренняя ошибка: ${message}` },
    };
    if (!expected && flags.verbose && error instanceof Error && error.stack) say(error.stack);
  }

  const tag = `[${service} ${command}]`;
  for (const line of summary) say(`${tag} ${line}`);
  for (const warning of envelope.warnings) say(`${tag} предупреждение: ${warning}`);
  for (const todo of envelope.humanTodo) say(`${tag} человеку: ${todo.text}`);
  for (const artifact of envelope.artifacts) {
    say(`${tag} ${artifact.written ? "записан" : flags.dryRun ? "был бы записан (dry-run)" : "без изменений"}: ${artifact.path}`);
  }
  if (envelope.error) say(`${tag} ошибка: ${envelope.error.message}`);
  if (flags.json) process.stdout.write(redact(JSON.stringify(envelope, null, 2)) + "\n");

  logRun(flags, envelope, Date.now() - started);
  process.exitCode = envelope.exitCode;
}
