import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { posix } from "node:path";
import { listFiles, readText, sha256 } from "@repokit/core";
import type { AuditFinding, Entrypoint, Mock, MockKind, Model, ProjectType, Route, ScanResult } from "./types.js";

const LANGUAGE_BY_EXT: Record<string, string> = {
  ".py": "Python", ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript",
  ".mjs": "JavaScript", ".cjs": "JavaScript", ".html": "HTML", ".css": "CSS", ".go": "Go", ".rs": "Rust",
  ".java": "Java", ".rb": "Ruby", ".php": "PHP",
};
const CODE_EXT = new Set([".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".go", ".rs", ".java", ".rb", ".php"]);
const JS_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

const NODE_FRAMEWORKS = ["express", "fastify", "next", "react", "vue", "svelte", "vite"];
const PYTHON_FRAMEWORKS = ["fastapi", "flask", "django", "streamlit", "gradio"];

const HASH_CONTENT_LIMIT = 1024 * 1024;
const LARGE_FILE_BYTES = 1024 * 1024;
const HUGE_FILE_BYTES = 5 * 1024 * 1024;
const SHORT_README_BYTES = 500;
const MAX_MOCKS = 200;
const MAX_MOCK_TEXT = 160;
const LARGEST_SOURCE_FILES = 3;

const MOCK_PATTERNS: [MockKind, RegExp][] = [
  ["not-implemented", /NotImplementedError|not implemented/i],
  ["todo", /\b(TODO|FIXME|HACK|XXX)\b/],
  ["mock-marker", /\b(mock|fake|dummy|stub|hard-?coded)/i],
  ["placeholder-text", /lorem ipsum/i],
];

const JUNK_SEGMENTS = new Set(["node_modules", "__pycache__", ".venv", "venv", ".pytest_cache"]);
const JUNK_NAMES = new Set([".env", ".DS_Store", "Thumbs.db"]);
const JUNK_SUFFIXES = [".pyc", ".log"];

const PY_APP = /^(\w+)\s*=\s*(FastAPI|Flask)\(/;
const PY_MAIN = /^if __name__\s*==\s*["']__main__["']/;
const PY_ROUTE = /^\s*@(\w+)\.(get|post|put|patch|delete|options|head)\(\s*["']([^"']*)["']/;
const PY_FLASK_ROUTE = /^\s*@(\w+)\.route\(\s*["']([^"']+)["'](.*)$/;
const PY_CLASS = /^class\s+(\w+)\(([^)]*)\)\s*:/;
const PY_CLI_LIB = /^\s*(import|from)\s+(argparse|click|typer)\b/m;
const JS_ROUTE = /\b(\w+)\.(get|post|put|patch|delete|all)\(\s*["'`](\/[^"'`]*)["'`]/;

export function isTestFile(path: string): boolean {
  return /(^|\/)(tests?|__tests__|spec)\//.test(path) || /(^|\/)test_[^/]+\.py$/.test(path) || /\.(test|spec)\.[jt]sx?$/.test(path);
}

function isJunk(path: string): boolean {
  const parts = path.split("/");
  const name = parts[parts.length - 1];
  return parts.some((p) => JUNK_SEGMENTS.has(p)) || JUNK_NAMES.has(name) || JUNK_SUFFIXES.some((s) => name.endsWith(s));
}

/** Collect deterministic facts about a repository. No network, no writes. */
export function analyze(repo: string): ScanResult {
  const { files, tracked } = listFiles(repo);
  const has = (path: string) => files.some((f) => f.path === path);
  const read = (path: string) => readText(repo, path);

  const treeSha256 = sha256(
    files
      .map((f) => `${f.path}:${f.size > HASH_CONTENT_LIMIT ? `size=${f.size}` : sha256(readFileSync(join(repo, f.path)))}`)
      .join("\n"),
  );

  // --- manifests and frameworks
  let pkg: Record<string, any> | null = null;
  try {
    pkg = has("package.json") ? JSON.parse(read("package.json") ?? "null") : null;
  } catch {
    pkg = null;
  }
  const nodeDeps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const pyManifests = files.filter((f) => /^requirements[^/]*\.txt$/.test(f.path) || f.path === "pyproject.toml");
  const pyDeps = pyManifests.map((f) => read(f.path) ?? "").join("\n").toLowerCase();
  const hasPyDep = (name: string) => new RegExp(`(^|[^a-z0-9_-])${name}([^a-z0-9_-]|$)`, "m").test(pyDeps);
  const frameworks = [
    ...NODE_FRAMEWORKS.filter((name) => name in nodeDeps),
    ...PYTHON_FRAMEWORKS.filter(hasPyDep),
  ];
  const uses = (name: string) => frameworks.includes(name);
  // Names only, as declared: enough to tell which technologies a project really depends on.
  const requirementNames = pyManifests
    .filter((f) => f.path.endsWith(".txt"))
    .flatMap((f) => (read(f.path) ?? "").split(/\r?\n/))
    .map((line) => line.trim().toLowerCase().match(/^([a-z0-9][a-z0-9._-]*)/)?.[1]);
  const pyprojectNames = [...(read("pyproject.toml") ?? "").matchAll(/dependencies\s*=\s*\[([\s\S]*?)\]/g)]
    .flatMap((block) => [...block[1].matchAll(/["']\s*([A-Za-z0-9][A-Za-z0-9._-]*)/g)].map((m) => m[1].toLowerCase()));
  const dependencies = [...new Set([...Object.keys(nodeDeps), ...requirementNames, ...pyprojectNames].filter((n): n is string => Boolean(n)))].sort();

  // --- languages
  const languageStats = new Map<string, { files: number; bytes: number }>();
  for (const file of files) {
    const language = LANGUAGE_BY_EXT[posix.extname(file.path)];
    if (!language) continue;
    const stat = languageStats.get(language) ?? { files: 0, bytes: 0 };
    stat.files += 1;
    stat.bytes += file.size;
    languageStats.set(language, stat);
  }
  const languages = [...languageStats]
    .map(([name, stat]) => ({ name, ...stat }))
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));

  // --- per-file facts
  const entrypoints: Entrypoint[] = [];
  const routes: Route[] = [];
  const models: Model[] = [];
  const mocks: Mock[] = [];
  let pythonCli = false;
  let asgiApp: { file: string; variable: string; kind: string } | null = null;
  const pyRouteFramework = uses("fastapi") ? "fastapi" : uses("flask") ? "flask" : "python";
  const jsRouteConfidence = uses("express") || uses("fastify") ? 0.8 : 0.4;

  for (const file of files) {
    const ext = posix.extname(file.path);
    if (!CODE_EXT.has(ext) && ext !== ".prisma") continue;
    if (isTestFile(file.path)) continue;
    const text = read(file.path);
    if (text === null) continue;
    const lines = text.split(/\r?\n/);
    let hasMain = false;

    lines.forEach((line, index) => {
      const lineNo = index + 1;
      let m: RegExpMatchArray | null;

      if (ext === ".py") {
        if ((m = line.match(PY_APP))) {
          const kind = m[2] === "FastAPI" ? "fastapi-app" : "flask-app";
          entrypoints.push({ file: file.path, line: lineNo, kind, confidence: 0.9 });
          asgiApp ??= { file: file.path, variable: m[1], kind };
        }
        if (PY_MAIN.test(line)) {
          hasMain = true;
          entrypoints.push({ file: file.path, line: lineNo, kind: "python-main", confidence: 0.8 });
        }
        if ((m = line.match(PY_ROUTE))) {
          routes.push({ method: m[2].toUpperCase(), path: m[3] || "/", file: file.path, line: lineNo, framework: pyRouteFramework, confidence: 0.9 });
        } else if ((m = line.match(PY_FLASK_ROUTE))) {
          const methods = m[3].match(/methods\s*=\s*\[([^\]]*)\]/)?.[1].match(/[A-Za-z]+/g) ?? ["GET"];
          for (const method of methods) {
            routes.push({ method: method.toUpperCase(), path: m[2], file: file.path, line: lineNo, framework: pyRouteFramework, confidence: 0.9 });
          }
        }
        if ((m = line.match(PY_CLASS))) {
          const bases = m[2];
          const kind = /\bSQLModel\b/.test(bases) ? "sqlmodel"
            : /\bBaseModel\b/.test(bases) ? "pydantic"
            : /\b(Base|DeclarativeBase)\b|db\.Model/.test(bases) ? "sqlalchemy"
            : null;
          if (kind) models.push({ name: m[1], file: file.path, line: lineNo, kind });
        }
      } else if (JS_EXT.has(ext)) {
        if ((m = line.match(JS_ROUTE))) {
          routes.push({ method: m[2].toUpperCase(), path: m[3], file: file.path, line: lineNo, framework: uses("fastify") ? "fastify" : "express", confidence: jsRouteConfidence });
        }
      } else if (ext === ".prisma") {
        if ((m = line.match(/^model\s+(\w+)\s*\{/))) models.push({ name: m[1], file: file.path, line: lineNo, kind: "prisma" });
      }

      if (CODE_EXT.has(ext) && mocks.length < MAX_MOCKS) {
        const hit = MOCK_PATTERNS.find(([, pattern]) => pattern.test(line));
        if (hit) mocks.push({ file: file.path, line: lineNo, kind: hit[0], text: line.trim().slice(0, MAX_MOCK_TEXT) });
      }
    });

    if (ext === ".py" && hasMain && PY_CLI_LIB.test(text)) pythonCli = true;
  }

  // --- Node entry points
  if (pkg) {
    const startScript: string | undefined = pkg.scripts?.start;
    const startFile = startScript?.match(/\bnode\s+(\S+)/)?.[1];
    const bins = typeof pkg.bin === "string" ? [pkg.bin] : Object.values(pkg.bin ?? {});
    const candidates: [string | undefined, string][] = [
      [pkg.main, "package-main"],
      [startFile, "start-script"],
      ...bins.map((bin): [string, string] => [String(bin), "package-bin"]),
    ];
    for (const [file, kind] of candidates) {
      const path = file?.replace(/^\.\//, "");
      if (path && has(path) && !entrypoints.some((e) => e.file === path)) entrypoints.push({ file: path, kind, confidence: 0.9 });
    }
  }

  // --- project types
  const types: ProjectType[] = [];
  if (uses("streamlit") || uses("gradio")) types.push("data-app");
  if (uses("fastapi") || uses("flask") || uses("django")) types.push("python-api");
  if (uses("express") || uses("fastify") || uses("next")) types.push("node-web");
  const hasBackend = types.length > 0;
  if (!hasBackend && has("index.html")) types.push("static-site");
  if (pkg?.bin || pythonCli || /\[project\.scripts\]/.test(pyDeps)) types.push("cli");
  if (has("Dockerfile")) types.push("docker");
  if (types.length === 0) types.push("unknown");

  if (types.includes("static-site")) {
    for (const file of files) {
      if (posix.extname(file.path) !== ".html") continue;
      const path = "/" + file.path.replace(/(^|\/)index\.html$/, "$1");
      routes.push({ method: "GET", path, file: file.path, line: 1, framework: "static", confidence: 1 });
      if (file.path === "index.html") entrypoints.push({ file: file.path, kind: "html-index", confidence: 1 });
    }
  }
  for (const file of files) {
    if (!uses("next")) break;
    const page = file.path.match(/^(?:src\/)?(?:pages\/(.*)\.[jt]sx?|app\/(.*?)\/?page\.[jt]sx?)$/);
    if (page) routes.push({ method: "GET", path: "/" + (page[1] ?? page[2] ?? "").replace(/(^|\/)index$/, ""), file: file.path, line: 1, framework: "next", confidence: 0.7 });
  }

  // --- commands
  const hasTests = files.some((f) => isTestFile(f.path));
  const commands: ScanResult["project"]["commands"] = {};
  let packageManager: string | null = null;
  if (pkg) {
    packageManager = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "npm";
    commands.install = `${packageManager} install`;
    if (pkg.scripts?.start) commands.run = `${packageManager} start`;
    else if (pkg.scripts?.dev) commands.run = `${packageManager} run dev`;
    if (pkg.scripts?.test && !/no test specified/.test(pkg.scripts.test)) commands.test = `${packageManager} test`;
  } else if (pyManifests.length > 0 || languageStats.has("Python")) {
    const app = asgiApp as { file: string; variable: string; kind: string } | null;
    const main = entrypoints.find((e) => e.kind === "python-main");
    packageManager = pyManifests.length > 0 ? "pip" : null;
    if (has("requirements.txt")) commands.install = "pip install -r requirements.txt";
    else if (has("pyproject.toml")) commands.install = "pip install .";
    if (app?.kind === "fastapi-app") commands.run = `uvicorn ${app.file.replace(/\.py$/, "").replaceAll("/", ".")}:${app.variable}`;
    else if (app?.kind === "flask-app") commands.run = `flask --app ${app.file} run`;
    else if (uses("streamlit") && main) commands.run = `streamlit run ${main.file}`;
    else if (main) commands.run = `python ${main.file}${pythonCli ? " --help" : ""}`;
    if (hasTests) commands.test = "pytest";
  }

  // --- repository health
  const readmeFile = files.find((f) => /^readme(\.(md|rst|txt))?$/i.test(f.path));
  const readmeText = readmeFile ? read(readmeFile.path) ?? "" : "";
  const repoHealth: ScanResult["repoHealth"] = {
    isGitRepo: tracked !== null,
    readme: readmeFile ? { file: readmeFile.path, bytes: readmeFile.size } : null,
    hasLicense: files.some((f) => /^(licen[sc]e|copying)(\.[^/]*)?$/i.test(f.path)),
    hasGitignore: has(".gitignore"),
    hasTests,
    hasCi: files.some((f) => f.path.startsWith(".github/workflows/") || f.path === ".gitlab-ci.yml"),
    fileCount: files.length,
    totalBytes: files.reduce((sum, f) => sum + f.size, 0),
    largeFiles: files.filter((f) => f.size >= LARGE_FILE_BYTES).map((f) => ({ file: f.path, bytes: f.size })),
    trackedJunk: (tracked ?? []).filter(isJunk).sort(),
  };

  // --- key files
  const reasons = new Map<string, string[]>();
  const addReason = (file: string, reason: string) => reasons.set(file, [...(reasons.get(file) ?? []), reason]);
  for (const e of entrypoints) addReason(e.file, `точка входа (${e.kind})`);
  const countBy = (items: { file: string }[]) => items.reduce((map, i) => map.set(i.file, (map.get(i.file) ?? 0) + 1), new Map<string, number>());
  for (const [file, count] of countBy(routes)) addReason(file, `роуты: ${count}`);
  for (const [file, count] of countBy(models)) addReason(file, `модели данных: ${count}`);
  for (const file of ["package.json", "requirements.txt", "pyproject.toml", "Dockerfile"]) if (has(file)) addReason(file, "манифест проекта");
  if (readmeFile) addReason(readmeFile.path, "README");
  files
    .filter((f) => CODE_EXT.has(posix.extname(f.path)) && !isTestFile(f.path))
    .sort((a, b) => b.size - a.size || a.path.localeCompare(b.path))
    .slice(0, LARGEST_SOURCE_FILES)
    .forEach((f) => addReason(f.path, "один из крупнейших файлов исходников"));
  const keyFiles = [...reasons].map(([file, list]) => ({ file, reasons: [...new Set(list)] })).sort((a, b) => a.file.localeCompare(b.file));

  // --- audit
  const audit: AuditFinding[] = [];
  const find = (id: string, severity: AuditFinding["severity"], message: string, file?: string) =>
    audit.push(file ? { id, severity, message, file } : { id, severity, message });
  if (!readmeFile) find("readme.missing", "error", "Нет README.");
  else {
    if (readmeFile.size < SHORT_README_BYTES) find("readme.short", "warn", `README очень короткий (${readmeFile.size} байт).`, readmeFile.path);
    if (/<!--\s*FILL/.test(readmeText)) find("readme.fill", "warn", "В README остались незаполненные места <!-- FILL -->.", readmeFile.path);
  }
  if (!repoHealth.hasLicense) find("license.missing", "warn", "Нет файла лицензии. Лицензию выбирает человек.");
  if (!repoHealth.hasGitignore) find("gitignore.missing", "warn", "Нет .gitignore.");
  if (!repoHealth.hasTests) find("tests.missing", "info", "Тесты не найдены: polish сможет менять только комментарии и документацию.");
  if (!repoHealth.hasCi) find("ci.missing", "info", "CI не настроен.");
  if (!commands.run && !types.includes("static-site")) find("run.unknown", "warn", "Не удалось определить команду запуска.");
  for (const file of repoHealth.trackedJunk) {
    const isEnv = basename(file) === ".env";
    find(isEnv ? "env.tracked" : "junk.tracked", "error", isEnv ? "Файл .env закоммичен: возможна утечка секретов." : "В git попал служебный файл.", file);
  }
  for (const large of repoHealth.largeFiles) {
    const huge = large.bytes >= HUGE_FILE_BYTES;
    find("file.large", huge ? "error" : "warn", `Тяжёлый файл: ${(large.bytes / 1024 / 1024).toFixed(1)} МБ.`, large.file);
  }
  if (mocks.length > 0) find("mocks.present", "info", `Найдено мест, похожих на заглушки и недоделки: ${mocks.length}. Их нельзя подавать как готовые фичи.`);

  return {
    schemaVersion: 1,
    treeSha256,
    project: { name: pkg?.name ?? basename(repo), types, languages, frameworks, dependencies, packageManager, commands },
    entrypoints,
    routes,
    models,
    keyFiles,
    mocks,
    repoHealth,
    audit,
  };
}
