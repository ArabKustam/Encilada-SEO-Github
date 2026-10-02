/** Sections a README preset can be assembled from. Shared by `brief` (criteria matrix) and `readme`. */
export const README_SLOTS = [
  "header", "hero", "stack", "problem", "solution", "features", "demo", "architecture",
  "routes", "quickstart", "judges", "limitations", "team", "license",
] as const;

export type ReadmeSlotId = (typeof README_SLOTS)[number];

/** What can back up a judging criterion inside a repository. */
export const EVIDENCE_KINDS = ["feature", "demo", "architecture", "tests", "deploy", "docs", "team"] as const;

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
