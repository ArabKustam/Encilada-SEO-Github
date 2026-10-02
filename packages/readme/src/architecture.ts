import { posix } from "node:path";
import { readText } from "@repokit/core";
import type { ScanResult } from "@repokit/scan";

const CODE_EXT = new Set([".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const JS_RESOLVE = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.js"];
const MAX_NODES = 12;
const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|(^|\/)test_[^/]+\.py$|\.(test|spec)\.[jt]sx?$/;
/** Sample projects and fixtures shipped next to the code are not part of how it works. */
const ASIDE = /^(examples?|demos?|samples?|fixtures?)\//i;
const WORKSPACE_MANIFEST = /^(packages|apps|libs|services)\/[^/]+\/package\.json$/;

export interface Graph {
  /** `files` is set on a block that stands for a whole directory. */
  nodes: { file: string; routes: number; models: number; entry: boolean; files?: number }[];
  edges: { from: string; to: string; kind: "import" | "http" }[];
  /** Files a user reaches first: the UI that calls the API, or the routes themselves. */
  entryFiles: string[];
}

function pythonImports(file: string, text: string, files: Set<string>): string[] {
  const dir = posix.dirname(file);
  const found: string[] = [];
  const resolveModule = (base: string, module: string) => {
    const path = posix.normalize(posix.join(base, module.split(".").join("/")));
    for (const candidate of [`${path}.py`, `${path}/__init__.py`]) if (files.has(candidate)) found.push(candidate);
  };
  for (const line of text.split(/\r?\n/)) {
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^\s*from\s+(\.+)([\w.]*)\s+import\s+(.+)$/))) {
      const base = posix.join(dir, "../".repeat(m[1].length - 1));
      if (m[2]) resolveModule(base, m[2]);
      // `from . import store` names modules after the import keyword.
      else for (const name of m[3].split(",")) resolveModule(base, name.trim().split(/\s+/)[0]);
    } else if ((m = line.match(/^\s*(?:from|import)\s+([\w.]+)/))) {
      resolveModule(".", m[1]);
    }
  }
  return found;
}

function jsImports(file: string, text: string, files: Set<string>): string[] {
  const dir = posix.dirname(file);
  const found: string[] = [];
  for (const m of text.matchAll(/(?:from\s+|import\s+|require\(\s*|import\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
    const base = posix.normalize(posix.join(dir, m[1]));
    const hit = JS_RESOLVE.map((suffix) => base + suffix).find((candidate) => files.has(candidate));
    if (hit) found.push(hit);
  }
  return found;
}

/** Literal request paths in client code: fetch("/api/x"), axios.get(`/api/x/${id}`). */
function requestedPaths(text: string): string[] {
  return [...text.matchAll(/(?:fetch|axios(?:\.\w+)?|api)\(\s*["'`](\/[^"'`$?]*)/g)].map((m) => m[1]);
}

const staticPrefix = (routePath: string) => routePath.split(/[{:<]/)[0];

/** In a workspace the picture is packages and which of them imports which. */
function packageGraph(repo: string, scan: ScanResult, files: Set<string>, sources: string[]): Graph | null {
  const dirs = new Map<string, string>();
  for (const manifest of files) {
    if (!WORKSPACE_MANIFEST.test(manifest)) continue;
    try {
      const name = JSON.parse(readText(repo, manifest) ?? "{}").name;
      if (typeof name === "string") dirs.set(name, manifest.replace(/package\.json$/, ""));
    } catch {
      // A manifest that does not parse names no package.
    }
  }
  if (dirs.size < 2) return null;
  const owner = (file: string) => [...dirs.values()].find((dir) => file.startsWith(dir));
  const count = (items: { file: string }[], dir: string) => items.filter((i) => i.file.startsWith(dir)).length;
  const edges: Graph["edges"] = [];
  const used = new Map<string, number>();
  for (const file of sources) {
    const from = owner(file);
    const text = from ? readText(repo, file) : null;
    if (!from || text === null) continue;
    used.set(from, (used.get(from) ?? 0) + 1);
    for (const m of text.matchAll(/(?:from\s+|require\(\s*|import\(\s*)["'](@?[\w.-]+(?:\/[\w.-]+)?)/g)) {
      const to = dirs.get(m[1]);
      if (to && to !== from && !edges.some((e) => e.from === from && e.to === to)) edges.push({ from, to, kind: "import" });
    }
  }
  const imported = new Set(edges.map((e) => e.to));
  const nodes = [...used.keys()].sort().map((dir) => ({
    file: dir,
    routes: count(scan.routes.filter((r) => r.framework !== "static"), dir),
    models: count(scan.models, dir),
    entry: scan.entrypoints.some((e) => e.file.startsWith(dir)),
    files: used.get(dir)!,
  }));
  // What nothing else imports is where a user comes in: the application or the command-line tool.
  const roots = nodes.filter((n) => !imported.has(n.file) && edges.some((e) => e.from === n.file)).map((n) => n.file);
  return { nodes, edges, entryFiles: roots.slice(0, 2) };
}

/** Which source files import or call which, derived from the code itself. */
export function buildGraph(repo: string, scan: ScanResult, files: Set<string>): Graph {
  const sources = [...files].filter((f) => CODE_EXT.has(posix.extname(f)) && !TEST_FILE.test(f) && !ASIDE.test(f));
  const packages = packageGraph(repo, scan, files, sources);
  if (packages) return packages;
  const routesBy = new Map<string, number>();
  for (const route of scan.routes) if (route.framework !== "static") routesBy.set(route.file, (routesBy.get(route.file) ?? 0) + 1);
  const modelsBy = new Map<string, number>();
  for (const model of scan.models) modelsBy.set(model.file, (modelsBy.get(model.file) ?? 0) + 1);
  const entries = new Set(scan.entrypoints.map((e) => e.file));

  const edges: Graph["edges"] = [];
  const add = (from: string, to: string, kind: "import" | "http") => {
    if (from !== to && !edges.some((e) => e.from === from && e.to === to)) edges.push({ from, to, kind });
  };
  for (const file of sources) {
    const text = readText(repo, file);
    if (text === null) continue;
    const imports = file.endsWith(".py") ? pythonImports(file, text, files) : jsImports(file, text, files);
    for (const target of imports) if (!TEST_FILE.test(target)) add(file, target, "import");
    if (!file.endsWith(".py") && !routesBy.has(file)) {
      for (const path of requestedPaths(text)) {
        const route = scan.routes.find((r) => r.framework !== "static" && staticPrefix(r.path).length > 1 && path.startsWith(staticPrefix(r.path)));
        if (route) add(file, route.file, "http");
      }
    }
  }

  const connected = new Set(edges.flatMap((e) => [e.from, e.to]));
  const interesting = sources.filter((f) => connected.has(f) || routesBy.has(f) || entries.has(f));
  const rank = (f: string) => (routesBy.get(f) ?? 0) * 10 + (modelsBy.get(f) ?? 0) * 3 + (entries.has(f) ? 5 : 0) + (connected.has(f) ? 1 : 0);
  const kept = new Set(interesting.sort((a, b) => rank(b) - rank(a) || a.localeCompare(b)).slice(0, MAX_NODES));

  const keptEdges = edges.filter((e) => kept.has(e.from) && kept.has(e.to));
  const clients = [...new Set(keptEdges.filter((e) => e.kind === "http").map((e) => e.from))];
  const entryFiles = clients.length > 0 ? clients : [...kept].filter((f) => routesBy.has(f) || entries.has(f)).slice(0, 2);
  return {
    nodes: [...kept].sort().map((file) => ({ file, routes: routesBy.get(file) ?? 0, models: modelsBy.get(file) ?? 0, entry: entries.has(file) })),
    edges: keptEdges,
    entryFiles,
  };
}

/** A diagram explains with five to ten blocks; beyond that it is a map nobody reads. */
export const MAX_BLOCKS = 8;

/**
 * Fold files into their directories until the diagram fits. Nothing is invented:
 * a block is a directory that exists, an arrow is at least one real import or request.
 */
export function groupGraph(graph: Graph, max = MAX_BLOCKS): Graph {
  if (graph.nodes.length <= max) return graph;
  const deepest = Math.max(...graph.nodes.map((n) => n.file.split("/").length - 1));
  let group = (file: string) => file;
  for (let depth = deepest; depth >= 1; depth--) {
    // Files above the cut stay themselves; everything at or below it becomes its directory.
    const candidate = (file: string) => {
      const parts = file.split("/");
      return parts.length - 1 < depth ? file : `${parts.slice(0, depth).join("/")}/`;
    };
    const size = new Set(graph.nodes.map((n) => candidate(n.file))).size;
    // Folding everything into one or two blocks explains nothing: better to keep the busiest.
    if (size < 3) break;
    group = candidate;
    if (size <= max) break;
  }
  const blocks = new Map<string, Graph["nodes"][number]>();
  for (const node of graph.nodes) {
    const key = group(node.file);
    const block: Graph["nodes"][number] = blocks.get(key) ?? { file: key, routes: 0, models: 0, entry: false, ...(key.endsWith("/") ? { files: 0 } : {}) };
    block.routes += node.routes;
    block.models += node.models;
    block.entry ||= node.entry;
    if (block.files !== undefined) block.files += node.files ?? 1;
    blocks.set(key, block);
  }
  const edges: Graph["edges"] = [];
  for (const edge of graph.edges) {
    const from = group(edge.from);
    const to = group(edge.to);
    const same = edges.find((e) => e.from === from && e.to === to);
    if (from === to) continue;
    if (!same) edges.push({ from, to, kind: edge.kind });
    else if (edge.kind === "http") same.kind = "http";
  }
  // The busiest blocks win when even top-level directories are too many.
  const weight = (file: string) => edges.filter((e) => e.from === file || e.to === file).length;
  const kept = new Set([...blocks.keys()].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b)).slice(0, max));
  return {
    nodes: [...blocks.values()].filter((n) => kept.has(n.file)).sort((a, b) => a.file.localeCompare(b.file)),
    edges: edges.filter((e) => kept.has(e.from) && kept.has(e.to)),
    entryFiles: [...new Set(graph.entryFiles.map(group))].filter((f) => kept.has(f)),
  };
}

export function mermaid(graph: Graph, phrases: Record<string, string>): string {
  const id = new Map(graph.nodes.map((node, index) => [node.file, `n${index}`]));
  const lines = ["flowchart LR", `  user(["${phrases.userNode}"])`];
  for (const node of graph.nodes) {
    const facts = [
      node.files ? phrases.filesCount.replace("{n}", String(node.files)) : "",
      node.routes > 0 ? phrases.routesCount.replace("{n}", String(node.routes)) : "",
      node.models > 0 ? phrases.modelsCount.replace("{n}", String(node.models)) : "",
    ].filter(Boolean).join(" · ");
    lines.push(`  ${id.get(node.file)}["${node.file}${facts ? `<br/>${facts}` : ""}"]`);
  }
  for (const file of graph.entryFiles) lines.push(`  user --> ${id.get(file)}`);
  for (const edge of graph.edges) lines.push(`  ${id.get(edge.from)} ${edge.kind === "http" ? "-- HTTP -->" : "-->"} ${id.get(edge.to)}`);
  return lines.join("\n");
}
