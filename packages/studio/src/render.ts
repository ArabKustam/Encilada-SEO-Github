import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findSystemBrowser, NeedsHumanError, UsageError } from "@repokit/core";

/** The compiled Remotion entry point; the bundler packs it together with the media files. */
const ENTRY_POINT = fileURLToPath(new URL("./remotion/index.js", import.meta.url));

/** How Chromium draws WebGL. `angle` uses the GPU; `swangle` is a software renderer for machines without one. */
export const GL_BACKENDS = ["angle", "swangle", "swiftshader", "egl", "vulkan"] as const;
export type GlBackend = (typeof GL_BACKENDS)[number];

export function glBackend(requested: string | undefined = process.env.REPOKIT_GL): GlBackend {
  const value = requested ?? "angle";
  if (!GL_BACKENDS.includes(value as GlBackend)) throw new UsageError(`Неизвестный GL-бэкенд «${value}». Доступны: ${GL_BACKENDS.join(", ")}`);
  return value as GlBackend;
}

export interface RenderJob {
  compositionId: string;
  inputProps: Record<string, unknown>;
  /** Media copied into the bundle's public directory under `name`. */
  files: { source: string; name: string }[];
  /** Set for 3D compositions, which need WebGL. */
  gl?: GlBackend;
}

interface Session {
  serveUrl: string;
  composition: Awaited<ReturnType<typeof import("@remotion/renderer").selectComposition>>;
  browser: {
    browserExecutable: string;
    chromeMode: "chrome-for-testing";
    logLevel: "error";
    chromiumOptions?: { gl: GlBackend };
  };
}

/** Bundle the compositions together with the job's media and hand the result to `body`. */
async function withBundle<T>(job: RenderJob, body: (session: Session) => Promise<T>): Promise<T> {
  const browserExecutable = findSystemBrowser();
  if (!browserExecutable) {
    throw new NeedsHumanError("Не найден браузер для рендера. Установите Google Chrome или укажите путь в REPOKIT_BROWSER.");
  }
  // Imported lazily: these packages are heavy and only needed for an actual render.
  const { bundle } = await import("@remotion/bundler");
  const { selectComposition } = await import("@remotion/renderer");

  const work = mkdtempSync(join(tmpdir(), "repokit-studio-"));
  try {
    const publicDir = join(work, "public");
    mkdirSync(publicDir);
    for (const file of job.files) copyFileSync(file.source, join(publicDir, file.name));

    const serveUrl = await bundle({ entryPoint: ENTRY_POINT, publicDir, outDir: join(work, "bundle") });
    const browser: Session["browser"] = {
      browserExecutable,
      chromeMode: "chrome-for-testing",
      logLevel: "error",
      ...(job.gl ? { chromiumOptions: { gl: job.gl } } : {}),
    };
    const composition = await selectComposition({ serveUrl, id: job.compositionId, inputProps: job.inputProps, ...browser });
    return await body({ serveUrl, composition, browser });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Render a composition to an H.264 MP4. */
export async function renderVideo(job: RenderJob, output: string, onProgress?: (percent: number) => void): Promise<void> {
  const { renderMedia } = await import("@remotion/renderer");
  await withBundle(job, async ({ serveUrl, composition, browser }) => {
    mkdirSync(dirname(output), { recursive: true });
    await renderMedia({
      composition,
      serveUrl,
      inputProps: job.inputProps,
      codec: "h264",
      crf: 18,
      pixelFormat: "yuv420p",
      outputLocation: output,
      overwrite: true,
      onProgress: ({ progress }) => onProgress?.(Math.round(progress * 100)),
      ...browser,
    });
  });
}

/** Render single frames to PNG files, sharing one bundle. */
export async function renderStills(job: RenderJob, stills: { frame: number; output: string }[]): Promise<void> {
  const { renderStill } = await import("@remotion/renderer");
  await withBundle(job, async ({ serveUrl, composition, browser }) => {
    for (const still of stills) {
      mkdirSync(dirname(still.output), { recursive: true });
      await renderStill({ composition, serveUrl, inputProps: job.inputProps, frame: still.frame, output: still.output, imageFormat: "png", overwrite: true, ...browser });
    }
  });
}
