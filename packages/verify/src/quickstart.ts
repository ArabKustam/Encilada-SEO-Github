import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { redact } from "@repokit/core";

const SECTION = /быстрый старт|quick ?start|запуск|установка|как запустить|getting started|installation|usage|использование|^run$|^install$/i;
const SHELL_LANGS = new Set(["", "bash", "sh", "shell", "console", "zsh"]);
const INSTALL = /^(npm|pnpm|yarn)\s+(install|i|ci)\b|^(python3?\s+-m\s+)?pip3?\s+install\b|^poetry\s+install\b|^uv\s+(sync|pip\s+install)\b/;
const TEST = /^(python3?\s+-m\s+)?pytest\b|^(npm|pnpm|yarn)\s+(run\s+)?test\b|^go\s+test\b|^cargo\s+test\b|^node\s+--test\b/;
/** Commands that are not run automatically, however they got into a README. */
const UNSAFE = /\bsudo\b|\brm\s+-|\|\s*(ba|z)?sh\b|\bmkfs\b|\bdd\s+if=|>\s*\/dev\/|\bshutdown\b|\bformat\b|\bdel\s+\/|\bcurl\b[^|]*\|\s*\w/i;
const PYTHON_COMMAND = /^(python3?|pip3?|pytest|uvicorn|flask|streamlit|gunicorn|poetry)\b/;

const INSTALL_TIMEOUT_MS = 10 * 60_000;
const TEST_TIMEOUT_MS = 5 * 60_000;
/** A run command still alive after this long is treated as a server that started successfully. */
const RUN_SETTLE_MS = 8_000;
const MAX_OUTPUT_CHARS = 1200;

export type CommandKind = "install" | "run" | "test";

export interface QuickstartCommand {
  command: string;
  kind: CommandKind;
  /** Line of the README the command comes from. */
  line: number;
}

/** Shell commands from the "Quick start"-like sections of a README, in order. */
export function extractQuickstart(readme: string): QuickstartCommand[] {
  const commands: QuickstartCommand[] = [];
  let inSection = false;
  let sectionLevel = 0;
  let fence: { lang: string } | null = null;
  readme.split(/\r?\n/).forEach((text, index) => {
    const fenceMatch = text.match(/^\s*(```|~~~)\s*([\w-]*)/);
    if (fenceMatch) {
      fence = fence ? null : { lang: fenceMatch[2].toLowerCase() };
      return;
    }
    if (!fence) {
      const heading = text.match(/^(#{2,4})\s+(.+?)\s*$/);
      if (heading) {
        if (SECTION.test(heading[2])) {
          inSection = true;
          sectionLevel = heading[1].length;
        } else if (heading[1].length <= sectionLevel) inSection = false;
      }
      return;
    }
    if (!inSection || !SHELL_LANGS.has(fence.lang)) return;
    const command = text.trim().replace(/^\$\s+/, "");
    if (!command || command.startsWith("#")) return;
    commands.push({ command, kind: INSTALL.test(command) ? "install" : TEST.test(command) ? "test" : "run", line: index + 1 });
  });
  return commands;
}

export interface CommandOutcome extends QuickstartCommand {
  status: "pass" | "fail" | "skip";
  detail: string;
}

function killTree(pid: number): void {
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
  else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

const tail = (output: string) => redact(output.trim().slice(-MAX_OUTPUT_CHARS));

function execute(command: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, settleMs: number | null): Promise<{ code: number | null; output: string; alive: boolean }> {
  return new Promise((resolve) => {
    // README commands are shell lines by nature; they run inside a throwaway copy of the repository.
    const child = spawn(command, { cwd, env, shell: true, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    let output = "";
    let done = false;
    const finish = (code: number | null, alive: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (alive && child.pid) killTree(child.pid);
      resolve({ code, output, alive });
    };
    child.stdout.on("data", (chunk) => (output = (output + chunk).slice(-8000)));
    child.stderr.on("data", (chunk) => (output = (output + chunk).slice(-8000)));
    child.on("error", (error) => {
      output += String(error.message);
      finish(1, false);
    });
    child.on("close", (code) => finish(code, false));
    const timer = setTimeout(() => finish(null, true), settleMs ?? timeoutMs);
  });
}

/**
 * Run the README's quick start in `dir`, a throwaway copy of the repository.
 * Python commands run inside a fresh virtual environment so the user's own environment is not touched.
 */
export async function runQuickstart(commands: QuickstartCommand[], dir: string): Promise<{ outcomes: CommandOutcome[]; notes: string[] }> {
  const notes: string[] = [];
  const env: NodeJS.ProcessEnv = { ...process.env, CI: "1" };
  if (commands.some((c) => PYTHON_COMMAND.test(c.command))) {
    const venv = join(dir, ".verify-venv");
    const created = spawnSync("python", ["-m", "venv", venv], { stdio: "ignore" });
    const bin = join(venv, process.platform === "win32" ? "Scripts" : "bin");
    if (created.status === 0 && existsSync(bin)) {
      env.PATH = `${bin}${delimiter}${env.PATH ?? ""}`;
      env.VIRTUAL_ENV = venv;
      notes.push("команды Python выполнены в отдельном виртуальном окружении внутри временной копии");
    } else {
      notes.push("не удалось создать виртуальное окружение Python — команды Python пропущены");
      return { outcomes: commands.map((c) => ({ ...c, status: "skip", detail: "нет Python для отдельного окружения" })), notes };
    }
  }

  const outcomes: CommandOutcome[] = [];
  let failed = false;
  for (const item of commands) {
    if (UNSAFE.test(item.command)) {
      outcomes.push({ ...item, status: "skip", detail: "не выполняется автоматически: команда может менять систему" });
      continue;
    }
    if (failed) {
      outcomes.push({ ...item, status: "skip", detail: "пропущена: предыдущая команда завершилась с ошибкой" });
      continue;
    }
    const isRun = item.kind === "run";
    const result = await execute(item.command, dir, env, item.kind === "install" ? INSTALL_TIMEOUT_MS : TEST_TIMEOUT_MS, isRun ? RUN_SETTLE_MS : null);
    if (result.alive && isRun) {
      outcomes.push({ ...item, status: "pass", detail: `запустилась и работала ${RUN_SETTLE_MS / 1000} с, затем остановлена` });
    } else if (result.alive) {
      failed = true;
      outcomes.push({ ...item, status: "fail", detail: "не завершилась за отведённое время" });
    } else if (result.code === 0) {
      outcomes.push({ ...item, status: "pass", detail: "завершилась успешно" });
    } else {
      failed = true;
      outcomes.push({ ...item, status: "fail", detail: `код ${result.code}: ${tail(result.output) || "без вывода"}` });
    }
  }
  return { outcomes, notes };
}
