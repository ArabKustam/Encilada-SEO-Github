import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { extractClaims, mergeClaims, pinClaims, type ClaimsDoc } from "@repokit/scan";
import { checkReadme, draftReadme, listReadmePresets, mergeCustomSections, slug, type Options } from "../src/index.js";

const EXAMPLE = fileURLToPath(new URL("../../../examples/web-app/", import.meta.url));
const repo = mkdtempSync(join(tmpdir(), "repokit-readme-"));
cpSync(EXAMPLE, repo, { recursive: true, filter: (source) => !source.includes(".repokit") && !source.includes("docs") });
mkdirSync(join(repo, ".repokit"));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

const artifact = (name: string, content: string) => writeFileSync(join(repo, ".repokit", name), content);
const options = (patch: Partial<Options> = {}): Options => ({ preset: "showcase", language: "ru", ...patch });

/** Mark the fixture's README claims the way a careful reader of the code would. */
function writeClaims(): void {
  const doc = mergeClaims(null, extractClaims(readFileSync(join(repo, "README.md"), "utf8")));
  Object.assign(doc.claims[0], { status: "implemented", evidence: [{ file: "app/main.py", lines: [44, 47] }] });
  Object.assign(doc.claims[1], { status: "implemented", evidence: [{ file: "app/store.py", lines: [26, 30] }] });
  Object.assign(doc.claims[2], { status: "mock", evidence: [{ file: "app/main.py", lines: [65, 68] }], note: "Возвращает три фиксированные строки." });
  artifact("claims.json", JSON.stringify(pinClaims(repo, doc as ClaimsDoc).doc));
}

describe("presets", () => {
  it("offers compact, showcase and technical", () => {
    expect(listReadmePresets().map((p) => p.name)).toEqual(["compact", "showcase", "technical"]);
  });
});

describe("draftReadme", () => {
  it("without claims and human input, leaves blanks instead of inventing text", () => {
    const { markdown, plan } = draftReadme(repo, options());
    expect(plan.slots.filter((s) => s.status === "empty").map((s) => s.id)).toEqual(["header", "hero", "problem", "solution", "features", "limitations", "license"]);
    expect(markdown).toContain("<!-- FILL: features");
    expect(markdown).not.toContain("Умные подсказки");
    expect(plan.humanTodo.length).toBeGreaterThanOrEqual(6);
  });

  it("publishes only proven claims and moves the mock to limitations", () => {
    writeClaims();
    const { markdown } = draftReadme(repo, options());
    const features = markdown.slice(markdown.indexOf("## Возможности"), markdown.indexOf("## Архитектура"));
    expect(features).toContain("**Отметка задач выполненными** — [`app/store.py:26–30`](app/store.py#L26-L30)");
    expect(features).not.toContain("подсказки");
    const limitations = markdown.slice(markdown.indexOf("## Ограничения и планы"));
    expect(limitations).toContain("Умные подсказки на основе ИИ — сейчас заглушка");
  });

  it("drops a claim whose code changed after it was pinned", () => {
    const store = join(repo, "app/store.py");
    const original = readFileSync(store, "utf8");
    writeFileSync(store, original.replace("task.done = not task.done", "task.done = True"));
    const { markdown, plan } = draftReadme(repo, options());
    writeFileSync(store, original);
    expect(markdown).not.toContain("Отметка задач выполненными");
    expect(plan.warnings.some((w) => w.includes("c2") && w.includes("код изменился"))).toBe(true);
  });

  it("uses the author's own words for tagline, problem and team", () => {
    artifact("readme.human.yaml", "tagline: Список задач на один экран\nproblem: Нужен общий список дел.\nsolution: Одна страница.\nteam:\n  - name: Ада\n    role: бэкенд\n");
    const { markdown, plan } = draftReadme(repo, options());
    expect(markdown).toContain("**Список задач на один экран**");
    expect(markdown).toContain("- **Ада** — бэкенд");
    expect(plan.slots.filter((s) => s.status === "empty").map((s) => s.id)).toEqual(["hero", "license"]);
  });

  it("draws the architecture from imports and API calls in the code", () => {
    const { markdown } = draftReadme(repo, options({ preset: "technical" }));
    expect(markdown).toContain("```mermaid");
    expect(markdown).toMatch(/n\d+ -- HTTP --> n\d+/);
    expect(markdown).toContain('app/main.py<br/>роутов: 7 · моделей: 2');
    expect(markdown).toContain("| DELETE | `/api/tasks/{task_id}` |");
  });

  it("links the judges table only to sections that exist", () => {
    artifact("brief.json", JSON.stringify({
      schemaVersion: 1, source: { kind: "default-profile", ref: "repokit", sha256: "x" }, isDefaultProfile: true,
      criteria: [{ id: "completeness", title: "Работоспособность" }, { id: "docs", title: "Документация" }],
      submission: [], deadlines: [], restrictions: [],
      matrix: [
        { criterionId: "completeness", evidenceKinds: ["demo"], readmeSlot: "demo" },
        { criterionId: "docs", evidenceKinds: ["docs"], readmeSlot: "quickstart" },
      ],
    }));
    const { markdown } = draftReadme(repo, options());
    expect(markdown).toContain("| Работоспособность | — | — |");
    expect(markdown).toContain("[раздел «Быстрый старт»](#быстрый-старт)");
    expect(markdown).toContain("Правил хакатона не было");
  });

  it("links to a deployment only once it has been checked and found alive", () => {
    const record = (healthy: boolean) => JSON.stringify({ schemaVersion: 1, provider: "render", url: "https://taskboard.onrender.com/", healthy, sleeps: true });
    artifact("deploy.json", record(false));
    expect(draftReadme(repo, options()).markdown).not.toContain("onrender.com");

    artifact("deploy.json", record(true));
    const { markdown } = draftReadme(repo, options());
    expect(markdown).toContain("- [Открыть работающую версию](https://taskboard.onrender.com/) — бесплатный хостинг: первое открытие может занять до минуты");
    rmSync(join(repo, ".repokit/deploy.json"));
  });

  it("can be written in English", () => {
    const { markdown } = draftReadme(repo, options({ language: "en" }));
    expect(markdown).toContain("## Features");
    expect(markdown).toContain("currently a stub");
  });

  it("keeps the author's own sections and flags a likely duplicate", () => {
    const { markdown, plan } = draftReadme(repo, options());
    expect(plan.preserved).toEqual(["Запуск"]);
    expect(markdown.indexOf("## Запуск")).toBeLessThan(markdown.indexOf("## Лицензия"));
    expect(plan.humanTodo.some((t) => t.id === "readme.duplicates")).toBe(true);
  });

  it("is stable: applying the draft and drafting again changes nothing", () => {
    const first = draftReadme(repo, options()).markdown;
    writeFileSync(join(repo, "README.md"), first);
    expect(draftReadme(repo, options()).markdown).toBe(first);
  });
});

describe("mergeCustomSections", () => {
  const generated = "# App\n\n## Возможности\n\n- a\n\n## Лицензия\n\nMIT\n";
  const known = new Set(["возможности", "лицензия"]);

  it("replaces regenerated sections and carries over the rest verbatim", () => {
    const existing = "# Old\n\nIntro.\n\n## Features\n\n- old\n\n## FAQ\n\nВопросы.\n\n```\n## not a heading\n```\n";
    const merged = mergeCustomSections(existing, generated, known, "Лицензия");
    expect(merged.preserved).toEqual(["FAQ"]);
    expect(merged.markdown).toBe("# App\n\n## Возможности\n\n- a\n\n## FAQ\n\nВопросы.\n\n```\n## not a heading\n```\n\n## Лицензия\n\nMIT\n");
  });

  it("returns the generated text untouched when there is no README yet", () => {
    expect(mergeCustomSections(null, generated, known, "Лицензия").markdown).toBe(generated);
  });
});

describe("checkReadme", () => {
  const files = new Set(["docs/shot.png", "app/main.py", "LICENSE"]);

  it("finds blanks, dead local links and images without alt text", () => {
    const text = [
      "# App", "<!-- FILL: tagline — одна фраза -->", "![](docs/shot.png)", "![Экран](docs/missing.png)",
      '<img src="docs/shot.png" width="100">', "[код](app/main.py#L10-L12) [сайт](https://example.com) [якорь](#app) [папка](docs/)",
      "```", "![](ignored/in-code.png)", "```",
    ].join("\n");
    expect(checkReadme(text, files).map((p) => `${p.line}:${p.kind}`)).toEqual(["2:fill", "3:missing-alt", "4:missing-file", "5:missing-alt"]);
  });

  it("passes a clean README", () => {
    expect(checkReadme('# App\n\n<picture>\n  <source media="(prefers-color-scheme: dark)" srcset="docs/shot.png">\n  <img src="docs/shot.png" alt="Экран">\n</picture>\n\nСм. [LICENSE](LICENSE).\n', files)).toEqual([]);
  });
});

describe("slug", () => {
  it("matches GitHub's heading anchors", () => {
    expect(slug("Быстрый старт")).toBe("быстрый-старт");
    expect(slug("Limitations & Roadmap")).toBe("limitations--roadmap");
    expect(slug("API и страницы")).toBe("api-и-страницы");
  });
});
