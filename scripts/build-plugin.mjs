// Builds the Claude Code plugin in plugin/ from the compiled packages:
//   plugin/lib/repokit.mjs   — the command-line tool as one file, without the media services
//   plugin/mcp/server.mjs    — the MCP server as one file
//   plugin/resources/        — schemas and README templates the tool reads at run time
//   plugin/skills/readme/references/cli-reference.md — generated from the tool's own --help
// and writes the version from the root package.json into the manifests.
// Run `pnpm build` first; `--check` fails if anything in plugin/ would change.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = join(ROOT, "plugin");
const check = process.argv.includes("--check");
const at = (...parts) => join(ROOT, ...parts);
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const changed = [];

function write(file, content) {
  const normalised = content.replace(/\r\n/g, "\n");
  const current = existsSync(file) ? readFileSync(file, "utf8").replace(/\r\n/g, "\n") : null;
  if (current === normalised) return;
  changed.push(file.slice(ROOT.length + 1).split("\\").join("/"));
  if (check) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, normalised);
}

// --- one version for everything
const { version } = json(at("package.json"));
const coreVersion = readFileSync(at("packages/core/src/envelope.ts"), "utf8").match(/export const VERSION = "([^"]+)"/)?.[1];
if (coreVersion !== version) {
  console.error(`Version mismatch: package.json says ${version}, packages/core/src/envelope.ts says ${coreVersion}. Change both.`);
  process.exit(1);
}
const manifestFile = join(PLUGIN, ".claude-plugin/plugin.json");
write(manifestFile, JSON.stringify({ ...json(manifestFile), version }, null, 2) + "\n");

// --- bundles
const banner = { js: 'import { createRequire as __repokitRequire } from "node:module";\nconst require = __repokitRequire(import.meta.url);' };
const common = { bundle: true, platform: "node", format: "esm", target: "node20", legalComments: "none", write: false, logLevel: "warning", charset: "utf8" };
async function bundle(entry, out, external = []) {
  if (!existsSync(entry)) {
    console.error(`${entry} not found — run "pnpm build" first.`);
    process.exit(1);
  }
  const result = await build({ ...common, entryPoints: [entry], outfile: out, external, banner });
  // Paths of the machine that built the file must not leak into it, or the output would differ between machines.
  write(out, result.outputFiles[0].text.replace(/^\/\/ (\.\.\/)*node_modules\/\.pnpm\/.*$/gm, "").replace(/\n{3,}/g, "\n\n"));
}
// The media services need a browser engine and a renderer; they are installed separately by `repokit setup`.
await bundle(at("packages/cli/dist/bin.js"), join(PLUGIN, "lib/repokit.mjs"), ["@repokit/capture", "@repokit/studio", "@repokit/preview"]);
await bundle(at("packages/mcp/dist/server.js"), join(PLUGIN, "mcp/server.mjs"));

// --- data files
function mirror(from, to, filter = () => true) {
  const files = [];
  const walk = (dir, rel) => {
    for (const entry of readdirSorted(dir)) {
      const source = join(dir, entry.name);
      const relative = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(source, relative);
      else if (filter(relative)) files.push(relative);
    }
  };
  walk(from, "");
  for (const file of files) {
    const text = readFileSync(join(from, file), "utf8");
    write(join(to, file), text);
  }
}
import { readdirSync } from "node:fs";
function readdirSorted(dir) {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
}
mirror(at("schemas"), join(PLUGIN, "resources/schemas"), (f) => f.endsWith(".schema.json"));
mirror(at("presets/readme"), join(PLUGIN, "resources/presets/readme"), (f) => /\.(json|md|ya?ml)$/.test(f));

// --- command reference, taken from the tool itself so that it cannot drift
const cli = (args) => spawnSync(process.execPath, [at("packages/cli/dist/bin.js"), ...args], { encoding: "utf8" });
function helpOf(path) {
  const out = cli([...path, "--help"]).stdout;
  const description = out.split(/\r?\n/).slice(2).find((line) => line.trim() && !line.startsWith("Usage")) ?? "";
  const section = (title) => {
    const lines = out.split(/\r?\n/);
    const start = lines.findIndex((line) => line.trim() === `${title}:`);
    if (start === -1) return [];
    const rows = [];
    for (const line of lines.slice(start + 1)) {
      if (!line.trim()) break;
      const match = line.match(/^ {2}(\S.*?) {2,}(.*)$/);
      if (match) rows.push([match[1], match[2]]);
      else if (rows.length) rows[rows.length - 1][1] += " " + line.trim();
    }
    return rows;
  };
  return { description: description.trim(), options: section("Options").filter(([flag]) => !flag.startsWith("-h,")), commands: section("Commands").filter(([name]) => !name.startsWith("help")) };
}
const SHARED = new Set(["--json", "--dry-run", "--repo <path>", "--verbose"]);
const lines = [
  "# Command reference",
  "",
  "Generated from `repokit --help` by `scripts/build-plugin.mjs`; do not edit by hand.",
  "",
  "Every command accepts `--json` (one JSON envelope on stdout), and most accept `--repo <path>` (default: current",
  "directory), `--dry-run` (write nothing) and `--verbose`. Only the other flags are listed below. Descriptions are in",
  "Russian, as the tool prints them.",
  "",
];
const top = helpOf([]);
function describe(path, depth) {
  const help = helpOf(path);
  if (help.commands.length === 0) {
    const flags = help.options.filter(([flag]) => !SHARED.has(flag)).map(([flag, text]) => `  - \`${flag}\` — ${text}`);
    lines.push(`- \`repokit ${path.join(" ")}\` — ${help.description}`, ...flags);
    return;
  }
  if (depth === 0) lines.push(`## ${path.join(" ")}`, "", help.description, "");
  for (const [name] of help.commands) describe([...path, name.split(/[ |]/)[0]], depth + 1);
  if (depth === 0) lines.push("");
}
for (const [name] of top.commands) {
  const service = name.split(/[ |]/)[0];
  const help = helpOf([service]);
  if (help.commands.length === 0) {
    const flags = help.options.filter(([flag]) => !SHARED.has(flag)).map(([flag, text]) => `  - \`${flag}\` — ${text}`);
    lines.push(`## ${service}`, "", `- \`repokit ${name}\` — ${help.description}`, ...flags, "");
  } else describe([service], 0);
}
write(join(PLUGIN, "skills/readme/references/cli-reference.md"), lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n");

// --- stale files from an earlier layout would otherwise ship forever
if (!check && existsSync(join(PLUGIN, "dist"))) rmSync(join(PLUGIN, "dist"), { recursive: true });

if (check && changed.length > 0) {
  console.error(`plugin/ is out of date. Run "pnpm build:plugin" and commit:\n${changed.map((f) => `  ${f}`).join("\n")}`);
  process.exit(1);
}
console.log(check ? "plugin/ is up to date" : changed.length ? `plugin ${version}: updated ${changed.length} file(s)\n${changed.map((f) => `  ${f}`).join("\n")}` : `plugin ${version}: nothing to update`);
