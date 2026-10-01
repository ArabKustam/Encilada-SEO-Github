import { describe, expect, it } from "vitest";
import { validate } from "@repokit/core";
import { htmlToText, validateBrief, type Brief } from "../src/index.js";

const RULES = `Критерии оценки
Инновационность идеи — 40%
Качество реализации — 60%
К заявке обязательно приложить видео до 3 минут.
Приём работ до 12 октября 2026, 18:00.`;

const brief = (patch: Partial<Brief> = {}): Brief => ({
  schemaVersion: 1,
  source: { kind: "text", ref: "inline", sha256: "0".repeat(64) },
  isDefaultProfile: false,
  criteria: [
    { id: "innovation", title: "Инновационность", weight: 0.4, quote: "Инновационность идеи — 40%" },
    { id: "quality", title: "Качество реализации", weight: 0.6, quote: "Качество реализации — 60%" },
  ],
  submission: [{ id: "video", title: "Видео", required: true, constraint: "до 3 минут", quote: "обязательно приложить видео до 3 минут" }],
  deadlines: [],
  restrictions: [],
  matrix: [
    { criterionId: "innovation", evidenceKinds: ["docs"], readmeSlot: "problem" },
    { criterionId: "quality", evidenceKinds: ["feature", "tests"], readmeSlot: "features" },
  ],
  ...patch,
});

describe("validateBrief", () => {
  it("accepts a brief whose every item is quoted from the rules", () => {
    expect(validate("brief", brief()).valid).toBe(true);
    expect(validateBrief(brief(), RULES)).toEqual({ problems: [], warnings: [] });
  });

  it("ignores case, spacing and typographic differences when matching quotes", () => {
    const loose = brief();
    loose.criteria[0].quote = "инновационность   идеи - 40%";
    expect(validateBrief(loose, RULES).problems).toEqual([]);
  });

  it("rejects a criterion that is not in the rules", () => {
    const invented = brief();
    invented.criteria.push({ id: "wow", title: "Вау-эффект", quote: "Жюри оценит вау-эффект" });
    invented.matrix.push({ criterionId: "wow", evidenceKinds: ["demo"], readmeSlot: "hero" });
    expect(validateBrief(invented, RULES).problems).toEqual(["критерий «wow»: цитата не найдена в тексте правил"]);
  });

  it("rejects items without a quote and criteria left out of the matrix", () => {
    const sloppy = brief({ matrix: [{ criterionId: "innovation", evidenceKinds: ["docs"], readmeSlot: "problem" }] });
    delete sloppy.criteria[1].quote;
    expect(validateBrief(sloppy, RULES).problems).toEqual([
      "критерий «quality»: нет цитаты из правил",
      "критерий «quality» не покрыт матрицей: укажите, чем он подтверждается",
    ]);
  });

  it("warns when weights do not add up", () => {
    const skewed = brief();
    skewed.criteria[0].weight = 0.7;
    expect(validateBrief(skewed, RULES).warnings).toEqual(["сумма весов 1.30, а не 1"]);
  });

  it("does not demand quotes from the default profile", () => {
    const fallback = brief({ isDefaultProfile: true, source: { kind: "default-profile", ref: "repokit", sha256: "0".repeat(64) }, submission: [] });
    for (const criterion of fallback.criteria) delete criterion.quote;
    expect(validateBrief(fallback, null).problems).toEqual([]);
  });

  it("requires the rules text for a brief that claims to come from rules", () => {
    expect(validateBrief(brief(), null).problems[0]).toContain("нечем подтвердить цитаты");
  });
});

describe("htmlToText", () => {
  it("keeps readable text and drops scripts, styles and tags", () => {
    const html = "<html><head><style>p{color:red}</style><script>alert(1)</script></head><body><h1>Правила</h1><p>Видео &amp; ссылка</p><ul><li>до&nbsp;3 минут</li></ul></body></html>";
    expect(htmlToText(html)).toBe("Правила\nВидео & ссылка\nдо 3 минут");
  });
});
