import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { validate } from "@repokit/core";
import { analyze, checkClaims, extractClaims, mergeClaims, pinClaims, suggestTopics, type ClaimsDoc } from "../src/index.js";

const EXAMPLES = fileURLToPath(new URL("../../../examples/", import.meta.url));
const example = (name: string) => join(EXAMPLES, name);

describe("analyze", () => {
  it.each(["web-app", "web-app-node", "static-site", "cli-tool"])("produces a schema-valid result for %s", (name) => {
    expect(validate("scan", analyze(example(name)))).toEqual({ valid: true, errors: [] });
  });

  it("understands the FastAPI fixture", () => {
    const scan = analyze(example("web-app"));
    expect(scan.project.types).toEqual(["python-api"]);
    expect(scan.project.frameworks).toEqual(["fastapi"]);
    expect(scan.project.commands).toEqual({ install: "pip install -r requirements.txt", run: "uvicorn app.main:app", test: "pytest" });
    expect(scan.routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /", "GET /health", "GET /api/tasks", "POST /api/tasks",
      "POST /api/tasks/{task_id}/toggle", "DELETE /api/tasks/{task_id}", "GET /api/suggestions",
    ]);
    expect(scan.models.map((m) => m.name)).toEqual(["TaskIn", "Task"]);
  });

  it("flags the hardcoded endpoint as a mock, with its location", () => {
    const [mock] = analyze(example("web-app")).mocks;
    expect(mock).toMatchObject({ file: "app/main.py", kind: "todo" });
    expect(readFileSync(join(example("web-app"), mock.file), "utf8").split(/\r?\n/)[mock.line - 1]).toContain("hardcoded demo data");
  });

  it("understands the Express fixture", () => {
    const scan = analyze(example("web-app-node"));
    expect(scan.project.types).toEqual(["node-web"]);
    expect(scan.project.commands.run).toBe("npm start");
    expect(scan.routes.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /health", "GET /api/links", "POST /api/links", "DELETE /api/links/:id"]);
    expect(scan.entrypoints).toEqual([{ file: "server.js", kind: "package-main", confidence: 0.9 }]);
  });

  it("understands the static and CLI fixtures", () => {
    const site = analyze(example("static-site"));
    expect(site.project.types).toEqual(["static-site"]);
    expect(site.routes.map((r) => r.path).sort()).toEqual(["/", "/about.html"]);

    const cli = analyze(example("cli-tool"));
    expect(cli.project.types).toEqual(["cli"]);
    expect(cli.project.commands.run).toBe("python wordfreq.py --help");
  });

  it("is deterministic", () => {
    expect(analyze(example("web-app"))).toEqual(analyze(example("web-app")));
  });

  it("suggests topics only from detected facts", () => {
    expect(suggestTopics(analyze(example("web-app")))).toEqual(["python", "javascript", "fastapi", "api", "hackathon"]);
  });
});

describe("claims", () => {
  const repo = mkdtempSync(join(tmpdir(), "repokit-scan-"));
  cpSync(example("web-app"), repo, { recursive: true });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  const readme = readFileSync(join(repo, "README.md"), "utf8");
  const extracted = mergeClaims(null, extractClaims(readme));

  it("extracts feature bullets from a Russian README as unverified", () => {
    expect(extracted.claims.map((c) => c.text)).toEqual([
      "Добавление и удаление задач", "Отметка задач выполненными", "Умные подсказки на основе ИИ",
    ]);
    expect(extracted.claims.every((c) => c.status === "unverified" && c.evidence.length === 0)).toBe(true);
    expect(validate("claims", extracted).valid).toBe(true);
  });

  it("does not duplicate claims when extraction is repeated", () => {
    expect(mergeClaims(extracted, extractClaims(readme))).toEqual(extracted);
  });

  it("rejects an implemented claim that has no evidence", () => {
    const doc: ClaimsDoc = { schemaVersion: 1, claims: [{ ...extracted.claims[0], status: "implemented" }] };
    expect(checkClaims(repo, doc)[0].ok).toBe(false);
  });

  it("rejects evidence pointing at lines that do not exist", () => {
    const doc: ClaimsDoc = {
      schemaVersion: 1,
      claims: [{ ...extracted.claims[0], status: "implemented", evidence: [{ file: "app/main.py", lines: [900, 910] }] }],
    };
    expect(pinClaims(repo, doc).problems).toHaveLength(1);
    expect(checkClaims(repo, doc)[0].ok).toBe(false);
  });

  it("accepts pinned evidence and detects when the code changes afterwards", () => {
    const doc: ClaimsDoc = {
      schemaVersion: 1,
      claims: [{ ...extracted.claims[1], status: "implemented", evidence: [{ file: "app/store.py", lines: [27, 31] }] }],
    };
    const pinned = pinClaims(repo, doc);
    expect(pinned.pinned).toBe(1);
    expect(checkClaims(repo, pinned.doc)[0]).toMatchObject({ ok: true, problems: [] });

    // Appending below the range must not invalidate it; editing inside the range must.
    appendFileSync(join(repo, "app/store.py"), "\n# trailing note\n");
    expect(checkClaims(repo, pinned.doc)[0].ok).toBe(true);

    const store = join(repo, "app/store.py");
    writeFileSync(store, readFileSync(store, "utf8").replace("task.done = not task.done", "task.done = True"));
    expect(checkClaims(repo, pinned.doc)[0].ok).toBe(false);
  });
});
