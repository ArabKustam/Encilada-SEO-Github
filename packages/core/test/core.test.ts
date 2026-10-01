import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { insideRepo, redact, UsageError, validate, writeArtifact } from "../src/index.js";

describe("redact", () => {
  it("masks values of secret-looking environment variables", () => {
    const env = { DEMO_PASSWORD: "correct-horse-battery", HOME: "/home/user" };
    expect(redact("login with correct-horse-battery at /home/user", env)).toBe("login with [REDACTED] at /home/user");
  });

  it("masks well-known token shapes even when they are not in env", () => {
    const token = "ghp_" + "a".repeat(30);
    expect(redact(`token=${token}`, {})).toBe("token=[REDACTED]");
  });

  it("leaves short env values alone to avoid shredding ordinary text", () => {
    expect(redact("the key is on", { API_KEY: "on" })).toBe("the key is on");
  });
});

describe("validate", () => {
  const envelope = {
    service: "scan", command: "audit", version: "0.1.0", ok: true, exitCode: 0,
    data: {}, warnings: [], humanTodo: [], artifacts: [],
  };

  it("accepts a well-formed envelope", () => {
    expect(validate("envelope", envelope)).toEqual({ valid: true, errors: [] });
  });

  it("rejects an unknown exit code", () => {
    expect(validate("envelope", { ...envelope, exitCode: 7 }).valid).toBe(false);
  });
});

describe("files", () => {
  it("refuses paths that escape the repository", () => {
    expect(() => insideRepo(tmpdir(), "../outside.txt")).toThrow(UsageError);
  });

  it("writes artifacts idempotently and never on dry-run", () => {
    const repo = mkdtempSync(join(tmpdir(), "repokit-core-"));
    try {
      expect(writeArtifact(repo, "a.json", "{}", "test", true).written).toBe(false);
      expect(writeArtifact(repo, "a.json", "{}", "test").written).toBe(true);
      expect(writeArtifact(repo, "a.json", "{}", "test").written).toBe(false);
      expect(readFileSync(join(repo, ".repokit", "a.json"), "utf8")).toBe("{}");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
