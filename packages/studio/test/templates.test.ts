import { describe, expect, it } from "vitest";
import { validate } from "@repokit/core";
import { transformAt } from "@repokit/presets/motion";
import { buildFromTemplate, listSceneTemplates, type TemplateOptions } from "../src/templates.js";

const options = (pages: number): TemplateOptions => ({
  pages: Array.from({ length: pages }, (_, i) => `shots/page-${i + 1}.png`),
  device: "browser",
  background: "light",
  hold: 2,
  move: 1,
});

describe("scene templates", () => {
  it("every template produces a scene that passes the schema and uses only the given pages", () => {
    for (const template of listSceneTemplates()) {
      const scene = buildFromTemplate(template.name, options(template.minPages));
      expect(validate("scene", scene), template.name).toEqual({ valid: true, errors: [] });
      expect(scene.objects!.map((o) => o.media)).toEqual(options(template.minPages).pages);
      // Templates stage what was recorded; they never add text of their own.
      expect(scene.captions).toEqual([]);
    }
  });

  it("brings each page to the front in turn and holds it there", () => {
    const scene = buildFromTemplate("swap", options(3));
    expect(scene.output.duration).toBe(8);
    const front = (t: number) =>
      scene.objects!.filter((o) => {
        const now = transformAt({ position: o.position!, rotation: o.rotation!, scale: o.scale ?? 1 }, o.keyframes ?? [], t);
        return now.position.every((v) => Math.abs(v) < 0.001) && now.rotation.every((v) => Math.abs(v) < 0.001);
      }).map((o) => o.id);
    expect(front(0)).toEqual(["page1"]);
    expect(front(1.9)).toEqual(["page1"]);
    expect(front(2.5)).toEqual([]);
    expect(front(3.1)).toEqual(["page2"]);
    expect(front(7.5)).toEqual(["page3"]);
  });

  it("refuses a wrong number of pages and an unknown template", () => {
    expect(() => buildFromTemplate("duo", options(3))).toThrow(/ровно 2/);
    expect(() => buildFromTemplate("carousel", options(1))).toThrow(/от 2 до 8/);
    expect(() => buildFromTemplate("spiral", options(2))).toThrow(/не найден/);
  });

  it("accepts a named cursor style in a scene and rejects an unknown one", () => {
    const scene = buildFromTemplate("wall", options(2));
    Object.assign(scene.objects![0], { cursor: "hand" });
    expect(validate("scene", scene).valid).toBe(true);
    Object.assign(scene.objects![0], { cursor: "sparkle" });
    expect(validate("scene", scene).valid).toBe(false);
  });
});
