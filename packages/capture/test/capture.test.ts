import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NeedsHumanError, UsageError, validate } from "@repokit/core";
import { analyze } from "@repokit/scan";
import { parse } from "yaml";
import { moveDuration, pointerPath, scrollDeltas } from "../src/motion.js";
import { draftScenario, envReferences, loadScenario, resolveEnv, type Scenario } from "../src/scenario.js";

const EXAMPLES = fileURLToPath(new URL("../../../examples/", import.meta.url));

describe("scenario", () => {
  it("loads and validates the fixture scenario", () => {
    const { scenario, sha256 } = loadScenario(join(EXAMPLES, "web-app/demo.scenario.yaml"));
    expect(scenario.steps).toHaveLength(12);
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a missing file and unknown step kinds", () => {
    expect(() => loadScenario(join(EXAMPLES, "nope.yaml"))).toThrow(UsageError);
    expect(validate("scenario", { schemaVersion: 1, baseUrl: "http://localhost", steps: [{ teleport: "/" }] }).valid).toBe(false);
    expect(validate("scenario", { schemaVersion: 1, baseUrl: "http://localhost", steps: [{ click: "#a", hover: "#b" }] }).valid).toBe(false);
  });

  const withSecret: Scenario = {
    schemaVersion: 1,
    baseUrl: "http://localhost:3000",
    steps: [{ type: { selector: "#password", text: "${env:DEMO_PASSWORD}" } }],
  };

  it("substitutes environment references", () => {
    expect(envReferences(withSecret)).toEqual(["DEMO_PASSWORD"]);
    const resolved = resolveEnv(withSecret, { DEMO_PASSWORD: "hunter2-demo" });
    expect(resolved.steps[0]).toEqual({ type: { selector: "#password", text: "hunter2-demo" } });
  });

  it("asks the human for missing variables instead of guessing", () => {
    expect(() => resolveEnv(withSecret, {})).toThrow(NeedsHumanError);
  });

  it("drafts only pages that the scan actually found", () => {
    const draft = parse(draftScenario(analyze(join(EXAMPLES, "web-app")))) as Scenario;
    expect(validate("scenario", draft).valid).toBe(true);
    expect(draft.steps).toEqual([{ goto: "/" }, { mark: "home" }]);
    expect(draft.start).toEqual({ command: "python -m uvicorn app.main:app --port 8000", readyUrl: "/health" });

    const site = parse(draftScenario(analyze(join(EXAMPLES, "static-site")))) as Scenario;
    expect(site.steps.filter((s) => "goto" in s)).toEqual([{ goto: "/about.html" }, { goto: "/" }]);
  });
});

describe("motion", () => {
  it("moves the pointer along a path that ends exactly on the target", () => {
    const path = pointerPath({ x: 0, y: 0 }, { x: 400, y: 300 });
    expect(path[path.length - 1]).toEqual({ x: 400, y: 300 });
    expect(path.length).toBeGreaterThan(10);
  });

  it("is deterministic", () => {
    expect(pointerPath({ x: 10, y: 20 }, { x: 300, y: 200 })).toEqual(pointerPath({ x: 10, y: 20 }, { x: 300, y: 200 }));
  });

  it("takes longer for longer moves, within limits", () => {
    const short = moveDuration({ x: 0, y: 0 }, { x: 50, y: 0 });
    const long = moveDuration({ x: 0, y: 0 }, { x: 5000, y: 0 });
    expect(short).toBe(300);
    expect(long).toBe(900);
  });

  it("scrolls exactly the requested distance", () => {
    for (const total of [437, -260, 3]) expect(scrollDeltas(total).reduce((a, b) => a + b, 0)).toBe(total);
  });
});
