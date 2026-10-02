import { listFiles, readText } from "@repokit/core";
import { isTestFile } from "./analyze.js";

export interface EnvVarUse {
  name: string;
  /** First place the variable is read. */
  file: string;
  line: number;
  /** The code supplies a fallback where it reads the variable, so the project runs without it. */
  optional: boolean;
}

const CODE_FILE = /\.(py|ts|tsx|js|jsx|mjs|cjs|go|rs)$/;
const PATTERNS = [
  /process\.env\.([A-Z][A-Z0-9_]+)/g,
  /process\.env\[\s*["']([A-Z][A-Z0-9_]+)["']\s*\]/g,
  /os\.environ(?:\.get)?\s*[[(]\s*["']([A-Z][A-Z0-9_]+)["']/g,
  /os\.getenv\(\s*["']([A-Z][A-Z0-9_]+)["']/g,
  /import\.meta\.env\.([A-Z][A-Z0-9_]+)/g,
  /os\.(?:Getenv|LookupEnv)\(\s*"([A-Z][A-Z0-9_]+)"/g,
  /env::var(?:_os)?\(\s*"([A-Z][A-Z0-9_]+)"/g,
  /\benv!\(\s*"([A-Z][A-Z0-9_]+)"/g,
];
/** Variables set by the platform or the runtime rather than by whoever configures the project. */
const AMBIENT = new Set(["PORT", "NODE_ENV", "CI", "HOME", "PATH", "HOST", "DEBUG", "PYTHONPATH", "TEMP", "TMP", "USER", "SHELL", "PWD", "LANG", "TERM", "MODE", "DEV", "PROD", "BASE_URL", "SSR"]);

/**
 * Environment variables the application code reads, with where each is first read.
 * Only names are collected; `.env` files and values are never looked at.
 */
export function envVarUses(repo: string): EnvVarUse[] {
  const found = new Map<string, EnvVarUse>();
  for (const file of listFiles(repo).files) {
    if (!CODE_FILE.test(file.path) || isTestFile(file.path)) continue;
    const text = readText(repo, file.path);
    if (!text) continue;
    text.split(/\r?\n/).forEach((content, index) => {
      for (const pattern of PATTERNS) {
        for (const match of content.matchAll(pattern)) {
          if (AMBIENT.has(match[1]) || found.has(match[1])) continue;
          const after = content.slice(match.index! + match[0].length);
          // `process.env.X ?? d`, `process.env.X || d`, `if (process.env.X)`, `os.environ.get("X", d)`, `os.getenv("X")`
          const optional = /^\s*\]?\s*(\?\?|\|\||\?|\)|&&|===?|!==?)/.test(after) && !/^\s*\)\s*\.(expect|unwrap)\(/.test(after) || /^\s*,/.test(after)
            || /getenv|environ\.get|LookupEnv|Getenv/.test(match[0]) || (/env::var/.test(match[0]) && /unwrap_or|\.ok\(\)|if let|match /.test(content));
          found.set(match[1], { name: match[1], file: file.path, line: index + 1, optional });
        }
      }
    });
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}
