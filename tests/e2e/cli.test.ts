import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { validate } from "../../packages/core/src/index.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BIN = join(ROOT, "packages/cli/dist/bin.js");
// Assembled at run time so that this file stays clean for secret scanners.
const SECRET = ["s3cret", "demo", "password", "value"].join("-");

function repokit(args: string[], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

const repo = mkdtempSync(join(tmpdir(), "repokit-e2e-"));
cpSync(join(ROOT, "examples/web-app"), repo, { recursive: true, filter: (source) => !source.includes(".repokit") });
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("repokit CLI contract", () => {
  it("prints exactly one schema-valid JSON envelope to stdout with --json", () => {
    const { code, stdout, stderr } = repokit(["scan", "audit", "--repo", repo, "--json", "--dry-run"]);
    expect(code).toBe(0);
    const envelope = JSON.parse(stdout);
    expect(validate("envelope", envelope)).toEqual({ valid: true, errors: [] });
    expect(validate("scan", envelope.data).valid).toBe(true);
    expect(stderr).toContain("[scan audit]");
  });

  it("keeps stdout empty without --json", () => {
    expect(repokit(["scan", "audit", "--repo", repo, "--dry-run"]).stdout).toBe("");
  });

  it("writes nothing on --dry-run", () => {
    repokit(["scan", "audit", "--repo", repo, "--dry-run"]);
    repokit(["scan", "init", "--repo", repo, "--dry-run", "--write-gitignore"]);
    expect(existsSync(join(repo, ".repokit"))).toBe(false);
  });

  it("is idempotent: a second run does not rewrite the artifact", () => {
    const first = JSON.parse(repokit(["scan", "audit", "--repo", repo, "--json"]).stdout);
    const second = JSON.parse(repokit(["scan", "audit", "--repo", repo, "--json"]).stdout);
    expect(first.artifacts[0].written).toBe(true);
    expect(second.artifacts[0].written).toBe(false);
    expect(second.data).toEqual(first.data);
  });

  it("exits 2 on usage errors and on services that are not built yet", () => {
    expect(repokit(["scan", "audit", "--no-such-flag"]).code).toBe(2);
    expect(repokit(["scan", "audit", "--repo", join(repo, "missing")]).code).toBe(2);
    expect(repokit(["polish", "plan"]).code).toBe(2);
  });

  it("exits 1 when a claim marked implemented cannot be proven", () => {
    expect(repokit(["scan", "claims", "extract", "--repo", repo]).code).toBe(0);
    const file = join(repo, ".repokit/claims.json");
    const doc = JSON.parse(readFileSync(file, "utf8"));
    doc.claims[2].status = "implemented";
    writeFileSync(file, JSON.stringify(doc));

    const { code, stdout } = repokit(["scan", "claims", "check", "--repo", repo, "--json"]);
    expect(code).toBe(1);
    expect(JSON.parse(stdout).data.failed).toBe(1);
  });

  it("never prints a secret from the environment", () => {
    const leaky = join(repo, SECRET);
    const { stdout, stderr } = repokit(["scan", "audit", "--repo", leaky, "--json"], { DEMO_PASSWORD: SECRET });
    expect(stdout + stderr).not.toContain(SECRET);
    expect(stdout).toContain("[REDACTED]");
  });
});

describe("repokit deploy", () => {
  it("never publishes on a plain invocation: it stops and asks", () => {
    const site = mkdtempSync(join(tmpdir(), "repokit-deploy-cli-"));
    cpSync(join(ROOT, "examples/static-site"), site, { recursive: true });
    try {
      const dry = repokit(["deploy", "apply", "--repo", site, "--dry-run", "--json"]);
      expect(JSON.parse(dry.stdout).data.written).toEqual([".github/workflows/pages.yml"]);
      expect(existsSync(join(site, ".github"))).toBe(false);

      expect(repokit(["deploy", "apply", "--repo", site]).code).toBe(0);
      expect(readFileSync(join(site, ".github/workflows/pages.yml"), "utf8")).toContain("actions/deploy-pages@v4");

      const run = repokit(["deploy", "run", "--repo", site, "--json"]);
      expect(run.code).toBe(3);
      expect(JSON.parse(run.stdout).error.message).toContain("--confirm");
    } finally {
      rmSync(site, { recursive: true, force: true });
    }
  });
});

describe("repokit release", () => {
  it("drafts notes from facts and never publishes without confirmation", () => {
    const project = mkdtempSync(join(tmpdir(), "repokit-release-cli-"));
    cpSync(join(ROOT, "examples/web-app"), project, { recursive: true, filter: (source) => !source.includes(".repokit") && !source.includes("docs") });
    try {
      const planned = repokit(["release", "plan", "--repo", project, "--json"]);
      expect(planned.code).toBe(0);
      expect(JSON.parse(planned.stdout).data.tag).toBe("v0.1.0");
      expect(readFileSync(join(project, ".repokit/release.md"), "utf8")).toContain("## Как запустить");

      const created = repokit(["release", "create", "--repo", project, "--json"]);
      expect(created.code).toBe(3);
      expect(JSON.parse(created.stdout).error.message).toContain("--confirm");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe("repokit run", () => {
  const project = mkdtempSync(join(tmpdir(), "repokit-run-"));
  cpSync(join(ROOT, "examples/web-app"), project, { recursive: true, filter: (source) => !source.includes(".repokit") && !source.includes("docs") });
  afterAll(() => rmSync(project, { recursive: true, force: true }));
  const run = (...args: string[]) => {
    const result = repokit(["run", project, "--json", ...args]);
    return { code: result.code, data: JSON.parse(result.stdout).data, todo: JSON.parse(result.stdout).humanTodo as { id: string; text: string }[] };
  };
  const statuses = (data: { steps: { id: string; status: string }[] }) => Object.fromEntries(data.steps.map((s) => [s.id, s.status]));

  it("does not ask for hackathon rules: without them the step simply does not apply", () => {
    const { code, data, todo } = run();
    expect(code).toBe(3);
    expect(statuses(data)).toMatchObject({ scan: "done", brief: "skipped", claims: "waiting" });
    expect(todo[0].text).toContain("claims.json");
    expect(todo.map((t) => t.id)).not.toContain("run.skipped.brief");
  });

  it("stops until the claims are backed by code", () => {
    const { code, data } = run("--default-brief");
    expect(code).toBe(3);
    expect(statuses(data)).toMatchObject({ scan: "done", brief: "done", claims: "waiting" });
  });

  it("does not write README.md without approval", () => {
    const file = join(project, ".repokit/claims.json");
    const doc = JSON.parse(readFileSync(file, "utf8"));
    Object.assign(doc.claims[0], { status: "implemented", evidence: [{ file: "app/main.py", lines: [44, 47] }] });
    Object.assign(doc.claims[2], { status: "mock", evidence: [{ file: "app/main.py", lines: [65, 68] }] });
    writeFileSync(file, JSON.stringify(doc));
    const before = readFileSync(join(project, "README.md"), "utf8");

    const { code, data, todo } = run("--skip", "demo");
    expect(code).toBe(3);
    expect(statuses(data)).toMatchObject({ claims: "done", demo: "skipped", readme: "waiting", verify: "pending" });
    expect(todo[0].text).toContain("--approve readme");
    expect(readFileSync(join(project, "README.md"), "utf8")).toBe(before);
  });

  it("after approval writes the README, and verification honestly fails on what is still blank", () => {
    const { code, data } = run("--approve", "readme");
    const readme = readFileSync(join(project, "README.md"), "utf8");
    expect(readme).toContain("## Возможности");
    expect(readme).not.toMatch(/Возможности[^#]*Умные подсказки/);
    // No tagline, no license, no hero: the author has not filled these in, so the repository is not ready.
    expect(statuses(data)).toMatchObject({ readme: "done", verify: "failed" });
    expect(code).toBe(1);
  });

  it("passes verification once the author fills in the blanks", () => {
    writeFileSync(join(project, ".repokit/readme.human.yaml"), "tagline: Список задач\nproblem: Нужен общий список.\nsolution: Одна страница.\nskip: [hero, team]\n");
    writeFileSync(join(project, "LICENSE"), "MIT License\n");
    const { code, data, todo } = run("--reset", "--default-brief", "--skip", "demo", "--approve", "readme");
    expect(statuses(data)).toMatchObject({ readme: "done", verify: "done" });
    expect(code).toBe(0);
    // Standing notes survive: the criteria are still an assumption, and the skipped demo is still missing.
    expect(todo.map((t) => t.id)).toEqual(expect.arrayContaining(["brief.default", "run.skipped.demo"]));
  });
});

describe("repokit readme: plan first, then write", () => {
  const project = mkdtempSync(join(tmpdir(), "repokit-layout-"));
  cpSync(join(ROOT, "examples/cli-tool"), project, { recursive: true, filter: (source) => !source.includes(".repokit") });
  afterAll(() => rmSync(project, { recursive: true, force: true }));
  const json = (...args: string[]) => {
    const { code, stdout } = repokit([...args, "--repo", project, "--json"]);
    return { code, envelope: JSON.parse(stdout) };
  };

  it("layout, examples and audit produce schema-valid documents", () => {
    const layout = json("readme", "layout");
    expect(layout.code).toBe(0);
    expect(validate("readme-layout", layout.envelope.data)).toEqual({ valid: true, errors: [] });
    expect(layout.envelope.data.projectType).toBe("cli");
    expect(validate("examples", json("examples", "extract").envelope.data)).toEqual({ valid: true, errors: [] });
    const audit = json("readme", "audit");
    expect(validate("readme-audit", audit.envelope.data)).toEqual({ valid: true, errors: [] });
    expect(json("readme", "hero-check").envelope.data.checks.length).toBeLessThan(audit.envelope.data.checks.length);
  });

  it("builds from an edited layout: a section marked omit is left out", () => {
    const file = join(project, ".repokit/readme.layout.json");
    const layout = JSON.parse(readFileSync(file, "utf8"));
    expect(json("readme", "plan").envelope.data.slots.map((s: { id: string }) => s.id)).toContain("commands");
    layout.sections.find((s: { id: string }) => s.id === "commands").priority = "omit";
    writeFileSync(file, JSON.stringify(layout));
    expect(json("readme", "plan").envelope.data.slots.map((s: { id: string }) => s.id)).not.toContain("commands");
  });

  it("rejects an unknown style", () => {
    expect(repokit(["readme", "plan", "--repo", project, "--style", "glossy"]).code).toBe(2);
  });

  it("does not replace a README somebody wrote unless told to", () => {
    const sections = ["Install", "Usage", "Options", "Contributing"].map((h) => `## ${h}\n\n${Array.from({ length: 16 }, (_, i) => `Line ${i}.`).join("\n")}\n`);
    const own = `# wordfreq\n\nCounts words in a text file.\n\n${sections.join("\n")}`;
    writeFileSync(join(project, "README.md"), own);
    const refused = json("readme", "apply");
    expect(refused.code).toBe(3);
    expect(refused.envelope.humanTodo.map((t: { id: string }) => t.id)).toContain("readme.existing");
    expect(readFileSync(join(project, "README.md"), "utf8")).toBe(own);

    expect(json("readme", "apply", "--regenerate").code).toBe(0);
    expect(readFileSync(join(project, ".repokit/readme.backup.md"), "utf8")).toBe(own);
    // What repokit wrote itself it may rewrite without asking again.
    expect(json("readme", "apply").code).toBe(0);
  });
});

describe("repokit capture terminal", () => {
  const project = mkdtempSync(join(tmpdir(), "repokit-terminal-"));
  afterAll(() => rmSync(project, { recursive: true, force: true }));
  writeFileSync(join(project, "hello.js"), "console.log('\\u001b[32mready\\u001b[0m');\nconsole.log('key ' + process.env.DEMO_API_KEY);\nconsole.error('<done & dusted>');\n");

  it("writes nothing and runs nothing on --dry-run", () => {
    const { code } = repokit(["capture", "terminal", "--repo", project, "--dry-run", "--", "node", "hello.js"]);
    expect(code).toBe(0);
    expect(existsSync(join(project, "docs"))).toBe(false);
  });

  it("records what the command really printed, with secrets masked and provenance kept", () => {
    const { code, stdout } = repokit(["capture", "terminal", "--repo", project, "--json", "--", "node", "hello.js"], { DEMO_API_KEY: SECRET });
    expect(code).toBe(0);
    const { data } = JSON.parse(stdout);
    expect(data).toMatchObject({ command: "node hello.js", exitCode: 0, lines: 3, light: "docs/assets/terminal.svg", dark: "docs/assets/terminal-dark.svg" });
    expect(data.text).toBe("$ node hello.js\nready\nkey [REDACTED]\n<done & dusted>");
    const svg = readFileSync(join(project, "docs/assets/terminal.svg"), "utf8");
    expect(svg).toContain("&lt;done &amp; dusted&gt;");
    expect(svg).not.toContain(SECRET);
    expect(svg).not.toContain("\u001b");
    const manifest = JSON.parse(readFileSync(join(project, ".repokit/media.manifest.json"), "utf8"));
    expect(validate("media-manifest", manifest).valid).toBe(true);
    expect(manifest.media[0]).toMatchObject({ kind: "terminal", command: { line: "node hello.js", exitCode: 0 } });
  });

  it("says so when the command fails, and refuses a command that prints nothing", () => {
    const failing = JSON.parse(repokit(["capture", "terminal", "--repo", project, "--json", "--out", "docs/assets/fail.svg", "--", "node", "-e", "\"console.log(1);process.exit(3)\""]).stdout);
    expect(failing.data.exitCode).toBe(3);
    expect(failing.warnings.join(" ")).toContain("кодом 3");
    expect(repokit(["capture", "terminal", "--repo", project, "--", "node", "-e", "0"]).code).toBe(2);
  });
});

describe("repokit readme audit --fix", () => {
  const project = mkdtempSync(join(tmpdir(), "repokit-fix-"));
  afterAll(() => rmSync(project, { recursive: true, force: true }));
  const original = "# Tool\n\nCounts words in text files and prints the most frequent ones.\n\n\n\n# Usage\n\n#### Options\n\nNone yet.\n";
  writeFileSync(join(project, "README.md"), original);

  it("shows the repairs on --dry-run and makes them without it, keeping the previous version", () => {
    const dry = JSON.parse(repokit(["readme", "audit", "--fix", "--dry-run", "--repo", project, "--json"]).stdout);
    expect(dry.data.fixes).toHaveLength(3);
    expect(readFileSync(join(project, "README.md"), "utf8")).toBe(original);

    repokit(["readme", "audit", "--fix", "--repo", project, "--json"]);
    expect(readFileSync(join(project, "README.md"), "utf8")).toBe("# Tool\n\nCounts words in text files and prints the most frequent ones.\n\n## Usage\n\n### Options\n\nNone yet.\n");
    expect(readFileSync(join(project, ".repokit/readme.backup.md"), "utf8")).toBe(original);
    const again = JSON.parse(repokit(["readme", "audit", "--fix", "--repo", project, "--json"]).stdout);
    expect(again.data.fixes).toEqual([]);
    expect(again.data.checks.find((c: { id: string }) => c.id === "hierarchy").ok).toBe(true);
  });
});
