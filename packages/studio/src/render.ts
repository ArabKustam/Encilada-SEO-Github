import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findSystemBrowser, NeedsHumanError } from "@repokit/core";
import { COMPOSITION_ID, type DemoProps } from "./remotion/props.js";

/** The compiled Remotion entry point; the bundler packs it together with the scene sources. */
const ENTRY_POINT = fileURLToPath(new URL("./remotion/index.js", import.meta.url));

export interface RenderOptions {
  props: DemoProps;
  /** Absolute paths of scene sources, in scene order. */
  sources: string[];
  output: string;
  onProgress?: (percent: number) => void;
}

/** Render the composition to an H.264 MP4. */
export async function renderVideo({ props, sources, output, onProgress }: RenderOptions): Promise<void> {
  const browserExecutable = findSystemBrowser();
  if (!browserExecutable) {
    throw new NeedsHumanError("Не найден браузер для рендера. Установите Google Chrome или укажите путь в REPOKIT_BROWSER.");
  }
  // Imported lazily: these packages are heavy and only needed for an actual render.
  const { bundle } = await import("@remotion/bundler");
  const { renderMedia, selectComposition } = await import("@remotion/renderer");

  const work = mkdtempSync(join(tmpdir(), "repokit-studio-"));
  try {
    const publicDir = join(work, "public");
    mkdirSync(publicDir);
    sources.forEach((source, index) => copyFileSync(source, join(publicDir, props.scenes[index].src)));

    const serveUrl = await bundle({ entryPoint: ENTRY_POINT, publicDir, outDir: join(work, "bundle") });
    const inputProps = props;
    const browser = { browserExecutable, chromeMode: "chrome-for-testing" as const, logLevel: "error" as const };
    const composition = await selectComposition({ serveUrl, id: COMPOSITION_ID, inputProps, ...browser });

    mkdirSync(dirname(output), { recursive: true });
    await renderMedia({
      composition,
      serveUrl,
      inputProps,
      codec: "h264",
      crf: 18,
      pixelFormat: "yuv420p",
      outputLocation: output,
      overwrite: true,
      onProgress: ({ progress }) => onProgress?.(Math.round(progress * 100)),
      ...browser,
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
