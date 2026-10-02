import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Directory of data files shipped with repokit: schemas and README templates.
 * In a checkout they sit at the repository root; a packaged build points
 * `REPOKIT_RESOURCES` at its own copy.
 */
export function resourceDir(name: "schemas" | "presets/readme"): string {
  const root = process.env.REPOKIT_RESOURCES;
  return root ? join(root, name) + sep : fileURLToPath(new URL(`../../../${name}/`, import.meta.url));
}
