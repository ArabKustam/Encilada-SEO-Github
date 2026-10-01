import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { validate } from "../../packages/core/src/index.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BIN = join(ROOT, "packages/cli/dist/bin.js");
const SECRET = "s3cret-demo-password-value";

function repokit(args: string[], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

const repo = mkdtempSync(join(tmpdir(), "repokit-e2e-"));
cpSync(join(ROOT, "examples/web-app"), repo, { recursive: true, filter: (source) => !source.includes(".repokit") });
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("repokit CLI contract", () => {
  it("prints exactly one schema-valid JSON envelope to stdout with --json", () => {
    const { code, stdout, stderr } = repokit(["scan", "audit", "--repo", repo, "--json", "--dry-run"]);
    expect(code).toBe(0);
    const envelope = JSON.parse(stdout);
    expect(validate("envelope", envelope)).toEqual({ valid: true, errors: [] });
    expect(validate("scan", envelope.data).valid).toBe(true);
    expect(stderr).toContain("[scan audit]");
  });

  it("keeps stdout empty without --json", () => {
    expect(repokit(["scan", "audit", "--repo", repo, "--dry-run"]).stdout).toBe("");
  });

  it("writes nothing on --dry-run", () => {
    repokit(["scan", "audit", "--repo", repo, "--dry-run"]);
    repokit(["scan", "init", "--repo", repo, "--dry-run", "--write-gitignore"]);
    expect(existsSync(join(repo, ".repokit"))).toBe(false);
  });

  it("is idempotent: a second run does not rewrite the artifact", () => {
    const first = JSON.parse(repokit(["scan", "audit", "--repo", repo, "--json"]).stdout);
    const second = JSON.parse(repokit(["scan", "audit", "--repo", repo, "--json"]).stdout);
    expect(first.artifacts[0].written).toBe(true);
    expect(second.artifacts[0].written).toBe(false);
    expect(second.data).toEqual(first.data);
  });

  it("exits 2 on usage errors and on services that are not built yet", () => {
    expect(repokit(["scan", "audit", "--no-such-flag"]).code).toBe(2);
    expect(repokit(["scan", "audit", "--repo", join(repo, "missing")]).code).toBe(2);
    expect(repokit(["verify", "run"]).code).toBe(2);
  });

  it("exits 1 when a claim marked implemented cannot be proven", () => {
    expect(repokit(["scan", "claims", "extract", "--repo", repo]).code).toBe(0);
    const file = join(repo, ".repokit/claims.json");
    const doc = JSON.parse(readFileSync(file, "utf8"));
    doc.claims[2].status = "implemented";
    writeFileSync(file, JSON.stringify(doc));

    const { code, stdout } = repokit(["scan", "claims", "check", "--repo", repo, "--json"]);
    expect(code).toBe(1);
    expect(JSON.parse(stdout).data.failed).toBe(1);
  });

  it("never prints a secret from the environment", () => {
    const leaky = join(repo, SECRET);
    const { stdout, stderr } = repokit(["scan", "audit", "--repo", leaky, "--json"], { DEMO_PASSWORD: SECRET });
    expect(stdout + stderr).not.toContain(SECRET);
    expect(stdout).toContain("[REDACTED]");
  });
});
