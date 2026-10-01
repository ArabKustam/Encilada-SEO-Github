import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { NeedsHumanError } from "./exit.js";

const INSTALL_HINTS: Record<string, string> = {
  ffmpeg: "https://ffmpeg.org/download.html",
  ffprobe: "https://ffmpeg.org/download.html (входит в состав ffmpeg)",
};

/** Make sure an external tool is on PATH; repokit never installs tools itself. */
export function requireTool(name: string): void {
  const result = spawnSync(name, ["-version"], { stdio: "ignore" });
  if (result.error || result.status !== 0) {
    throw new NeedsHumanError(`Не найден ${name}. Установите его: ${INSTALL_HINTS[name] ?? name}`);
  }
}

/** Run a tool to completion, rejecting with the tail of stderr on failure. */
export function runTool(name: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(name, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-4000)));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(`${name} завершился с кодом ${code}: ${stderr.trim()}`))));
  });
}

/** A Chromium-family browser already installed on the machine, or null. `REPOKIT_BROWSER` overrides. */
export function findSystemBrowser(): string | null {
  const env = process.env;
  const candidates: (string | undefined)[] = [env.REPOKIT_BROWSER];
  if (process.platform === "win32") {
    for (const root of [env["PROGRAMFILES"], env["PROGRAMFILES(X86)"], env["LOCALAPPDATA"]]) {
      if (!root) continue;
      candidates.push(join(root, "Google/Chrome/Application/chrome.exe"), join(root, "Microsoft/Edge/Application/msedge.exe"));
    }
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  } else {
    candidates.push("/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge");
  }
  return candidates.find((path): path is string => Boolean(path) && existsSync(path!)) ?? null;
}

/** Current commit of the target repository, for provenance records. */
export function gitHead(repo: string): { commit: string; dirty: boolean } | null {
  try {
    const run = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return { commit: run(["rev-parse", "HEAD"]), dirty: run(["status", "--porcelain", "--", "."]).length > 0 };
  } catch {
    return null;
  }
}
