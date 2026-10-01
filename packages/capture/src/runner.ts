import { join } from "node:path";
import type { Page } from "playwright";
import { UsageError } from "@repokit/core";
import { pointerPath, scrollDeltas, STEP_INTERVAL_MS, type Point } from "./motion.js";
import type { FrameRecorder } from "./recorder.js";
import type { Scenario, Step, Viewport } from "./scenario.js";

export interface CaptureEvent {
  t: number;
  type: "nav" | "move" | "click" | "hover" | "type" | "press" | "scroll" | "mark";
  x?: number;
  y?: number;
  duration?: number;
  chars?: number;
  dy?: number;
  key?: string;
  name?: string;
  url?: string;
  selector?: string;
  box?: { x: number; y: number; width: number; height: number };
}

const STEP_TIMEOUT_MS = 10_000;
const KEY_DELAY_MS = 55;
/** Pauses that make a human-paced recording readable. */
const PAUSE = { afterStep: 350, beforeClick: 120, afterNavigation: 600, beforeMark: 300, tail: 900 };
/** Where an element scrolled into view should sit, as a fraction of viewport height. */
const SCROLL_TARGET_Y = 0.3;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const round = (n: number) => Math.round(n * 1000) / 1000;

export interface RunOptions {
  page: Page;
  scenario: Scenario;
  viewport: Viewport;
  /** Absent when only stills are wanted (`capture shots`). */
  recorder?: FrameRecorder;
  /** Called at each `mark` step with the mark name; returns the file written. */
  onMark: (name: string) => Promise<void>;
}

/** Execute scenario steps against the real application, logging what was done and when. */
export async function runScenario({ page, scenario, viewport, recorder, onMark }: RunOptions): Promise<CaptureEvent[]> {
  const human = (scenario.pace ?? "human") === "human" && Boolean(recorder);
  const events: CaptureEvent[] = [];
  const now = () => round(recorder?.now() ?? 0);
  const log = (event: Omit<CaptureEvent, "t">) => events.push({ t: now(), ...event });
  const pause = (ms: number) => (human ? sleep(ms) : Promise.resolve());
  let cursor: Point = { x: viewport.width / 2, y: viewport.height * 0.6 };
  if (human) log({ type: "move", x: cursor.x, y: cursor.y });

  async function moveTo(target: Point): Promise<void> {
    if (!human) {
      await page.mouse.move(target.x, target.y);
    } else {
      for (const point of pointerPath(cursor, target)) {
        await page.mouse.move(point.x, point.y);
        log({ type: "move", x: round(point.x), y: round(point.y) });
        await sleep(STEP_INTERVAL_MS);
      }
    }
    cursor = target;
  }

  async function locate(selector: string) {
    const locator = page.locator(selector).first();
    try {
      await locator.waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
      await locator.scrollIntoViewIfNeeded({ timeout: STEP_TIMEOUT_MS });
    } catch {
      throw new UsageError(`Шаг сценария: элемент не найден или не виден — ${selector}`);
    }
    const box = await locator.boundingBox();
    if (!box) throw new UsageError(`Шаг сценария: у элемента нет размеров — ${selector}`);
    const rounded = { x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height) };
    return { box: rounded, center: { x: box.x + box.width / 2, y: box.y + box.height / 2 } };
  }

  async function click(selector: string): Promise<Point> {
    const { box, center } = await locate(selector);
    await moveTo(center);
    await pause(PAUSE.beforeClick);
    log({ type: "click", x: round(center.x), y: round(center.y), selector, box });
    await page.mouse.click(center.x, center.y);
    return center;
  }

  async function run(step: Step): Promise<void> {
    if ("goto" in step) {
      const url = new URL(step.goto, scenario.baseUrl).toString();
      await page.goto(url, { waitUntil: "load" });
      log({ type: "nav", url: step.goto });
      await pause(PAUSE.afterNavigation);
    } else if ("click" in step) {
      await click(step.click);
    } else if ("hover" in step) {
      const { box, center } = await locate(step.hover);
      await moveTo(center);
      log({ type: "hover", x: round(center.x), y: round(center.y), selector: step.hover, box });
    } else if ("type" in step) {
      const center = await click(step.type.selector);
      const chars = [...step.type.text];
      const started = now();
      // The text itself is never logged: it may come from a secret environment variable.
      const entry: CaptureEvent = { t: started, type: "type", x: round(center.x), y: round(center.y), chars: chars.length, selector: step.type.selector };
      events.push(entry);
      if (human) await page.keyboard.type(step.type.text, { delay: KEY_DELAY_MS });
      else await page.keyboard.insertText(step.type.text);
      entry.duration = round(now() - started);
    } else if ("press" in step) {
      log({ type: "press", key: step.press });
      await page.keyboard.press(step.press);
    } else if ("scroll" in step) {
      let dy: number;
      if ("to" in step.scroll) {
        const target = page.locator(step.scroll.to).first();
        await target.waitFor({ state: "attached", timeout: STEP_TIMEOUT_MS }).catch(() => {
          throw new UsageError(`Шаг сценария: элемент не найден — ${(step.scroll as { to: string }).to}`);
        });
        const top = await target.evaluate((element) => element.getBoundingClientRect().top);
        dy = Math.round(top - viewport.height * SCROLL_TARGET_Y);
      } else {
        dy = step.scroll.by;
      }
      const started = now();
      const entry: CaptureEvent = { t: started, type: "scroll", dy };
      events.push(entry);
      for (const delta of human ? scrollDeltas(dy) : [dy]) {
        await page.mouse.wheel(0, delta);
        await pause(STEP_INTERVAL_MS);
      }
      entry.duration = round(now() - started);
    } else if ("wait" in step) {
      if (typeof step.wait === "number") await sleep(step.wait * 1000);
      else {
        const selector = step.wait.for;
        await page.locator(selector).first().waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS }).catch(() => {
          throw new UsageError(`Шаг сценария: не дождались элемента — ${selector}`);
        });
      }
    } else if ("mark" in step) {
      await pause(PAUSE.beforeMark);
      log({ type: "mark", name: step.mark });
      await onMark(step.mark);
    }
  }

  for (const step of scenario.steps) {
    await run(step);
    await pause(PAUSE.afterStep);
  }
  await pause(PAUSE.tail);
  return events;
}

export const shotPath = (dir: string, name: string, suffix = "") => join(dir, "shots", `${name}${suffix}.png`);

