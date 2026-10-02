import type { ScanResult } from "@repokit/scan";

export interface Technology {
  name: string;
  /** Brand colour, hex without the hash. */
  color: string;
  /** Icon slug understood by shields.io. */
  logo?: string;
  logoColor?: string;
  group: "language" | "framework" | "data" | "tooling";
}

interface Rule extends Technology {
  language?: string;
  /** Package names in package.json or requirements that prove the technology is used. */
  deps?: string[];
  /** A file whose presence proves it. */
  file?: RegExp;
}

/** What repokit can recognise. Every entry needs evidence in the repository to be shown. */
const RULES: Rule[] = [
  { name: "Python", color: "3670A0", logo: "python", logoColor: "ffdd54", group: "language", language: "Python" },
  { name: "TypeScript", color: "3178C6", logo: "typescript", logoColor: "white", group: "language", language: "TypeScript" },
  { name: "JavaScript", color: "323330", logo: "javascript", logoColor: "F7DF1E", group: "language", language: "JavaScript" },
  { name: "HTML5", color: "E34F26", logo: "html5", logoColor: "white", group: "language", language: "HTML" },
  { name: "CSS3", color: "1572B6", logo: "css", logoColor: "white", group: "language", language: "CSS" },
  { name: "Go", color: "00ADD8", logo: "go", logoColor: "white", group: "language", language: "Go" },
  { name: "Rust", color: "000000", logo: "rust", logoColor: "white", group: "language", language: "Rust" },
  { name: "Java", color: "ED8B00", logo: "openjdk", logoColor: "white", group: "language", language: "Java" },
  { name: "Ruby", color: "CC342D", logo: "ruby", logoColor: "white", group: "language", language: "Ruby" },
  { name: "PHP", color: "777BB4", logo: "php", logoColor: "white", group: "language", language: "PHP" },

  { name: "FastAPI", color: "009688", logo: "fastapi", logoColor: "white", group: "framework", deps: ["fastapi"] },
  { name: "Flask", color: "000000", logo: "flask", logoColor: "white", group: "framework", deps: ["flask"] },
  { name: "Django", color: "092E20", logo: "django", logoColor: "white", group: "framework", deps: ["django"] },
  { name: "Streamlit", color: "FF4B4B", logo: "streamlit", logoColor: "white", group: "framework", deps: ["streamlit"] },
  { name: "Gradio", color: "F97316", logo: "gradio", logoColor: "white", group: "framework", deps: ["gradio"] },
  { name: "Node.js", color: "339933", logo: "nodedotjs", logoColor: "white", group: "framework", file: /^package\.json$/ },
  { name: "Express", color: "000000", logo: "express", logoColor: "white", group: "framework", deps: ["express"] },
  { name: "Fastify", color: "000000", logo: "fastify", logoColor: "white", group: "framework", deps: ["fastify"] },
  { name: "Next.js", color: "000000", logo: "nextdotjs", logoColor: "white", group: "framework", deps: ["next"] },
  { name: "React", color: "20232A", logo: "react", logoColor: "61DAFB", group: "framework", deps: ["react"] },
  { name: "Vue", color: "35495E", logo: "vuedotjs", logoColor: "4FC08D", group: "framework", deps: ["vue"] },
  { name: "Svelte", color: "FF3E00", logo: "svelte", logoColor: "white", group: "framework", deps: ["svelte"] },
  { name: "Tailwind CSS", color: "06B6D4", logo: "tailwindcss", logoColor: "white", group: "framework", deps: ["tailwindcss"] },
  { name: "Three.js", color: "000000", logo: "threedotjs", logoColor: "white", group: "framework", deps: ["three"] },

  { name: "PostgreSQL", color: "4169E1", logo: "postgresql", logoColor: "white", group: "data", deps: ["psycopg", "psycopg2", "psycopg2-binary", "asyncpg", "pg", "postgres"] },
  { name: "MongoDB", color: "47A248", logo: "mongodb", logoColor: "white", group: "data", deps: ["pymongo", "motor", "mongoose", "mongodb"] },
  { name: "Redis", color: "DC382D", logo: "redis", logoColor: "white", group: "data", deps: ["redis", "ioredis"] },
  { name: "SQLAlchemy", color: "D71F00", logo: "sqlalchemy", logoColor: "white", group: "data", deps: ["sqlalchemy", "sqlmodel"] },
  { name: "Prisma", color: "2D3748", logo: "prisma", logoColor: "white", group: "data", deps: ["prisma", "@prisma/client"] },
  { name: "Pydantic", color: "E92063", logo: "pydantic", logoColor: "white", group: "data", deps: ["pydantic"] },
  { name: "NumPy", color: "013243", logo: "numpy", logoColor: "white", group: "data", deps: ["numpy"] },
  { name: "pandas", color: "150458", logo: "pandas", logoColor: "white", group: "data", deps: ["pandas"] },
  { name: "PyTorch", color: "EE4C2C", logo: "pytorch", logoColor: "white", group: "data", deps: ["torch"] },
  { name: "TensorFlow", color: "FF6F00", logo: "tensorflow", logoColor: "white", group: "data", deps: ["tensorflow"] },
  { name: "scikit-learn", color: "F7931E", logo: "scikitlearn", logoColor: "white", group: "data", deps: ["scikit-learn"] },

  { name: "Vite", color: "646CFF", logo: "vite", logoColor: "white", group: "tooling", deps: ["vite"] },
  { name: "Playwright", color: "2EAD33", logo: "playwright", logoColor: "white", group: "tooling", deps: ["playwright", "@playwright/test"] },
  { name: "Pytest", color: "0A9EDC", logo: "pytest", logoColor: "white", group: "tooling", deps: ["pytest"] },
  { name: "Vitest", color: "6E9F18", logo: "vitest", logoColor: "white", group: "tooling", deps: ["vitest"] },
  { name: "Docker", color: "2496ED", logo: "docker", logoColor: "white", group: "tooling", file: /(^|\/)Dockerfile$|(^|\/)docker-compose\.ya?ml$/ },
  { name: "GitHub Actions", color: "2088FF", logo: "githubactions", logoColor: "white", group: "tooling", file: /^\.github\/workflows\/[^/]+\.ya?ml$/ },
  { name: "pnpm", color: "F69220", logo: "pnpm", logoColor: "white", group: "tooling", file: /^pnpm-lock\.yaml$/ },
];

const GROUP_ORDER: Technology["group"][] = ["language", "framework", "data", "tooling"];
/** Languages below this share of the code are incidental (a config file, one script) and are not listed. */
const MIN_LANGUAGE_SHARE = 0.05;

/** Technologies the repository demonstrably uses: by language statistics, declared dependencies or telltale files. */
export function detectStack(scan: ScanResult, files: Set<string>): Technology[] {
  const dependencies = new Set(scan.project.dependencies);
  const totalBytes = scan.project.languages.reduce((sum, l) => sum + l.bytes, 0) || 1;
  const languages = new Set(scan.project.languages.filter((l) => l.bytes / totalBytes >= MIN_LANGUAGE_SHARE).map((l) => l.name));
  const found = RULES.filter((rule) =>
    (rule.language && languages.has(rule.language))
    || rule.deps?.some((dep) => dependencies.has(dep))
    || (rule.file && [...files].some((file) => rule.file!.test(file))),
  );
  return found
    .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group))
    .map(({ name, color, logo, logoColor, group }) => ({ name, color, logo, logoColor, group }));
}

/** A technology by name, for ones the author adds by hand; unknown names get a neutral badge. */
export function technologyByName(name: string): Technology {
  const rule = RULES.find((r) => r.name.toLowerCase() === name.trim().toLowerCase());
  return rule ? { name: rule.name, color: rule.color, logo: rule.logo, logoColor: rule.logoColor, group: rule.group } : { name: name.trim(), color: "555555", group: "tooling" };
}

/** shields.io treats `-` and `_` specially inside a label. */
const label = (text: string) => encodeURIComponent(text.replace(/-/g, "--").replace(/_/g, "__").replace(/ /g, "_"));

export function badgeUrl(tech: Technology): string {
  const query = [`style=for-the-badge`, ...(tech.logo ? [`logo=${tech.logo}`, `logoColor=${tech.logoColor ?? "white"}`] : [])].join("&");
  return `https://img.shields.io/badge/${label(tech.name)}-${tech.color}?${query}`;
}

export const badgeMarkdown = (tech: Technology) => `![${tech.name}](${badgeUrl(tech)})`;
