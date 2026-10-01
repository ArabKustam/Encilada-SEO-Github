import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type LaunchOptions } from "playwright";
import { findSystemBrowser, insideRepo, NeedsHumanError, UsageError } from "@repokit/core";
import type { Scenario, Viewport } from "./scenario.js";

const DEFAULT_READY_TIMEOUT_SEC = 30;
const POLL_MS = 250;
const ALWAYS_MASKED = "input[type=password]";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function responds(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

export interface RunningApp {
  /** False when the app was already running and repokit did not start it. */
  started: boolean;
  stop: () => void;
}

/** Start the application under test, unless it is already answering. */
export async function startApp(scenario: Scenario, repo: string): Promise<RunningApp> {
  const readyUrl = new URL(scenario.start?.readyUrl ?? "/", scenario.baseUrl).toString();
  if (await responds(readyUrl)) return { started: false, stop: () => {} };
  if (!scenario.start) {
    throw new NeedsHumanError(`Приложение не отвечает по ${readyUrl}. Запустите его или добавьте в сценарий start.command.`);
  }

  // The command comes from a scenario file the user approved; shell is needed for PATH lookup on Windows.
  const child: ChildProcess = spawn(scenario.start.command, { cwd: repo, shell: true, stdio: "ignore", detached: process.platform !== "win32" });
  const stop = () => {
    if (child.exitCode !== null || child.pid === undefined) return;
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
  };

  const deadline = Date.now() + (scenario.start.timeoutSec ?? DEFAULT_READY_TIMEOUT_SEC) * 1000;
  while (Date.now() < deadline) {
    if (await responds(readyUrl)) return { started: true, stop };
    if (child.exitCode !== null) {
      throw new UsageError(`Команда запуска завершилась с кодом ${child.exitCode}: ${scenario.start.command}`);
    }
    await sleep(POLL_MS);
  }
  stop();
  throw new UsageError(`Приложение не ответило по ${readyUrl} за отведённое время.`);
}

/**
 * Launch a Chromium-family browser: `REPOKIT_BROWSER`, then Playwright's own
 * build if it is downloaded, then an installed Chrome or Edge.
 */
export async function launchBrowser(): Promise<{ browser: Browser; label: string }> {
  const attempts: LaunchOptions[] = [];
  if (process.env.REPOKIT_BROWSER) attempts.push({ executablePath: process.env.REPOKIT_BROWSER });
  if (existsSync(chromium.executablePath())) attempts.push({});
  const system = findSystemBrowser();
  if (system) attempts.push({ executablePath: system });

  for (const options of attempts) {
    try {
      const browser = await chromium.launch({ headless: true, ...options });
      return { browser, label: `Chromium ${browser.version()}` };
    } catch {
      // Try the next candidate.
    }
  }
  throw new NeedsHumanError(
    "Не найден браузер для записи. Установите Google Chrome или выполните `npx playwright install chromium`, либо укажите путь в REPOKIT_BROWSER.",
  );
}

/** A browser context configured for recording: viewport, theme, test-account state, masks. */
export async function openContext(
  browser: Browser,
  scenario: Scenario,
  repo: string,
  viewport: Viewport,
  colorScheme: "light" | "dark" | undefined = scenario.colorScheme,
): Promise<BrowserContext> {
  let storageState: string | undefined;
  if (scenario.auth?.storageState) {
    storageState = insideRepo(repo, scenario.auth.storageState);
    if (!existsSync(storageState)) throw new NeedsHumanError("Файл storageState тестового аккаунта не найден. Создайте его и повторите запись.");
  }
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.deviceScaleFactor,
    colorScheme: colorScheme ?? "light",
    storageState,
  });
  const selectors = masks(scenario);
  const css = `${selectors.join(", ")} { filter: blur(14px) !important; }`;
  // Runs before any page script, so a masked element is never visible in a frame.
  await context.addInitScript((styles) => {
    const inject = () => {
      const style = document.createElement("style");
      style.setAttribute("data-repokit-mask", "");
      style.textContent = styles;
      document.documentElement.appendChild(style);
    };
    if (document.documentElement) inject();
    else document.addEventListener("DOMContentLoaded", inject);
  }, css);
  return context;
}

export const masks = (scenario: Scenario) => [...new Set([ALWAYS_MASKED, ...(scenario.mask ?? [])])];
