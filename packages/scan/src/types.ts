/** TypeScript mirror of `schemas/scan.schema.json` and `schemas/claims.schema.json`. */

export type ProjectType = "static-site" | "node-web" | "python-api" | "data-app" | "cli" | "docker" | "unknown";

export interface Entrypoint {
  file: string;
  line?: number;
  kind: string;
  confidence: number;
}

export interface Route {
  method: string;
  path: string;
  file: string;
  line: number;
  framework: string;
  confidence: number;
}

export interface Model {
  name: string;
  file: string;
  line: number;
  kind: string;
}

export type MockKind = "todo" | "mock-marker" | "not-implemented" | "placeholder-text";

export interface Mock {
  file: string;
  line: number;
  kind: MockKind;
  text: string;
}

export interface AuditFinding {
  id: string;
  severity: "error" | "warn" | "info";
  message: string;
  file?: string;
}

export interface ScanResult {
  schemaVersion: 1;
  treeSha256: string;
  project: {
    name: string;
    types: ProjectType[];
    languages: { name: string; files: number; bytes: number }[];
    frameworks: string[];
    packageManager: string | null;
    commands: { install?: string; run?: string; test?: string };
  };
  entrypoints: Entrypoint[];
  routes: Route[];
  models: Model[];
  keyFiles: { file: string; reasons: string[] }[];
  mocks: Mock[];
  repoHealth: {
    isGitRepo: boolean;
    readme: { file: string; bytes: number } | null;
    hasLicense: boolean;
    hasGitignore: boolean;
    hasTests: boolean;
    hasCi: boolean;
    fileCount: number;
    totalBytes: number;
    largeFiles: { file: string; bytes: number }[];
    trackedJunk: string[];
  };
  audit: AuditFinding[];
}

export type ClaimStatus = "implemented" | "partial" | "mock" | "unverified";

export interface Evidence {
  file: string;
  /** Inclusive 1-based line range. */
  lines: [number, number];
  /** Hash of the referenced lines; a mismatch means the code changed since the claim was pinned. */
  snippetSha256?: string;
}

export interface Claim {
  id: string;
  text: string;
  status: ClaimStatus;
  evidence: Evidence[];
  source: "readme" | "scan" | "claude";
  readmeLine?: number;
  note?: string;
  /** Ids of criteria from brief.json that this claim supports. */
  criteria?: string[];
}

export interface ClaimsDoc {
  schemaVersion: 1;
  claims: Claim[];
}
