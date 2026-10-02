import { posix } from "node:path";
import { readText } from "@repokit/core";
import { buildGraph, groupGraph } from "./architecture.js";
import type { Context } from "./context.js";
import { bestExample } from "./examples.js";
import { KIND_TITLES, type ProjectKind } from "./profile.js";

export type Visual = "clip" | "screenshot" | "terminal" | "code" | "diagram" | "none";
export type PageRole = "home" | "catalog" | "detail" | "search" | "personal" | "auth" | "settings" | "other";

/** One thing worth showing, with the reason and the way to make the picture. */
export interface StoryItem {
  id: string;
  /** Working title; the README heading is written by the author. */
  title: string;
  /** Files and routes that prove the thing exists. */
  evidence: string[];
  visual: Visual;
  reason: string;
  /** Commands that produce the visual. */
  how: string[];
  /** What the reader has to be told next to the picture, as questions the text must answer. */
  say: string[];
}

export interface Storyboard {
  schemaVersion: 1;
  projectType: ProjectKind;
  /** The one picture at the top: what a visitor sees before reading anything. */
  hero: StoryItem;
  /** What the project does, in the order a newcomer would meet it. At most `budget.items`. */
  tour: StoryItem[];
  /** Considered and left out, with the reason: these are decisions too. */
  skip: { what: string; reason: string }[];
  budget: { items: number; megabytes: number; clipSeconds: number };
  /** What to check before the plan is carried out. */
  questions: string[];
}

interface Page {
  file: string;
  url: string;
  role: PageRole;
}

interface Capability {
  name: string;
  routes: string[];
  role: PageRole | "content";
}

const BUDGET = { items: 5, megabytes: 15, clipSeconds: 8 };
const INTERFACE_KINDS = new Set<ProjectKind>(["web-app", "mobile-app", "desktop-app", "game", "template"]);
const TERMINAL_KINDS = new Set<ProjectKind>(["cli", "dev-tool", "ai-agent"]);

const ROLE_BY_NAME: [RegExp, PageRole][] = [
  [/^(index|home|main|landing)$/i, "home"],
  [/login|signin|sign-in|register|signup|sign-up|auth|password|reset/i, "auth"],
  [/profile|account|dashboard|cabinet|library|history|favorites|my/i, "personal"],
  [/settings|preferences|config/i, "settings"],
  [/search|find/i, "search"],
  [/detail|item|view|watch|product|post|article|\[.*\]|:id/i, "detail"],
];
const ROLE_TITLES: Record<PageRole | "content", string> = {
  home: "Главная", catalog: "Каталог", detail: "Страница объекта", search: "Поиск", personal: "Личный раздел",
  auth: "Вход и регистрация", settings: "Настройки", other: "Страница", content: "Возможность",
};
/** Things that only make sense in motion. Everything else is clearer as a still. */
const MOVES = /search|filter|sort|schedule|calendar|player|upload|drag|chat|stream|live|progress|vote|toggle/i;

const roleOf = (name: string): PageRole => ROLE_BY_NAME.find(([pattern]) => pattern.test(name))?.[1] ?? "catalog";

/** Pages a visitor can open: HTML files near the root, and page routes of a framework. */
function pagesOf(ctx: Context): Page[] {
  const pages: Page[] = [];
  for (const file of [...ctx.files].sort()) {
    if (!/\.html?$/i.test(file) || file.split("/").length > 2 || /^(node_modules|dist|build|coverage|docs|tests?|examples?)\//.test(file)) continue;
    const name = posix.basename(file).replace(/\.html?$/i, "");
    pages.push({ file, url: name === "index" ? "/" : `/${posix.basename(file)}`, role: roleOf(name) });
  }
  for (const route of ctx.scan.routes) {
    if (route.framework !== "next" && route.framework !== "static") continue;
    if (pages.some((p) => p.url === route.path)) continue;
    pages.push({ file: route.file, url: route.path, role: route.path === "/" ? "home" : roleOf(route.path) });
  }
  return pages;
}

/** API routes grouped by the resource they serve: `/api/user/history` and `/api/user/history/clear` are one capability. */
function capabilitiesOf(ctx: Context): Capability[] {
  const groups = new Map<string, string[]>();
  for (const route of ctx.scan.routes) {
    if (route.framework === "static" || route.framework === "next") continue;
    const parts = route.path.split("/").filter((p) => p && !/^(api|v\d+)$/i.test(p) && !/^[:{[<*]/.test(p));
    if (parts.length === 0) continue;
    const key = parts.slice(0, parts[0].length <= 5 && parts.length > 1 ? 2 : 1).join("/");
    groups.set(key, [...(groups.get(key) ?? []), `${route.method} ${route.path} (${route.file}:${route.line})`]);
  }
  return [...groups.entries()].map(([name, routes]) => {
    const role = /^(user|users|account|me|profile)(\/|$)/i.test(name) ? "personal" : roleOf(name.replace(/\//g, "-"));
    return { name, routes, role: role === "catalog" ? "content" : role };
  });
}

const responsive = (ctx: Context, pages: Page[]) =>
  pages.some((p) => /\.html?$/i.test(p.file) && /<meta[^>]+name=["']viewport["']/i.test(readText(ctx.repo, p.file) ?? ""));

const clip = (id: string, url: string) => [
  `сценарий: .repokit/storyboard/${id}.scenario.yaml — goto ${url}, затем одно действие и его результат (не дольше ${BUDGET.clipSeconds} с)`,
  `repokit capture run --scenario .repokit/storyboard/${id}.scenario.yaml`,
  `repokit studio render --capture latest --style dark --out docs/media/${id}.mp4 --webp`,
];
const shot = (id: string, url: string) => [`repokit capture screenshot --url <адрес>${url} --out docs/media/${id}.png`];

/**
 * Decide what the README should show and how, before any picture is made.
 * The plan is drawn from what the repository contains; wording and the final cut are the author's.
 */
export function planStoryboard(ctx: Context): Storyboard {
  const kind = ctx.profile.kind;
  const skip: Storyboard["skip"] = [];
  const questions: string[] = [];
  const tour: StoryItem[] = [];
  const example = bestExample(ctx.examples);
  const graph = groupGraph(buildGraph(ctx.repo, ctx.scan, ctx.files));

  let hero: StoryItem;
  if (INTERFACE_KINDS.has(kind)) {
    const pages = pagesOf(ctx);
    const capabilities = capabilitiesOf(ctx);
    const home = pages.find((p) => p.role === "home") ?? pages[0];
    const phone = responsive(ctx, pages);
    hero = {
      id: "hero",
      title: "Главный экран",
      evidence: home ? [home.file] : [],
      visual: "screenshot",
      reason: phone
        ? "первое, что видит посетитель: один чёткий кадр продукта. Страницы адаптированы под телефон (viewport), поэтому — ноутбук и телефон рядом: сразу видно и продукт, и то, что он работает на обоих"
        : "первое, что видит посетитель: один чёткий кадр главного экрана. Неподвижная картинка резче и легче ролика",
      how: phone
        ? [`repokit capture shots --scenario <сценарий с mark на главном экране> --sizes desktop,mobile`, "repokit studio scene make --template duo --pages <desktop.png>,<mobile.png> --out .repokit/hero.scene.json", "repokit studio still --scene .repokit/hero.scene.json --at 2 --width 1600 --out docs/media/hero.png"]
        : shot("hero", home?.url ?? "/"),
      say: ["что это за продукт и для кого — одной фразой над картинкой"],
    };

    const add = (item: StoryItem) => {
      if (tour.length < BUDGET.items) tour.push(item);
      else skip.push({ what: item.title, reason: `сверх бюджета в ${BUDGET.items} показов: README показывает главное, остальное — в docs/ или в свёрнутом блоке` });
    };
    // The path of a newcomer: look around, find something, open it, then what is personal.
    if (home) {
      add({
        id: "browse", title: "Что на главной", evidence: [home.file], visual: "clip",
        reason: "с этого начинается знакомство: видно, из чего состоит главный экран и как по нему двигаться",
        how: clip("browse", home.url), say: ["что пользователь находит на главном экране", "чем можно управлять прямо здесь (переключатели, подборки)"],
      });
    }
    const searchProof = [...ctx.files].filter((f) => /\.(js|ts|jsx|tsx|html|vue|svelte)$/.test(f) && !/node_modules|\.test\.|(^|\/)tests?\//.test(f)).find((f) => /search[-_]?input|type=["']search["']|placeholder=["'][^"']*(search|поиск)/i.test(readText(ctx.repo, f) ?? ""));
    if (searchProof || capabilities.some((c) => c.role === "search")) {
      add({
        id: "search", title: "Поиск", evidence: [searchProof ?? capabilities.find((c) => c.role === "search")!.routes[0]], visual: "clip",
        reason: "поиск понятен только в движении: ввод запроса и появление результатов",
        how: clip("search", home?.url ?? "/"), say: ["по чему ищет", "что происходит при выборе результата"],
      });
    }
    const detail = pages.find((p) => p.role === "detail");
    if (detail) {
      add({
        id: "detail", title: ROLE_TITLES.detail, evidence: [detail.file, ...capabilities.filter((c) => /comment|review|rate|rating/i.test(c.name)).flatMap((c) => c.routes.slice(0, 2))], visual: "clip",
        reason: "страница длиннее экрана: прокрутка показывает, что на ней есть, одним роликом вместо трёх скриншотов",
        how: clip("detail", `${detail.url}?<параметры конкретного объекта>`), say: ["что пользователь узнаёт и что может сделать на этой странице"],
      });
    }
    // A capability earns a place of its own only where it has a page of its own; the rest are plumbing.
    const plumbing = /comment|review|rate|rating|tmdb|proxy|fanart|image|static|health/i;
    const own = capabilities.filter((c) => c.role === "content" && !plumbing.test(c.name));
    const pageOf = (capability: Capability) => pages.find((p) => p.role !== "home" && capability.name.split("/").some((part) => part.length > 3 && posix.basename(p.file).toLowerCase().includes(part.toLowerCase())));
    for (const capability of own.filter((c) => pageOf(c))) {
      const page = pageOf(capability)!;
      const id = capability.name.replace(/[^a-z0-9]+/gi, "-");
      add({
        id, title: `${ROLE_TITLES.content}: ${capability.name}`, evidence: [...capability.routes.slice(0, 3), page.file], visual: "clip",
        reason: `у возможности есть своя страница (${page.file}) и свой API: это отдельная часть продукта, а не вариант каталога`,
        how: clip(id, page.url), say: ["что это даёт пользователю", "чем эта страница отличается от остальных"],
      });
    }
    const unplaced = own.filter((c) => !pageOf(c));
    if (unplaced.length) skip.push({ what: `отдельные показы для ${unplaced.map((c) => c.name).join(", ")}`, reason: "у этих эндпоинтов нет своей страницы: они работают внутри других экранов и упоминаются в списке возможностей" });
    const personal = [...pages.filter((p) => p.role === "personal"), ...capabilities.filter((c) => c.role === "personal")];
    if (personal.length > 0) {
      add({
        id: "personal", title: ROLE_TITLES.personal, evidence: personal.flatMap((p) => ("routes" in p ? p.routes.slice(0, 2) : [p.file])).slice(0, 5), visual: "screenshot",
        reason: "личный раздел — это состояние, а не действие: одного кадра с заполненными данными достаточно",
        how: ["нужен тестовый аккаунт с данными: создайте его сами или дайте storageState — repokit не входит под настоящим аккаунтом", ...shot("personal", "<адрес личного раздела>")],
        say: ["что хранится за пользователем", "что он видит о себе"],
      });
      questions.push("Для кадра личного раздела нужен тестовый аккаунт с данными (или уже снятый скриншот). Есть ли он?");
    }

    // --- what is deliberately not shown
    const auth = pages.filter((p) => p.role === "auth");
    if (auth.length) skip.push({ what: `${auth.map((p) => p.file).join(", ")}`, reason: "форма входа одинакова у всех и ничего не говорит о продукте" });
    const shown = new Set(tour.flatMap((item) => item.evidence));
    const catalogs = pages.filter((p) => p.role === "catalog" && !shown.has(p.file));
    if (catalogs.length > 1) skip.push({ what: catalogs.map((p) => p.file).join(", "), reason: "страницы одного типа выглядят одинаково: отдельный кадр каждой — повтор уже показанного" });
    skip.push({ what: "несколько 3D-постановок одних и тех же страниц (карусель, куб, стопка…)", reason: "это одна и та же информация в разной обёртке; постановка нужна максимум одна — в главном кадре" });
    skip.push({ what: "видеоразбор архитектуры в README", reason: `схема из ${graph.nodes.length} блоков читается с одного взгляда как диаграмма Mermaid; ролик на полминуты ради неё — шум. Он уместен в docs/ или в презентации` });
    if (ctx.human.demoUrl ?? ctx.deployment?.url) skip.push({ what: "длинное обзорное видео", reason: "есть работающая версия: ссылка на неё убедительнее любого ролика" });
    else questions.push("Работающей версии в интернете нет. Если она появится, ссылка на неё должна стоять первой — раньше любых роликов.");
  } else if (TERMINAL_KINDS.has(kind)) {
    const run = ctx.scan.project.commands.run;
    hero = {
      id: "hero", title: "Инструмент в работе", evidence: ctx.scan.entrypoints.slice(0, 2).map((e) => e.file), visual: "terminal",
      reason: "у инструмента командной строки интерфейс — это его вывод: один настоящий запуск говорит больше описания",
      how: [`repokit capture terminal -- ${run ? run.replace(/\s--help$/, " <типичные аргументы>") : "<команда, которую пользователь запустит первой>"}`],
      say: ["что делает инструмент — одной фразой", "какую задачу решает показанная команда"],
    };
    const commands = ctx.examples.commands.slice(0, 3);
    for (const command of commands) {
      tour.push({
        id: `cmd-${command.command.split(/\s/)[0]}`, title: `Команда ${command.command}`, evidence: [`${command.file}:${command.line}`], visual: "code",
        reason: "команду показывают блоком кода с её настоящим выводом: его можно скопировать",
        how: [`repokit capture terminal --out docs/assets/${command.command.split(/\s/)[0]}.svg -- <команда>  # поле text в ответе — тот же вывод для блока кода`],
        say: ["когда эта команда нужна"],
      });
    }
    if (ctx.examples.commands.length > 3) skip.push({ what: `остальные команды (${ctx.examples.commands.length - 3})`, reason: "полный список — таблицей в разделе «Команды», а не картинками" });
    skip.push({ what: "скриншоты и 3D-сцены", reason: "у проекта нет графического интерфейса" });
    questions.push("Какую команду пользователь запускает первой и с какими аргументами? Запись делается с неё.");
  } else {
    hero = {
      id: "hero", title: "Минимальный пример", evidence: example ? [`${example.file}:${example.lines[0]}–${example.lines[1]}`] : [], visual: example ? "code" : "none",
      reason: example ? "библиотеку показывает код: самый короткий работающий пример в начале README" : "примера использования в репозитории нет — сначала его нужно написать и проверить, что он запускается",
      how: example ? ["repokit examples extract", "repokit readme plan"] : ["добавьте файл в examples/ и запустите его"],
      say: ["какую задачу решает пример", "что получится на выходе"],
    };
    skip.push({ what: "скриншоты, GIF и 3D-сцены", reason: `для проекта типа «${KIND_TITLES[kind]}» картинка не заменяет пример кода` });
    if (!example) questions.push("В репозитории нет примера использования. Какой сценарий самый типичный?");
  }

  if (graph.nodes.length >= 3) {
    tour.push({
      id: "architecture", title: "Как устроено", evidence: graph.nodes.map((n) => n.file), visual: "diagram",
      reason: `${graph.nodes.length} связанных блоков: схема помогает понять, куда смотреть в коде`,
      how: ["repokit diagram architecture"], say: ["из каких частей состоит проект и кто к кому обращается — два-три предложения"],
    });
  }
  return { schemaVersion: 1, projectType: kind, hero, tour, skip, budget: BUDGET, questions };
}

const VISUAL_TITLES: Record<Visual, string> = { clip: "ролик", screenshot: "кадр", terminal: "запись терминала", code: "блок кода", diagram: "схема", none: "ничего" };

/** The plan as a page a person can read and argue with. */
export function renderStoryboard(board: Storyboard): string {
  const item = (s: StoryItem, index?: number) => [
    `### ${index === undefined ? "" : `${index + 1}. `}${s.title} — ${VISUAL_TITLES[s.visual]}`,
    "",
    `Зачем: ${s.reason}.`,
    "",
    s.evidence.length ? `Основание: ${s.evidence.map((e) => `\`${e}\``).join(", ")}` : "",
    "",
    "Что сказать рядом:",
    ...s.say.map((line) => `- ${line}`),
    "",
    "Как сделать:",
    ...s.how.map((line) => `- \`${line}\``),
    "",
  ].filter((line, i, all) => !(line === "" && all[i - 1] === ""));
  return [
    `# План презентации — ${KIND_TITLES[board.projectType]}`,
    "",
    `Бюджет: главный кадр и не больше ${board.budget.items} показов; ролик — до ${board.budget.clipSeconds} с, одно действие; всё медиа — до ${board.budget.megabytes} МБ.`,
    "Рядом с каждой картинкой — одна-две фразы о том, что на ней и зачем это пользователю. Без пояснений о том, как картинка сделана.",
    "",
    "## Главный кадр",
    "",
    ...item(board.hero),
    "## Показы по порядку",
    "",
    ...board.tour.flatMap((s, index) => item(s, index)),
    "## Не делаем",
    "",
    ...board.skip.map((s) => `- **${s.what}** — ${s.reason}.`),
    "",
    ...(board.questions.length ? ["## Вопросы к автору", "", ...board.questions.map((q) => `- ${q}`), ""] : []),
  ].join("\n");
}
