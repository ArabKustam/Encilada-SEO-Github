import type { StageIcon } from "@repokit/presets/stage-types";

/**
 * Generic icons drawn for repokit: simple filled shapes in a 24-unit box.
 * They are filled with the even-odd rule, so inner shapes read as holes.
 */
const GENERIC: Record<string, string> = {
  user: "M12 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Zm0 2c-4.4 0-8 2.2-8 5v2h16v-2c0-2.8-3.6-5-8-5Z",
  browser: "M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5Zm2 4v10h14V9H5Zm1-3.5a1 1 0 1 0 2 0 1 1 0 0 0-2 0Zm3 0a1 1 0 1 0 2 0 1 1 0 0 0-2 0Z",
  server: "M4 4h16a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm2 2.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2ZM4 13h16a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1Zm2 2.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z",
  database: "M12 3c-4.4 0-8 1.3-8 3v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6c0-1.7-3.6-3-8-3Zm0 2c3.6 0 6 .9 6 1s-2.4 1-6 1-6-.9-6-1 2.4-1 6-1ZM6 8.3c1.5.5 3.6.7 6 .7s4.5-.2 6-.7V12c0 .1-2.4 1-6 1s-6-.9-6-1V8.3Zm0 6c1.5.5 3.6.7 6 .7s4.5-.2 6-.7V18c0 .1-2.4 1-6 1s-6-.9-6-1v-3.7Z",
  file: "M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm7 1.5V9h5.5L13 3.5Z",
  cloud: "M7 19a5 5 0 0 1-.6-9.96A6.5 6.5 0 0 1 19 10.5 4.25 4.25 0 0 1 18.25 19H7Z",
  bolt: "M13 2 4 14h6l-1 8 9-12h-6l1-8Z",
  lock: "M7 10V7a5 5 0 0 1 10 0v3h1a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h1Zm2 0h6V7a3 3 0 0 0-6 0v3Z",
  box: "M12 2 3 6.5v11L12 22l9-4.5v-11L12 2Zm0 2.2 6.3 3.2L12 10.5 5.7 7.4 12 4.2ZM5 9.1l6 3v7.3l-6-3V9.1Zm8 10.3v-7.3l6-3v7.3l-6 3Z",
  terminal: "M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5Zm3.3 4.7 2.6 2.3-2.6 2.3 1.3 1.5L12 12 7.6 8.2 6.3 9.7ZM12 14.5v2h6v-2h-6Z",
  star: "m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1L12 2Z",
};

export const GENERIC_ICONS = Object.keys(GENERIC);

type SimpleIcon = { title: string; slug: string; path: string; hex: string };
let brandIcons: Map<string, SimpleIcon> | null = null;

/** Brand icons come from the simple-icons package (CC0); loaded only when a scene or a slide asks for one. */
async function brands(): Promise<Map<string, SimpleIcon>> {
  if (!brandIcons) {
    const module = (await import("simple-icons")) as unknown as Record<string, SimpleIcon>;
    brandIcons = new Map();
    for (const icon of Object.values(module)) {
      if (!icon?.slug) continue;
      brandIcons.set(icon.slug, icon);
      brandIcons.set(icon.title.toLowerCase(), icon);
    }
  }
  return brandIcons;
}

export interface ResolvedIcon extends StageIcon {
  /** Brand colour for brand icons, as a hex string without the hash. */
  hex?: string;
}

/** An icon by name: one of the generic ones, or a technology's logo by its simple-icons slug or title. */
export async function resolveIcon(name: string): Promise<ResolvedIcon | null> {
  const key = name.trim().toLowerCase();
  if (GENERIC[key]) return { path: GENERIC[key], viewBox: 24 };
  const brand = (await brands()).get(key) ?? (await brands()).get(key.replace(/[\s.]+/g, ""));
  return brand ? { path: brand.path, viewBox: 24, hex: brand.hex } : null;
}
