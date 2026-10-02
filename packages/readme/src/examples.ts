import { posix } from "node:path";
import { readText, sha256 } from "@repokit/core";
import { isTestFile, type ScanResult } from "@repokit/scan";

export type ExampleKind = "example-file" | "documentation" | "test";

/** A piece of code that exists in the repository, copied verbatim, with the place it was taken from. */
export interface Example {
  kind: ExampleKind;
  language: string;
  /** What the example shows, as far as the source says: a heading, a file name, a test name. */
  title: string;
  code: string;
  file: string;
  /** Inclusive 1-based line range of `code` in `file`. */
  lines: [number, number];
  /** Hash of those lines: the example is stale once the file changes there. */
  snippetSha256: string;
  /** 0–1: how well it would serve as the first example a newcomer sees. */
  score: number;
}

export interface CommandInfo {
  command: string;
  description: string;
  file: string;
  line: number;
}

export interface ExamplesDoc {
  schemaVersion: 1;
  /** Best first. */
  examples: Example[];
  /** Sub-commands a command-line tool defines. */
  commands: CommandInfo[];
  /** Options and arguments a command-line tool defines. */
  options: CommandInfo[];
}

const LANGUAGE_BY_EXT: Record<string, string> = {
  ".py": "python", ".js": "js", ".mjs": "js", ".cjs": "js", ".ts": "ts", ".tsx": "tsx", ".jsx": "jsx",
  ".go": "go", ".rs": "rust", ".rb": "ruby", ".java": "java", ".sh": "bash", ".php": "php",
};
const EXAMPLE_DIR = /^(examples?|demos?|samples?)\//i;
const USAGE_HEADING = /usage|example|quick ?start|getting started|how to use|использовани|пример|быстрый старт|как пользоваться|запуск/i;
const CODE_LANGS = new Set(["python", "py", "js", "javascript", "ts", "typescript", "tsx", "jsx", "go", "rust", "ruby", "java", "php", "bash", "sh", "shell", "console"]);
const SHELL_LANGS = new Set(["bash", "sh", "shell", "console"]);
/** An example should fit on a screen. */
const MAX_LINES = 40;
const MIN_LINES = 2;
const MAX_EXAMPLES = 12;

const hashOf = (lines: string[]) => sha256(lines.map((line) => line.trimEnd()).join("\n"));

function snippet(kind: ExampleKind, file: string, all: string[], from: number, to: number, language: string, title: string, score: number): Example {
  const lines = all.slice(from - 1, to);
  // Common indentation is removed for reading; the hash is of the lines as they are in the file.
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)![0].length));
  return { kind, language, title, code: lines.map((l) => l.slice(indent)).join("\n").trimEnd(), file, lines: [from, to], snippetSha256: hashOf(lines), score };
}

const PROJECT_MARKER = /^(package\.json|requirements\.txt|pyproject\.toml|Cargo\.toml|go\.mod|index\.html|README\.md)$/i;
/** Does this directory look like a project of its own: a manifest, a README, tests? */
const isProject = (dir: string, files: Set<string>) =>
  [...files].some((f) => f.startsWith(dir) && (PROJECT_MARKER.test(f.slice(dir.length)) || isTestFile(f)));

/** Whole small files from an examples directory. */
function fromExampleFiles(repo: string, files: Set<string>): Example[] {
  const out: Example[] = [];
  for (const file of files) {
    const parts = file.split("/");
    if (!EXAMPLE_DIR.test(file) || parts.length > 3) continue;
    if (parts.length === 3 && isProject(`${parts[0]}/${parts[1]}/`, files)) continue;
    const language = LANGUAGE_BY_EXT[posix.extname(file)];
    const text = language ? readText(repo, file) : null;
    if (!text) continue;
    const lines = text.replace(/\s+$/, "").split(/\r?\n/);
    if (lines.length < MIN_LINES || lines.length > MAX_LINES) continue;
    // Shorter files make better first examples.
    out.push(snippet("example-file", file, lines, 1, lines.length, language, posix.basename(file), 0.9 - lines.length / (MAX_LINES * 5)));
  }
  return out;
}

/** Fenced code blocks under usage-like headings of the README and the docs. */
function fromDocumentation(repo: string, files: Set<string>, readmeFile: string | null): Example[] {
  const out: Example[] = [];
  const docs = [...files].filter((f) => f === readmeFile || /^docs?\/[^/]+\.md$/i.test(f));
  for (const file of docs) {
    const text = readText(repo, file);
    if (!text) continue;
    const lines = text.split(/\r?\n/);
    let heading = "";
    let relevant = false;
    let open: { start: number; language: string } | null = null;
    lines.forEach((line, index) => {
      const fence = line.match(/^\s*(```|~~~)\s*([\w-]*)/);
      if (fence) {
        if (!open) {
          open = { start: index + 2, language: fence[2].toLowerCase() };
          return;
        }
        const start = open.start;
        const end = index;
        // A block with no language under a usage heading is, in practice, a command line.
        const language = open.language || "bash";
        open = null;
        if (!relevant || !CODE_LANGS.has(language) || end - start + 1 < 1 || end - start + 1 > MAX_LINES) return;
        const shell = SHELL_LANGS.has(language);
        // A code example teaches more than a shell line; the README's own examples outrank other docs.
        out.push(snippet("documentation", file, lines, start, end, shell ? "bash" : language, heading, (shell ? 0.55 : 0.75) + (file === readmeFile ? 0.05 : 0)));
        return;
      }
      if (open) return;
      const h = line.match(/^#{1,4}\s+(.*)$/);
      if (h) {
        heading = h[1].trim();
        relevant = USAGE_HEADING.test(heading);
      }
    });
  }
  return out;
}

/** The shortest test that exercises the project's own code: proof that the API is used this way. */
function fromTests(repo: string, files: Set<string>): Example[] {
  const out: Example[] = [];
  for (const file of files) {
    if (!isTestFile(file)) continue;
    const text = readText(repo, file);
    if (!text) continue;
    const lines = text.split(/\r?\n/);
    if (file.endsWith(".py")) {
      lines.forEach((line, index) => {
        const def = line.match(/^(\s*)def (test_\w+)\(/);
        if (!def) return;
        let end = index + 1;
        while (end < lines.length && (lines[end].trim() === "" || lines[end].startsWith(def[1] + " ") || lines[end].startsWith(def[1] + "\t"))) end++;
        while (end > index + 1 && lines[end - 1].trim() === "") end--;
        const length = end - index;
        if (length >= MIN_LINES + 1 && length <= 15) out.push(snippet("test", file, lines, index + 1, end, "python", def[2].replace(/^test_/, "").replace(/_/g, " "), 0.5 - length / 100));
      });
    } else if (/\.[jt]sx?$/.test(file)) {
      lines.forEach((line, index) => {
        const it = line.match(/^(\s*)(?:it|test)\(\s*["'`](.+?)["'`]/);
        if (!it) return;
        const close = lines.findIndex((l, i) => i > index && l.startsWith(`${it[1]}});`));
        if (close === -1) return;
        const length = close - index + 1;
        if (length >= MIN_LINES + 1 && length <= 15) out.push(snippet("test", file, lines, index + 1, close + 1, posix.extname(file).slice(1).replace(/x$/, ""), it[2], 0.5 - length / 100));
      });
    } else if (file.endsWith("_test.go") || file.endsWith(".rs")) {
      const go = file.endsWith(".go");
      lines.forEach((line, index) => {
        const fn = go ? line.match(/^func (Test\w+)\(/) : lines[index - 1]?.trim() === "#[test]" ? line.match(/^(\s*)fn (\w+)\(/) : null;
        if (!fn) return;
        const indent = go ? "" : fn[1];
        const close = lines.findIndex((l, i) => i > index && l === `${indent}}`);
        if (close === -1) return;
        const length = close - index + 1;
        const name = (go ? fn[1].replace(/^Test/, "") : fn[2]).replace(/_/g, " ");
        if (length >= MIN_LINES + 1 && length <= 15) out.push(snippet("test", file, lines, index + 1, close + 1, go ? "go" : "rust", name, 0.5 - length / 100));
      });
    }
  }
  return out;
}

const literal = (source: string | undefined) => source?.match(/^f?["'`]([\s\S]*)["'`]$/)?.[1] ?? null;

/** `default {DEFAULT_TOP}` in an f-string help text → `default 10`, when the constant is a literal in the same file. */
function resolvePlaceholders(text: string, source: string): string {
  return text.replace(/\{([A-Za-z_]\w*)\}/g, (whole, name: string) => {
    const value = source.match(new RegExp(`^${name}\\s*(?::[^=]+)?=\\s*(\\d+(?:\\.\\d+)?|"[^"]*"|'[^']*')\\s*$`, "m"))?.[1];
    return value === undefined ? whole : value.replace(/^["']|["']$/g, "");
  });
}

/** Sub-commands and options, read from how the command-line parser is set up. */
function fromCommandLine(repo: string, files: Set<string>): { commands: CommandInfo[]; options: CommandInfo[] } {
  const commands: CommandInfo[] = [];
  const options: CommandInfo[] = [];
  for (const file of files) {
    if (isTestFile(file) || !/\.(py|[cm]?[jt]s|go|rs)$/.test(file)) continue;
    const text = readText(repo, file);
    if (!text) continue;
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      const at = { file, line: index + 1 };
      if (file.endsWith(".py")) {
        // parser.add_argument("-n", "--top", ..., help="...") / sub.add_parser("name", help="...")
        const argument = line.match(/\.add_argument\(\s*((?:["'][^"']+["']\s*,\s*)*["'][^"']+["'])(.*)$/);
        if (argument) {
          const flags = [...argument[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]).join(", ");
          const help = literal(argument[2].match(/help\s*=\s*(f?["'][^"']*["'])/)?.[1]);
          options.push({ command: flags, description: resolvePlaceholders(help ?? "", text), ...at });
        }
        const parser = line.match(/\.add_parser\(\s*["']([^"']+)["'](.*)$/);
        if (parser) commands.push({ command: parser[1], description: literal(parser[2].match(/help\s*=\s*(f?["'][^"']*["'])/)?.[1]) ?? "", ...at });
        const click = line.match(/@click\.option\(\s*((?:["'][^"']+["']\s*,\s*)*["'][^"']+["'])(.*)$/);
        if (click) {
          const flags = [...click[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]).join(", ");
          options.push({ command: flags, description: resolvePlaceholders(literal(click[2].match(/help\s*=\s*(f?["'][^"']*["'])/)?.[1]) ?? "", text), ...at });
        }
      } else if (file.endsWith(".go")) {
        // cobra: &cobra.Command{ Use: "sync [dir]", Short: "…" } and cmd.Flags().StringVarP(&x, "name", "n", "", "…")
        const use = line.match(/\bUse:\s*"([^"]+)"/);
        if (use) {
          const near = lines.slice(index, index + 6).join(" ");
          commands.push({ command: use[1], description: near.match(/\bShort:\s*"([^"]+)"/)?.[1] ?? "", ...at });
        }
        const flag = line.match(/\.(?:String|Bool|Int|Duration|StringSlice|Float64)(?:Var)?(P)?\(\s*(?:&[\w.]+\s*,\s*)?"([\w-]+)"\s*,(?:\s*"(\w?)"\s*,)?.*,\s*"([^"]*)"\s*\)/);
        if (flag) options.push({ command: `${flag[1] && flag[3] ? `-${flag[3]}, ` : ""}--${flag[2]}`, description: flag[4], ...at });
      } else if (file.endsWith(".rs")) {
        // clap builder: Command::new("sync").about("…"); derive: a doc comment above a variant of a Subcommand enum
        const built = line.match(/Command::new\(\s*"([^"]+)"\s*\)/);
        if (built) {
          const near = lines.slice(index, index + 4).join(" ");
          commands.push({ command: built[1], description: near.match(/\.about\(\s*"([^"]+)"/)?.[1] ?? "", ...at });
        }
        const arg = line.match(/Arg::new\(\s*"([^"]+)"\s*\)/);
        if (arg) {
          const near = lines.slice(index, index + 5).join(" ");
          const long = near.match(/\.long\(\s*"([^"]+)"/)?.[1];
          options.push({ command: long ? `--${long}` : arg[1], description: near.match(/\.help\(\s*"([^"]+)"/)?.[1] ?? "", ...at });
        }
      } else {
        // commander: .command("name <arg>") … .description("…")
        const command = line.match(/\.command\(\s*["'`]([^"'`]+)["'`]/);
        if (command) {
          const near = lines.slice(index, index + 4).join(" ");
          commands.push({ command: command[1], description: near.match(/\.description\(\s*["'`]([^"'`]+)["'`]/)?.[1] ?? "", ...at });
        }
        const option = line.match(/\.(?:option|requiredOption)\(\s*["'`]([^"'`]+)["'`]\s*,\s*["'`]([^"'`]+)["'`]/);
        if (option) options.push({ command: option[1], description: option[2], ...at });
      }
    });
  }
  return { commands, options };
}

/**
 * Find real usage examples: nothing is written, everything is copied from the repository
 * together with the file and lines it came from.
 */
export function extractExamples(repo: string, scan: ScanResult, files: Set<string>): ExamplesDoc {
  const readme = scan.repoHealth.readme?.file ?? null;
  const all = [...fromExampleFiles(repo, files), ...fromDocumentation(repo, files, readme), ...fromTests(repo, files)];
  const seen = new Set<string>();
  const examples = all
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.lines[0] - b.lines[0])
    .filter((example) => {
      const key = example.code.replace(/\s+/g, " ");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_EXAMPLES)
    .map((example) => ({ ...example, score: Math.round(example.score * 100) / 100 }));
  return { schemaVersion: 1, examples, ...fromCommandLine(repo, files) };
}

/** The example to lead with: real code rather than a shell line, when there is any. */
export const bestExample = (doc: ExamplesDoc): Example | null => doc.examples.find((e) => e.language !== "bash") ?? doc.examples[0] ?? null;
