import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertValid, findProvenance, insideRepo, runTool, UsageError } from "@repokit/core";
import { aspectMismatch, parseAspect } from "@repokit/presets/path";
import type { PresetDefinition, PresetProps, SlotMedia } from "@repokit/presets/types";

/** `presets/3d/` at the repository root; each subfolder without a leading underscore is a preset. */
const PRESETS_DIR = fileURLToPath(new URL("../../../presets/3d/", import.meta.url));

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const VIDEO_EXT = new Set([".mp4", ".webm", ".mov"]);
/** Aspect difference above which the user is told how the media will be fitted. */
const ASPECT_TOLERANCE = 0.03;
const DEFAULT_WIDTH = 1280;

export interface PresetInfo {
  preset: PresetDefinition;
  dir: string;
  /** Absolute path of preview.gif, or null when the preset has none yet. */
  preview: string | null;
}

export function listPresets(): PresetInfo[] {
  return readdirSync(PRESETS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_") && existsSync(join(PRESETS_DIR, entry.name, "preset.json")))
    .map((entry) => {
      const dir = join(PRESETS_DIR, entry.name);
      const preset = JSON.parse(readFileSync(join(dir, "preset.json"), "utf8")) as PresetDefinition;
      assertValid("preset", preset);
      if (preset.name !== entry.name) throw new Error(`Preset folder "${entry.name}" declares a different name: "${preset.name}"`);
      const preview = join(dir, "preview.gif");
      return { preset, dir, preview: existsSync(preview) ? preview : null };
    })
    .sort((a, b) => a.preset.name.localeCompare(b.preset.name));
}

export function findPreset(name: string): PresetInfo {
  const presets = listPresets();
  const found = presets.find((p) => p.preset.name === name);
  if (!found) throw new UsageError(`Пресет «${name}» не найден. Доступны: ${presets.map((p) => p.preset.name).join(", ")}`);
  return found;
}

async function probeMedia(file: string): Promise<{ width: number; height: number; duration: number }> {
  const out = await runTool("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", file]);
  const info = JSON.parse(out);
  if (!info.streams?.[0]) throw new UsageError(`Не удалось прочитать медиафайл: ${file}`);
  return { width: info.streams[0].width, height: info.streams[0].height, duration: Number(info.format?.duration ?? 0) };
}

export interface PresetOptions {
  /** `id=path` pairs from `--slot`. */
  slots: string[];
  aspect?: string;
  width?: number;
}

export interface ResolvedPreset {
  props: PresetProps;
  files: { source: string; name: string }[];
  warnings: string[];
}

/** Check slot assignments against the preset and prepare render props. */
export async function resolvePreset(repo: string, name: string, options: PresetOptions): Promise<ResolvedPreset> {
  const { preset } = findPreset(name);
  const warnings: string[] = [];

  const assigned = new Map<string, string>();
  for (const pair of options.slots) {
    const separator = pair.indexOf("=");
    if (separator <= 0) throw new UsageError(`--slot ожидает формат id=путь, получено «${pair}»`);
    const id = pair.slice(0, separator);
    if (!preset.slots.some((s) => s.id === id)) {
      throw new UsageError(`У пресета «${name}» нет слота «${id}». Слоты: ${preset.slots.map((s) => s.id).join(", ")}`);
    }
    assigned.set(id, pair.slice(separator + 1));
  }
  const empty = preset.slots.filter((s) => !assigned.has(s.id));
  if (empty.length > 0) {
    throw new UsageError(`Слоты без медиа: ${empty.map((s) => s.id).join(", ")}. Укажите --slot ${empty[0].id}=<файл>`);
  }

  const aspect = options.aspect ?? preset.aspectRatios[0];
  if (!preset.aspectRatios.includes(aspect)) {
    throw new UsageError(`Пресет «${name}» не поддерживает соотношение ${aspect}. Поддерживаются: ${preset.aspectRatios.join(", ")}`);
  }
  const width = options.width ?? DEFAULT_WIDTH;
  // H.264 needs even dimensions.
  const even = (n: number) => Math.round(n / 2) * 2;
  const output = { width: even(width), height: even(width / parseAspect(aspect)) };

  const slots: Record<string, SlotMedia> = {};
  const files: ResolvedPreset["files"] = [];
  for (const slot of preset.slots) {
    const path = assigned.get(slot.id)!;
    const source = insideRepo(repo, path);
    if (!existsSync(source)) throw new UsageError(`Слот «${slot.id}»: файл не найден — ${path}`);
    const extension = extname(source).toLowerCase();
    const kind = IMAGE_EXT.has(extension) ? "image" : VIDEO_EXT.has(extension) ? "video" : null;
    if (!kind) throw new UsageError(`Слот «${slot.id}»: неподдерживаемый формат ${extension}. Изображения: png, jpg, webp; видео: mp4, webm, mov`);
    if (slot.type !== "any" && slot.type !== kind) {
      throw new UsageError(`Слот «${slot.id}» принимает только ${slot.type === "image" ? "изображение" : "видео"}, а получил ${kind === "image" ? "изображение" : "видео"}`);
    }
    if (!findProvenance(repo, source)) {
      warnings.push(`слот «${slot.id}»: происхождение неизвестно — ${path} не записан через repokit capture`);
    }

    const media = await probeMedia(source);
    const mismatch = aspectMismatch(media.width / media.height, slot.aspect);
    if (mismatch > ASPECT_TOLERANCE) {
      const effect = slot.fit === "cover" ? "края будут обрезаны (fit: cover)" : "появятся поля (fit: contain)";
      warnings.push(`слот «${slot.id}»: пропорции медиа ${media.width}×${media.height} не совпадают с экраном (${slot.aspect.toFixed(2)}) — ${effect}`);
    }
    const fileName = `slot-${slot.id}${extension}`;
    files.push({ source, name: fileName });
    slots[slot.id] = {
      src: fileName,
      kind,
      width: media.width,
      height: media.height,
      ...(kind === "video" ? { durationInFrames: Math.max(1, Math.floor(media.duration * preset.fps)) } : {}),
    };
    if (kind === "video" && media.duration * preset.fps < preset.durationInFrames) {
      warnings.push(`слот «${slot.id}»: видео короче пресета (${media.duration.toFixed(1)} с против ${(preset.durationInFrames / preset.fps).toFixed(1)} с) — будет зациклено`);
    }
  }

  return {
    props: { ...output, fps: preset.fps, durationInFrames: preset.durationInFrames, preset, slots },
    files,
    warnings,
  };
}
