import type { ProjectType, ScanResult } from "@repokit/scan";

export const PROVIDER_IDS = [
  "github-pages", "cloudflare-pages", "netlify", "vercel", "render", "fly", "hf-spaces", "streamlit-cloud",
] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface Provider {
  id: ProviderId;
  title: string;
  /** The user's own CLI that performs the deployment, with the command that tells whether they are logged in. */
  cli: { name: string; whoami: string[]; login: string; install: string } | null;
  /** True when `deploy run` can start the deployment itself; otherwise the last step is done in the provider's dashboard. */
  automated: boolean;
  /** The free tier puts the app to sleep, so the first request after a pause is slow. */
  sleeps: boolean;
  limits: string[];
}

export const PROVIDERS: Record<ProviderId, Provider> = {
  "github-pages": {
    id: "github-pages", title: "GitHub Pages",
    cli: { name: "gh", whoami: ["auth", "status"], login: "gh auth login", install: "https://cli.github.com" },
    automated: true, sleeps: false,
    limits: ["бесплатно только для публичных репозиториев (на бесплатном плане GitHub)", "только статические файлы, без серверного кода", "сайт до 1 ГБ"],
  },
  "cloudflare-pages": {
    id: "cloudflare-pages", title: "Cloudflare Pages",
    cli: { name: "wrangler", whoami: ["whoami"], login: "wrangler login", install: "npm install -g wrangler" },
    automated: true, sleeps: false,
    limits: ["500 сборок в месяц на бесплатном плане", "только статика и функции Cloudflare"],
  },
  netlify: {
    id: "netlify", title: "Netlify",
    cli: { name: "netlify", whoami: ["status"], login: "netlify login", install: "npm install -g netlify-cli" },
    automated: true, sleeps: false,
    limits: ["100 ГБ трафика и 300 минут сборки в месяц на бесплатном плане"],
  },
  vercel: {
    id: "vercel", title: "Vercel",
    cli: { name: "vercel", whoami: ["whoami"], login: "vercel login", install: "npm install -g vercel" },
    automated: true, sleeps: false,
    limits: ["бесплатный план — только для некоммерческих личных проектов", "серверный код выполняется как функции с ограничением по времени"],
  },
  render: {
    id: "render", title: "Render",
    cli: null,
    automated: false, sleeps: true,
    limits: ["бесплатный веб-сервис засыпает после 15 минут без запросов", "первый запрос после сна занимает 30–60 секунд", "данные в памяти и на диске при засыпании теряются"],
  },
  fly: {
    id: "fly", title: "Fly.io",
    cli: { name: "fly", whoami: ["auth", "whoami"], login: "fly auth login", install: "https://fly.io/docs/flyctl/install/" },
    automated: true, sleeps: true,
    limits: ["для регистрации нужна банковская карта", "бесплатного плана как такового нет — есть небольшой бесплатный объём использования", "машины могут останавливаться при простое"],
  },
  "hf-spaces": {
    id: "hf-spaces", title: "Hugging Face Spaces",
    cli: null,
    automated: false, sleeps: true,
    limits: ["бесплатный Space засыпает после 48 часов без посещений", "2 vCPU и 16 ГБ памяти, без GPU", "Space на бесплатном плане публичный"],
  },
  "streamlit-cloud": {
    id: "streamlit-cloud", title: "Streamlit Community Cloud",
    cli: null,
    automated: false, sleeps: true,
    limits: ["приложение засыпает после нескольких дней без посещений", "репозиторий должен быть на GitHub", "около 1 ГБ памяти"],
  },
};

/** Which providers suit a project, best first. */
export function candidates(scan: ScanResult): { provider: ProviderId; reason: string }[] {
  const types = new Set<ProjectType>(scan.project.types);
  const uses = (name: string) => scan.project.frameworks.includes(name);
  if (types.has("data-app")) {
    return [
      { provider: "hf-spaces", reason: `${uses("gradio") ? "Gradio" : "Streamlit"}-приложение: Spaces запускает его без настройки сервера` },
      ...(uses("streamlit") ? [{ provider: "streamlit-cloud" as const, reason: "родная площадка для Streamlit, подключается к репозиторию GitHub" }] : []),
    ];
  }
  if (types.has("python-api")) {
    return [
      { provider: "render", reason: "Python-сервер: запускается обычной командой, без упаковки в контейнер" },
      { provider: "fly", reason: "запасной вариант через Docker; нужна банковская карта" },
      { provider: "hf-spaces", reason: "запасной вариант: Space с Docker" },
    ];
  }
  if (types.has("node-web")) {
    return uses("next")
      ? [
          { provider: "vercel", reason: "Next.js: Vercel собирает его без настройки" },
          { provider: "netlify", reason: "запасной вариант для Next.js" },
          { provider: "render", reason: "запасной вариант: обычный Node-сервер" },
        ]
      : [
          { provider: "render", reason: "постоянно работающий Node-сервер: запускается обычной командой" },
          { provider: "fly", reason: "запасной вариант через Docker; нужна банковская карта" },
          { provider: "vercel", reason: "возможен, но сервер придётся переделать под функции" },
        ];
  }
  if (types.has("static-site")) {
    return [
      { provider: "github-pages", reason: "статический сайт: публикуется из этого же репозитория через GitHub Actions" },
      { provider: "cloudflare-pages", reason: "запасной вариант: работает и с приватным репозиторием" },
      { provider: "netlify", reason: "запасной вариант" },
    ];
  }
  if (types.has("docker")) {
    return [
      { provider: "fly", reason: "есть Dockerfile: Fly запускает контейнер как есть" },
      { provider: "render", reason: "запасной вариант: Render тоже собирает Dockerfile" },
    ];
  }
  return [];
}
