import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { NeedsHumanError, UsageError } from "@repokit/core";
import { createRelease, planRelease, type Executor, type ReleasePlan } from "../src/index.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const repo = mkdtempSync(join(tmpdir(), "repokit-release-"));
cpSync(join(ROOT, "examples/web-app"), repo, { recursive: true, filter: (source) => !source.includes(".repokit") && !source.includes("docs") });
mkdirSync(join(repo, ".repokit"));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("planRelease", () => {
  it("without confirmed facts, promises nothing and says what is missing", () => {
    const { plan, humanTodo } = planRelease(repo);
    expect(plan.tag).toBe("v0.1.0");
    expect(plan.notes).not.toContain("Что работает");
    expect(plan.notes).not.toContain("Умные подсказки");
    expect(plan.notes).toContain("uvicorn app.main:app");
    expect(humanTodo.map((t) => t.id)).toEqual(["release.tag", "release.tagline", "release.claims"]);
  });

  it("leaves out unpinned claims, names stubs as stubs and takes the version from the manifest", () => {
    writeFileSync(join(repo, "pyproject.toml"), '[project]\nname = "taskboard"\nversion = "1.4.0"\n');
    writeFileSync(join(repo, ".repokit/readme.human.yaml"), "title: Taskboard\ntagline: Список задач на один экран\n");
    writeFileSync(join(repo, ".repokit/claims.json"), JSON.stringify({
      schemaVersion: 1,
      claims: [
        { id: "c1", text: "Отметка задач выполненными", status: "partial", note: "нет отмены", source: "claude", evidence: [{ file: "app/store.py", lines: [26, 30] }] },
        { id: "c2", text: "Умные подсказки на основе ИИ", status: "mock", source: "readme", evidence: [] },
      ],
    }));
    // Evidence without a pinned hash does not pass the check, so nothing is claimed yet.
    expect(planRelease(repo).plan.notes).not.toContain("Что работает");

    const { plan } = planRelease(repo);
    expect(plan).toMatchObject({ tag: "v1.4.0", title: "Taskboard v1.4.0", tagExists: false, assets: [] });
    expect(plan.notes.startsWith("Список задач на один экран\n")).toBe(true);
    expect(plan.notes).toContain("## Известные ограничения\n\n- Умные подсказки на основе ИИ — пока заглушка");
  });

  it("attaches media that exists and rejects a tag that is not a version", () => {
    mkdirSync(join(repo, "docs/media"), { recursive: true });
    writeFileSync(join(repo, "docs/media/hero.mp4"), "video");
    expect(planRelease(repo, "v2.0.0").plan).toMatchObject({ tag: "v2.0.0", assets: ["docs/media/hero.mp4"] });
    expect(() => planRelease(repo, "latest")).toThrow(UsageError);
  });
});

describe("createRelease", () => {
  const plan: ReleasePlan = { tag: "v1.0.0", title: "App v1.0.0", notes: "notes", assets: ["docs/media/hero.mp4"], tagExists: false, github: { owner: "someone", repo: "app" } };
  const recorder = (answers: Record<string, { code: number; output: string }>) => {
    const calls: string[] = [];
    const execute: Executor = (command) => {
      const key = command.slice(0, 3).join(" ");
      calls.push(key);
      return answers[key] ?? { code: 0, output: "" };
    };
    return { calls, execute };
  };

  it("needs a GitHub repository and a signed-in gh", () => {
    expect(() => createRelease(repo, { ...plan, github: null }, "notes.md", {}, recorder({}).execute)).toThrow(NeedsHumanError);
    const missing = recorder({ "gh auth status": { code: 127, output: "" } });
    expect(() => createRelease(repo, plan, "notes.md", {}, missing.execute)).toThrow(/Установите его/);
    const signedOut = recorder({ "gh auth status": { code: 1, output: "You are not logged into any GitHub hosts." } });
    expect(() => createRelease(repo, plan, "notes.md", {}, signedOut.execute)).toThrow(/gh auth login/);
    expect(signedOut.calls).toEqual(["gh auth status"]);
  });

  it("does nothing when the release is already there", () => {
    const { calls, execute } = recorder({ "gh release view": { code: 0, output: "url: https://github.com/someone/app/releases/tag/v1.0.0" } });
    expect(createRelease(repo, plan, "notes.md", {}, execute)).toMatchObject({ created: false, reason: "релиз v1.0.0 уже существует", url: "https://github.com/someone/app/releases/tag/v1.0.0" });
    expect(calls).toEqual(["gh auth status", "gh release view"]);
  });

  it("creates the release with its notes and assets when there is none", () => {
    const full: string[][] = [];
    const execute: Executor = (command) => {
      full.push(command);
      if (command[2] === "view") return { code: 1, output: "release not found" };
      if (command[2] === "create") return { code: 0, output: "https://github.com/someone/app/releases/tag/v1.0.0\n" };
      return { code: 0, output: "" };
    };
    expect(createRelease(repo, plan, "notes.md", { draft: true }, execute)).toMatchObject({ created: true, url: "https://github.com/someone/app/releases/tag/v1.0.0" });
    expect(full[2]).toEqual(["gh", "release", "create", "v1.0.0", "--title", "App v1.0.0", "--notes-file", "notes.md", "--draft", "docs/media/hero.mp4"]);
  });

  it("reports gh's own error when creation fails", () => {
    const { execute } = recorder({ "gh release view": { code: 1, output: "" }, "gh release create": { code: 1, output: "HTTP 403: Resource not accessible" } });
    expect(createRelease(repo, plan, "notes.md", {}, execute)).toEqual({ created: false, reason: "gh завершился с ошибкой", output: "HTTP 403: Resource not accessible" });
  });
});
