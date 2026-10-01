import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { REPOKIT_DIR, sha256 } from "./files.js";
import { assertValid } from "./schema.js";

const MANIFEST_FILE = "media.manifest.json";

/** Where a media file came from. Every screenshot and video repokit produces gets one. */
export interface MediaEntry {
  /** POSIX path relative to the repository root. */
  path: string;
  sha256: string;
  kind: "video" | "screenshot" | "events" | "render" | "gif" | "webp" | "poster";
  createdAt: string;
  tool: { name: string; version: string; browser?: string };
  /** Present on recordings of the real application. */
  source?: {
    runId: string;
    scenario: string;
    scenarioSha256: string;
    baseUrl: string;
    targetCommit: string | null;
    targetDirty: boolean;
  };
  /** Hashes of the media this file was produced from. */
  derivedFrom?: string[];
  masks?: string[];
  demoData?: boolean;
}

export interface MediaManifest {
  schemaVersion: 1;
  media: MediaEntry[];
}

const manifestPath = (repo: string) => join(repo, REPOKIT_DIR, MANIFEST_FILE);

export const repoRelative = (repo: string, abs: string) => relative(repo, abs).split("\\").join("/");

export function readManifest(repo: string): MediaManifest {
  const file = manifestPath(repo);
  if (!existsSync(file)) return { schemaVersion: 1, media: [] };
  const manifest = JSON.parse(readFileSync(file, "utf8")) as MediaManifest;
  assertValid("media-manifest", manifest);
  return manifest;
}

/** Add or replace entries (matched by path) and save the manifest. */
export function recordMedia(repo: string, entries: MediaEntry[]): void {
  const manifest = readManifest(repo);
  const replaced = new Set(entries.map((e) => e.path));
  manifest.media = [...manifest.media.filter((e) => !replaced.has(e.path)), ...entries];
  assertValid("media-manifest", manifest);
  mkdirSync(dirname(manifestPath(repo)), { recursive: true });
  writeFileSync(manifestPath(repo), JSON.stringify(manifest, null, 2) + "\n");
}

export function fileSha256(abs: string): string {
  return sha256(readFileSync(abs));
}

/** Manifest entry for a file with this exact content, if repokit produced it. */
export function findProvenance(repo: string, abs: string): MediaEntry | null {
  const hash = fileSha256(abs);
  return readManifest(repo).media.find((e) => e.sha256 === hash) ?? null;
}
