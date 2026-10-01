import { listFiles } from "@repokit/core";
import type { ScanResult } from "./types.js";

const MAX_TREE_ENTRIES = 150;
const MAX_TOPICS = 20;

const TOPIC_BY_TYPE: Record<string, string> = {
  "static-site": "static-site",
  "node-web": "web-app",
  "python-api": "api",
  "data-app": "data-app",
  cli: "cli",
  docker: "docker",
};
const TOPIC_LANGUAGES = new Set(["Python", "TypeScript", "JavaScript", "Go", "Rust", "Java", "Ruby", "PHP"]);

/** Compact Markdown digest of the repository for the model's context. */
export function renderContext(repo: string, scan: ScanResult): string {
  const { project, repoHealth } = scan;
  const out: string[] = [];
  const section = (title: string, lines: string[]) => {
    if (lines.length > 0) out.push(`## ${title}`, "", ...lines, "");
  };

  out.push(`# Контекст репозитория: ${project.name}`, "");
  section("Проект", [
    `- Тип: ${project.types.join(", ")}`,
    `- Языки: ${project.languages.map((l) => `${l.name} (${l.files})`).join(", ") || "не определены"}`,
    `- Фреймворки: ${project.frameworks.join(", ") || "не определены"}`,
    `- Установка: ${project.commands.install ?? "не определена"}`,
    `- Запуск: ${project.commands.run ?? "не определён"}`,
    `- Тесты: ${project.commands.test ?? "не найдены"}`,
  ]);
  section("Ключевые файлы", scan.keyFiles.map((k) => `- \`${k.file}\` — ${k.reasons.join("; ")}`));
  section("Роуты", scan.routes.map((r) => `- ${r.method} \`${r.path}\` — \`${r.file}:${r.line}\`${r.confidence < 0.6 ? " (низкая уверенность)" : ""}`));
  section("Модели данных", scan.models.map((m) => `- ${m.name} (${m.kind}) — \`${m.file}:${m.line}\``));
  section("Заглушки и недоделки", scan.mocks.map((m) => `- \`${m.file}:${m.line}\` [${m.kind}] ${m.text}`));
  section("Замечания аудита", scan.audit.map((a) => `- [${a.severity}] ${a.message}${a.file ? ` (\`${a.file}\`)` : ""}`));

  const files = listFiles(repo).files.map((f) => f.path);
  const tree = files.slice(0, MAX_TREE_ENTRIES).map((path) => `- ${path}`);
  if (files.length > MAX_TREE_ENTRIES) tree.push(`- … ещё ${files.length - MAX_TREE_ENTRIES}`);
  section(`Файлы (${repoHealth.fileCount})`, tree);

  return out.join("\n");
}

/** Suggested GitHub topics, derived only from detected facts. Never applied automatically. */
export function suggestTopics(scan: ScanResult): string[] {
  const topics = [
    ...scan.project.languages.filter((l) => TOPIC_LANGUAGES.has(l.name)).map((l) => l.name.toLowerCase()),
    ...scan.project.frameworks,
    ...scan.project.types.map((t) => TOPIC_BY_TYPE[t]).filter(Boolean),
    "hackathon",
  ];
  return [...new Set(topics)].slice(0, MAX_TOPICS);
}
