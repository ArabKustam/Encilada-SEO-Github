import { posix } from "node:path";
import type { HumanTodo } from "@repokit/core";
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
const FOV = 30;

type Role = "user" | "client" | "api" | "module" | "service";

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
  facts: { modules: number; links: number; services: string[] };
}

/**
 * A walk-through of how the project is put together, as a directed scene:
 * a card per module and per external service, links that are real imports and
 * HTTP calls found in the code, and a camera that follows one request through them.
 */
export function explainScene(repo: string, background: BackgroundName = "dark"): Explainer {
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
  const duration = walkStart + edges.length * STEP + OUTRO;

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
  cameraKeys.push({ at: duration - OUTRO + 1, position: [0, 0, overview], lookAt: [0, 0, 0], ease: "inOut" });
  cameraKeys.push({ at: duration, position: [0.6, 0.2, overview * 0.97], lookAt: [0, 0, 0], ease: "linear" });

  const title = context.human.title ?? scan.project.name;
  captions.unshift({ from: 0.2, to: walkStart - 0.5, text: `Как устроен ${title}`, position: "top" });

  return {
    scene: {
      schemaVersion: 1,
      output: { width: 1280, height: 720, fps: 30, duration: Math.round(duration * 10) / 10 },
      background,
      cards: order.map((node) => ({
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
    facts: { modules: nodes.size - 1 - services.length, links: edges.length, services: services.map((s) => s.name) },
  };
}
