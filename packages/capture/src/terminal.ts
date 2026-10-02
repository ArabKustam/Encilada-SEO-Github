import { spawn, spawnSync } from "node:child_process";
import { redact } from "@repokit/core";

export interface TerminalRun {
  command: string;
  /** Combined stdout and stderr in the order they arrived, cleaned and with secrets masked. */
  lines: string[];
  exitCode: number | null;
  /** Lines left out because the output was longer than the picture allows. */
  truncated: number;
  timedOut: boolean;
}

export interface TerminalOptions {
  cols: number;
  maxLines: number;
  timeoutSec: number;
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/** What a terminal would show: no colour codes, carriage returns applied, tabs expanded, long lines wrapped. */
export function cleanOutput(raw: string, cols: number): string[] {
  const out: string[] = [];
  for (const rawLine of raw.replace(ANSI, "").replace(/\r\n/g, "\n").split("\n")) {
    // A progress bar redraws its line with \r: only the last state is what stays on screen.
    const shown = rawLine.split("\r").filter((part, index, parts) => part !== "" || index === parts.length - 1).pop() ?? "";
    let line = "";
    for (const char of shown) {
      if (char === "\t") line += " ".repeat(8 - (line.length % 8));
      else if (char >= " ") line += char;
    }
    line = line.trimEnd();
    if (line.length === 0) out.push("");
    for (let at = 0; at < line.length; at += cols) out.push(line.slice(at, at + cols));
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

/** Run a command the way a reader would, and keep what it printed. Nothing is typed in or edited afterwards. */
export function runInTerminal(command: string, cwd: string, options: TerminalOptions): Promise<TerminalRun> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", TERM: "dumb", COLUMNS: String(options.cols), PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" };
    // The command is given by the user on the command line; a shell is needed to find programs on PATH on Windows.
    // stderr is merged into stdout by the shell itself, so lines keep the order a terminal would show them in.
    const child = spawn(`( ${command} ) 2>&1`, { cwd, env, shell: true, stdio: ["ignore", "pipe", "ignore"] });
    let raw = "";
    let timedOut = false;
    const collect = (chunk: Buffer) => {
      if (raw.length < 1024 * 1024) raw += chunk.toString("utf8");
    };
    child.stdout.on("data", collect);
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32" && child.pid !== undefined) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      else child.kill("SIGKILL");
    }, options.timeoutSec * 1000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const all = cleanOutput(redact(raw), options.cols);
      const lines = all.slice(0, options.maxLines);
      resolve({ command, lines, exitCode: timedOut ? null : code, truncated: all.length - lines.length, timedOut });
    });
  });
}

const THEMES = {
  light: { window: "#ffffff", bar: "#f6f8fa", border: "#d0d7de", text: "#1f2328", dim: "#656d76", prompt: "#1a7f37" },
  dark: { window: "#0d1117", bar: "#161b22", border: "#30363d", text: "#e6edf3", dim: "#8b949e", prompt: "#3fb950" },
};

const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const FONT_SIZE = 14;
const CHAR_WIDTH = 8.43;
const LINE_HEIGHT = 20;
const PADDING = 18;
const BAR_HEIGHT = 34;

/** A picture of a terminal window with the command and its output as text: sharp at any size and small. */
export function terminalSvg(run: TerminalRun, theme: keyof typeof THEMES, cols: number, title: string): string {
  const colors = THEMES[theme];
  const rows: { text: string; fill: string; prompt?: boolean }[] = [
    { text: run.command, fill: colors.text, prompt: true },
    ...run.lines.map((text) => ({ text, fill: colors.text })),
    ...(run.truncated > 0 ? [{ text: `… ещё строк: ${run.truncated}`, fill: colors.dim }] : []),
  ];
  const width = Math.ceil(PADDING * 2 + (cols + 2) * CHAR_WIDTH);
  const height = BAR_HEIGHT + PADDING * 2 + rows.length * LINE_HEIGHT - 6;
  const text = rows.map((row, index) => {
    const y = BAR_HEIGHT + PADDING + index * LINE_HEIGHT + FONT_SIZE - 3;
    const body = row.prompt ? `<tspan fill="${colors.prompt}">$</tspan> ${escapeXml(row.text)}` : escapeXml(row.text);
    return `  <text x="${PADDING}" y="${y}" fill="${row.fill}" xml:space="preserve">${body}</text>`;
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title)}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace" font-size="${FONT_SIZE}">`,
    `  <title>${escapeXml(title)}</title>`,
    `  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="8" fill="${colors.window}" stroke="${colors.border}"/>`,
    `  <path d="M0.5 8.5a8 8 0 0 1 8-8h${width - 17}a8 8 0 0 1 8 8v${BAR_HEIGHT - 8}h-${width - 1}z" fill="${colors.bar}" stroke="${colors.border}"/>`,
    ...[0, 1, 2].map((i) => `  <circle cx="${20 + i * 18}" cy="${BAR_HEIGHT / 2 + 0.5}" r="5.5" fill="${colors.border}"/>`),
    `  <text x="${width / 2}" y="${BAR_HEIGHT / 2 + 5}" fill="${colors.dim}" text-anchor="middle" font-size="12">${escapeXml(title)}</text>`,
    ...text,
    "</svg>",
    "",
  ].join("\n");
}

/** The same run as a fenced block for a README. */
export const terminalText = (run: TerminalRun) => [`$ ${run.command}`, ...run.lines, ...(run.truncated > 0 ? [`… ещё строк: ${run.truncated}`] : [])].join("\n");
