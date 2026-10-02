import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { listFiles, sha256 } from "@repokit/core";
import { analyze, envVarUses } from "@repokit/scan";
import {
  analyzeExisting, auditReadme, bestExample, buildGraph, detectProfile, draftReadme, extractExamples, groupGraph, heroChecks,
  loadContext, planLayout, type AuditCheck, type Options,
} from "../src/index.js";

const created: string[] = [];
afterAll(() => created.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A throwaway repository with exactly these files. */
function repoWith(files: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), "repokit-presentation-"));
  created.push(repo);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  return repo;
}

const auto = (patch: Partial<Options> = {}): Options => ({ preset: "auto", language: "en", ...patch });
const profileOf = (repo: string) => detectProfile(repo, analyze(repo), new Set(listFiles(repo).files.map((f) => f.path)));
const failed = (checks: AuditCheck[]) => checks.filter((c) => !c.ok).map((c) => `${c.category}/${c.id}`);

const LIBRARY = {
  "package.json": JSON.stringify({ name: "tinyslug", version: "1.0.0", description: "Turn a title into a URL slug", main: "index.js", license: "MIT" }),
  "index.js": "export const slug = (text) => text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-');\n",
  "examples/basic.js": "import { slug } from 'tinyslug';\n\nconsole.log(slug('Hello, World'));\n// hello-world\n",
  "LICENSE": "MIT License\n\nCopyright (c) 2026\n",
};

const CLI = {
  "requirements.txt": "click\n",
  "tool.py": [
    "import argparse, os",
    "",
    "def main():",
    "    parser = argparse.ArgumentParser(prog='tool')",
    "    sub = parser.add_subparsers()",
    "    sub.add_parser('sync', help='copy new files to the remote')",
    "    sub.add_parser('status', help='show what would be copied')",
    "    sub.add_parser('clean', help='remove files deleted locally')",
    "    token = os.environ['TOOL_TOKEN']",
    "    region = os.environ.get('TOOL_REGION', 'eu')",
    "",
    "if __name__ == '__main__':",
    "    main()",
    "",
  ].join("\n"),
};

describe("detectProfile", () => {
  it("names the kind of project and the facts behind the decision", () => {
    expect(profileOf(repoWith(LIBRARY)).kind).toBe("library");
    const cli = profileOf(repoWith(CLI));
    expect(cli.kind).toBe("cli");
    expect(cli.signals.length).toBeGreaterThan(0);
    const infra = profileOf(repoWith({ "main.tf": 'resource "null_resource" "x" {}\n' }));
    expect(infra.kind).toBe("infrastructure");
    expect(infra.signals.join(" ")).toContain("main.tf");
  });

  it("does not guess when there is nothing to go on", () => {
    const profile = profileOf(repoWith({ "notes.txt": "hello\n" }));
    expect(profile.kind).toBe("unknown");
    expect(profile.confidence).toBeLessThan(0.6);
  });
});

describe("planLayout", () => {
  it("puts usage before everything else for a library and leaves out what has nothing to show", () => {
    const repo = repoWith(LIBRARY);
    const layout = planLayout(loadContext(repo, auto()), null);
    expect(layout.projectType).toBe("library");
    const kept = layout.sections.filter((s) => s.priority !== "omit").map((s) => s.id);
    expect(kept).toContain("usage");
    expect(kept.indexOf("usage")).toBeLessThan(kept.indexOf("license"));
    expect(layout.usageExamples).toBe(true);
    expect(layout.comparisonTable).toBe(false);
    const omitted = layout.sections.filter((s) => s.priority === "omit");
    expect(omitted.every((s) => s.reason.length > 0)).toBe(true);
    expect(omitted.map((s) => s.id)).toContain("configuration");
  });

  it("keeps only the essential sections in the minimal style", () => {
    const repo = repoWith(CLI);
    const context = loadContext(repo, auto());
    const full = planLayout(context, null).sections.filter((s) => s.priority !== "omit");
    const minimal = planLayout(context, null, "minimal").sections.filter((s) => s.priority !== "omit");
    expect(minimal.length).toBeLessThan(full.length);
    expect(minimal.every((s) => s.priority === "must")).toBe(true);
  });

  it("treats a substantial README as something to improve, not to replace", () => {
    const sections = ["Install", "Usage", "API", "Contributing"].map((h) => `## ${h}\n\n${Array.from({ length: 16 }, (_, i) => `Line ${i} of ${h}.`).join("\n")}\n`);
    const readme = `# tinyslug\n\nTurn a title into a URL slug.\n\n${sections.join("\n")}`;
    const repo = repoWith({ ...LIBRARY, "README.md": readme });
    const layout = planLayout(loadContext(repo, auto()), readme);
    expect(layout.mode).toBe("improve");
    expect(analyzeExisting(readme)!.sections.map((s) => s.slot)).toEqual(["quickstart", "usage", "routes", null]);
    expect(planLayout(loadContext(repo, auto()), "# tinyslug\n\nShort.\n").mode).toBe("generate");
  });
});

describe("draftReadme with the structure chosen by project kind", () => {
  it("shows a real example with its source and a clone step, and invents nothing", () => {
    const repo = repoWith(LIBRARY);
    const { markdown, plan } = draftReadme(repo, auto());
    expect(plan.projectType).toBe("library");
    expect(markdown).toContain("console.log(slug('Hello, World'));");
    expect(markdown).toContain("[`examples/basic.js:1–4`](examples/basic.js#L1-L4)");
    expect(markdown).not.toContain("## Problem");
    expect(markdown).not.toContain("## For judges");
  });

  it("lists commands and environment variables read by the code", () => {
    const repo = repoWith(CLI);
    const { markdown } = draftReadme(repo, auto());
    expect(markdown).toContain("| `sync` | copy new files to the remote |");
    expect(markdown).toContain("## Configuration");
    expect(markdown).toContain("`TOOL_TOKEN`");
    expect(markdown).toMatch(/`TOOL_REGION` \(optional\)/);
  });

  it("leaves a blank, not an invented example, when the repository has none", () => {
    const { markdown, plan } = draftReadme(repoWith({ ...LIBRARY, "examples/basic.js": "" }), auto());
    expect(plan.slots.find((s) => s.id === "usage")?.status).toBe("empty");
    expect(markdown).toContain("<!-- FILL: usage");
  });
});

describe("extractExamples", () => {
  it("copies examples verbatim with the lines they came from", () => {
    const repo = repoWith(LIBRARY);
    const doc = extractExamples(repo, analyze(repo), new Set(listFiles(repo).files.map((f) => f.path)));
    const best = bestExample(doc)!;
    expect(best).toMatchObject({ kind: "example-file", file: "examples/basic.js", lines: [1, 4], language: "js" });
    const lines = readFileSync(join(repo, "examples/basic.js"), "utf8").trimEnd().split("\n");
    expect(best.snippetSha256).toBe(sha256(lines.join("\n")));
  });

  it("does not take a sample project for a usage example", () => {
    const repo = repoWith({ ...LIBRARY, "examples/basic.js": "", "examples/shop/package.json": "{}", "examples/shop/server.js": "const a = 1;\nconsole.log(a);\n" });
    const doc = extractExamples(repo, analyze(repo), new Set(listFiles(repo).files.map((f) => f.path)));
    expect(doc.examples.map((e) => e.file)).not.toContain("examples/shop/server.js");
  });

  it("reads sub-commands from the argument parser", () => {
    const repo = repoWith(CLI);
    const doc = extractExamples(repo, analyze(repo), new Set(listFiles(repo).files.map((f) => f.path)));
    expect(doc.commands.map((c) => c.command)).toEqual(["sync", "status", "clean"]);
    expect(doc.commands[0]).toMatchObject({ description: "copy new files to the remote", file: "tool.py", line: 6 });
  });
});

describe("envVarUses", () => {
  it("finds names only, and tells required from optional", () => {
    expect(envVarUses(repoWith(CLI))).toEqual([
      { name: "TOOL_REGION", file: "tool.py", line: 10, optional: true },
      { name: "TOOL_TOKEN", file: "tool.py", line: 9, optional: false },
    ]);
    const js = envVarUses(repoWith({ "a.js": "const a = process.env.API_KEY;\nconst b = process.env.LOG_LEVEL ?? 'info';\nconst c = process.env.PORT;\n" }));
    expect(js.map((v) => [v.name, v.optional])).toEqual([["API_KEY", false], ["LOG_LEVEL", true]]);
  });
});

describe("auditReadme", () => {
  const audit = (files: Record<string, string>, readme: string) => {
    const repo = repoWith({ ...files, "README.md": readme });
    const context = loadContext(repo, auto());
    return auditReadme(readme, context, planLayout(context, readme));
  };

  it("passes a plain, complete README", () => {
    const readme = [
      "# tinyslug", "", "Turn a title into a URL slug: lowercase, ASCII, words joined by dashes.", "",
      "## Install", "", "```bash", "npm install tinyslug", "```", "",
      "## Usage", "", "```js", "import { slug } from 'tinyslug';", "", "console.log(slug('Hello, World'));", "```", "",
      "## License", "", "[MIT](LICENSE)", "",
    ].join("\n");
    expect(failed(audit(LIBRARY, readme))).toEqual([]);
  });

  it("flags hype, unmeasured claims, badge noise and a missing description", () => {
    const badges = Array.from({ length: 11 }, (_, i) => `![b${i}](https://img.shields.io/badge/x-${i}-blue)`).join(" ");
    const readme = [
      "# tinyslug", "", badges, "",
      "## About", "", "A powerful, revolutionary and blazing fast slug library.", "",
      "## License", "", "MIT", "",
    ].join("\n");
    const checks = audit(LIBRARY, readme);
    expect(failed(checks)).toEqual(expect.arrayContaining([
      "clarity/description", "clarity/hype", "first-viewport/badges", "quick-start/present", "examples/present", "claims/measured",
    ]));
    expect(checks.find((c) => c.id === "badges")!.severity).toBe("error");
    expect(checks.find((c) => c.id === "hype")!.message).toContain("powerful");
  });

  it("accepts a speed claim that comes with a number", () => {
    const readme = "# tinyslug\n\nTurn a title into a URL slug for links and file names.\n\n## Usage\n\n```js\nslug('a')\n```\n\nBlazing fast: 2 ms per 10 000 titles.\n";
    expect(failed(audit(LIBRARY, readme))).not.toContain("claims/measured");
  });

  it("notices environment variables the README does not mention", () => {
    const readme = "# tool\n\nCopies new files to a remote bucket and removes deleted ones.\n\n## Usage\n\n```bash\npython tool.py sync\n```\n";
    const env = audit(CLI, readme).find((c) => c.id === "env")!;
    expect(env).toMatchObject({ ok: false, severity: "error" });
    expect(env.message).toContain("TOOL_TOKEN (tool.py:9)");
    expect(audit(CLI, `${readme}\nSet \`TOOL_TOKEN\` and, if needed, \`TOOL_REGION\`.\n`).find((c) => c.id === "env")!.ok).toBe(true);
  });

  it("checks the first screen on its own", () => {
    const readme = `# tinyslug\n\n## Table of contents\n\n- [Usage](#usage)\n\n## Usage\n\n\`\`\`js\nslug('a')\n\`\`\`\n`;
    const hero = heroChecks(audit(LIBRARY, readme));
    expect(hero.every((c) => c.category === "first-viewport" || c.category === "clarity")).toBe(true);
    expect(failed(hero)).toContain("clarity/description");
  });

  it("reports tables that should be lists and tables too wide to read", () => {
    const readme = "# tinyslug\n\nTurn a title into a URL slug for links and file names.\n\n## Usage\n\n```js\nslug('a')\n```\n\n| Option | Meaning |\n|---|---|\n| a | b |\n\n| 1 | 2 | 3 | 4 | 5 | 6 | 7 |\n|---|---|---|---|---|---|---|\n| a | b | c | d | e | f | g |\n| a | b | c | d | e | f | g |\n| a | b | c | d | e | f | g |\n";
    const tables = audit(LIBRARY, readme).find((c) => c.id === "tables")!;
    expect(tables.ok).toBe(false);
    expect(tables.message).toContain("хватит списка");
    expect(tables.message).toContain("7 колонок");
  });
});

describe("groupGraph", () => {
  it("folds files into directories until the diagram fits, keeping real edges only", () => {
    const files: Record<string, string> = { "package.json": JSON.stringify({ name: "big" }) };
    for (const dir of ["api", "db", "ui"]) {
      for (let i = 0; i < 5; i++) files[`src/${dir}/m${i}.js`] = i === 0 ? "" : `import './m${i - 1}.js';\n`;
    }
    files["src/api/m0.js"] = "import '../db/m4.js';\n";
    files["src/ui/m0.js"] = "import '../api/m4.js';\n";
    const repo = repoWith(files);
    const full = buildGraph(repo, analyze(repo), new Set(listFiles(repo).files.map((f) => f.path)));
    expect(full.nodes.length).toBeGreaterThan(8);
    const grouped = groupGraph(full);
    expect(grouped.nodes.map((n) => n.file)).toEqual(["src/api/", "src/db/", "src/ui/"]);
    expect(grouped.edges.map((e) => `${e.from}>${e.to}`).sort()).toEqual(["src/api/>src/db/", "src/ui/>src/api/"]);
    expect(groupGraph(grouped)).toBe(grouped);
  });

  it("draws a workspace package by package", () => {
    const repo = repoWith({
      "package.json": JSON.stringify({ name: "mono", workspaces: ["packages/*"] }),
      "packages/core/package.json": JSON.stringify({ name: "@mono/core" }),
      "packages/core/src/index.js": "export const a = 1;\n",
      "packages/app/package.json": JSON.stringify({ name: "@mono/app" }),
      "packages/app/src/index.js": "import { a } from '@mono/core';\nconsole.log(a);\n",
    });
    const graph = buildGraph(repo, analyze(repo), new Set(listFiles(repo).files.map((f) => f.path)));
    expect(graph.nodes.map((n) => n.file)).toEqual(["packages/app/", "packages/core/"]);
    expect(graph.edges).toEqual([{ from: "packages/app/", to: "packages/core/", kind: "import" }]);
    expect(graph.entryFiles).toEqual(["packages/app/"]);
  });
});
