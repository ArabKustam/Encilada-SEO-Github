import { posix } from "node:path";
import { readText } from "@repokit/core";
import type { ScanResult } from "@repokit/scan";

const CODE_EXT = new Set([".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const JS_RESOLVE = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.js"];
const MAX_NODES = 12;
const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|(^|\/)test_[^/]+\.py$|\.(test|spec)\.[jt]sx?$/;

export interface Graph {
  nodes: { file: string; routes: number; models: number; entry: boolean }[];
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
  for (const m of text.matchAll(/(?:from\s+|require\(\s*|import\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
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

/** Which source files import or call which, derived from the code itself. */
export function buildGraph(repo: string, scan: ScanResult, files: Set<string>): Graph {
  const sources = [...files].filter((f) => CODE_EXT.has(posix.extname(f)) && !TEST_FILE.test(f));
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

export function mermaid(graph: Graph, phrases: Record<string, string>): string {
  const id = new Map(graph.nodes.map((node, index) => [node.file, `n${index}`]));
  const lines = ["flowchart LR", `  user(["${phrases.userNode}"])`];
  for (const node of graph.nodes) {
    const facts = [
      node.routes > 0 ? phrases.routesCount.replace("{n}", String(node.routes)) : "",
      node.models > 0 ? phrases.modelsCount.replace("{n}", String(node.models)) : "",
    ].filter(Boolean).join(" · ");
    lines.push(`  ${id.get(node.file)}["${node.file}${facts ? `<br/>${facts}` : ""}"]`);
  }
  for (const file of graph.entryFiles) lines.push(`  user --> ${id.get(file)}`);
  for (const edge of graph.edges) lines.push(`  ${id.get(edge.from)} ${edge.kind === "http" ? "-- HTTP -->" : "-->"} ${id.get(edge.to)}`);
  return lines.join("\n");
}
