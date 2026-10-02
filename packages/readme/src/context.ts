import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { loadBrief, type Brief } from "@repokit/brief";
import {
  assertValid, listFiles, readArtifact, readManifest, README_SLOTS, REPOKIT_DIR, UsageError,
  type MediaManifest, type ReadmeSlotId,
} from "@repokit/core";
import { analyze, checkClaims, type ClaimsDoc, type ScanResult } from "@repokit/scan";

/** `presets/readme/` at the repository root. */
const PRESETS_DIR = fileURLToPath(new URL("../../../presets/readme/", import.meta.url));

export const LANGUAGES = ["ru", "en"] as const;
export type Language = (typeof LANGUAGES)[number];

export const HUMAN_FILE = "readme.human.yaml";
export const OPTIONS_FILE = "readme.options.json";

/** Things only a person can decide; repokit never invents them. */
export interface Human {
  title?: string;
  tagline?: string;
  problem?: string;
  solution?: string;
  demoUrl?: string;
  videoUrl?: string;
  heroAlt?: string;
  team?: { name: string; role?: string; link?: string }[];
  roadmap?: string[];
  /** Technologies repokit could not detect on its own. */
  stack?: string[];
  /** Slots the author chose to leave out. */
  skip?: string[];
}

export interface Options {
  preset: string;
  language: Language;
  hero?: string;
  heroDark?: string;
  /** A banner image shown above the title. */
  banner?: string;
}

export const DEFAULT_OPTIONS: Options = { preset: "showcase", language: "ru" };

export interface I18n {
  headings: Record<string, string>;
  phrases: Record<string, string>;
}

export interface TemplateSlot {
  id: ReadmeSlotId;
  /** Flags and key=value options from the template line, e.g. `collapsible`, `variant=centered`. */
  options: Record<string, string>;
}

export interface ReadmePreset {
  name: string;
  title: string;
  description: string;
  required: ReadmeSlotId[];
  slots: TemplateSlot[];
}

export interface Context {
  repo: string;
  scan: ScanResult;
  /** Claims whose evidence still checks out; everything else is reported, not published. */
  claims: ClaimsDoc["claims"];
  staleClaims: string[];
  brief: Brief | null;
  human: Human;
  options: Options;
  manifest: MediaManifest;
  github: { owner: string; repo: string } | null;
  license: { file: string; name: string | null } | null;
  files: Set<string>;
  workflows: string[];
  /** A deployment that answered the last time `deploy check` ran. */
  deployment: { url: string; sleeps: boolean } | null;
  i18n: I18n;
  allHeadings: Set<string>;
}

const LICENSE_SIGNATURES: [RegExp, string][] = [
  [/MIT License|Permission is hereby granted, free of charge/i, "MIT"],
  [/Apache License\s+Version 2\.0/i, "Apache-2.0"],
  [/GNU AFFERO GENERAL PUBLIC LICENSE/i, "AGPL-3.0"],
  [/GNU GENERAL PUBLIC LICENSE\s+Version 3/i, "GPL-3.0"],
  [/GNU GENERAL PUBLIC LICENSE\s+Version 2/i, "GPL-2.0"],
  [/BSD 3-Clause|Redistributions in binary form[\s\S]*Neither the name/i, "BSD-3-Clause"],
  [/Mozilla Public License Version 2\.0/i, "MPL-2.0"],
  [/The Unlicense|This is free and unencumbered software/i, "Unlicense"],
];

function loadI18n(language: Language): I18n {
  return parse(readFileSync(join(PRESETS_DIR, "_i18n", `${language}.yaml`), "utf8")) as I18n;
}

const TEMPLATE_LINE = /^\{\{\s*([a-z]+)((?:\s+[a-z]+(?:=[\w-]+)?)*)\s*\}\}$/;

export function listReadmePresets(): ReadmePreset[] {
  return readdirSync(PRESETS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => {
      const dir = join(PRESETS_DIR, entry.name);
      const meta = JSON.parse(readFileSync(join(dir, "preset.json"), "utf8"));
      const slots: TemplateSlot[] = [];
      for (const line of readFileSync(join(dir, "template.md"), "utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        const match = line.trim().match(TEMPLATE_LINE);
        if (!match || !README_SLOTS.includes(match[1] as ReadmeSlotId)) throw new Error(`presets/readme/${entry.name}/template.md: непонятная строка «${line}»`);
        const options = Object.fromEntries(match[2].trim().split(/\s+/).filter(Boolean).map((part) => part.split("=")).map(([key, value]) => [key, value ?? "true"]));
        slots.push({ id: match[1] as ReadmeSlotId, options });
      }
      return { name: meta.name, title: meta.title, description: meta.description, required: meta.required, slots };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function findReadmePreset(name: string): ReadmePreset {
  const presets = listReadmePresets();
  const preset = presets.find((p) => p.name === name);
  if (!preset) throw new UsageError(`Пресет README «${name}» не найден. Доступны: ${presets.map((p) => p.name).join(", ")}`);
  return preset;
}

export function loadHuman(repo: string): Human {
  const text = readArtifact(repo, HUMAN_FILE);
  if (text === null) return {};
  let human: Human;
  try {
    human = parse(text) ?? {};
  } catch (error) {
    throw new UsageError(`${REPOKIT_DIR}/${HUMAN_FILE}: ошибка YAML — ${(error as Error).message}`);
  }
  // Empty YAML values come back as null; treat them as "not filled in".
  human = Object.fromEntries(Object.entries(human).filter(([, value]) => value !== null && value !== "")) as Human;
  assertValid("readme-human", human);
  return human;
}

export function loadOptions(repo: string): Options {
  const text = readArtifact(repo, OPTIONS_FILE);
  return text === null ? { ...DEFAULT_OPTIONS } : { ...DEFAULT_OPTIONS, ...JSON.parse(text) };
}

function loadDeployment(repo: string): Context["deployment"] {
  const text = readArtifact(repo, "deploy.json");
  if (!text) return null;
  const record = JSON.parse(text) as { url: string; healthy: boolean; sleeps: boolean };
  return record.healthy ? { url: record.url, sleeps: record.sleeps } : null;
}

function githubRemote(repo: string): Context["github"] {
  try {
    const url = execFileSync("git", ["-C", repo, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const match = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    return match ? { owner: match[1], repo: match[2] } : null;
  } catch {
    return null;
  }
}

/** Everything a README is built from. Nothing here is generated text: only facts and the author's own words. */
export function loadContext(repo: string, options: Options): Context {
  if (!LANGUAGES.includes(options.language)) throw new UsageError(`Язык «${options.language}» не поддерживается. Доступны: ${LANGUAGES.join(", ")}`);
  const scan = analyze(repo);
  const files = new Set(listFiles(repo).files.map((f) => f.path));

  const claimsText = readArtifact(repo, "claims.json");
  const claimsDoc: ClaimsDoc | null = claimsText ? JSON.parse(claimsText) : null;
  if (claimsDoc) assertValid("claims", claimsDoc);
  const failed = new Map((claimsDoc ? checkClaims(repo, claimsDoc) : []).filter((c) => !c.ok).map((c) => [c.claimId, c.problems]));
  const claims = (claimsDoc?.claims ?? []).filter((c) => !failed.has(c.id));
  const staleClaims = [...failed].map(([id, problems]) => `${id}: ${problems.join("; ")}`);

  const licenseFile = [...files].find((f) => /^(licen[sc]e|copying)(\.[^/]*)?$/i.test(f));
  const licenseText = licenseFile ? readFileSync(join(repo, licenseFile), "utf8").slice(0, 4000) : "";
  const license = licenseFile ? { file: licenseFile, name: LICENSE_SIGNATURES.find(([pattern]) => pattern.test(licenseText))?.[1] ?? null } : null;

  const allHeadings = new Set(LANGUAGES.flatMap((language) => Object.values(loadI18n(language).headings)).map((h) => h.toLowerCase()));
  return {
    repo, scan, claims, staleClaims,
    brief: loadBrief(repo),
    human: loadHuman(repo),
    options,
    manifest: existsSync(join(repo, REPOKIT_DIR, "media.manifest.json")) ? readManifest(repo) : { schemaVersion: 1, media: [] },
    github: githubRemote(repo),
    license,
    files,
    deployment: loadDeployment(repo),
    workflows: [...files].filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f)).sort(),
    i18n: loadI18n(options.language),
    allHeadings,
  };
}
