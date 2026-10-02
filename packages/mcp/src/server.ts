#!/usr/bin/env node
/**
 * MCP server for repokit: a thin layer of structured tools over the command-line tool.
 * It holds no logic of its own — every tool runs `repokit … --json` and passes the
 * envelope on. stdout carries the protocol only; anything else goes to stderr.
 */
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { VERSION } from "@repokit/core";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The command-line entry: next to this file in the plugin, or in the checkout during development. */
const CLI = process.env.REPOKIT_CLI ?? [join(HERE, "..", "bin", "repokit"), join(HERE, "..", "..", "cli", "dist", "bin.js")].find((p) => existsSync(p)) ?? "";
const TIMEOUT_MS = 15 * 60 * 1000;
const PROTOCOL_VERSION = "2025-06-18";

interface Envelope {
  ok: boolean;
  exitCode: number;
  service?: string;
  command?: string;
  data?: any;
  warnings?: string[];
  humanTodo?: { id: string; text: string }[];
  artifacts?: unknown[];
  error?: { message: string };
}

type Args = Record<string, unknown>;

const log = (line: string) => process.stderr.write(`[repokit-mcp] ${line}\n`);

/** Directories the client says the session may work in, from `roots/list`. */
let roots: string[] = [];

/** The repository a tool works on: the one named, else the project Claude Code is open in. */
function repoOf(args: Args): string {
  const named = typeof args.repo === "string" && args.repo.trim() ? args.repo.trim() : null;
  const base = process.env.CLAUDE_PROJECT_DIR || roots[0] || process.cwd();
  const repo = named ? (isAbsolute(named) ? named : resolve(base, named)) : base;
  if (!existsSync(repo) || !statSync(repo).isDirectory()) throw new Error(`Папка репозитория не найдена: ${repo}`);
  return repo;
}

/** Run one repokit command and read its JSON envelope. Never throws for a failed check: that is a result. */
function repokit(repo: string, args: string[]): Promise<Envelope> {
  return new Promise((done) => {
    if (!CLI) return done({ ok: false, exitCode: 2, error: { message: "Не найден исполняемый файл repokit рядом с MCP-сервером." } });
    const child = spawn(process.execPath, [CLI, ...args, "--repo", repo, "--json"], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-2000)));
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ ok: false, exitCode: 2, error: { message: `repokit не запустился: ${error.message}` } });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        done(JSON.parse(stdout) as Envelope);
      } catch {
        // No envelope means the command crashed or was refused by the argument parser: report it, do not guess.
        const reason = stderr.trim().split(/\r?\n/).slice(-3).join(" ");
        done({ ok: false, exitCode: code ?? 1, error: { message: reason || `repokit ${args.join(" ")} завершился с кодом ${code} без результата` } });
      }
    });
  });
}

interface ToolResult {
  ok: boolean;
  exitCode: number;
  error?: string;
  data: unknown;
  warnings: string[];
  humanTodo: string[];
  artifacts: unknown[];
}

/** What a tool hands back: the envelope's contract, with `data` trimmed to what a model needs. */
const result = (envelope: Envelope, data: unknown = envelope.data): ToolResult => ({
  ok: envelope.ok,
  exitCode: envelope.exitCode,
  ...(envelope.error ? { error: envelope.error.message } : {}),
  data: data ?? null,
  warnings: envelope.warnings ?? [],
  humanTodo: (envelope.humanTodo ?? []).map((t) => t.text),
  artifacts: envelope.artifacts ?? [],
});

/** Several commands as one answer: fails if any failed to run, and keeps every note. */
function combine(parts: Record<string, Envelope>, data: unknown): ToolResult {
  const all = Object.values(parts);
  const failed = Object.entries(parts).filter(([, e]) => e.error);
  return {
    ok: all.every((e) => e.ok),
    exitCode: Math.max(...all.map((e) => e.exitCode)),
    ...(failed.length ? { error: failed.map(([name, e]) => `${name}: ${e.error!.message}`).join("; ") } : {}),
    data,
    warnings: [...new Set(all.flatMap((e) => e.warnings ?? []))],
    humanTodo: [...new Set(all.flatMap((e) => (e.humanTodo ?? []).map((t) => t.text)))],
    artifacts: all.flatMap((e) => e.artifacts ?? []),
  };
}

const text = (value: unknown, name: string): string | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${name}: ожидается строка`);
  return value;
};
const flag = (name: string, value: string | undefined) => (value === undefined ? [] : [name, value]);

const REPO = { type: "string", description: "Path to the repository. Omit to use the project Claude Code is open in." };
const STYLE = { type: "string", enum: ["minimal", "developer", "product", "showcase", "research", "docs"], description: "Presentation style; chosen from the kind of project when omitted." };
const LANG = { type: "string", enum: ["ru", "en"], description: "Language of the generated README. Match the existing README or the user's language." };

/** Services `run_repokit` may call. Publishing and installing are left to the user and the terminal. */
const SERVICES = new Set(["scan", "readme", "examples", "diagram", "assets", "capture", "studio", "preview", "verify", "brief", "deploy", "release", "doctor", "run"]);
const REFUSED: [RegExp, string][] = [
  [/^deploy run\b/, "deploy run публикует проект — его запускает пользователь в терминале после явного согласия"],
  [/^release create\b/, "release create публикует релиз — его запускает пользователь в терминале после явного согласия"],
  [/^preview serve\b/, "preview serve — долгоживущий сервер; запустите его в терминале"],
];

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  call: (args: Args) => Promise<ToolResult>;
}

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });

const TOOLS: Tool[] = [
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
        repokit(repo, ["examples", "extract", "--dry-run"]),
      ]);
      const s = scan.data ?? {};
      const l = layout.data ?? {};
      const e = examples.data ?? {};
      return combine({ scan, layout, examples }, {
        repo,
        project: s.project ? { name: s.project.name, types: s.project.types, languages: (s.project.languages ?? []).slice(0, 5), packageManager: s.project.packageManager, commands: s.project.commands } : null,
        entrypoints: (s.entrypoints ?? []).slice(0, 8),
        routes: { count: (s.routes ?? []).length, sample: (s.routes ?? []).slice(0, 12).map((r: any) => `${r.method} ${r.path} (${r.file}:${r.line})`) },
        stubs: (s.mocks ?? []).slice(0, 10).map((m: any) => `${m.file}:${m.line} ${m.kind}`),
        repositoryProblems: (s.audit ?? []).filter((a: any) => a.severity !== "info").map((a: any) => `${a.severity}: ${a.message}`),
        readme: s.repoHealth?.readme ?? null,
        presentation: layout.data ? {
          projectType: l.projectType, confidence: l.confidence, signals: l.signals, alternatives: l.alternatives, style: l.style, audience: l.audience,
          primaryAction: l.primaryAction, demo: l.demo, mode: l.mode,
          sections: (l.sections ?? []).map((x: any) => ({ id: x.id, priority: x.priority, reason: x.reason })),
          existing: l.existing ? { lines: l.existing.lines, sections: l.existing.sections.map((x: any) => x.heading) } : null,
        } : null,
        examples: { count: (e.examples ?? []).length, best: (e.examples ?? []).slice(0, 3).map((x: any) => ({ file: x.file, lines: x.lines, kind: x.kind, language: x.language, title: x.title })), commands: (e.commands ?? []).length, options: (e.options ?? []).length },
      });
    },
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
    },
  },
  {
    name: "audit_readme",
    description: "Check a README the way a first-time visitor reads it: clarity, first screen, visuals, quick start, examples, claims, formatting, assets. Returns the failed checks; nothing is scored. Use draft=true to check .repokit/readme.draft.md before writing README.md.",
    inputSchema: schema({ repo: REPO, draft: { type: "boolean" }, firstScreenOnly: { type: "boolean", description: "Only what is visible before the first heading." } }),
    annotations: { readOnlyHint: true },
    call: async (args) => {
      const repo = repoOf(args);
      const audit = await repokit(repo, ["readme", args.firstScreenOnly ? "hero-check" : "audit", "--dry-run", ...(args.draft ? ["--draft"] : [])]);
      const d = audit.data ?? {};
      return result(audit, audit.data ? { file: d.file, projectType: d.projectType, passed: d.passed, failed: d.failed, errors: d.errors, failedChecks: (d.checks ?? []).filter((c: any) => !c.ok).map((c: any) => ({ category: c.category, id: c.id, severity: c.severity, message: c.message, line: c.line, fix: c.fix })) } : null);
    },
  },
  {
    name: "generate_presentation",
    description: "Write README.md from the current plan. With apply=false (default) returns the diff and changes nothing. Call with apply=true only after the user has seen the diff and agreed. A substantial README written by the author is not replaced unless regenerate=true — prefer editing it by hand using audit_readme.",
    inputSchema: schema({ repo: REPO, style: STYLE, lang: LANG, hero: { type: "string" }, heroDark: { type: "string" }, banner: { type: "string" }, apply: { type: "boolean" }, regenerate: { type: "boolean", description: "Replace an existing hand-written README. Only on the user's explicit request." } }),
    call: async (args) => {
      const repo = repoOf(args);
      const options = [...flag("--style", text(args.style, "style")), ...flag("--lang", text(args.lang, "lang")), ...flag("--hero", text(args.hero, "hero")), ...flag("--hero-dark", text(args.heroDark, "heroDark")), ...flag("--banner", text(args.banner, "banner"))];
      const applied = await repokit(repo, ["readme", "apply", ...options, ...(args.apply ? [] : ["--dry-run"]), ...(args.apply && args.regenerate ? ["--regenerate"] : [])]);
      return result(applied);
    },
  },
  {
    name: "capture_demo",
    description: "Make a real visual for the README. kind=terminal runs `command` in the repository and saves its true output as an SVG (light and dark). kind=screenshot opens `url` in a browser (starting the app with `start` if given) and saves a PNG. Both run code on the user's machine: agree the command with the user first, and use dryRun=true to preview. Needs `repokit setup` once.",
    inputSchema: schema({
      repo: REPO, kind: { type: "string", enum: ["terminal", "screenshot"] },
      command: { type: "string", description: "terminal: the command to run, e.g. `python tool.py --help`." },
      url: { type: "string", description: "screenshot: page address, e.g. http://localhost:8000/." },
      start: { type: "string", description: "screenshot: command that starts the app if it is not running." },
      themes: { type: "string", enum: ["light", "dark", "light,dark"] },
      out: { type: "string", description: "Output file inside the repository; defaults to docs/assets/." },
      dryRun: { type: "boolean" },
    }, ["kind"]),
    call: async (args) => {
      const repo = repoOf(args);
      const dry = args.dryRun ? ["--dry-run"] : [];
      if (args.kind === "terminal") {
        const command = text(args.command, "command");
        if (!command) throw new Error("command: укажите команду, вывод которой нужно записать");
        // The command goes after `--` as one word, so nothing in it is read as an option of repokit.
        return result(await spawnTerminal(repo, command, text(args.out, "out"), dry));
      }
      if (args.kind === "screenshot") {
        const url = text(args.url, "url");
        if (!url) throw new Error("url: укажите адрес страницы");
        return result(await repokit(repo, ["capture", "screenshot", "--url", url, ...flag("--start", text(args.start, "start")), ...flag("--themes", text(args.themes, "themes")), ...flag("--out", text(args.out, "out")), ...dry]));
      }
      throw new Error("kind: terminal или screenshot");
    },
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
        repokit(repo, ["assets", "check"]),
      ]);
      return combine({ verify, assets }, {
        checks: (verify.data?.checks ?? []).map((c: any) => ({ id: c.id, status: c.status, title: c.title, ...(c.status === "pass" ? {} : { details: c.details.slice(0, 8) }) })),
        assets: assets.data ?? null,
      });
    },
  },
  {
    name: "run_repokit",
    description: "Run any other repokit command and get its JSON result, e.g. args=[\"diagram\",\"architecture\"] or [\"studio\",\"scene\",\"templates\"]. `--json` and `--repo` are added automatically. Publishing commands are refused here by design; flags that confirm an irreversible step (--confirm) are not accepted.",
    inputSchema: schema({ repo: REPO, args: { type: "array", items: { type: "string" }, minItems: 1, description: "Service, command and flags, one word per item." } }, ["args"]),
    call: async (args) => {
      const words = args.args;
      if (!Array.isArray(words) || words.length === 0 || words.some((w) => typeof w !== "string")) throw new Error("args: ожидается непустой список строк");
      const list = words as string[];
      if (!SERVICES.has(list[0])) throw new Error(`Неизвестный сервис «${list[0]}». Доступны: ${[...SERVICES].join(", ")}`);
      const line = list.join(" ");
      const refused = REFUSED.find(([pattern]) => pattern.test(line));
      if (refused) throw new Error(refused[1]);
      if (list.some((w) => w === "--confirm" || w === "--repo" || w.startsWith("--repo="))) throw new Error("--confirm и --repo здесь не принимаются: подтверждение даёт пользователь в терминале, а репозиторий задаётся полем repo");
      const repo = repoOf(args);
      // `run` takes the repository as its argument rather than as a flag.
      return result(list[0] === "run" ? await repokitRun(repo, list.slice(1)) : await repokit(repo, list.filter((w) => w !== "--json")));
    },
  },
];

function spawnTerminal(repo: string, command: string, out: string | undefined, dry: string[]): Promise<Envelope> {
  return repokitRaw(["capture", "terminal", "--repo", repo, "--json", ...flag("--out", out), ...dry, "--", command]);
}

const repokitRun = (repo: string, rest: string[]) => repokitRaw(["run", repo, "--json", ...rest.filter((w) => w !== "--json")]);

/** For the two commands whose arguments do not fit the usual `--repo … --json` tail. */
function repokitRaw(argv: string[]): Promise<Envelope> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI, ...argv], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-2000)));
    child.on("error", (error) => done({ ok: false, exitCode: 2, error: { message: error.message } }));
    child.on("close", (code) => {
      try {
        done(JSON.parse(stdout) as Envelope);
      } catch {
        done({ ok: false, exitCode: code ?? 1, error: { message: stderr.trim().split(/\r?\n/).slice(-3).join(" ") || `код ${code}` } });
      }
    });
  });
}

// --- JSON-RPC over stdio: one JSON message per line

interface Message {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: unknown;
}

const send = (message: Record<string, unknown>) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const ROOTS_REQUEST = "repokit-roots";

async function handle(message: Message): Promise<void> {
  // The answer to our own `roots/list` request.
  if (message.id === ROOTS_REQUEST && message.method === undefined) {
    roots = ((message.result?.roots ?? []) as { uri: string }[]).filter((r) => r.uri.startsWith("file://")).map((r) => fileURLToPath(r.uri));
    return;
  }
  const { id, method, params } = message;
  const reply = (value: unknown) => id !== undefined && send({ id, result: value });
  switch (method) {
    case "initialize":
      reply({
        protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "repokit", version: VERSION },
        instructions: "Tools over the repokit command-line tool. Start with analyze_repository. Facts come from the repository's code; do not add features, numbers or links the tools did not report.",
      });
      if (params?.capabilities?.roots) send({ id: ROOTS_REQUEST, method: "roots/list" });
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
      reply({ tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, ...(annotations ? { annotations } : {}) })) });
      return;
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) {
        if (id !== undefined) send({ id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } });
        return;
      }
      try {
        const value = await tool.call((params.arguments ?? {}) as Args);
        // A check that did not pass is an answer, not a failure of the tool; a command that could not run is.
        reply({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError: Boolean(value.error) });
      } catch (error) {
        reply({ content: [{ type: "text", text: (error as Error).message }], isError: true });
      }
      return;
    }
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

const pending = new Set<Promise<unknown>>();
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) return;
  let message: Message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  const work: Promise<unknown> = handle(message).catch((error) => log(`${message.method}: ${(error as Error).stack ?? error}`)).finally(() => {
    pending.delete(work);
  });
  pending.add(work);
});
// Finish what was asked before leaving: the client closes stdin when the session ends.
lines.on("close", () => void Promise.allSettled([...pending]).then(() => process.exit(0)));
log(`started, repokit ${VERSION}, cli ${CLI || "not found"}`);
