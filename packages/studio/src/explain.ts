import { posix } from "node:path";
import { existsSync } from "node:fs";
import { insideRepo, readManifest, readText, type HumanTodo } from "@repokit/core";
import { buildGraph, detectStack, loadContext, loadOptions } from "@repokit/readme";
import type { Vec3 } from "@repokit/presets/types";
import type { BackgroundName, Scene } from "./scene.js";

/** Layout of the diagram, in scene units. */
const COLUMN_GAP = 3.7;
const ROW_GAP = 1.5;
const CARD_WIDTH = 2.8;
/** Pacing of the walk-through, in seconds. */
const INTRO = 0.6;
const ENTER_STEP = 0.35;
const STEP = 3.0;
const OUTRO = 2.2;
const MAX_ROUTES_IN_CAPTION = 3;
/** The detailed walk-through: how many requests are traced, and how long each stays on screen. */
const MAX_TRACES = 5;
const TRACE = 3.2;
const HOP = 0.55;
const HANDLER_LINES = 40;
const FOV = 30;

type Role = "user" | "client" | "api" | "module" | "service" | "models";

interface Node {
  id: string;
  role: Role;
  title: string;
  subtitle?: string;
  icon: string;
  column: number;
  row: number;
}

interface Edge {
  from: string;
  to: string;
  caption: string;
}

const cardId = (file: string) => `f-${file.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;

export interface Explainer {
  scene: Scene;
  humanTodo: HumanTodo[];
  /** What the diagram is built from, for the summary. */
  facts: { modules: number; links: number; services: string[]; traces: number; screen: string | null };
}

export interface ExplainOptions {
  /** `full` adds a real screenshot in place of the interface card, data models, and requests traced through the code. */
  detail: "overview" | "full";
}

/** The lines of a route's handler: from its declaration to the next declaration at the same level. */
function handlerBody(lines: string[], line: number): { text: string; end: number } {
  const start = line - 1;
  const boundary = /^\s*(@\w|(async\s+)?def\s|\w+\.(get|post|put|patch|delete|all)\(|(export\s+)?(async\s+)?function\s)/;
  let seen = 0;
  let end = Math.min(lines.length, start + HANDLER_LINES);
  for (let i = start; i < end; i++) {
    // The route line and its own `def` are the first two declarations; the third starts the next handler.
    if (boundary.test(lines[i]) && ++seen > 2) {
      end = i;
      break;
    }
  }
  return { text: lines.slice(start, end).join("\n"), end };
}

/**
 * A walk-through of how the project is put together, as a directed scene:
 * a card per module and per external service, links that are real imports and
 * HTTP calls found in the code, and a camera that follows one request through them.
 */
export function explainScene(repo: string, background: BackgroundName = "dark", options: ExplainOptions = { detail: "overview" }): Explainer {
  const full = options.detail === "full";
  const context = loadContext(repo, loadOptions(repo));
  const { scan } = context;
  const graph = buildGraph(repo, scan, context.files);
  const stack = detectStack(scan, context.files);
  const framework = stack.find((t) => t.group === "framework" && t.name !== "Node.js");
  const language = stack.find((t) => t.group === "language");
  const iconOf = (name?: string) => stack.find((t) => t.name === name)?.logo;

  const nodes = new Map<string, Node>();
  const edges: Edge[] = [];
  const add = (node: Omit<Node, "column" | "row">, column: number) => {
    const row = [...nodes.values()].filter((n) => n.column === column).length;
    nodes.set(node.id, { ...node, column, row });
  };

  // Column of each file: how many hops it is from the place a user enters.
  const depth = new Map<string, number>(graph.entryFiles.map((file) => [file, 1]));
  for (let changed = true; changed; ) {
    changed = false;
    for (const edge of graph.edges) {
      const from = depth.get(edge.from);
      if (from !== undefined && (depth.get(edge.to) ?? Infinity) > from + 1) {
        depth.set(edge.to, from + 1);
        changed = true;
      }
    }
  }

  add({ id: "user", role: "user", title: "Пользователь", icon: "user" }, 0);
  const clients = new Set(graph.edges.filter((e) => e.kind === "http").map((e) => e.from));
  for (const node of [...graph.nodes].sort((a, b) => (depth.get(a.file) ?? 9) - (depth.get(b.file) ?? 9) || a.file.localeCompare(b.file))) {
    if (!depth.has(node.file)) continue;
    const role: Role = clients.has(node.file) ? "client" : node.routes > 0 ? "api" : "module";
    const facts = [node.routes ? `роутов: ${node.routes}` : "", node.models ? `моделей: ${node.models}` : ""].filter(Boolean).join(" · ");
    add({
      id: cardId(node.file),
      role,
      title: role === "client" ? "Веб-интерфейс" : role === "api" ? (framework ? `${framework.name} API` : "Сервер") : posix.basename(node.file),
      subtitle: [node.file, facts].filter(Boolean).join(" · "),
      icon: role === "client" ? "browser" : role === "api" ? iconOf(framework?.name) ?? "server" : iconOf(language?.name) ?? "file",
    }, depth.get(node.file)!);
  }

  for (const file of graph.entryFiles) {
    const target = nodes.get(cardId(file));
    if (!target) continue;
    const caption = target.role === "client" ? `Пользователь работает со страницей — ${file}` : target.role === "api" ? `Запросы приходят в ${file}` : `Точка входа — ${file}`;
    edges.push({ from: "user", to: target.id, caption });
  }
  for (const edge of graph.edges) {
    const from = nodes.get(cardId(edge.from));
    const to = nodes.get(cardId(edge.to));
    if (!from || !to) continue;
    if (edge.kind === "http") {
      const routes = scan.routes.filter((r) => r.file === edge.to && r.framework !== "static" && r.path.length > 1);
      const shown = routes.slice(0, MAX_ROUTES_IN_CAPTION).map((r) => `${r.method} ${r.path}`).join(", ");
      edges.push({ from: from.id, to: to.id, caption: `Страница обращается к серверу по HTTP: ${shown}${routes.length > MAX_ROUTES_IN_CAPTION ? ` и ещё ${routes.length - MAX_ROUTES_IN_CAPTION}` : ""}` });
    } else {
      edges.push({ from: from.id, to: to.id, caption: `${edge.from} использует ${edge.to}` });
    }
  }

  // Data models, next to the file that declares them.
  if (full) {
    for (const node of graph.nodes) {
      const owner = nodes.get(cardId(node.file));
      const models = scan.models.filter((m) => m.file === node.file);
      if (!owner || models.length === 0) continue;
      const names = models.slice(0, 4).map((m) => m.name).join(", ") + (models.length > 4 ? ` и ещё ${models.length - 4}` : "");
      const id = `m-${cardId(node.file)}`;
      add({ id, role: "models", title: "Модели данных", subtitle: names, icon: "database" }, owner.column + 1);
      edges.push({ from: owner.id, to: id, caption: `Модели данных описаны в ${node.file}: ${names}` });
    }
  }

  // External services are known only as declared dependencies: which module talks to them is not inferred.
  const services = stack.filter((t) => t.group === "data" && !["Pydantic", "NumPy", "pandas", "scikit-learn"].includes(t.name));
  const lastColumn = Math.max(...[...nodes.values()].map((n) => n.column));
  const hub = [...nodes.values()].find((n) => n.role === "api") ?? [...nodes.values()].find((n) => n.role === "module");
  for (const service of services) {
    const id = `s-${service.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    add({ id, role: "service", title: service.name, subtitle: "зависимость проекта", icon: service.logo ?? "database" }, lastColumn + 1);
    if (hub) edges.push({ from: hub.id, to: id, caption: `Среди зависимостей проекта — ${service.name}` });
  }

  // The walk-through follows the request: links closer to the user come first.
  edges.sort((x, y) => nodes.get(x.from)!.column - nodes.get(y.from)!.column || nodes.get(x.to)!.column - nodes.get(y.to)!.column);

  const humanTodo: HumanTodo[] = [];
  if (graph.edges.length === 0) humanTodo.push({ id: "explain.empty", text: "Разбор архитектуры: связей между модулями не найдено — схему придётся описать вручную в файле сцены." });

  // --- layout: columns left to right, each centred vertically
  const columns = Math.max(...[...nodes.values()].map((n) => n.column)) + 1;
  const position = (node: Node): Vec3 => {
    const rows = [...nodes.values()].filter((n) => n.column === node.column).length;
    return [(node.column - (columns - 1) / 2) * COLUMN_GAP, ((rows - 1) / 2 - node.row) * ROW_GAP, 0];
  };

  // --- timeline: cards arrive, then each link is walked in turn
  const order = [...nodes.values()].sort((a, b) => a.column - b.column || a.row - b.row);
  const enterAt = new Map(order.map((node, index) => [node.id, INTRO + index * ENTER_STEP]));
  const walkStart = INTRO + order.length * ENTER_STEP + 0.8;

  // --- requests traced through the code: which handler answers, what it calls, whether it is a stub
  interface Trace { caption: string; hops: [string, string][] }
  const traces: Trace[] = [];
  if (full) {
    const client = [...nodes.values()].find((n) => n.role === "client");
    const candidates = scan.routes.filter((r) => r.framework !== "static" && r.path.length > 1 && !/^\/(health|docs|openapi|static|favicon)/.test(r.path) && nodes.has(cardId(r.file)));
    // One of each method first, so the walk-through shows reading, writing and deleting rather than five GETs.
    const byMethod = [...new Set(candidates.map((r) => r.method))].map((method) => candidates.find((r) => r.method === method)!);
    const chosen = [...byMethod, ...candidates.filter((r) => !byMethod.includes(r))].slice(0, MAX_TRACES);
    for (const route of chosen) {
      const lines = (readText(repo, route.file) ?? "").split(/\r?\n/);
      const body = handlerBody(lines, route.line);
      const api = cardId(route.file);
      const used = graph.edges
        .filter((e) => e.from === route.file && e.kind === "import" && nodes.has(cardId(e.to)))
        .filter((e) => new RegExp(`\\b${posix.basename(e.to).replace(/\.[^.]+$/, "")}\\.`).test(body.text));
      const stub = scan.mocks.find((m) => m.file === route.file && m.line >= route.line && m.line <= body.end);
      const hops: [string, string][] = [
        ...(client && edges.some((e) => e.from === client.id && e.to === api) ? [["user", client.id], [client.id, api]] as [string, string][] : edges.some((e) => e.from === "user" && e.to === api) ? [["user", api]] as [string, string][] : []),
        ...used.map((e): [string, string] => [api, cardId(e.to)]),
      ];
      traces.push({
        hops,
        caption: `${route.method} ${route.path} — ${route.file}:${route.line}`
          + (used.length ? ` → ${used.map((e) => posix.basename(e.to)).join(", ")}` : "")
          + (stub ? ` · заглушка (строка ${stub.line})` : ""),
      });
    }
  }
  const tracesStart = walkStart + edges.length * STEP + (traces.length ? 1.2 : 0);
  const duration = tracesStart + traces.length * TRACE + OUTRO;

  const width = (columns - 1) * COLUMN_GAP + CARD_WIDTH;
  const rowsMax = Math.max(...Array.from({ length: columns }, (_, c) => [...nodes.values()].filter((n) => n.column === c).length));
  const height = (rowsMax - 1) * ROW_GAP + CARD_WIDTH * 0.4;
  const half = Math.tan((FOV * Math.PI) / 360);
  const overview = Math.max(width / (2 * half * (16 / 9)), height / (2 * half)) * 1.1;
  const closeUp = Math.max((COLUMN_GAP + CARD_WIDTH) / (2 * half * (16 / 9)), (ROW_GAP + CARD_WIDTH * 0.4) / (2 * half)) * 1.25;

  const cameraKeys: NonNullable<NonNullable<Scene["camera"]>["keyframes"]> = [
    { at: 0, position: [0, 0.4, overview * 1.1], lookAt: [0, 0, 0] },
    { at: walkStart - 0.4, position: [0, 0, overview], lookAt: [0, 0, 0] },
  ];
  const links: NonNullable<Scene["links"]> = [];
  const captions: NonNullable<Scene["captions"]> = [];
  edges.forEach((edge, index) => {
    const at = walkStart + index * STEP;
    const a = position(nodes.get(edge.from)!);
    const b = position(nodes.get(edge.to)!);
    const middle: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 0];
    const far = Math.max(closeUp, (Math.hypot(b[0] - a[0], b[1] - a[1]) + CARD_WIDTH) / (2 * half * (16 / 9)) * 1.15);
    // A slight sideways offset keeps some depth in the picture while the camera is close.
    cameraKeys.push({ at: at + 0.7, position: [middle[0] - 0.5, middle[1] + 0.25, far], lookAt: middle, ease: "inOut" });
    cameraKeys.push({ at: at + STEP - 0.3, position: [middle[0] + 0.5, middle[1] + 0.25, far], lookAt: middle, ease: "linear" });
    links.push({ from: edge.from, to: edge.to, at: at + 0.2, pulses: [at + 0.8, at + 1.7] });
    captions.push({ from: at + 0.3, to: at + STEP - 0.1, text: edge.caption, position: "bottom" });
  });
  if (traces.length > 0) {
    cameraKeys.push({ at: tracesStart - 0.2, position: [0, 0.2, overview], lookAt: [0, 0, 0], ease: "inOut" });
    captions.push({ from: tracesStart - 1.1, to: tracesStart - 0.1, text: "Что происходит при каждом запросе", position: "top" });
    traces.forEach((trace, index) => {
      const at = tracesStart + index * TRACE;
      trace.hops.forEach(([from, to], hop) => links.find((l) => l.from === from && l.to === to)?.pulses!.push(Math.round((at + 0.3 + hop * HOP) * 100) / 100));
      captions.push({ from: at + 0.1, to: at + TRACE - 0.15, text: trace.caption, position: "bottom" });
      // The camera leans from side to side between requests, so the diagram does not sit still for long.
      cameraKeys.push({ at: at + TRACE - 0.2, position: [index % 2 === 0 ? 0.9 : -0.9, 0.35, overview * 0.96], lookAt: [0, 0, 0], ease: "inOut" });
    });
  }
  cameraKeys.push({ at: duration - OUTRO + 1, position: [0, 0, overview], lookAt: [0, 0, 0], ease: "inOut" });
  cameraKeys.push({ at: duration, position: [0.6, 0.2, overview * 0.97], lookAt: [0, 0, 0], ease: "linear" });

  const title = context.human.title ?? scan.project.name;
  captions.unshift({ from: 0.2, to: walkStart - 0.5, text: `Как устроен ${title}`, position: "top" });

  // A real screenshot stands in for the interface card, when one has been recorded.
  const clientNode = order.find((n) => n.role === "client");
  const screen = full && clientNode
    ? readManifest(repo).media
      .filter((m) => m.kind === "screenshot" && /\.(png|jpe?g|webp)$/i.test(m.path) && !/-(mobile|tablet|dark)\b/.test(m.path) && existsSync(insideRepo(repo, m.path)))
      .sort((x, y) => y.createdAt.localeCompare(x.createdAt))[0]?.path ?? null
    : null;
  if (full && clientNode && !screen) humanTodo.push({ id: "explain.screen", text: "Разбор: скриншота интерфейса нет, поэтому он показан карточкой. Снимите его (repokit capture screenshot --url <адрес>) и пересоберите разбор." });
  const carded = order.filter((node) => !(screen && node === clientNode));

  return {
    scene: {
      schemaVersion: 1,
      output: { width: 1280, height: 720, fps: 30, duration: Math.round(duration * 10) / 10 },
      background,
      ...(screen && clientNode ? { objects: [{ id: clientNode.id, device: "browser" as const, media: screen, width: CARD_WIDTH, position: position(clientNode), rotation: [0, 14, 0] as Vec3, scale: 0.01, keyframes: [{ at: Math.round((enterAt.get(clientNode.id)! + 0.5) * 100) / 100, scale: 1, rotation: [0, 0, 0] as Vec3, ease: "back" as const }] }] } : {}),
      cards: carded.map((node) => ({
        id: node.id,
        title: node.title,
        ...(node.subtitle ? { subtitle: node.subtitle } : {}),
        icon: node.icon,
        width: CARD_WIDTH,
        position: position(node),
        enterAt: Math.round(enterAt.get(node.id)! * 100) / 100,
      })),
      links,
      camera: { fov: FOV, keyframes: cameraKeys.map((k) => ({ ...k, at: Math.round(k.at * 100) / 100 })) },
      captions,
    },
    humanTodo,
    facts: { modules: [...nodes.values()].filter((n) => ["client", "api", "module"].includes(n.role)).length, links: edges.length, services: services.map((s) => s.name), traces: traces.length, screen },
  };
}
