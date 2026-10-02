import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import {
  diffStats, fileSha256, formatDiff, insideRepo, lineDiff, listFiles, readManifest, validate, writeArtifact,
} from "@repokit/core";
import { AUTO_PRESET, draftReadme, HUMAN_FILE, listReadmePresets, loadHuman, loadOptions, renderTodo, writeReadme, type Human, type Options } from "@repokit/readme";
import { renderPage, REPO_PREFIX, type Theme } from "./render.js";

const require = createRequire(import.meta.url);
const UI_FILE = fileURLToPath(new URL("../ui/index.html", import.meta.url));
const HOST = "127.0.0.1";
const MAX_BODY_BYTES = 256 * 1024;
const MAX_SNIPPET_LINES = 30;
const WATCH_DEBOUNCE_MS = 150;
/** Changes in these places never affect what the preview shows. */
const WATCH_IGNORE = /(^|[\\/])(\.git|node_modules|__pycache__|\.venv)([\\/]|$)|\.repokit[\\/](logs|capture|out|readme\.(draft|backup)\.md|readme\.plan\.json|human-todo\.md)/;

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".mp4": "video/mp4", ".webm": "video/webm",
};
const MEDIA_EXT = new Set(Object.keys(CONTENT_TYPES));

/** Files from installed packages that the preview page loads; never from a CDN. */
const VENDOR: Record<string, { file: () => string; type: string }> = {
  "mermaid.min.js": { file: () => join(require.resolve("mermaid/package.json"), "../dist/mermaid.min.js"), type: "text/javascript" },
  "github-markdown-light.css": { file: () => require.resolve("github-markdown-css/github-markdown-light.css"), type: "text/css" },
  "github-markdown-dark.css": { file: () => require.resolve("github-markdown-css/github-markdown-dark.css"), type: "text/css" },
};

export interface PreviewServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

function send(res: ServerResponse, status: number, body: string | Buffer, type = "text/plain; charset=utf-8"): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(body);
}

const sendJson = (res: ServerResponse, status: number, value: unknown) => send(res, status, JSON.stringify(value), "application/json; charset=utf-8");

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function optionsFor(repo: string, preset: string | null): Options {
  const saved = loadOptions(repo);
  return preset ? { ...saved, preset } : saved;
}

/** Everything the side panel shows, as data: also what `preview check --json` builds on. */
export function previewState(repo: string, preset: string | null) {
  const options = optionsFor(repo, preset);
  const draft = draftReadme(repo, options);
  const diff = lineDiff(draft.current ?? "", draft.markdown);
  const provenance = new Map(readManifestSafe(repo).map((m) => [m.sha256, m]));

  const claims = draft.context.claims.map((claim) => ({
    ...claim,
    evidence: claim.evidence.map((evidence) => {
      const lines = readFileSync(join(repo, evidence.file), "utf8").split(/\r?\n/);
      const [from, to] = evidence.lines;
      return { ...evidence, snippet: lines.slice(from - 1, Math.min(to, from - 1 + MAX_SNIPPET_LINES)).join("\n") };
    }),
  }));

  const referenced = new Set([...draft.markdown.matchAll(/(?:src|srcset)="([^"]+)"|!\[[^\]]*\]\(([^)\s]+)/g)].map((m) => m[1] ?? m[2]));
  const media = [...referenced]
    .filter((path) => MEDIA_EXT.has(extname(path).toLowerCase()) && existsSync(join(repo, path)))
    .map((path) => {
      const entry = provenance.get(fileSha256(join(repo, path)));
      return { path, bytes: statSync(join(repo, path)).size, provenance: entry ? entry.tool.name : null, demoData: Boolean(entry?.demoData) };
    });

  return {
    options,
    presets: [
      { name: AUTO_PRESET, title: "По типу проекта", description: "структура выбирается по тому, что это за проект" },
      ...listReadmePresets().map((p) => ({ name: p.name, title: p.title, description: p.description })),
    ],
    hasReadme: draft.current !== null,
    plan: draft.plan,
    staleClaims: draft.context.staleClaims,
    claims,
    media,
    human: loadHuman(repo),
    brief: draft.context.brief ? { isDefaultProfile: draft.context.brief.isDefaultProfile, criteria: draft.context.brief.criteria.length } : null,
    diff: { ...diffStats(diff), text: formatDiff(diff) },
    draft,
  };
}

function readManifestSafe(repo: string) {
  try {
    return readManifest(repo).media;
  } catch {
    return [];
  }
}

export async function startPreviewServer(repo: string, port: number): Promise<PreviewServer> {
  const token = randomBytes(16).toString("hex");
  const clients = new Set<ServerResponse>();

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Reject requests addressed to any other name: a web page cannot reach this server through DNS tricks.
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (host !== HOST && host !== "localhost") return send(res, 403, "forbidden");
    const url = new URL(req.url ?? "/", `http://${HOST}`);
    const path = decodeURIComponent(url.pathname);
    const preset = url.searchParams.get("preset");

    if (req.method === "POST") {
      // Only the page served by this process may change files: it alone knows the token.
      if (req.headers["x-repokit-token"] !== token) return send(res, 403, "forbidden");
      const body = JSON.parse((await readBody(req)) || "{}");
      if (path === "/api/human") {
        const human: Human = Object.fromEntries(Object.entries(body).filter(([, value]) => value !== "" && value !== null && !(Array.isArray(value) && value.length === 0)));
        const result = validate("readme-human", human);
        if (!result.valid) return sendJson(res, 400, { errors: result.errors });
        writeArtifact(repo, HUMAN_FILE, stringify(human), "readme-human");
        return sendJson(res, 200, { ok: true });
      }
      if (path === "/api/apply") {
        const options = optionsFor(repo, typeof body.preset === "string" ? body.preset : null);
        const draft = draftReadme(repo, options);
        writeReadme(repo, draft);
        writeArtifact(repo, "readme.options.json", JSON.stringify(options, null, 2) + "\n", "readme-options");
        writeArtifact(repo, "human-todo.md", renderTodo(draft.plan.humanTodo), "human-todo");
        return sendJson(res, 200, { ok: true });
      }
      return send(res, 404, "not found");
    }
    if (req.method !== "GET") return send(res, 405, "method not allowed");

    if (path === "/") return send(res, 200, readFileSync(UI_FILE, "utf8").replace("__REPOKIT_TOKEN__", token), "text/html; charset=utf-8");

    if (path === "/view") {
      const theme: Theme = url.searchParams.get("theme") === "dark" ? "dark" : "light";
      const state = previewState(repo, preset);
      const source = url.searchParams.get("source") === "current" ? state.draft.current ?? "" : state.draft.markdown;
      return send(res, 200, renderPage(source, { theme, title: "README.md" }), "text/html; charset=utf-8");
    }

    if (path === "/api/state") {
      const { draft: _, ...state } = previewState(repo, preset);
      return sendJson(res, 200, state);
    }

    if (path === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(": connected\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    if (path.startsWith("/vendor/")) {
      const asset = VENDOR[path.slice("/vendor/".length)];
      return asset ? send(res, 200, readFileSync(asset.file()), asset.type) : send(res, 404, "not found");
    }

    if (path.startsWith(REPO_PREFIX)) {
      const relative = path.slice(REPO_PREFIX.length);
      // Only files that belong to the project are served: nothing ignored, nothing outside the repository.
      const known = new Set(listFiles(repo).files.map((f) => f.path));
      if (!known.has(relative)) return send(res, 404, "not found");
      const file = insideRepo(repo, relative);
      const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? "text/plain; charset=utf-8";
      return send(res, 200, readFileSync(file), type);
    }
    return send(res, 404, "not found");
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: Error) => {
      if (!res.headersSent) send(res, 500, error.message);
      else res.end();
    });
  });

  let timer: NodeJS.Timeout | null = null;
  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(repo, { recursive: true }, (_, filename) => {
      if (!filename || WATCH_IGNORE.test(filename.toString())) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        for (const client of clients) client.write("event: change\ndata: {}\n\n");
      }, WATCH_DEBOUNCE_MS);
    });
  } catch {
    // Recursive watching is unavailable on some platforms; the page still has a manual refresh.
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, resolve);
  });
  const actualPort = (server.address() as AddressInfo).port;
  return {
    url: `http://${HOST}:${actualPort}`,
    port: actualPort,
    close: () =>
      new Promise((resolve) => {
        watcher?.close();
        for (const client of clients) client.end();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
