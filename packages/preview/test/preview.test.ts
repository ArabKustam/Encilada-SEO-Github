import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderMarkdown, renderPage } from "../src/render.js";
import { startPreviewServer, type PreviewServer } from "../src/server.js";

describe("renderMarkdown", () => {
  it("drops what GitHub drops: scripts, styles, event handlers, javascript: links", () => {
    const html = renderMarkdown('<script>alert(1)</script><p style="color:red" onclick="x()">Текст</p><a href="javascript:alert(1)">x</a><span style="display:none">скрыто</span>', "light");
    expect(html).not.toMatch(/script|style=|onclick|javascript:/);
    expect(html).toContain("<p>Текст</p>");
  });

  it("gives headings GitHub-style anchors, numbering repeats", () => {
    const html = renderMarkdown("## Быстрый старт\n\n## Быстрый старт\n", "light");
    expect(html).toContain('<h2 id="быстрый-старт">');
    expect(html).toContain('<h2 id="быстрый-старт-1">');
  });

  it("serves repository files through the preview server and leaves external links alone", () => {
    const html = renderMarkdown('![Экран](docs/shot.png) [код](./app/main.py#L3) [сайт](https://example.com) <img src="docs/a.png" alt="A" width="10">', "light");
    expect(html).toContain('src="/repo/docs/shot.png"');
    expect(html).toContain('href="/repo/app/main.py#L3"');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('<img src="/repo/docs/a.png" alt="A" width="10" />');
  });

  it("picks the picture source for the chosen theme", () => {
    const picture = '<picture>\n<source media="(prefers-color-scheme: dark)" srcset="dark.png">\n<img src="light.png" alt="Демо">\n</picture>';
    expect(renderMarkdown(picture, "light")).toContain('src="/repo/light.png"');
    const dark = renderMarkdown(picture, "dark");
    expect(dark).toContain('src="/repo/dark.png"');
    expect(dark).not.toContain("<source");
  });

  it("keeps mermaid diagrams, collapsible sections and alerts", () => {
    const html = renderMarkdown("```mermaid\nflowchart LR\n  a --> b\n```\n\n<details>\n<summary>Подробнее</summary>\n\nТекст\n\n</details>\n\n> [!NOTE]\n> Важно\n", "light");
    expect(html).toContain('<pre class="mermaid">flowchart LR\n  a --&gt; b\n</pre>');
    expect(html).toContain("<summary>Подробнее</summary>");
    expect(html).toContain('<div class="markdown-alert markdown-alert-note">');
  });

  it("builds a self-contained page without external scripts or styles", () => {
    const page = renderPage("# Привет", { theme: "dark", title: "README.md" });
    expect(page).toContain('href="/vendor/github-markdown-dark.css"');
    expect(page).not.toMatch(/(src|href)="https?:/);
  });
});

describe("preview server", () => {
  const repo = mkdtempSync(join(tmpdir(), "repokit-preview-"));
  cpSync(fileURLToPath(new URL("../../../examples/web-app/", import.meta.url)), repo, { recursive: true, filter: (source) => !source.includes(".repokit") && !source.includes("docs") });
  let server: PreviewServer;
  let token = "";
  beforeAll(async () => {
    server = await startPreviewServer(repo, 0);
    token = (await (await fetch(server.url)).text()).match(/const TOKEN = "([0-9a-f]+)"/)![1];
  });
  afterAll(async () => {
    await server.close();
    rmSync(repo, { recursive: true, force: true });
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(server.url + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  it("listens on the loopback interface only", () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("describes every slot of the chosen preset", async () => {
    const state = await (await fetch(`${server.url}/api/state?preset=compact`)).json();
    expect(state.plan.preset).toBe("compact");
    expect(state.plan.slots.map((s: { id: string }) => s.id)).toEqual(["header", "features", "quickstart", "demo", "limitations", "license"]);
    expect(state.presets).toHaveLength(3);
    expect(state.hasReadme).toBe(true);
  });

  it("renders the draft and the current README", async () => {
    const draft = await (await fetch(`${server.url}/view?source=draft&theme=light`)).text();
    expect(draft).toContain('<h2 id="быстрый-старт">Быстрый старт</h2>');
    const current = await (await fetch(`${server.url}/view?source=current&theme=dark`)).text();
    expect(current).toContain('<h2 id="возможности">Возможности</h2>');
    expect(current).toContain('data-theme="dark"');
  });

  it("serves project files but nothing outside the project", async () => {
    expect((await fetch(`${server.url}/repo/app/main.py`)).status).toBe(200);
    expect((await fetch(`${server.url}/repo/..%2F..%2Fpackage.json`)).status).toBe(404);
    expect((await fetch(`${server.url}/repo/.repokit/readme.human.yaml`)).status).toBe(404);
  });

  it("refuses to change files without the page's token", async () => {
    expect((await post("/api/human", { tagline: "x" })).status).toBe(403);
    expect((await post("/api/apply", {}, { "x-repokit-token": "0".repeat(32) })).status).toBe(403);
    expect(existsSync(join(repo, ".repokit/readme.human.yaml"))).toBe(false);
  });

  it("refuses requests addressed to another host name", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: server.port, path: "/api/state", headers: { host: "evil.example" } }, (res) => resolve(res.statusCode ?? 0));
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it("saves the author's fields, rejecting invalid ones", async () => {
    expect((await post("/api/human", { demoUrl: "not a url" }, { "x-repokit-token": token })).status).toBe(400);
    const saved = await post("/api/human", { tagline: "Список задач", problem: "", team: [], skip: ["team"] }, { "x-repokit-token": token });
    expect(saved.status).toBe(200);
    expect(readFileSync(join(repo, ".repokit/readme.human.yaml"), "utf8")).toBe("tagline: Список задач\nskip:\n  - team\n");
  });

  it("writes README.md only on an explicit apply, keeping the previous version", async () => {
    const before = readFileSync(join(repo, "README.md"), "utf8");
    await fetch(`${server.url}/api/state?preset=compact`);
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe(before);

    expect((await post("/api/apply", { preset: "compact" }, { "x-repokit-token": token })).status).toBe(200);
    expect(readFileSync(join(repo, "README.md"), "utf8")).toContain("**Список задач**");
    expect(readFileSync(join(repo, ".repokit/readme.backup.md"), "utf8")).toBe(before);
  });
});
