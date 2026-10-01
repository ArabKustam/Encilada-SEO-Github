import { spawnSync } from "node:child_process";
import type { Command } from "commander";
import { ExitCode, runCommand, type CommandResult } from "@repokit/core";

interface Tool {
  name: string;
  required: boolean;
  /** What stops working without it. */
  neededFor: string;
  hint: string;
}

interface ToolStatus extends Tool {
  found: boolean;
  version: string | null;
}

const MIN_NODE_MAJOR = 20;

const TOOLS: Tool[] = [
  { name: "git", required: true, neededFor: "все сервисы", hint: "https://git-scm.com/downloads" },
  { name: "ffmpeg", required: false, neededFor: "studio: кодирование видео и GIF", hint: "https://ffmpeg.org/download.html" },
  { name: "gh", required: false, neededFor: "deploy: GitHub Pages, описание и topics репозитория", hint: "https://cli.github.com" },
  { name: "python", required: false, neededFor: "запуск Python-проектов при capture и verify", hint: "https://www.python.org/downloads/" },
];

function probe(tool: Tool): ToolStatus {
  const flag = tool.name === "ffmpeg" ? "-version" : "--version";
  // Fixed command names only; shell is needed on Windows to resolve .cmd shims.
  const result = spawnSync(`${tool.name} ${flag}`, { encoding: "utf8", shell: true });
  const found = result.status === 0;
  const version = found ? (result.stdout || result.stderr).split(/\r?\n/)[0].trim() : null;
  return { ...tool, found, version };
}

function doctor(): CommandResult<{ node: string; tools: ToolStatus[] }> {
  const tools = TOOLS.map(probe);
  const nodeOk = Number(process.versions.node.split(".")[0]) >= MIN_NODE_MAJOR;
  const missingRequired = tools.some((t) => t.required && !t.found) || !nodeOk;
  return {
    data: { node: process.version, tools },
    exitCode: missingRequired ? ExitCode.CheckFailed : ExitCode.Ok,
    warnings: tools.filter((t) => !t.found && !t.required).map((t) => `${t.name} не найден (нужен для: ${t.neededFor}). Установка: ${t.hint}`),
    summary: [
      `node ${process.version}${nodeOk ? "" : ` — нужен Node ≥ ${MIN_NODE_MAJOR}`}`,
      ...tools.map((t) => `${t.found ? "есть" : "нет "}  ${t.name}${t.version ? ` — ${t.version}` : ""}`),
    ],
  };
}

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("проверить внешние инструменты (ничего не устанавливает)")
    .option("--json", "один JSON-документ в stdout")
    .action((flags: { json?: boolean }) => runCommand("repokit", "doctor", flags, doctor));
}
