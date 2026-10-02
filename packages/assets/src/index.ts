import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import type { Command } from "commander";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import {
  commonFlags, ExitCode, fileSha256, listFiles, readManifest, readText, recordMedia, REPOKIT_DIR, requireTool, resolveRepo, runCommand, runTool, UsageError,
  type CommandResult, type CommonFlags, type MediaEntry,
} from "@repokit/core";

/** Directories that hold media for the documentation. Media elsewhere is left alone. */
export const ASSET_DIRS = /^(docs\/(assets|media|images|img|screenshots)|\.github\/(assets|images)|assets|media|images|screenshots)\//i;
/** Where new media goes when the repository has no such directory yet. */
export const DEFAULT_ASSET_DIR = "docs/assets";
const MEDIA_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".mp4", ".webm"]);
const RASTER = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const CONVERT_TO = ["png", "jpg", "webp", "gif", "mp4", "webm"] as const;
const BACKUP_DIR = "assets-backup";
const PRUNED_DIR = "assets-pruned";

/** A README image wider than this is scaled down by GitHub anyway; the bytes are wasted. */
export const LIMITS = { width: 1600, imageBytes: 1024 * 1024, gifBytes: 8 * 1024 * 1024, gifWidth: 960, gifFps: 12 };

export interface Reference {
  /** The document that refers to the file. */
  file: string;
  line: number;
  /** The target exactly as written. */
  target: string;
}

export interface Inventory {
  /** Media files in the asset directories, plus any media a document refers to. */
  assets: { path: string; bytes: number; references: Reference[] }[];
  /** References to local files that do not exist. */
  missing: (Reference & { resolved: string })[];
  /** The directory media is kept in: the one already in use, or the default. */
  dir: string;
}

const isLocal = (target: string) => !/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(target);
const isMedia = (path: string) => MEDIA_EXT.has(posix.extname(path).toLowerCase());
const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
const TARGETS = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|\b(?:src|srcset|href)="([^"\s]+)/g;

function resolveTarget(document: string, target: string): string {
  let path = target.split(/[?#]/)[0];
  try {
    path = decodeURI(path);
  } catch {
    // A malformed escape is kept as written.
  }
  return posix.normalize(posix.join(posix.dirname(document), path));
}

/** What media the repository has and which documents use it. */
export function inventory(repo: string): Inventory {
  const files = listFiles(repo).files;
  const paths = new Set(files.map((f) => f.path));
  const references = new Map<string, Reference[]>();
  const missing: Inventory["missing"] = [];
  for (const file of files) {
    if (!/\.(md|markdown|html?)$/i.test(file.path)) continue;
    let fence = false;
    (readText(repo, file.path) ?? "").split(/\r?\n/).forEach((text, index) => {
      if (/^\s*(```|~~~)/.test(text)) fence = !fence;
      if (fence) return;
      for (const m of text.matchAll(TARGETS)) {
        const target = m[1] ?? m[2];
        if (!isLocal(target)) continue;
        const resolved = resolveTarget(file.path, target);
        if (!isMedia(resolved)) continue;
        const reference = { file: file.path, line: index + 1, target };
        if (paths.has(resolved)) references.set(resolved, [...(references.get(resolved) ?? []), reference]);
        else missing.push({ ...reference, resolved });
      }
    });
  }
  const assets = files
    .filter((f) => isMedia(f.path) && (ASSET_DIRS.test(f.path) || references.has(f.path)))
    .map((f) => ({ path: f.path, bytes: statSync(join(repo, f.path)).size, references: references.get(f.path) ?? [] }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  const inUse = assets.map((a) => a.path.match(ASSET_DIRS)?.[0].replace(/\/$/, "")).filter(Boolean) as string[];
  const counts = new Map<string, number>();
  for (const dir of inUse) counts.set(dir, (counts.get(dir) ?? 0) + 1);
  const dir = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? DEFAULT_ASSET_DIR;
  return { assets, missing, dir };
}

/** `Screen Shot 2024.PNG` → `screen-shot-2024.png`. */
export function normalizedName(name: string): string {
  const ext = posix.extname(name);
  const stem = name.slice(0, name.length - ext.length)
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return `${stem || "file"}${ext.toLowerCase()}`;
}

const badName = (path: string) => posix.basename(path) !== normalizedName(posix.basename(path));
const isHeavy = (asset: { path: string; bytes: number }) => asset.bytes > (posix.extname(asset.path).toLowerCase() === ".gif" ? LIMITS.gifBytes : LIMITS.imageBytes);
const unusedOf = (inv: Inventory) => inv.assets.filter((a) => a.references.length === 0 && ASSET_DIRS.test(a.path));

export interface Duplicate {
  a: string;
  b: string;
  /** Share of pixels that differ: 0 for identical files. */
  difference: number;
}

/** Pictures that show the same thing twice: identical files, or same-sized PNGs that differ in under 1 % of pixels. */
export function duplicates(repo: string, paths: string[]): Duplicate[] {
  const found: Duplicate[] = [];
  const hashes = new Map<string, string>();
  const decoded: { path: string; png: PNG }[] = [];
  for (const path of paths) {
    const file = join(repo, path);
    const hash = fileSha256(file);
    const same = hashes.get(hash);
    if (same) {
      found.push({ a: same, b: path, difference: 0 });
      continue;
    }
    hashes.set(hash, path);
    if (posix.extname(path).toLowerCase() !== ".png" || statSync(file).size > 4 * 1024 * 1024 || decoded.length >= 40) continue;
    try {
      decoded.push({ path, png: PNG.sync.read(readFileSync(file)) });
    } catch {
      // Not a PNG a decoder accepts: it is only compared by hash.
    }
  }
  for (let i = 0; i < decoded.length; i++) {
    for (let j = i + 1; j < decoded.length; j++) {
      const { png: a } = decoded[i];
      const { png: b } = decoded[j];
      if (a.width !== b.width || a.height !== b.height) continue;
      const difference = pixelmatch(a.data, b.data, undefined, a.width, a.height, { threshold: 0.1 }) / (a.width * a.height);
      if (difference < 0.01) found.push({ a: decoded[i].path, b: decoded[j].path, difference: Math.round(difference * 10000) / 10000 });
    }
  }
  return found;
}

interface CheckData {
  dir: string;
  total: number;
  bytes: number;
  missing: Inventory["missing"];
  unused: string[];
  heavy: { path: string; bytes: number }[];
  badNames: string[];
  duplicates: Duplicate[];
  /** Media a document uses that lives outside the asset directories. */
  scattered: string[];
}

function check(flags: CommonFlags): CommandResult<CheckData> {
  const repo = resolveRepo(flags.repo);
  const inv = inventory(repo);
  const data: CheckData = {
    dir: inv.dir,
    total: inv.assets.length,
    bytes: inv.assets.reduce((sum, a) => sum + a.bytes, 0),
    missing: inv.missing,
    unused: unusedOf(inv).map((a) => a.path),
    heavy: inv.assets.filter(isHeavy).map(({ path, bytes }) => ({ path, bytes })),
    badNames: inv.assets.filter((a) => badName(a.path)).map((a) => a.path),
    duplicates: duplicates(repo, inv.assets.filter((a) => /\.(png|jpe?g|gif|webp)$/i.test(a.path)).map((a) => a.path)),
    scattered: inv.assets.filter((a) => !ASSET_DIRS.test(a.path)).map((a) => a.path),
  };
  const line = (ok: boolean, good: string, bad: string) => `  ${ok ? "✓" : "✗"} ${ok ? good : bad}`;
  return {
    data,
    exitCode: data.missing.length > 0 ? ExitCode.CheckFailed : ExitCode.Ok,
    summary: [
      `медиафайлов: ${data.total}, всего ${megabytes(data.bytes)}; папка: ${data.dir}/`,
      line(data.missing.length === 0, "все ссылки на медиа ведут к существующим файлам", `битые ссылки: ${data.missing.map((m) => `${m.file}:${m.line} → ${m.target}`).join(", ")}`),
      line(data.heavy.length === 0, "тяжёлых файлов нет", `тяжёлые: ${data.heavy.map((h) => `${h.path} (${megabytes(h.bytes)})`).join(", ")} — repokit assets optimize`),
      line(data.unused.length === 0, "неиспользуемых файлов нет", `никто не ссылается: ${data.unused.join(", ")} — repokit assets prune`),
      line(data.duplicates.length === 0, "повторяющихся изображений нет", `почти одинаковые: ${data.duplicates.map((d) => `${d.a} и ${d.b}`).join("; ")} — оставьте одно`),
      line(data.badNames.length === 0, "имена файлов аккуратные", `имена с пробелами или заглавными буквами: ${data.badNames.join(", ")} — repokit assets normalize`),
      ...(data.scattered.length > 0 ? [`  · используется медиа вне папки ${data.dir}/: ${data.scattered.join(", ")}`] : []),
    ],
  };
}

/** Keep the original of a file that is about to be changed or removed. */
function backup(repo: string, path: string, into: string): string {
  const target = join(repo, REPOKIT_DIR, into, path);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(repo, path), target);
  return `${REPOKIT_DIR}/${into}/${path}`;
}

/** A file derived from a recorded one keeps its history: the new hash points at the old. */
function carryProvenance(repo: string, previous: MediaEntry | undefined, path: string, oldSha: string): void {
  if (!previous) return;
  recordMedia(repo, [{ ...previous, path, sha256: fileSha256(join(repo, path)), createdAt: new Date().toISOString(), derivedFrom: [oldSha] }]);
}

async function imageWidth(file: string): Promise<number> {
  const out = await runTool("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width", "-of", "csv=p=0", file]);
  return Number(out.trim().split(/[,\r\n]/)[0]) || 0;
}

interface OptimizeData {
  optimized: { path: string; before: number; after: number; backup: string | null }[];
  skipped: { path: string; reason: string }[];
}

async function optimize(flags: CommonFlags & { maxWidth?: string }): Promise<CommandResult<OptimizeData>> {
  const repo = resolveRepo(flags.repo);
  const maxWidth = flags.maxWidth === undefined ? LIMITS.width : Number(flags.maxWidth);
  if (!Number.isInteger(maxWidth) || maxWidth < 320) throw new UsageError("--max-width: целое число не меньше 320");
  requireTool("ffmpeg");
  requireTool("ffprobe");
  const manifest = readManifest(repo);
  const data: OptimizeData = { optimized: [], skipped: [] };
  for (const asset of inventory(repo).assets) {
    const ext = posix.extname(asset.path).toLowerCase();
    const gif = ext === ".gif";
    if (!gif && !RASTER.has(ext)) continue;
    const file = join(repo, asset.path);
    const width = await imageWidth(file);
    const limit = gif ? LIMITS.gifWidth : maxWidth;
    const tooWide = width > limit;
    if (!tooWide && !isHeavy(asset)) continue;
    const temp = join(repo, REPOKIT_DIR, `optimize-tmp${ext}`);
    mkdirSync(dirname(temp), { recursive: true });
    const scale = `scale='min(${limit},iw)':-2:flags=lanczos`;
    const args = gif
      ? ["-filter_complex", `[0:v]fps=${LIMITS.gifFps},${scale},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`]
      : ["-vf", scale, ...(ext === ".png" ? ["-compression_level", "9"] : ext === ".webp" ? ["-quality", "82"] : ["-q:v", "4"])];
    await runTool("ffmpeg", ["-y", "-v", "error", "-i", file, ...args, temp]);
    const after = statSync(temp).size;
    // Re-encoding that gains nothing is not worth a changed file.
    if (after >= asset.bytes * 0.95) {
      rmSync(temp);
      data.skipped.push({ path: asset.path, reason: "после сжатия не стал меньше" });
      continue;
    }
    if (flags.dryRun) {
      rmSync(temp);
      data.optimized.push({ path: asset.path, before: asset.bytes, after, backup: null });
      continue;
    }
    const oldSha = fileSha256(file);
    const kept = backup(repo, asset.path, BACKUP_DIR);
    renameSync(temp, file);
    carryProvenance(repo, manifest.media.find((e) => e.sha256 === oldSha), asset.path, oldSha);
    data.optimized.push({ path: asset.path, before: asset.bytes, after, backup: kept });
  }
  return {
    data,
    summary: [
      data.optimized.length === 0 ? "сжимать нечего" : `${flags.dryRun ? "было бы сжато" : "сжато"} файлов: ${data.optimized.length}`,
      ...data.optimized.map((o) => `  ${o.path}: ${megabytes(o.before)} → ${megabytes(o.after)}${o.backup ? `; оригинал — ${o.backup}` : ""}`),
      ...data.skipped.map((s) => `  ${s.path}: пропущен — ${s.reason}`),
    ],
  };
}

function prune(flags: CommonFlags): CommandResult<{ pruned: { path: string; movedTo: string | null }[] }> {
  const repo = resolveRepo(flags.repo);
  const pruned = unusedOf(inventory(repo)).map((asset) => {
    if (flags.dryRun) return { path: asset.path, movedTo: null };
    // Moved, not deleted: a file nobody links to today may still be somebody's work.
    const movedTo = backup(repo, asset.path, PRUNED_DIR);
    rmSync(join(repo, asset.path));
    return { path: asset.path, movedTo };
  });
  return {
    data: { pruned },
    summary: [
      pruned.length === 0 ? "неиспользуемых медиафайлов нет" : `${flags.dryRun ? "были бы убраны" : "убраны"} из репозитория: ${pruned.length}${flags.dryRun ? "" : ` — лежат в ${REPOKIT_DIR}/${PRUNED_DIR}/`}`,
      ...pruned.map((p) => `  ${p.path}`),
    ],
  };
}

interface NormalizeData {
  renamed: { from: string; to: string; references: number }[];
  skipped: { path: string; reason: string }[];
}

function normalize(flags: CommonFlags): CommandResult<NormalizeData> {
  const repo = resolveRepo(flags.repo);
  const inv = inventory(repo);
  const taken = new Set(listFiles(repo).files.map((f) => f.path.toLowerCase()));
  const manifest = readManifest(repo);
  const data: NormalizeData = { renamed: [], skipped: [] };
  const edits = new Map<string, string>();
  for (const asset of inv.assets.filter((a) => badName(a.path))) {
    const to = posix.join(posix.dirname(asset.path), normalizedName(posix.basename(asset.path)));
    // On a case-insensitive disk a change of case alone is the same file, not a clash.
    if (taken.has(to.toLowerCase()) && to.toLowerCase() !== asset.path.toLowerCase()) {
      data.skipped.push({ path: asset.path, reason: `${to} уже существует` });
      continue;
    }
    taken.add(to.toLowerCase());
    data.renamed.push({ from: asset.path, to, references: asset.references.length });
    if (flags.dryRun) continue;
    renameSync(join(repo, asset.path), join(repo, to));
    for (const reference of asset.references) {
      const text = edits.get(reference.file) ?? readFileSync(join(repo, reference.file), "utf8");
      const [path, suffix = ""] = reference.target.split(/(?=[?#])/);
      const renamed = posix.join(posix.dirname(path), posix.basename(to)) + suffix;
      edits.set(reference.file, text.split(reference.target).join(path.startsWith("./") ? `./${renamed}` : renamed));
    }
    const entry = manifest.media.find((e) => e.path === asset.path);
    if (entry) recordMedia(repo, [{ ...entry, path: to }]);
  }
  for (const [file, text] of edits) writeFileSync(join(repo, file), text);
  return {
    data,
    summary: [
      data.renamed.length === 0 ? "переименовывать нечего" : `${flags.dryRun ? "были бы переименованы" : "переименованы"}: ${data.renamed.length}; ссылки в документах ${flags.dryRun ? "были бы обновлены" : "обновлены"}`,
      ...data.renamed.map((r) => `  ${r.from} → ${posix.basename(r.to)} (ссылок: ${r.references})`),
      ...data.skipped.map((s) => `  ${s.path}: пропущен — ${s.reason}`),
    ],
  };
}

async function convert(file: string, flags: CommonFlags & { to?: string }): Promise<CommandResult<{ from: string; to: string; before: number; after: number }>> {
  const repo = resolveRepo(flags.repo);
  const to = flags.to?.toLowerCase().replace(/^\./, "");
  if (!to || !(CONVERT_TO as readonly string[]).includes(to)) throw new UsageError(`--to: один из ${CONVERT_TO.join(", ")}`);
  const from = file.split("\\").join("/");
  const source = join(repo, from);
  if (!existsSync(source)) throw new UsageError(`Файл не найден: ${from}`);
  const target = from.slice(0, from.length - posix.extname(from).length) + `.${to}`;
  if (target === from) throw new UsageError("Файл уже в этом формате");
  requireTool("ffmpeg");
  const before = statSync(source).size;
  if (flags.dryRun) return { data: { from, to: target, before, after: 0 }, summary: [`dry-run: ${from} был бы преобразован в ${target}`] };
  const filters: Record<string, string[]> = {
    gif: ["-filter_complex", `[0:v]fps=${LIMITS.gifFps},scale='min(${LIMITS.gifWidth},iw)':-2:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse`],
    mp4: ["-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-movflags", "+faststart"],
    webm: ["-an", "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "34"],
    webp: ["-quality", "82"],
  };
  await runTool("ffmpeg", ["-y", "-v", "error", "-i", source, ...(filters[to] ?? []), join(repo, target)]);
  const oldSha = fileSha256(source);
  const previous = readManifest(repo).media.find((e) => e.sha256 === oldSha);
  if (previous) carryProvenance(repo, { ...previous, kind: to === "gif" ? "gif" : to === "webp" ? "webp" : previous.kind }, target, oldSha);
  const after = statSync(join(repo, target)).size;
  return {
    data: { from, to: target, before, after },
    summary: [`${from} (${megabytes(before)}) → ${target} (${megabytes(after)}); исходный файл оставлен`],
  };
}

export function registerAssets(program: Command): void {
  const assets = program.command("assets").description("медиафайлы документации: проверка ссылок, сжатие, уборка, имена");
  commonFlags(assets.command("check").description("битые ссылки, тяжёлые и неиспользуемые файлы, неаккуратные имена"))
    .action((flags: CommonFlags) => runCommand("assets", "check", flags, () => check(flags)));
  commonFlags(assets.command("optimize").description(`уменьшить слишком широкие и тяжёлые изображения и GIF; оригиналы — в .repokit/${BACKUP_DIR}/`))
    .option("--max-width <px>", `наибольшая ширина изображения (по умолчанию ${LIMITS.width})`)
    .action((flags: CommonFlags & { maxWidth?: string }) => runCommand("assets", "optimize", flags, () => optimize(flags)));
  commonFlags(assets.command("prune").description(`убрать медиафайлы, на которые никто не ссылается, в .repokit/${PRUNED_DIR}/`))
    .action((flags: CommonFlags) => runCommand("assets", "prune", flags, () => prune(flags)));
  commonFlags(assets.command("normalize").description("привести имена файлов к виду kebab-case и обновить ссылки в документах"))
    .action((flags: CommonFlags) => runCommand("assets", "normalize", flags, () => normalize(flags)));
  commonFlags(assets.command("convert <file>").description(`преобразовать файл: --to ${CONVERT_TO.join(" | ")}`))
    .option("--to <format>", "целевой формат")
    .action((file: string, flags: CommonFlags & { to?: string }) => runCommand("assets", "convert", flags, () => convert(file, flags)));
}
