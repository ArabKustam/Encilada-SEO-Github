import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, posix } from "node:path";
import { listFiles, readText, UsageError } from "@repokit/core";
import { isTestFile, type ScanResult } from "@repokit/scan";
import { candidates, PROVIDER_IDS, PROVIDERS, type Provider, type ProviderId } from "./providers.js";

export interface PlannedFile {
  /** Path relative to `root`, POSIX separators. */
  path: string;
  /** Absolute directory the path is relative to: the git root for repo-level configs, otherwise the project folder. */
  root: string;
  content: string;
  /** `same` — already there with this content; `differs` — there with other content, not overwritten without --force. */
  state: "new" | "same" | "differs";
  purpose: string;
}

export interface DeployPlan {
  provider: Provider;
  reason: string;
  alternatives: { provider: ProviderId; reason: string }[];
  files: PlannedFile[];
  /** Commands `deploy run` would execute through the user's own CLI, in order. */
  commands: string[][];
  /** Things only the user can do: logins, dashboard clicks, pushing commits. */
  humanSteps: string[];
  warnings: string[];
  /** Names of environment variables the code reads; values are never read or stored. */
  envVars: string[];
  expectedUrl: string | null;
  healthPath: string;
}

const CODE_EXT = /\.(py|ts|tsx|js|jsx|mjs|cjs)$/;
const ENV_PATTERNS = [/process\.env\.([A-Z][A-Z0-9_]+)/g, /os\.environ(?:\.get)?\s*[[(]\s*["']([A-Z][A-Z0-9_]+)["']/g, /os\.getenv\(\s*["']([A-Z][A-Z0-9_]+)["']/g];
const NOT_SECRETS = new Set(["PORT", "NODE_ENV", "CI", "HOME", "PATH", "HOST", "DEBUG", "PYTHONPATH"]);
/** Port Hugging Face Spaces expects a Docker app to listen on. */
const HF_PORT = 7860;
const FLY_PORT = 8080;

const git = (cwd: string, args: string[]): string | null => {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};

const slugify = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "app";

/** Names of environment variables read by the application code. */
export function envVarNames(repo: string): string[] {
  const names = new Set<string>();
  for (const file of listFiles(repo).files) {
    if (!CODE_EXT.test(file.path) || isTestFile(file.path)) continue;
    const text = readText(repo, file.path);
    if (!text) continue;
    for (const pattern of ENV_PATTERNS) for (const match of text.matchAll(pattern)) if (!NOT_SECRETS.has(match[1])) names.add(match[1]);
  }
  return [...names].sort();
}

/** The project's run command, adapted to listen on the address and port a host assigns. */
export function hostedStartCommand(scan: ScanResult, port = "$PORT"): string | null {
  const run = scan.project.commands.run;
  if (!run) return null;
  if (run.startsWith("uvicorn ")) return `${run} --host 0.0.0.0 --port ${port}`;
  if (run.startsWith("flask ")) return `${run} --host 0.0.0.0 --port ${port}`;
  if (run.startsWith("streamlit run ")) return `${run} --server.port ${port} --server.address 0.0.0.0`;
  return run;
}

const PAGES_WORKFLOW = (branch: string, dir: string) => `name: Deploy to GitHub Pages

on:
  push:
    branches: [${branch}]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: ${dir}
      - id: deployment
        uses: actions/deploy-pages@v4
`;

function dockerfile(scan: ScanResult, port: number): string | null {
  const start = hostedStartCommand(scan, String(port));
  if (!start) return null;
  if (scan.project.packageManager === "pip") {
    return `FROM python:3.12-slim\nWORKDIR /app\nCOPY requirements.txt .\nRUN pip install --no-cache-dir -r requirements.txt\nCOPY . .\nEXPOSE ${port}\nCMD ${JSON.stringify(start.split(" "))}\n`;
  }
  if (scan.project.packageManager) {
    return `FROM node:22-slim\nWORKDIR /app\nCOPY package*.json ./\nRUN npm install --omit=dev\nCOPY . .\nENV PORT=${port}\nEXPOSE ${port}\nCMD ["npm", "start"]\n`;
  }
  return null;
}

export function planDeploy(repo: string, scan: ScanResult, requested?: string): DeployPlan {
  const options = candidates(scan);
  if (requested && !PROVIDER_IDS.includes(requested as ProviderId)) {
    throw new UsageError(`Неизвестный провайдер «${requested}». Доступны: ${PROVIDER_IDS.join(", ")}`);
  }
  if (!requested && options.length === 0) {
    throw new UsageError("Тип проекта не определён — выберите провайдера сами: --provider <имя>. Список: repokit deploy providers");
  }
  const id = (requested as ProviderId | undefined) ?? options[0].provider;
  const provider = PROVIDERS[id];
  const reason = options.find((o) => o.provider === id)?.reason ?? "выбран вручную; для этого типа проекта repokit его не рекомендует";

  const gitRoot = git(repo, ["rev-parse", "--show-toplevel"]);
  const prefix = (git(repo, ["rev-parse", "--show-prefix"]) ?? "").replace(/\/$/, "");
  const branch = git(repo, ["symbolic-ref", "--short", "HEAD"]) ?? "main";
  const remote = git(repo, ["remote", "get-url", "origin"])?.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  const github = remote ? { owner: remote[1], repo: remote[2] } : null;
  const name = slugify(scan.project.name || basename(repo));
  const files = new Set(listFiles(repo).files.map((f) => f.path));
  const types = new Set(scan.project.types);
  const isStatic = types.has("static-site");
  const start = hostedStartCommand(scan);
  const healthPath = scan.routes.some((r) => r.method === "GET" && r.path === "/health") ? "/health" : "/";

  const plan: DeployPlan = {
    provider, reason,
    alternatives: options.filter((o) => o.provider !== id),
    files: [], commands: [], humanSteps: [], warnings: [],
    envVars: isStatic ? [] : envVarNames(repo),
    expectedUrl: null, healthPath,
  };
  const addFile = (root: string, path: string, content: string, purpose: string) => {
    const abs = join(root, path);
    const state = !existsSync(abs) ? "new" : readFileSync(abs, "utf8").replace(/\r\n/g, "\n") === content ? "same" : "differs";
    plan.files.push({ path, root, content, state, purpose });
  };
  const needServer = (what: string) => {
    if (isStatic) plan.warnings.push(`${provider.title} рассчитан на ${what}, а проект — статический сайт: проще GitHub Pages`);
    else if (!start) plan.warnings.push("команда запуска не определена — впишите её в конфигурацию сами");
  };
  if (types.has("node-web") && ![...files].some((f) => CODE_EXT.test(f) && (readText(repo, f) ?? "").includes("process.env.PORT"))) {
    plan.warnings.push("сервер не читает порт из process.env.PORT — на хостинге он должен слушать порт, который назначит площадка");
  }

  switch (id) {
    case "github-pages": {
      if (!isStatic) plan.warnings.push("GitHub Pages отдаёт только статические файлы — серверная часть проекта работать не будет");
      const root = gitRoot ?? repo;
      addFile(root, ".github/workflows/pages.yml", PAGES_WORKFLOW(branch, prefix || "."), "сборка и публикация сайта при каждом пуше");
      plan.humanSteps.push("закоммитьте и запушьте .github/workflows/pages.yml — публикация запускается пушем");
      if (github) {
        plan.commands.push(["gh", "api", "--method", "POST", `repos/${github.owner}/${github.repo}/pages`, "-f", "build_type=workflow"]);
        plan.commands.push(["gh", "workflow", "run", "pages.yml", "--ref", branch]);
        plan.expectedUrl = `https://${github.owner.toLowerCase()}.github.io/${github.repo}/`;
      } else {
        plan.humanSteps.unshift("создайте репозиторий на GitHub и добавьте его как origin");
      }
      break;
    }
    case "cloudflare-pages": {
      if (!isStatic) plan.warnings.push("Cloudflare Pages отдаёт статические файлы — серверная часть проекта работать не будет");
      plan.commands.push(["wrangler", "pages", "deploy", ".", "--project-name", name]);
      plan.expectedUrl = `https://${name}.pages.dev/`;
      plan.warnings.push("адрес зависит от того, свободно ли имя проекта — возьмите точный из вывода wrangler");
      break;
    }
    case "netlify": {
      if (isStatic) addFile(repo, "netlify.toml", '[build]\n  publish = "."\n', "какая папка публикуется");
      else plan.warnings.push("для серверного проекта Netlify потребует переделки под функции — repokit этого не делает");
      plan.commands.push(["netlify", "deploy", "--prod", "--dir", "."]);
      break;
    }
    case "vercel": {
      if (types.has("node-web") && !scan.project.frameworks.includes("next")) {
        plan.warnings.push("постоянно работающий сервер (Express, Fastify) на Vercel нужно переделать под функции — repokit этого не делает; проще Render");
      }
      if (types.has("python-api")) plan.warnings.push("Python-сервер на Vercel работает только как функции — проще Render");
      plan.commands.push(["vercel", "deploy", "--prod", "--yes"]);
      break;
    }
    case "render": {
      needServer("серверные приложения");
      const runtime = scan.project.packageManager === "pip" ? "python" : "node";
      const lines = [
        "services:",
        "  - type: web",
        `    name: ${name}`,
        `    runtime: ${runtime}`,
        "    plan: free",
        ...(prefix ? [`    rootDir: ${prefix}`] : []),
        `    buildCommand: ${scan.project.commands.install ?? "# FILL: команда установки зависимостей"}`,
        `    startCommand: ${start ?? "# FILL: команда запуска"}`,
        `    healthCheckPath: ${healthPath}`,
        ...(plan.envVars.length > 0 ? ["    envVars:", ...plan.envVars.flatMap((v) => [`      - key: ${v}`, "        sync: false"])] : []),
      ];
      addFile(gitRoot ?? repo, "render.yaml", lines.join("\n") + "\n", "описание сервиса для Render Blueprint");
      plan.humanSteps.push("закоммитьте и запушьте render.yaml", "в панели Render: New → Blueprint → выберите этот репозиторий (у Render нет команды для этого шага)");
      plan.expectedUrl = `https://${name}.onrender.com/`;
      plan.warnings.push("адрес зависит от того, свободно ли имя сервиса — возьмите точный из панели Render");
      break;
    }
    case "fly": {
      needServer("приложения в контейнере");
      if (!files.has("Dockerfile")) {
        const generated = dockerfile(scan, FLY_PORT);
        if (generated) addFile(repo, "Dockerfile", generated, "образ приложения");
        else plan.warnings.push("Dockerfile нет, и собрать его автоматически не удалось — напишите его сами");
      }
      addFile(repo, "fly.toml", `app = "${name}"\n\n[http_service]\n  internal_port = ${FLY_PORT}\n  force_https = true\n  auto_stop_machines = "stop"\n  auto_start_machines = true\n  min_machines_running = 0\n`, "настройки приложения Fly.io");
      plan.humanSteps.push(`первый раз создайте приложение сами: fly apps create ${name} (имя должно быть свободно)`);
      plan.commands.push(["fly", "deploy"]);
      plan.expectedUrl = `https://${name}.fly.dev/`;
      break;
    }
    case "hf-spaces": {
      const sdk = scan.project.frameworks.includes("gradio") ? "gradio" : scan.project.frameworks.includes("streamlit") ? "streamlit" : "docker";
      if (sdk === "docker" && !files.has("Dockerfile")) {
        const generated = dockerfile(scan, HF_PORT);
        if (generated) addFile(repo, "Dockerfile", generated, `образ приложения; Spaces ждёт его на порту ${HF_PORT}`);
        else plan.warnings.push("Dockerfile нет, и собрать его автоматически не удалось — напишите его сами");
      }
      const entry = scan.entrypoints.find((e) => e.file.endsWith(".py"))?.file ?? "app.py";
      plan.humanSteps.push(
        `создайте Space на huggingface.co/new-space, SDK: ${sdk}`,
        `в начало README того репозитория, который пушите в Space, добавьте блок метаданных: ---\\ntitle: ${scan.project.name}\\nsdk: ${sdk}${sdk === "docker" ? `\\napp_port: ${HF_PORT}` : `\\napp_file: ${entry}`}\\n---`,
        "добавьте Space как git-remote и запушьте в него (нужен ваш вход: huggingface-cli login)",
      );
      plan.warnings.push("блок метаданных Space будет виден в начале README на GitHub — многие держат для Space отдельную ветку");
      break;
    }
    case "streamlit-cloud": {
      if (!scan.project.frameworks.includes("streamlit")) plan.warnings.push("Streamlit Community Cloud запускает только приложения Streamlit");
      if (!files.has("requirements.txt")) plan.warnings.push("нет requirements.txt — площадка не узнает, какие зависимости ставить");
      const entry = scan.entrypoints.find((e) => e.file.endsWith(".py"))?.file ?? "app.py";
      plan.humanSteps.push("запушьте репозиторий на GitHub", `на share.streamlit.io: New app → этот репозиторий, ветка ${branch}, файл ${posix.join(prefix, entry)}`);
      break;
    }
  }

  if (plan.envVars.length > 0) {
    plan.humanSteps.push(`задайте переменные окружения в настройках ${provider.title} (не в репозитории): ${plan.envVars.join(", ")}`);
  }
  if (provider.sleeps) plan.warnings.push("бесплатный тариф усыпляет приложение при простое: откройте его за минуту до показа жюри");
  return plan;
}
