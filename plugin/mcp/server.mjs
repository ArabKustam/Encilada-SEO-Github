#!/usr/bin/env node
import { createRequire as __repokitRequire } from "node:module";
const require = __repokitRequire(import.meta.url);

// packages/mcp/dist/server.js
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join as join2, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// packages/core/dist/envelope.js
var VERSION = "0.2.1";

// packages/core/dist/files.js
var MAX_TEXT_BYTES = 512 * 1024;

// packages/core/dist/resources.js
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
function resourceDir(name) {
  const root = process.env.REPOKIT_RESOURCES;
  return root ? join(root, name) + sep : fileURLToPath(new URL(`../../../${name}/`, import.meta.url));
}

// packages/core/dist/schema.js
var SCHEMA_DIR = resourceDir("schemas");

// packages/mcp/dist/server.js
var HERE = dirname(fileURLToPath2(import.meta.url));
var CLI = process.env.REPOKIT_CLI ?? [join2(HERE, "..", "bin", "repokit"), join2(HERE, "..", "..", "cli", "dist", "bin.js")].find((p) => existsSync(p)) ?? "";
var TIMEOUT_MS = 15 * 60 * 1e3;
var PROTOCOL_VERSION = "2025-06-18";
var log = (line) => process.stderr.write(`[repokit-mcp] ${line}
`);
var roots = [];
function repoOf(args) {
  const named = typeof args.repo === "string" && args.repo.trim() ? args.repo.trim() : null;
  const base = process.env.CLAUDE_PROJECT_DIR || roots[0] || process.cwd();
  const repo = named ? isAbsolute(named) ? named : resolve(base, named) : base;
  if (!existsSync(repo) || !statSync(repo).isDirectory())
    throw new Error(`Папка репозитория не найдена: ${repo}`);
  return repo;
}
function repokit(repo, args) {
  return new Promise((done) => {
    if (!CLI)
      return done({ ok: false, exitCode: 2, error: { message: "Не найден исполняемый файл repokit рядом с MCP-сервером." } });
    const child = spawn(process.execPath, [CLI, ...args, "--repo", repo, "--json"], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.stderr.on("data", (chunk) => stderr = (stderr + chunk).slice(-2e3));
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ ok: false, exitCode: 2, error: { message: `repokit не запустился: ${error.message}` } });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        done(JSON.parse(stdout));
      } catch {
        const reason = stderr.trim().split(/\r?\n/).slice(-3).join(" ");
        done({ ok: false, exitCode: code ?? 1, error: { message: reason || `repokit ${args.join(" ")} завершился с кодом ${code} без результата` } });
      }
    });
  });
}
var result = (envelope, data = envelope.data) => ({
  ok: envelope.ok,
  exitCode: envelope.exitCode,
  ...envelope.error ? { error: envelope.error.message } : {},
  data: data ?? null,
  warnings: envelope.warnings ?? [],
  humanTodo: (envelope.humanTodo ?? []).map((t) => t.text),
  artifacts: envelope.artifacts ?? []
});
function combine(parts, data) {
  const all = Object.values(parts);
  const failed = Object.entries(parts).filter(([, e]) => e.error);
  return {
    ok: all.every((e) => e.ok),
    exitCode: Math.max(...all.map((e) => e.exitCode)),
    ...failed.length ? { error: failed.map(([name, e]) => `${name}: ${e.error.message}`).join("; ") } : {},
    data,
    warnings: [...new Set(all.flatMap((e) => e.warnings ?? []))],
    humanTodo: [...new Set(all.flatMap((e) => (e.humanTodo ?? []).map((t) => t.text)))],
    artifacts: all.flatMap((e) => e.artifacts ?? [])
  };
}
var text = (value, name) => {
  if (value === void 0 || value === null || value === "")
    return void 0;
  if (typeof value !== "string")
    throw new Error(`${name}: ожидается строка`);
  return value;
};
var flag = (name, value) => value === void 0 ? [] : [name, value];
var REPO = { type: "string", description: "Path to the repository. Omit to use the project Claude Code is open in." };
var STYLE = { type: "string", enum: ["minimal", "developer", "product", "showcase", "research", "docs"], description: "Presentation style; chosen from the kind of project when omitted." };
var LANG = { type: "string", enum: ["ru", "en"], description: "Language of the generated README. Match the existing README or the user's language." };
var SERVICES = /* @__PURE__ */ new Set(["scan", "readme", "examples", "diagram", "assets", "capture", "studio", "preview", "verify", "brief", "deploy", "release", "doctor", "run"]);
var REFUSED = [
  [/^deploy run\b/, "deploy run публикует проект — его запускает пользователь в терминале после явного согласия"],
  [/^release create\b/, "release create публикует релиз — его запускает пользователь в терминале после явного согласия"],
  [/^preview serve\b/, "preview serve — долгоживущий сервер; запустите его в терминале"]
];
var schema = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
var TOOLS = [
  {
    name: "analyze_repository",
    description: "Read-only facts about a repository for planning its README: project type with evidence, stack, install/run/test commands, routes, stubs, repository problems, real usage examples found in the code, and the recommended README strategy. Start here.",
    inputSchema: schema({ repo: REPO }),
    annotations: { readOnlyHint: true },
    call: async (args) => {
      const repo = repoOf(args);
      const [scan, layout, examples] = await Promise.all([
        repokit(repo, ["scan", "audit", "--dry-run"]),
        repokit(repo, ["readme", "layout", "--dry-run"]),
        repokit(repo, ["examples", "extract", "--dry-run"])
      ]);
      const s = scan.data ?? {};
      const l = layout.data ?? {};
      const e = examples.data ?? {};
      return combine({ scan, layout, examples }, {
        repo,
        project: s.project ? { name: s.project.name, types: s.project.types, languages: (s.project.languages ?? []).slice(0, 5), packageManager: s.project.packageManager, commands: s.project.commands } : null,
        entrypoints: (s.entrypoints ?? []).slice(0, 8),
        routes: { count: (s.routes ?? []).length, sample: (s.routes ?? []).slice(0, 12).map((r) => `${r.method} ${r.path} (${r.file}:${r.line})`) },
        stubs: (s.mocks ?? []).slice(0, 10).map((m) => `${m.file}:${m.line} ${m.kind}`),
        repositoryProblems: (s.audit ?? []).filter((a) => a.severity !== "info").map((a) => `${a.severity}: ${a.message}`),
        readme: s.repoHealth?.readme ?? null,
        presentation: layout.data ? {
          projectType: l.projectType,
          confidence: l.confidence,
          signals: l.signals,
          alternatives: l.alternatives,
          style: l.style,
          audience: l.audience,
          primaryAction: l.primaryAction,
          demo: l.demo,
          mode: l.mode,
          sections: (l.sections ?? []).map((x) => ({ id: x.id, priority: x.priority, reason: x.reason })),
          existing: l.existing ? { lines: l.existing.lines, sections: l.existing.sections.map((x) => x.heading) } : null
        } : null,
        examples: { count: (e.examples ?? []).length, best: (e.examples ?? []).slice(0, 3).map((x) => ({ file: x.file, lines: x.lines, kind: x.kind, language: x.language, title: x.title })), commands: (e.commands ?? []).length, options: (e.options ?? []).length }
      });
    }
  },
  {
    name: "plan_readme",
    description: "Plan the README before writing it: sections with priority and reason, then a draft built from proven facts with the state of every section (filled, empty, omitted). Writes only to .repokit/. An empty section means data is missing — ask the user or leave it, never invent.",
    inputSchema: schema({ repo: REPO, style: STYLE, lang: LANG, hero: { type: "string", description: "Main image, path inside the repository." }, heroDark: { type: "string" }, banner: { type: "string" } }),
    call: async (args) => {
      const repo = repoOf(args);
      const options = [...flag("--style", text(args.style, "style")), ...flag("--lang", text(args.lang, "lang")), ...flag("--hero", text(args.hero, "hero")), ...flag("--hero-dark", text(args.heroDark, "heroDark")), ...flag("--banner", text(args.banner, "banner"))];
      const plan = await repokit(repo, ["readme", "plan", ...options]);
      const d = plan.data ?? {};
      return result(plan, plan.data ? { projectType: d.projectType, style: d.style, mode: d.mode, draft: ".repokit/readme.draft.md", slots: d.slots, preservedAuthorSections: d.preserved, problems: d.problems } : null);
    }
  },
  {
    name: "audit_readme",
    description: "Check a README the way a first-time visitor reads it: clarity, first screen, visuals, quick start, examples, claims, formatting, assets. Returns the failed checks; nothing is scored. Use draft=true to check .repokit/readme.draft.md before writing README.md.",
    inputSchema: schema({ repo: REPO, draft: { type: "boolean" }, firstScreenOnly: { type: "boolean", description: "Only what is visible before the first heading." } }),
    annotations: { readOnlyHint: true },
    call: async (args) => {
      const repo = repoOf(args);
      const audit = await repokit(repo, ["readme", args.firstScreenOnly ? "hero-check" : "audit", "--dry-run", ...args.draft ? ["--draft"] : []]);
      const d = audit.data ?? {};
      return result(audit, audit.data ? { file: d.file, projectType: d.projectType, passed: d.passed, failed: d.failed, errors: d.errors, failedChecks: (d.checks ?? []).filter((c) => !c.ok).map((c) => ({ category: c.category, id: c.id, severity: c.severity, message: c.message, line: c.line, fix: c.fix })) } : null);
    }
  },
  {
    name: "generate_presentation",
    description: "Write README.md from the current plan. With apply=false (default) returns the diff and changes nothing. Call with apply=true only after the user has seen the diff and agreed. A substantial README written by the author is not replaced unless regenerate=true — prefer editing it by hand using audit_readme.",
    inputSchema: schema({ repo: REPO, style: STYLE, lang: LANG, hero: { type: "string" }, heroDark: { type: "string" }, banner: { type: "string" }, apply: { type: "boolean" }, regenerate: { type: "boolean", description: "Replace an existing hand-written README. Only on the user's explicit request." } }),
    call: async (args) => {
      const repo = repoOf(args);
      const options = [...flag("--style", text(args.style, "style")), ...flag("--lang", text(args.lang, "lang")), ...flag("--hero", text(args.hero, "hero")), ...flag("--hero-dark", text(args.heroDark, "heroDark")), ...flag("--banner", text(args.banner, "banner"))];
      const applied = await repokit(repo, ["readme", "apply", ...options, ...args.apply ? [] : ["--dry-run"], ...args.apply && args.regenerate ? ["--regenerate"] : []]);
      return result(applied);
    }
  },
  {
    name: "capture_demo",
    description: "Make a real visual for the README. kind=terminal runs `command` in the repository and saves its true output as an SVG (light and dark). kind=screenshot opens `url` in a browser (starting the app with `start` if given) and saves a PNG. Both run code on the user's machine: agree the command with the user first, and use dryRun=true to preview. Needs `repokit setup` once.",
    inputSchema: schema({
      repo: REPO,
      kind: { type: "string", enum: ["terminal", "screenshot"] },
      command: { type: "string", description: "terminal: the command to run, e.g. `python tool.py --help`." },
      url: { type: "string", description: "screenshot: page address, e.g. http://localhost:8000/." },
      start: { type: "string", description: "screenshot: command that starts the app if it is not running." },
      themes: { type: "string", enum: ["light", "dark", "light,dark"] },
      out: { type: "string", description: "Output file inside the repository; defaults to docs/assets/." },
      dryRun: { type: "boolean" }
    }, ["kind"]),
    call: async (args) => {
      const repo = repoOf(args);
      const dry = args.dryRun ? ["--dry-run"] : [];
      if (args.kind === "terminal") {
        const command = text(args.command, "command");
        if (!command)
          throw new Error("command: укажите команду, вывод которой нужно записать");
        return result(await spawnTerminal(repo, command, text(args.out, "out"), dry));
      }
      if (args.kind === "screenshot") {
        const url = text(args.url, "url");
        if (!url)
          throw new Error("url: укажите адрес страницы");
        return result(await repokit(repo, ["capture", "screenshot", "--url", url, ...flag("--start", text(args.start, "start")), ...flag("--themes", text(args.themes, "themes")), ...flag("--out", text(args.out, "out")), ...dry]));
      }
      throw new Error("kind: terminal или screenshot");
    }
  },
  {
    name: "verify_repository",
    description: "Final check of the repository as a newcomer would get it: README has no blanks or broken links, images have alt text, media is within budget, no secrets or hidden text, plus the state of media files. Does not run the project's commands and does not use the network.",
    inputSchema: schema({ repo: REPO, source: { type: "string", enum: ["worktree", "head"], description: "worktree (default): the working folder as it would be after committing; head: a clean clone of the last commit." } }),
    annotations: { readOnlyHint: true },
    call: async (args) => {
      const repo = repoOf(args);
      const [verify, assets] = await Promise.all([
        repokit(repo, ["verify", "run", "--source", text(args.source, "source") ?? "worktree", "--dry-run"]),
        repokit(repo, ["assets", "check"])
      ]);
      return combine({ verify, assets }, {
        checks: (verify.data?.checks ?? []).map((c) => ({ id: c.id, status: c.status, title: c.title, ...c.status === "pass" ? {} : { details: c.details.slice(0, 8) } })),
        assets: assets.data ?? null
      });
    }
  },
  {
    name: "run_repokit",
    description: 'Run any other repokit command and get its JSON result, e.g. args=["diagram","architecture"] or ["studio","scene","templates"]. `--json` and `--repo` are added automatically. Publishing commands are refused here by design; flags that confirm an irreversible step (--confirm) are not accepted.',
    inputSchema: schema({ repo: REPO, args: { type: "array", items: { type: "string" }, minItems: 1, description: "Service, command and flags, one word per item." } }, ["args"]),
    call: async (args) => {
      const words = args.args;
      if (!Array.isArray(words) || words.length === 0 || words.some((w) => typeof w !== "string"))
        throw new Error("args: ожидается непустой список строк");
      const list = words;
      if (!SERVICES.has(list[0]))
        throw new Error(`Неизвестный сервис «${list[0]}». Доступны: ${[...SERVICES].join(", ")}`);
      const line = list.join(" ");
      const refused = REFUSED.find(([pattern]) => pattern.test(line));
      if (refused)
        throw new Error(refused[1]);
      if (list.some((w) => w === "--confirm" || w === "--repo" || w.startsWith("--repo=")))
        throw new Error("--confirm и --repo здесь не принимаются: подтверждение даёт пользователь в терминале, а репозиторий задаётся полем repo");
      const repo = repoOf(args);
      return result(list[0] === "run" ? await repokitRun(repo, list.slice(1)) : await repokit(repo, list.filter((w) => w !== "--json")));
    }
  }
];
function spawnTerminal(repo, command, out, dry) {
  return repokitRaw(["capture", "terminal", "--repo", repo, "--json", ...flag("--out", out), ...dry, "--", command]);
}
var repokitRun = (repo, rest) => repokitRaw(["run", repo, "--json", ...rest.filter((w) => w !== "--json")]);
function repokitRaw(argv) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI, ...argv], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.stderr.on("data", (chunk) => stderr = (stderr + chunk).slice(-2e3));
    child.on("error", (error) => done({ ok: false, exitCode: 2, error: { message: error.message } }));
    child.on("close", (code) => {
      try {
        done(JSON.parse(stdout));
      } catch {
        done({ ok: false, exitCode: code ?? 1, error: { message: stderr.trim().split(/\r?\n/).slice(-3).join(" ") || `код ${code}` } });
      }
    });
  });
}
var send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
var ROOTS_REQUEST = "repokit-roots";
async function handle(message) {
  if (message.id === ROOTS_REQUEST && message.method === void 0) {
    roots = (message.result?.roots ?? []).filter((r) => r.uri.startsWith("file://")).map((r) => fileURLToPath2(r.uri));
    return;
  }
  const { id, method, params } = message;
  const reply = (value) => id !== void 0 && send({ id, result: value });
  switch (method) {
    case "initialize":
      reply({
        protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "repokit", version: VERSION },
        instructions: "Tools over the repokit command-line tool. Start with analyze_repository. Facts come from the repository's code; do not add features, numbers or links the tools did not report."
      });
      if (params?.capabilities?.roots)
        send({ id: ROOTS_REQUEST, method: "roots/list" });
      return;
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "notifications/roots/list_changed":
      send({ id: ROOTS_REQUEST, method: "roots/list" });
      return;
    case "ping":
      reply({});
      return;
    case "tools/list":
      reply({ tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, ...annotations ? { annotations } : {} })) });
      return;
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) {
        if (id !== void 0)
          send({ id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } });
        return;
      }
      try {
        const value = await tool.call(params.arguments ?? {});
        reply({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError: Boolean(value.error) });
      } catch (error) {
        reply({ content: [{ type: "text", text: error.message }], isError: true });
      }
      return;
    }
    default:
      if (id !== void 0)
        send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}
var pending = /* @__PURE__ */ new Set();
var lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim())
    return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  const work = handle(message).catch((error) => log(`${message.method}: ${error.stack ?? error}`)).finally(() => {
    pending.delete(work);
  });
  pending.add(work);
});
lines.on("close", () => void Promise.allSettled([...pending]).then(() => process.exit(0)));
log(`started, repokit ${VERSION}, cli ${CLI || "not found"}`);
