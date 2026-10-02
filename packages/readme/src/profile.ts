import { readText, type ReadmeSlotId } from "@repokit/core";
import type { ScanResult } from "@repokit/scan";

/** What kind of project this is, from the point of view of someone reading its README. */
export const PROJECT_KINDS = [
  "web-app", "cli", "library", "sdk", "api", "ai-agent", "mobile-app", "desktop-app", "game",
  "ml-research", "dev-tool", "template", "monorepo", "infrastructure", "unknown",
] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];

export const KIND_TITLES: Record<ProjectKind, string> = {
  "web-app": "веб-приложение", cli: "CLI-утилита", library: "библиотека", sdk: "SDK", api: "API / бэкенд",
  "ai-agent": "ИИ-агент", "mobile-app": "мобильное приложение", "desktop-app": "десктопное приложение", game: "игра",
  "ml-research": "ML / исследование", "dev-tool": "инструмент разработчика", template: "шаблон / стартер",
  monorepo: "монорепозиторий", infrastructure: "инфраструктура / DevOps", unknown: "не определён",
};

export interface Profile {
  kind: ProjectKind;
  /** 0–1: how sure the detection is. Below 0.6 the author should confirm. */
  confidence: number;
  /** Facts the decision rests on, each naming a file or dependency. */
  signals: string[];
  /** Other kinds that also matched, strongest first. */
  alternatives: ProjectKind[];
}

interface Rule {
  kind: ProjectKind;
  weight: number;
  signal: string;
}

const AI_DEPS = ["anthropic", "@anthropic-ai/sdk", "openai", "langchain", "langgraph", "llama-index", "llama_index", "@modelcontextprotocol/sdk", "mcp", "crewai", "autogen", "litellm", "ollama"];
const ML_DEPS = ["torch", "tensorflow", "keras", "jax", "scikit-learn", "transformers", "xgboost", "lightgbm"];
const GAME_DEPS = ["phaser", "pygame", "bevy", "kaboom", "pixi.js", "babylonjs", "love", "arcade", "godot"];
const MOBILE_DEPS = ["react-native", "expo", "@capacitor/core", "@ionic/react", "nativescript", "kivy"];
const DESKTOP_DEPS = ["electron", "@tauri-apps/api", "tauri", "pyqt5", "pyqt6", "pyside6", "wxpython", "nw", "neutralinojs"];
const FRONTEND_DEPS = ["react", "vue", "svelte", "next", "nuxt", "@angular/core", "solid-js", "astro", "remix", "@sveltejs/kit"];
const DEVTOOL_NAME = /^(eslint-plugin-|eslint-config-|vite-plugin-|rollup-plugin-|babel-plugin-|prettier-plugin-|postcss-|webpack-|@types\/)|-loader$/;
const TEMPLATE_NAME = /(^|[-_ ])(template|starter|boilerplate|scaffold|skeleton)([-_ ]|$)|^create-/i;
const SDK_NAME = /(^|[-_ ])(sdk|client|api-client|bindings|wrapper)([-_ ]|$)/i;

/** Decide what kind of project a repository is. Every signal names the evidence it comes from. */
export function detectProfile(repo: string, scan: ScanResult, files: Set<string>): Profile {
  const deps = new Set(scan.project.dependencies);
  const types = new Set(scan.project.types);
  const has = (path: string) => files.has(path);
  const any = (pattern: RegExp) => [...files].find((f) => pattern.test(f));
  const depOf = (list: string[]) => list.find((d) => deps.has(d));
  const name = scan.project.name;
  let pkg: Record<string, any> = {};
  try {
    pkg = has("package.json") ? JSON.parse(readText(repo, "package.json") ?? "{}") : {};
  } catch {
    pkg = {};
  }
  const rules: Rule[] = [];
  const add = (kind: ProjectKind, weight: number, signal: string | undefined | false) => {
    if (signal) rules.push({ kind, weight, signal });
  };

  // --- structure of the repository
  const workspaces = has("pnpm-workspace.yaml") || Boolean(pkg.workspaces) || has("lerna.json") || has("nx.json") || has("turbo.json");
  const manifests = [...files].filter((f) => /^(packages|apps|libs|crates|services)\/[^/]+\/(package\.json|pyproject\.toml|Cargo\.toml|go\.mod)$/.test(f));
  add("monorepo", 0.9, workspaces && manifests.length >= 2 && `рабочее пространство с ${manifests.length} пакетами (${manifests[0]} и др.)`);
  add("monorepo", 0.6, !workspaces && manifests.length >= 3 && `несколько пакетов в одном репозитории (${manifests.length})`);

  const terraform = any(/\.tf$/);
  const helm = any(/(^|\/)Chart\.ya?ml$/);
  const kubernetes = any(/(^|\/)(k8s|kubernetes|manifests|deploy)\/[^/]+\.ya?ml$/);
  const ansible = any(/(^|\/)(playbook|site)\.ya?ml$|(^|\/)roles\/[^/]+\/tasks\//);
  add("infrastructure", 0.9, terraform && `файлы Terraform (${terraform})`);
  add("infrastructure", 0.85, helm && `чарт Helm (${helm})`);
  add("infrastructure", 0.6, kubernetes && `манифесты Kubernetes (${kubernetes})`);
  add("infrastructure", 0.8, ansible && `плейбуки Ansible (${ansible})`);

  // --- platforms
  const mobileDep = depOf(MOBILE_DEPS);
  add("mobile-app", 0.9, has("pubspec.yaml") && "pubspec.yaml (Flutter)");
  add("mobile-app", 0.85, mobileDep && `зависимость ${mobileDep}`);
  add("mobile-app", 0.8, any(/(^|\/)AndroidManifest\.xml$/) && !mobileDep && "AndroidManifest.xml");
  add("mobile-app", 0.8, any(/\.xcodeproj\//) && "проект Xcode");
  const desktopDep = depOf(DESKTOP_DEPS);
  add("desktop-app", 0.85, desktopDep && `зависимость ${desktopDep}`);
  add("desktop-app", 0.85, any(/^src-tauri\//) && "папка src-tauri");
  const gameDep = depOf(GAME_DEPS);
  add("game", 0.9, has("project.godot") && "project.godot (Godot)");
  add("game", 0.9, any(/^ProjectSettings\/ProjectVersion\.txt$/) && "проект Unity");
  add("game", 0.8, gameDep && `игровой движок в зависимостях: ${gameDep}`);

  // --- ML and agents
  const notebooks = [...files].filter((f) => f.endsWith(".ipynb")).length;
  const mlDep = depOf(ML_DEPS);
  add("ml-research", 0.75, mlDep && any(/(^|\/)(train|finetune|evaluate|eval)[^/]*\.py$/) && `${mlDep} и скрипт обучения`);
  add("ml-research", 0.7, notebooks >= 2 && `ноутбуков Jupyter: ${notebooks}`);
  add("ml-research", 0.7, has("CITATION.cff") && "CITATION.cff");
  add("ml-research", 0.45, mlDep && `зависимость ${mlDep}`);
  const aiDep = depOf(AI_DEPS);
  add("ai-agent", 0.8, aiDep && any(/(^|\/)(agent|agents|tools|prompts?)(\/|\.py$|\.ts$|\.js$)/i) && `${aiDep} и код агента (${any(/(^|\/)(agent|agents|tools|prompts?)(\/|\.py$|\.ts$|\.js$)/i)})`);
  add("ai-agent", 0.75, (deps.has("@modelcontextprotocol/sdk") || deps.has("mcp")) && "SDK Model Context Protocol в зависимостях");
  add("ai-agent", 0.4, aiDep && `зависимость ${aiDep}`);

  // --- packaging
  add("template", 0.85, has("cookiecutter.json") && "cookiecutter.json");
  add("template", 0.7, TEMPLATE_NAME.test(name) && `имя «${name}»`);
  add("dev-tool", 0.85, Boolean(pkg.engines?.vscode) && "расширение VS Code (engines.vscode)");
  add("dev-tool", 0.85, (has("action.yml") || has("action.yaml")) && "GitHub Action (action.yml)");
  add("dev-tool", 0.8, DEVTOOL_NAME.test(name) && `имя «${name}» — плагин инструмента сборки или линтера`);

  const frontend = depOf(FRONTEND_DEPS);
  const hasPages = scan.routes.some((r) => r.framework === "static") || [...files].some((f) => f.endsWith(".html"));
  const server = types.has("python-api") || types.has("node-web");
  add("web-app", 0.85, server && hasPages && "серверный фреймворк и HTML-страницы");
  add("web-app", 0.8, frontend && !pkg.main && !pkg.exports && `фронтенд-фреймворк ${frontend}`);
  add("web-app", 0.75, types.has("static-site") && "статический сайт (index.html)");
  add("web-app", 0.7, types.has("data-app") && "приложение Streamlit или Gradio");
  add("api", 0.8, server && !hasPages && `серверный фреймворк без страниц; роутов: ${scan.routes.length}`);

  add("cli", 0.85, types.has("cli") && "точка входа командной строки");
  const exportsApi = Boolean(pkg.main || pkg.exports || pkg.module || pkg.types);
  const pyLibrary = /\[project\]|\[tool\.poetry\]/.test(readText(repo, "pyproject.toml") ?? "") || has("setup.py");
  add("sdk", 0.8, (exportsApi || pyLibrary) && SDK_NAME.test(name) && `публикуемый пакет с именем «${name}»`);
  add("library", 0.7, exportsApi && !pkg.bin && !server && "package.json объявляет main/exports — публикуемый пакет");
  add("library", 0.65, pyLibrary && !server && !types.has("cli") && "pyproject.toml/setup.py — публикуемый пакет");
  add("library", 0.6, (has("Cargo.toml") && has("src/lib.rs")) && "Cargo.toml и src/lib.rs");

  // Strongest signal per kind; kinds ordered by it.
  const best = new Map<ProjectKind, Rule>();
  for (const rule of rules) if ((best.get(rule.kind)?.weight ?? 0) < rule.weight) best.set(rule.kind, rule);
  const ranked = [...best.values()].sort((a, b) => b.weight - a.weight);
  if (ranked.length === 0) return { kind: "unknown", confidence: 0, signals: ["характерных признаков не найдено"], alternatives: [] };
  const top = ranked[0];
  return {
    kind: top.kind,
    confidence: top.weight,
    signals: rules.filter((r) => r.kind === top.kind).sort((a, b) => b.weight - a.weight).map((r) => r.signal),
    alternatives: ranked.slice(1, 4).map((r) => r.kind),
  };
}

export const PRIORITIES = ["must", "should", "optional"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const STYLES = ["minimal", "developer", "product", "showcase", "research", "docs"] as const;
export type Style = (typeof STYLES)[number];

export const STYLE_TITLES: Record<Style, string> = {
  minimal: "только необходимое: что это, как поставить, как пользоваться",
  developer: "для разработчиков: установка, пример, команды и настройка раньше картинок",
  product: "для пользователей продукта: что это даёт, как выглядит, как попробовать",
  showcase: "витрина: крупное демо в начале, возможности, затем запуск",
  research: "исследование: суть, как воспроизвести, результаты",
  docs: "подробный: всё существенное, длинные разделы свёрнуты",
};

export type DemoKind = "gif" | "screenshots" | "terminal" | "none";

export interface Strategy {
  style: Style;
  /** What a first-time visitor is most likely to want to do. */
  primaryAction: "open-demo" | "install" | "quick-start" | "read-docs";
  audience: string[];
  demo: DemoKind;
  /** How many screenshots are worth having, at most. */
  screenshots: number;
  /** Sections in reading order with their priority. */
  sections: [ReadmeSlotId, Priority][];
}

const S = (style: Style, primaryAction: Strategy["primaryAction"], audience: string[], demo: DemoKind, screenshots: number, sections: [ReadmeSlotId, Priority][]): Strategy =>
  ({ style, primaryAction, audience, demo, screenshots, sections });

/**
 * A starting structure for each kind of project, drawn from how well-kept open-source
 * READMEs of that kind are organised. It is a default, not a template: the layout
 * built from it drops what the repository has nothing to show for.
 */
export const STRATEGIES: Record<ProjectKind, Strategy> = {
  "web-app": S("showcase", "open-demo", ["пользователи", "разработчики"], "gif", 3, [
    ["header", "must"], ["hero", "must"], ["features", "must"], ["demo", "should"], ["quickstart", "must"],
    ["configuration", "should"], ["architecture", "should"], ["stack", "optional"], ["limitations", "should"], ["license", "must"],
  ]),
  cli: S("developer", "install", ["разработчики", "пользователи терминала"], "terminal", 1, [
    ["header", "must"], ["hero", "should"], ["quickstart", "must"], ["usage", "must"], ["commands", "must"],
    ["configuration", "should"], ["features", "should"], ["limitations", "optional"], ["license", "must"],
  ]),
  library: S("developer", "install", ["разработчики"], "none", 0, [
    ["header", "must"], ["quickstart", "must"], ["usage", "must"], ["features", "should"],
    ["configuration", "optional"], ["limitations", "optional"], ["license", "must"],
  ]),
  sdk: S("developer", "install", ["разработчики, подключающие сервис"], "none", 0, [
    ["header", "must"], ["quickstart", "must"], ["usage", "must"], ["configuration", "must"],
    ["features", "should"], ["limitations", "optional"], ["license", "must"],
  ]),
  api: S("developer", "quick-start", ["разработчики клиентов", "те, кто разворачивает сервис"], "none", 0, [
    ["header", "must"], ["features", "should"], ["quickstart", "must"], ["routes", "must"], ["configuration", "must"],
    ["architecture", "should"], ["limitations", "should"], ["license", "must"],
  ]),
  "ai-agent": S("developer", "quick-start", ["разработчики", "пользователи агента"], "terminal", 1, [
    ["header", "must"], ["hero", "should"], ["features", "must"], ["quickstart", "must"], ["configuration", "must"],
    ["usage", "must"], ["architecture", "should"], ["limitations", "should"], ["license", "must"],
  ]),
  "mobile-app": S("product", "open-demo", ["пользователи", "разработчики"], "screenshots", 3, [
    ["header", "must"], ["hero", "must"], ["features", "must"], ["quickstart", "must"],
    ["configuration", "should"], ["stack", "optional"], ["limitations", "should"], ["license", "must"],
  ]),
  "desktop-app": S("product", "install", ["пользователи", "разработчики"], "screenshots", 3, [
    ["header", "must"], ["hero", "must"], ["features", "must"], ["quickstart", "must"],
    ["configuration", "optional"], ["stack", "optional"], ["limitations", "should"], ["license", "must"],
  ]),
  game: S("showcase", "open-demo", ["игроки", "разработчики"], "gif", 3, [
    ["header", "must"], ["hero", "must"], ["features", "must"], ["quickstart", "must"], ["stack", "optional"], ["license", "must"],
  ]),
  "ml-research": S("research", "quick-start", ["исследователи", "инженеры ML"], "none", 1, [
    ["header", "must"], ["hero", "optional"], ["features", "should"], ["quickstart", "must"], ["usage", "must"],
    ["configuration", "optional"], ["limitations", "should"], ["license", "must"],
  ]),
  "dev-tool": S("developer", "install", ["разработчики"], "terminal", 1, [
    ["header", "must"], ["hero", "optional"], ["quickstart", "must"], ["usage", "must"], ["commands", "should"],
    ["configuration", "should"], ["features", "should"], ["license", "must"],
  ]),
  template: S("developer", "quick-start", ["разработчики, начинающие проект"], "screenshots", 1, [
    ["header", "must"], ["hero", "should"], ["features", "must"], ["quickstart", "must"],
    ["configuration", "should"], ["stack", "should"], ["license", "must"],
  ]),
  monorepo: S("docs", "read-docs", ["разработчики", "контрибьюторы"], "none", 0, [
    ["header", "must"], ["hero", "optional"], ["features", "should"], ["packages", "must"], ["quickstart", "must"],
    ["architecture", "should"], ["configuration", "optional"], ["license", "must"],
  ]),
  infrastructure: S("developer", "quick-start", ["инженеры эксплуатации"], "none", 0, [
    ["header", "must"], ["architecture", "must"], ["quickstart", "must"], ["configuration", "must"],
    ["features", "optional"], ["limitations", "should"], ["license", "must"],
  ]),
  unknown: S("developer", "quick-start", ["разработчики"], "none", 0, [
    ["header", "must"], ["features", "should"], ["quickstart", "must"], ["usage", "should"],
    ["configuration", "optional"], ["limitations", "optional"], ["license", "must"],
  ]),
};
