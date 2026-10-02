import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { validate } from "@repokit/core";
import { deckFromFacts, imagesToPdf, resolveDeck, type Deck } from "../src/deck.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const repo = mkdtempSync(join(tmpdir(), "repokit-deck-"));
cpSync(join(ROOT, "examples/web-app"), repo, { recursive: true, filter: (source) => !source.includes(".repokit") && !source.includes("docs") });
mkdirSync(join(repo, ".repokit"));
cpSync(join(ROOT, "tests/fixtures/slots/pattern-16x10.png"), join(repo, "shot.png"));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("deckFromFacts", () => {
  it("without the author's input, builds only what the code proves and lists what is missing", () => {
    const { deck, humanTodo } = deckFromFacts(repo, "slides");
    expect(validate("deck", deck)).toEqual({ valid: true, errors: [] });
    // Title and detected technologies: no problem, solution or feature slides are made up.
    expect(deck.slides.map((s) => s.layout)).toEqual(["title", "chips"]);
    expect(deck.slides[1].chips).toEqual(["Python", "JavaScript", "FastAPI", "Pytest"]);
    expect(humanTodo.map((t) => t.id)).toEqual(["deck.tagline", "deck.shots", "deck.problem", "deck.solution", "deck.claims"]);
  });

  it("uses the author's words, proven claims and an honest slide about what is not done", () => {
    writeFileSync(join(repo, ".repokit/readme.human.yaml"), "tagline: Список задач на один экран\nproblem: Нужен общий список дел. Без регистрации.\nsolution: Одна страница.\nteam:\n  - name: Ада\n    role: бэкенд\n");
    writeFileSync(join(repo, ".repokit/claims.json"), JSON.stringify({
      schemaVersion: 1,
      claims: [
        { id: "c1", text: "Отметка задач выполненными", status: "implemented", source: "readme", evidence: [{ file: "app/store.py", lines: [26, 30], snippetSha256: sha("app/store.py", 26, 30) }] },
        { id: "c2", text: "Умные подсказки на основе ИИ", status: "mock", source: "readme", evidence: [] },
        { id: "c3", text: "Экспорт в PDF", status: "unverified", source: "readme", evidence: [] },
      ],
    }));
    const { deck } = deckFromFacts(repo, "slides", "dark");
    const byKicker = (kicker: string) => deck.slides.find((s) => s.kicker === kicker)!;
    expect(deck.theme).toBe("dark");
    expect(deck.slides[0]).toMatchObject({ layout: "title", body: "Список задач на один экран" });
    expect(byKicker("Проблема")).toMatchObject({ heading: "Нужен общий список дел.", body: "Без регистрации." });
    expect(byKicker("Решение")).toEqual({ layout: "text", kicker: "Решение", heading: "Одна страница." });
    expect(byKicker("Возможности").bullets).toEqual(["Отметка задач выполненными"]);
    expect(byKicker("Ограничения и планы").bullets).toEqual(["Умные подсказки на основе ИИ — пока заглушка"]);
    expect(byKicker("Команда").bullets).toEqual(["Ада — бэкенд"]);
    // The unverified claim appears nowhere.
    expect(JSON.stringify(deck)).not.toContain("Экспорт в PDF");
  });

  it("makes a one-slide banner with the detected stack", () => {
    const { deck } = deckFromFacts(repo, "banner");
    expect(deck.size).toEqual({ width: 1280, height: 640 });
    expect(deck.slides).toHaveLength(1);
    expect(deck.slides[0].chips).toContain("FastAPI");
  });
});

describe("resolveDeck", () => {
  const deck = (slides: Deck["slides"]): Deck => ({ schemaVersion: 1, slides });

  it("colours known technologies and leaves unknown ones neutral", () => {
    const { props } = resolveDeck(repo, deck([{ layout: "chips", chips: ["Python", "Наш собственный движок", { label: "Особая", color: "ff0000" }] }]));
    expect(props.slides[0].chips).toEqual([{ label: "Python", color: "3670A0" }, { label: "Наш собственный движок", color: undefined }, { label: "Особая", color: "ff0000" }]);
    expect(props).toMatchObject({ width: 1920, height: 1080, durationInFrames: 1 });
  });

  it("copies images into the render and flags ones it did not capture", () => {
    const { files, warnings, props } = resolveDeck(repo, deck([{ layout: "image", image: "shot.png" }]));
    expect(files).toEqual([{ source: join(repo, "shot.png"), name: "slide-1.png" }]);
    expect(props.slides[0].image).toBe("slide-1.png");
    expect(warnings[0]).toContain("происхождение неизвестно");
  });

  it("refuses missing images, non-images and an image slide without an image", () => {
    expect(() => resolveDeck(repo, deck([{ layout: "split", image: "nope.png" }]))).toThrow(/не найдено/);
    expect(() => resolveDeck(repo, deck([{ layout: "split", image: "README.md" }]))).toThrow(/не изображение/);
    expect(() => resolveDeck(repo, deck([{ layout: "image" }]))).toThrow(/нужно изображение/);
  });
});

describe("imagesToPdf", () => {
  it("writes a well-formed PDF with one page per image", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const pdf = imagesToPdf([{ jpeg, width: 1920, height: 1080 }, { jpeg, width: 1920, height: 1080 }]);
    const text = pdf.toString("latin1");
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(text).toContain("/Count 2");
    expect(text.match(/\/Type \/Page /g)).toHaveLength(2);
    // The cross-reference table must point at the real byte offset of every object.
    const xref = Number(text.match(/startxref\n(\d+)/)![1]);
    expect(text.slice(xref, xref + 4)).toBe("xref");
    const offsets = [...text.slice(xref).matchAll(/^(\d{10}) 00000 n /gm)].map((m) => Number(m[1]));
    offsets.forEach((offset, index) => expect(text.slice(offset, offset + `${index + 1} 0 obj`.length)).toBe(`${index + 1} 0 obj`));
  });
});

/** Hash of a line range, the same way `scan claims pin` computes it. */
function sha(file: string, from: number, to: number): string {
  const lines = readFileSync(join(repo, file), "utf8").split(/\r?\n/).slice(from - 1, to).map((l) => l.trimEnd()).join("\n");
  return createHash("sha256").update(lines).digest("hex");
}
