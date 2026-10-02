import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { validate } from "@repokit/core";
import { soundArgs } from "../src/audio.js";
import { explainScene } from "../src/explain.js";
import { GENERIC_ICONS, resolveIcon } from "../src/icons.js";
import { resolveScene, type Scene } from "../src/scene.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const hasFfprobe = spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0;
const temps: string[] = [];
afterAll(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function fixture(name: string): string {
  const repo = mkdtempSync(join(tmpdir(), `repokit-explain-${name}-`));
  temps.push(repo);
  cpSync(join(ROOT, "examples", name), repo, { recursive: true, filter: (source) => !source.includes(".repokit") && !source.includes("docs") });
  mkdirSync(join(repo, ".repokit"));
  return repo;
}

describe("explainScene", () => {
  it("draws only the modules and links that the code contains", () => {
    const { scene, facts } = explainScene(fixture("web-app"));
    expect(validate("scene", scene)).toEqual({ valid: true, errors: [] });
    expect(scene.cards!.map((c) => [c.id, c.title, c.icon])).toEqual([
      ["user", "Пользователь", "user"],
      ["f-app-static-app-js", "Веб-интерфейс", "browser"],
      ["f-app-main-py", "FastAPI API", "fastapi"],
      ["f-app-store-py", "store.py", "python"],
    ]);
    expect(scene.cards![2].subtitle).toBe("app/main.py · роутов: 7 · моделей: 2");
    expect(scene.links!.map((l) => `${l.from}>${l.to}`)).toEqual(["user>f-app-static-app-js", "f-app-static-app-js>f-app-main-py", "f-app-main-py>f-app-store-py"]);
    expect(facts).toEqual({ modules: 3, links: 3, services: [], traces: 0, screen: null });
  });

  it("in full detail traces real requests through the code and marks the stub", () => {
    const { scene, facts, humanTodo } = explainScene(fixture("web-app"), "dark", { detail: "full" });
    expect(validate("scene", scene)).toEqual({ valid: true, errors: [] });
    expect(facts.traces).toBe(5);
    const texts = scene.captions!.map((c) => c.text);
    expect(texts).toContain("POST /api/tasks — app/main.py:44 → store.py");
    expect(texts.find((t) => t.startsWith("GET /api/suggestions"))).toMatch(/заглушка \(строка \d+\)$/);
    expect(texts).toContain("Модели данных описаны в app/main.py: TaskIn, Task");
    // Every traced request travels along links that exist: a pulse is only ever added to a real connection.
    const store = scene.links!.find((l) => l.to === "f-app-store-py")!;
    expect(store.pulses!.length).toBe(2 + 4);
    // No screenshot has been recorded in this copy, so the interface stays a card and the author is told.
    expect(scene.objects).toBeUndefined();
    expect(humanTodo.map((t) => t.id)).toContain("explain.screen");
  });

  it("captions name real files and real routes", () => {
    const { scene } = explainScene(fixture("web-app"));
    const texts = scene.captions!.map((c) => c.text);
    expect(texts[0]).toBe("Как устроен " + scene.captions![0].text.slice("Как устроен ".length));
    expect(texts).toContain("Пользователь работает со страницей — app/static/app.js");
    expect(texts).toContain("Страница обращается к серверу по HTTP: GET /health, GET /api/tasks, POST /api/tasks и ещё 3");
    expect(texts).toContain("app/main.py использует app/store.py");
    expect(texts.every((t) => t.length <= 140)).toBe(true);
  });

  it("places every card and every pulse inside the scene's duration, cards left to right", () => {
    const { scene } = explainScene(fixture("web-app"));
    const xs = scene.cards!.map((c) => c.position![0]);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    const times = [...scene.cards!.map((c) => c.enterAt!), ...scene.links!.flatMap((l) => [l.at!, ...l.pulses!]), ...scene.captions!.map((c) => c.to)];
    expect(Math.max(...times)).toBeLessThanOrEqual(scene.output.duration);
  });

  it("shows a declared database as a dependency, without claiming which module talks to it", () => {
    const repo = fixture("web-app");
    writeFileSync(join(repo, "requirements.txt"), "fastapi\nuvicorn\nredis\nasyncpg\n");
    const { scene, facts } = explainScene(repo);
    expect(facts.services).toEqual(["PostgreSQL", "Redis"]);
    const postgres = scene.cards!.find((c) => c.title === "PostgreSQL")!;
    expect(postgres).toMatchObject({ subtitle: "зависимость проекта", icon: "postgresql" });
    expect(scene.captions!.map((c) => c.text)).toContain("Среди зависимостей проекта — PostgreSQL");
  });

  it("says so when the project has no connected modules", () => {
    const { scene, humanTodo } = explainScene(fixture("cli-tool"));
    // A single script: there is an entry point and nothing to connect it to.
    expect(scene.cards!.map((c) => c.title)).toEqual(["Пользователь", "wordfreq.py"]);
    expect(scene.captions!.map((c) => c.text)).toContain("Точка входа — wordfreq.py");
    expect(humanTodo[0].id).toBe("explain.empty");
  });
});

describe.skipIf(!hasFfprobe)("scenes with cards and links", () => {
  const repo = fixture("web-app");
  const scene = (patch: Partial<Scene>): Scene => ({ schemaVersion: 1, output: { duration: 4 }, ...patch });

  it("resolves icons, colours and a camera that sees every card", async () => {
    const { props, warnings, clickTimes } = await resolveScene(repo, scene({
      background: "dark",
      cards: [
        { id: "api", title: "API", icon: "fastapi", position: [-2, 0, 0] },
        { id: "db", title: "База", icon: "database", color: "#ff8800", position: [2, 0, 0], enterAt: 1 },
        { id: "odd", title: "Нечто", icon: "no-such-icon", position: [0, 2, 0] },
      ],
      links: [{ from: "api", to: "db", at: 1.5, pulses: [2, 3] }],
    }));
    expect(props.cards.map((c) => [c.id, c.color, c.theme, Boolean(c.icon), c.enterAt])).toEqual([
      ["api", "#009688", "dark", true, 0], ["db", "#ff8800", "dark", true, 1], ["odd", "#3157d5", "dark", false, 0],
    ]);
    expect(props.links).toEqual([{ from: "api", to: "db", at: 1.5, color: "#8ea6ff", pulses: [2, 3] }]);
    expect(warnings).toEqual(["карточка «odd»: значок «no-such-icon» не найден — карточка будет без значка"]);
    expect(props.camera.keys).toHaveLength(1);
    expect(props.camera.keys[0].position![2]).toBeGreaterThan(5);
    expect(clickTimes).toEqual([]);
  });

  it("refuses an empty scene, links to nowhere and effects placed on a card", async () => {
    await expect(resolveScene(repo, scene({}))).rejects.toThrow(/нет ни объектов, ни карточек/);
    const cards = [{ id: "a", title: "A" }];
    await expect(resolveScene(repo, scene({ cards, links: [{ from: "a", to: "ghost" }] }))).rejects.toThrow(/объекта «ghost» нет/);
    await expect(resolveScene(repo, scene({ cards, effects: [{ type: "sparks", object: "a", at: 1, point: [0, 0] }] }))).rejects.toThrow(/карточка/);
  });
});

describe("icons", () => {
  it("offers generic icons and brand logos, and nothing for unknown names", async () => {
    expect(GENERIC_ICONS).toEqual(expect.arrayContaining(["user", "browser", "server", "database", "file"]));
    expect(await resolveIcon("database")).toMatchObject({ viewBox: 24 });
    expect(await resolveIcon("python")).toMatchObject({ viewBox: 24, hex: "3776AB" });
    expect(await resolveIcon("PostgreSQL")).toMatchObject({ hex: "4169E1" });
    expect(await resolveIcon("definitely-not-a-thing")).toBeNull();
  });
});

describe("soundArgs", () => {
  it("delays one click per recorded click and mixes without lowering the volume", () => {
    const { inputs, filter } = soundArgs({ clickTimes: [0.5, 2.25, 99], clickVolume: 0.7, musicVolume: 0.25 }, 4);
    // The click beyond the end of the video is dropped.
    expect(filter).toContain("asplit=2[c0][c1]");
    expect(filter).toContain("[c0]adelay=500|500[d0]");
    expect(filter).toContain("[c1]adelay=2250|2250[d1]");
    expect(filter).toContain("[0:a][d0][d1]amix=inputs=3:normalize=0");
    expect(inputs.filter((arg) => arg === "-i")).toHaveLength(2);
  });

  it("loops the music, trims it to the video and fades it out", () => {
    const { inputs, filter } = soundArgs({ clickTimes: [], clickVolume: 0.7, music: "/music/track.mp3", musicVolume: 0.3 }, 10);
    expect(inputs).toEqual(expect.arrayContaining(["-stream_loop", "-1", "/music/track.mp3"]));
    expect(filter).toContain("atrim=0:10.000,volume=0.3");
    expect(filter).toContain("afade=t=out:st=8.500:d=1.5[music]");
    expect(filter).toContain("[0:a][music]amix=inputs=2");
  });
});
