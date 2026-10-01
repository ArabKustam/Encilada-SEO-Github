import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { Artifact } from "./envelope.js";
import { UsageError } from "./exit.js";

export const REPOKIT_DIR = ".repokit";

/** Directories never analysed as project source. */
const SKIP_DIRS = new Set([
  ".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build",
  REPOKIT_DIR, ".next", ".pytest_cache", ".mypy_cache",
]);

const MAX_TEXT_BYTES = 512 * 1024;

export interface RepoFile {
  /** POSIX-style path relative to the repository root. */
  path: string;
  size: number;
}

export interface FileListing {
  files: RepoFile[];
  /** Paths tracked by git (including skipped dirs), or null when not a git repo. */
  tracked: string[] | null;
}

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function resolveRepo(path: string): string {
  const repo = resolve(path);
  if (!existsSync(repo) || !statSync(repo).isDirectory()) throw new UsageError(`Папка не найдена: ${path}`);
  return repo;
}

/** Resolve a repo-relative path, refusing anything that escapes the repository. */
export function insideRepo(repo: string, rel: string): string {
  const abs = resolve(repo, rel);
  const back = relative(repo, abs);
  if (back.startsWith("..") || resolve(back) === back) throw new UsageError(`Путь вне репозитория: ${rel}`);
  return abs;
}

function gitList(repo: string, args: string[]): string[] | null {
  try {
    const out = execFileSync("git", ["-C", repo, "ls-files", "-z", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

function walk(repo: string, dir: string, out: string[]): void {
  for (const entry of readdirSync(join(repo, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(repo, rel, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
}

const skipped = (path: string) => path.split("/").some((part) => SKIP_DIRS.has(part));

/** Files of the project: via git (respects .gitignore) when possible, otherwise by walking the tree. */
export function listFiles(repo: string): FileListing {
  const tracked = gitList(repo, ["--cached"]);
  let paths = tracked ? gitList(repo, ["--cached", "--others", "--exclude-standard"]) : null;
  if (!paths) {
    paths = [];
    walk(repo, "", paths);
  }
  const files: RepoFile[] = [];
  for (const path of [...new Set(paths)].sort()) {
    if (skipped(path)) continue;
    const abs = join(repo, path);
    if (!existsSync(abs)) continue;
    const stat = statSync(abs);
    if (stat.isFile()) files.push({ path, size: stat.size });
  }
  return { files, tracked };
}

/** Text content of a repo file, or null when it is missing, too large or binary. */
export function readText(repo: string, rel: string): string | null {
  const abs = join(repo, rel);
  if (!existsSync(abs) || statSync(abs).size > MAX_TEXT_BYTES) return null;
  const buffer = readFileSync(abs);
  if (buffer.includes(0)) return null;
  return buffer.toString("utf8");
}

/**
 * Write a file under `.repokit/`. Idempotent: identical content is not rewritten,
 * and `dryRun` never touches the disk.
 */
export function writeArtifact(repo: string, rel: string, content: string, kind: string, dryRun = false): Artifact {
  const abs = join(repo, REPOKIT_DIR, rel);
  const path = [REPOKIT_DIR, ...rel.split(sep)].join("/");
  const unchanged = existsSync(abs) && readFileSync(abs, "utf8") === content;
  if (dryRun || unchanged) return { path, kind, written: false };
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return { path, kind, written: true };
}

export function readArtifact(repo: string, rel: string): string | null {
  const abs = join(repo, REPOKIT_DIR, rel);
  return existsSync(abs) ? readFileSync(abs, "utf8") : null;
}
