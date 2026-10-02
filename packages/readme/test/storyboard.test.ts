import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadContext, planStoryboard, renderStoryboard } from "../src/index.js";

const created: string[] = [];
afterAll(() => created.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function repoWith(files: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), "repokit-storyboard-"));
  created.push(repo);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  return repo;
}
const board = (files: Record<string, string>) => planStoryboard(loadContext(repoWith(files), { preset: "auto", language: "ru" }));
const page = '<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body></body></html>\n';

const SITE = {
  "package.json": JSON.stringify({ name: "cinema", dependencies: { express: "^4" }, scripts: { start: "node server.js" } }),
  "server.js": [
    "const app = require('express')();",
    "app.post('/api/auth/login', login);",
    "app.post('/api/user/history', saveHistory);",
    "app.post('/api/user/library', saveLibrary);",
    "app.get('/api/anime/ongoing', ongoing);",
    "app.get('/api/players', players);",
    "app.get('/api/comments/:id', comments);",
    "app.listen(3000);",
    "",
  ].join("\n"),
  "index.html": page.replace("<body>", '<body><input id="search-input" placeholder="Поиск">'),
  "movies.html": page, "series.html": page, "anime.html": page, "details.html": page, "profile.html": page, "login.html": page, "register.html": page,
};

describe("planStoryboard", () => {
  it("for a site: one picture on top, then what a newcomer meets, in order and within the budget", () => {
    const plan = board(SITE);
    expect(plan.projectType).toBe("web-app");
    expect(plan.hero.visual).toBe("screenshot");
    expect(plan.hero.how.join(" ")).toContain("--template duo");
    expect(plan.tour.map((s) => [s.id, s.visual])).toEqual([
      ["browse", "clip"], ["search", "clip"], ["detail", "clip"], ["anime-ongoing", "clip"], ["personal", "screenshot"],
    ]);
    expect(plan.tour.filter((s) => s.visual !== "diagram").length).toBeLessThanOrEqual(plan.budget.items);
  });

  it("every item names the files or routes it rests on", () => {
    const plan = board(SITE);
    for (const item of [plan.hero, ...plan.tour]) expect(item.evidence.length, item.id).toBeGreaterThan(0);
    expect(plan.tour.find((s) => s.id === "anime-ongoing")!.evidence).toEqual(["GET /api/anime/ongoing (server.js:5)", "anime.html"]);
    expect(plan.tour.find((s) => s.id === "search")!.evidence).toEqual(["index.html"]);
  });

  it("says what is left out and why", () => {
    const skipped = board(SITE).skip.map((s) => s.what).join(" | ");
    expect(skipped).toContain("login.html, register.html");
    expect(skipped).toContain("movies.html, series.html");
    // The page already shown as a capability is not listed among the repeats.
    expect(skipped).not.toMatch(/anime\.html, movies/);
    expect(skipped).toContain("players");
    expect(skipped).toContain("3D-постановок");
    expect(skipped).toContain("видеоразбор архитектуры");
  });

  it("asks for a test account when there is a personal section", () => {
    expect(board(SITE).questions.join(" ")).toContain("тестовый аккаунт");
  });

  it("for a command-line tool: a real run on top and no pictures of an interface", () => {
    const plan = board({
      "requirements.txt": "",
      "tool.py": "import argparse\nparser = argparse.ArgumentParser()\nsub = parser.add_subparsers()\nsub.add_parser('sync', help='copy files')\nsub.add_parser('status', help='show state')\nif __name__ == '__main__':\n    parser.parse_args()\n",
    });
    expect(plan.hero.visual).toBe("terminal");
    expect(plan.tour.map((s) => s.visual)).toEqual(["code", "code"]);
    expect(plan.skip.map((s) => s.what)).toContain("скриншоты и 3D-сцены");
  });

  it("for a library: a code example, and a question when there is none", () => {
    const plan = board({ "package.json": JSON.stringify({ name: "tinyslug", main: "index.js" }), "index.js": "export const slug = (t) => t;\n" });
    expect(plan.hero.visual).toBe("none");
    expect(plan.questions.join(" ")).toContain("примера использования");
    const withExample = board({ "package.json": JSON.stringify({ name: "tinyslug", main: "index.js" }), "index.js": "export const slug = (t) => t;\n", "examples/basic.js": "import { slug } from 'tinyslug';\nconsole.log(slug('A B'));\n" });
    expect(withExample.hero.visual).toBe("code");
  });

  it("renders as a page with the budget, the reasons and the commands", () => {
    const text = renderStoryboard(board(SITE));
    expect(text).toContain("## Главный кадр");
    expect(text).toContain("## Не делаем");
    expect(text).toContain("repokit capture run --scenario .repokit/storyboard/search.scenario.yaml");
    expect(text).toContain("Без пояснений о том, как картинка сделана");
  });
});
