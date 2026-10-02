import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validate, VERSION } from "../../packages/core/src/index.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const built = existsSync(join(ROOT, "plugin/lib/repokit.mjs")) && existsSync(join(ROOT, "plugin/mcp/server.mjs"));

/**
 * The plugin is tested the way a user gets it: copied alone to a path with a space in it,
 * with nothing of the repository next to it.
 */
const home = mkdtempSync(join(tmpdir(), "repokit plugin "));
const plugin = join(home, "installed plugin");
const project = join(home, "some project");
const emptyHome = join(home, "home");
// Servers started by the tests may still be letting go of the folder on Windows.
afterAll(() => rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));

beforeAll(() => {
  if (!built) return;
  cpSync(join(ROOT, "plugin"), plugin, { recursive: true });
  cpSync(join(ROOT, "examples/cli-tool"), project, { recursive: true, filter: (source) => !source.includes(".repokit") });
  mkdirSync(emptyHome);
});

const env = (extra: NodeJS.ProcessEnv = {}) => ({ ...process.env, REPOKIT_HOME: emptyHome, REPOKIT_RUNTIME: "", REPOKIT_RESOURCES: "", ...extra });

function repokit(args: string[], cwd = project) {
  const result = spawnSync(process.execPath, [join(plugin, "bin/repokit"), ...args], { encoding: "utf8", cwd, env: env() });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe.skipIf(!built)("packaged repokit", () => {
  it("runs from a path with spaces, away from the repository", () => {
    const help = repokit(["--help"]);
    expect(help.code).toBe(0);
    for (const service of ["scan", "readme", "assets", "verify", "capture", "studio", "preview", "setup"]) expect(help.stdout).toContain(service);
    expect(repokit(["--version"]).stdout.trim()).toBe(VERSION);
  });

  it("doctor answers with a valid envelope and says whether the media services are set up", () => {
    const { stdout } = repokit(["doctor", "--json"]);
    const envelope = JSON.parse(stdout);
    expect(validate("envelope", envelope)).toEqual({ valid: true, errors: [] });
    expect(envelope.data.tools.find((t: { name: string }) => t.name === "media")).toMatchObject({ found: false, hint: "repokit setup" });
  });

  it("analyses and plans a README for the project it is run in, using its bundled schemas and templates", () => {
    const scan = JSON.parse(repokit(["scan", "audit", "--json", "--dry-run"]).stdout);
    expect(validate("scan", scan.data).valid).toBe(true);
    expect(scan.data.project.types).toContain("cli");

    const layout = JSON.parse(repokit(["readme", "layout", "--json", "--dry-run"]).stdout);
    expect(layout.data.projectType).toBe("cli");
    const plan = JSON.parse(repokit(["readme", "plan", "--json", "--lang", "en"]).stdout);
    expect(plan.ok).toBe(true);
    expect(readFileSync(join(project, ".repokit/readme.draft.md"), "utf8")).toContain("## Quick start");
  });

  it("the whole pipeline calls itself, not a file from the checkout", () => {
    const run = JSON.parse(repokit(["run", project, "--json"]).stdout);
    expect(run.data.steps.find((s: { id: string }) => s.id === "scan").status).toBe("done");
  });

  it("media commands ask for a one-time setup instead of failing obscurely", () => {
    const { code, stdout } = repokit(["capture", "terminal", "--json", "--", "node", "--version"]);
    expect(code).toBe(3);
    const envelope = JSON.parse(stdout);
    expect(validate("envelope", envelope).valid).toBe(true);
    expect(envelope.error.message).toContain("repokit setup");
    // Without --json the same message goes to stderr and stdout stays empty.
    const plain = repokit(["studio", "scene", "templates"]);
    expect(plain.code).toBe(3);
    expect(plain.stdout).toBe("");
    expect(plain.stderr).toContain("repokit setup");
  });

  it("setup --dry-run only describes what it would do", () => {
    const { code, stdout } = repokit(["setup", "--dry-run", "--json"]);
    expect(code).toBe(0);
    const { data } = JSON.parse(stdout);
    expect(data.installed).toBe(false);
    expect(data.steps[0]).toContain(`v${VERSION}`);
    expect(readdirSync(emptyHome)).toEqual([]);
  });

  it("hands media commands to the full build once it is there", () => {
    const result = spawnSync(process.execPath, [join(plugin, "bin/repokit"), "studio", "scene", "templates", "--json"], { encoding: "utf8", cwd: project, env: env({ REPOKIT_RUNTIME: ROOT }) });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).data.templates.length).toBeGreaterThan(20);
  });
});

describe("plugin manifests", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "plugin/.claude-plugin/plugin.json"), "utf8"));
  const marketplace = JSON.parse(readFileSync(join(ROOT, ".claude-plugin/marketplace.json"), "utf8"));

  it("carry one version, the same as the tool reports", () => {
    expect(manifest.version).toBe(VERSION);
    expect(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version).toBe(VERSION);
  });

  it("the marketplace lists the plugin under the name its manifest declares, at a path that exists", () => {
    const entry = marketplace.plugins[0];
    expect(entry.name).toBe(manifest.name);
    expect(entry.source).toBe("./plugin");
    expect(existsSync(join(ROOT, entry.source, ".claude-plugin/plugin.json"))).toBe(true);
    expect(marketplace.name).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
  });

  it("the MCP server and the executable the manifest points at are part of the plugin", () => {
    const mcp = JSON.parse(readFileSync(join(ROOT, "plugin/.mcp.json"), "utf8"));
    expect(mcp.mcpServers.repokit.args[0]).toBe("${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs");
    expect(existsSync(join(ROOT, "plugin/bin/repokit"))).toBe(true);
    expect(readFileSync(join(ROOT, "plugin/bin/repokit"), "utf8").startsWith("#!/usr/bin/env node")).toBe(true);
  });

  it("the skill has a name, a description that fits the listing, and references that exist", () => {
    const skill = readFileSync(join(ROOT, "plugin/skills/readme/SKILL.md"), "utf8");
    // Frontmatter here is flat `key: value` lines, so it is read without a YAML parser.
    const frontmatter = Object.fromEntries(skill.split("---")[1].trim().split(/\r?\n/).map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim().replace(/^"|"$/g, "")]));
    expect(frontmatter.name).toBe("readme");
    expect(frontmatter.description.length).toBeGreaterThan(100);
    expect(frontmatter.description.length).toBeLessThanOrEqual(1536);
    expect(skill.split("\n").length).toBeLessThan(500);
    for (const [, target] of skill.matchAll(/\]\((references\/[^)]+)\)/g)) expect(existsSync(join(ROOT, "plugin/skills/readme", target)), target).toBe(true);
    // The skill tells Claude to call the installed command, never a path inside a checkout.
    expect(skill).not.toContain("packages/cli/dist");
  });

  const claude = spawnSync("claude --version", { shell: true, stdio: "ignore" }).status === 0;
  it.skipIf(!claude)("pass Claude Code's own validation", () => {
    for (const target of [join(ROOT, "plugin"), ROOT.replace(/[\\/]+$/, "")]) {
      const result = spawnSync(`claude plugin validate "${target}"`, { shell: true, encoding: "utf8" });
      expect(result.status, result.stdout + result.stderr).toBe(0);
    }
  }, 120_000);
});

describe.skipIf(!built)("MCP server", () => {
  /** Talk to the server the way a client does: newline-delimited JSON-RPC over stdio. */
  function connect(extraEnv: NodeJS.ProcessEnv = {}, cwd = home) {
    const child = spawn(process.execPath, [join(plugin, "mcp/server.mjs")], { cwd, env: env({ CLAUDE_PROJECT_DIR: project, ...extraEnv }), stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    const waiting = new Map<number, (message: any) => void>();
    const stray: string[] = [];
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        try {
          const message = JSON.parse(line);
          waiting.get(message.id)?.(message);
        } catch {
          stray.push(line);
        }
      }
    });
    let next = 1;
    const request = (method: string, params: unknown = {}) =>
      new Promise<any>((resolve) => {
        const id = next++;
        waiting.set(id, resolve);
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    return {
      request,
      stray,
      close: () => new Promise<void>((done) => {
        child.on("close", () => done());
        child.stdin.end();
      }),
    };
  }
  const payload = (response: any) => response.result.structuredContent;

  it("initializes, lists a small set of tools and keeps stdout to the protocol", async () => {
    const client = connect();
    const init = await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    expect(init.result.serverInfo).toEqual({ name: "repokit", version: VERSION });
    expect(init.result.capabilities.tools).toBeDefined();
    const { tools } = (await client.request("tools/list")).result;
    expect(tools.map((t: { name: string }) => t.name)).toEqual(["analyze_repository", "plan_readme", "audit_readme", "generate_presentation", "capture_demo", "verify_repository", "run_repokit"]);
    for (const tool of tools) expect(tool.inputSchema.type).toBe("object");
    expect(client.stray).toEqual([]);
    await client.close();
  }, 60_000);

  it("works on the project Claude Code is open in, without being told the path", async () => {
    const client = connect();
    await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    const analysed = payload(await client.request("tools/call", { name: "analyze_repository", arguments: {} }));
    expect(analysed.ok).toBe(true);
    expect(analysed.data.repo).toBe(project);
    expect(analysed.data.presentation.projectType).toBe("cli");
    expect(analysed.data.project.commands.run).toContain("wordfreq.py");
    // Read-only: analysing leaves nothing behind in the project.
    expect(Array.isArray(analysed.humanTodo)).toBe(true);

    const audit = payload(await client.request("tools/call", { name: "audit_readme", arguments: {} }));
    expect(audit.data.failedChecks.length).toBeGreaterThan(0);
    expect(audit.data.failedChecks[0]).toHaveProperty("message");
    await client.close();
  }, 120_000);

  it("accepts another repository by path, and reports a missing one as an error, not a crash", async () => {
    const other = join(home, "another one");
    mkdirSync(other);
    writeFileSync(join(other, "main.tf"), 'resource "null_resource" "x" {}\n');
    const client = connect();
    await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    const analysed = payload(await client.request("tools/call", { name: "analyze_repository", arguments: { repo: other } }));
    expect(analysed.data.presentation.projectType).toBe("infrastructure");

    const missing = await client.request("tools/call", { name: "analyze_repository", arguments: { repo: join(home, "nope") } });
    expect(missing.result.isError).toBe(true);
    expect(missing.result.content[0].text).toContain("не найдена");
    // The server is still alive and answering.
    expect((await client.request("ping")).result).toEqual({});
    await client.close();
  }, 120_000);

  it("does not write README.md unless asked to apply, and passes the tool's own guard through", async () => {
    const before = readFileSync(join(project, "README.md"), "utf8");
    const client = connect();
    await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    const preview = payload(await client.request("tools/call", { name: "generate_presentation", arguments: { lang: "en" } }));
    expect(preview.data.written).toBe(false);
    expect(preview.data.diff.length).toBeGreaterThan(0);
    expect(readFileSync(join(project, "README.md"), "utf8")).toBe(before);
    await client.close();
  }, 120_000);

  it("refuses publishing and confirmation flags, unknown services and unknown tools", async () => {
    const client = connect();
    await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    const call = (args: string[]) => client.request("tools/call", { name: "run_repokit", arguments: { args } });
    for (const args of [["deploy", "run"], ["release", "create"], ["readme", "apply", "--confirm"], ["rm", "-rf"], ["scan", "audit", "--repo", "/"]]) {
      const response = await call(args);
      expect(response.result.isError, args.join(" ")).toBe(true);
    }
    const allowed = payload(await call(["diagram", "architecture", "--dry-run"]));
    expect(allowed.exitCode).toBe(0);
    // A failed check is an answer with ok=false, not a protocol error.
    writeFileSync(join(project, "README.md"), readFileSync(join(project, "README.md"), "utf8") + ["", "![Screenshot](docs/missing.png)", ""].join("\n"));
    const failing = await call(["readme", "check"]);
    expect(failing.result.isError).toBe(false);
    expect(payload(failing).exitCode).toBe(1);
    // A command the tool rejects comes back as an error message, and the connection survives.
    const bad = await call(["readme", "no-such-command"]);
    expect(bad.result.isError).toBe(true);
    expect((await client.request("tools/call", { name: "nope", arguments: {} })).error.code).toBe(-32602);
    expect((await client.request("no/such/method")).error.code).toBe(-32601);
    expect(client.stray).toEqual([]);
    await client.close();
  }, 120_000);
});
