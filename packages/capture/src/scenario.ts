import { existsSync, readFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import { assertValid, NeedsHumanError, sha256, UsageError } from "@repokit/core";
import type { ScanResult } from "@repokit/scan";

export type Step =
  | { goto: string }
  | { click: string }
  | { hover: string }
  | { type: { selector: string; text: string } }
  | { press: string }
  | { scroll: { to: string } | { by: number } }
  | { wait: number | { for: string } }
  | { mark: string };

export interface Viewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
}

export interface Scenario {
  schemaVersion: 1;
  name?: string;
  baseUrl: string;
  start?: { command: string; readyUrl?: string; timeoutSec?: number };
  viewport?: Partial<Viewport>;
  colorScheme?: "light" | "dark";
  auth?: { storageState?: string };
  mask?: string[];
  demoData?: boolean;
  pace?: "human" | "fast";
  steps: Step[];
}

export const DEFAULT_VIEWPORT: Viewport = { width: 1920, height: 1080, deviceScaleFactor: 2 };

const ENV_REFERENCE = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

export interface LoadedScenario {
  scenario: Scenario;
  /** Hash of the file as written, before `${env:…}` substitution: secrets never enter provenance. */
  sha256: string;
}

export function loadScenario(file: string): LoadedScenario {
  if (!existsSync(file)) throw new UsageError(`Сценарий не найден: ${file}`);
  const raw = readFileSync(file, "utf8");
  let scenario: Scenario;
  try {
    scenario = parse(raw);
  } catch (error) {
    throw new UsageError(`Сценарий ${file}: ошибка YAML — ${(error as Error).message}`);
  }
  assertValid("scenario", scenario);
  return { scenario, sha256: sha256(raw.replace(/\r\n/g, "\n")) };
}

/** Names of environment variables a scenario refers to. */
export function envReferences(scenario: Scenario): string[] {
  return [...new Set([...JSON.stringify(scenario).matchAll(ENV_REFERENCE)].map((m) => m[1]))].sort();
}

/** Substitute `${env:NAME}`; a missing variable is a job for the user, not something to guess. */
export function resolveEnv(scenario: Scenario, env: NodeJS.ProcessEnv = process.env): Scenario {
  const missing = envReferences(scenario).filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new NeedsHumanError(`Задайте переменные окружения для сценария: ${missing.join(", ")}`);
  }
  const substitute = (value: unknown): unknown => {
    if (typeof value === "string") return value.replace(ENV_REFERENCE, (_, name: string) => env[name]!);
    if (Array.isArray(value)) return value.map(substitute);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v)]));
    return value;
  };
  return substitute(scenario) as Scenario;
}

const DEFAULT_PORT: Record<string, number> = { "python-api": 8000, "node-web": 3000, "static-site": 8000 };
const DRAFT_HEADER = `# Черновик сценария демо, собранный из результатов scan.
# Это только каркас: откройте приложение, допишите реальные действия пользователя
# (click, type, press, scroll, hover, wait, mark) и проверьте адрес и команду запуска.
# Записывается только то, что приложение действительно делает.
`;

/** A starting point for a scenario: pages the scan found, no invented interactions. */
export function draftScenario(scan: ScanResult): string {
  const type = scan.project.types.find((t) => t in DEFAULT_PORT);
  const port = type ? DEFAULT_PORT[type] : 8000;
  const pages = scan.routes
    .filter((r) => r.method === "GET" && !/[{:[]/.test(r.path) && !/^\/(api|health|static)\b/.test(r.path))
    .map((r) => r.path);
  const paths = [...new Set(pages.length > 0 ? pages : ["/"])].slice(0, 5);
  const health = scan.routes.find((r) => r.method === "GET" && r.path === "/health");

  let command = type === "static-site" ? `python -m http.server ${port}` : scan.project.commands.run;
  if (command?.startsWith("uvicorn ")) command = `python -m ${command} --port ${port}`;

  const scenario: Scenario = {
    schemaVersion: 1,
    name: "demo",
    baseUrl: `http://127.0.0.1:${port}`,
    ...(command ? { start: { command, readyUrl: health ? "/health" : "/" } } : {}),
    viewport: { width: 1280, height: 720, deviceScaleFactor: 2 },
    pace: "human",
    mask: [],
    steps: paths.flatMap((path, index): Step[] => [{ goto: path }, { mark: index === 0 ? "home" : `page-${index + 1}` }]),
  };
  return DRAFT_HEADER + stringify(scenario);
}
