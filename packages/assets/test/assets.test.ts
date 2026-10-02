import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { duplicates, inventory, normalizedName } from "../src/index.js";

const BIN = fileURLToPath(new URL("../../cli/dist/bin.js", import.meta.url));
const created: string[] = [];
afterAll(() => created.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function repoWith(files: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), "repokit-assets-"));
  created.push(repo);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  return repo;
}

function cli(repo: string, ...args: string[]): { code: number; data: any } {
  try {
    const out = execFileSync(process.execPath, [BIN, ...args, "--repo", repo, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return { code: 0, data: JSON.parse(out).data };
  } catch (error) {
    const failure = error as { status: number; stdout: string };
    return { code: failure.status, data: JSON.parse(failure.stdout).data };
  }
}

const FILES = {
  "README.md": "# App\n\n![Main screen](docs/assets/Main%20Screen.PNG)\n\n<img src=\"./docs/assets/chart.png\" alt=\"Chart\">\n\n![Gone](docs/assets/gone.png)\n",
  "docs/guide.md": "![Chart](assets/chart.png)\n",
  "docs/assets/Main Screen.PNG": "a",
  "docs/assets/chart.png": "b",
  "docs/assets/old-draft.png": "c",
  "src/logo.png": "d",
};

describe("normalizedName", () => {
  it("makes kebab-case names and keeps good ones", () => {
    expect(normalizedName("Main Screen.PNG")).toBe("main-screen.png");
    expect(normalizedName("heroDark_v2.gif")).toBe("hero-dark-v2.gif");
    expect(normalizedName("hero-dark.gif")).toBe("hero-dark.gif");
  });
});

describe("inventory", () => {
  it("resolves references from every document, relative to that document", () => {
    const inv = inventory(repoWith(FILES));
    expect(inv.dir).toBe("docs/assets");
    expect(inv.assets.map((a) => [a.path, a.references.length])).toEqual([
      ["docs/assets/Main Screen.PNG", 1], ["docs/assets/chart.png", 2], ["docs/assets/old-draft.png", 0],
    ]);
    expect(inv.missing).toEqual([{ file: "README.md", line: 7, target: "docs/assets/gone.png", resolved: "docs/assets/gone.png" }]);
  });

  it("suggests docs/assets when the repository keeps no media yet", () => {
    expect(inventory(repoWith({ "README.md": "# App\n" })).dir).toBe("docs/assets");
  });
});

describe("repokit assets", () => {
  it("check fails on a broken reference and lists what to tidy", () => {
    const { code, data } = cli(repoWith(FILES), "assets", "check");
    expect(code).toBe(1);
    expect(data.unused).toEqual(["docs/assets/old-draft.png"]);
    expect(data.badNames).toEqual(["docs/assets/Main Screen.PNG"]);
    expect(data.missing).toHaveLength(1);
  });

  it("normalize renames the file and updates every reference; --dry-run changes nothing", () => {
    const repo = repoWith(FILES);
    cli(repo, "assets", "normalize", "--dry-run");
    expect(existsSync(join(repo, "docs/assets/Main Screen.PNG"))).toBe(true);
    const { data } = cli(repo, "assets", "normalize");
    expect(data.renamed).toEqual([{ from: "docs/assets/Main Screen.PNG", to: "docs/assets/main-screen.png", references: 1 }]);
    expect(readFileSync(join(repo, "README.md"), "utf8")).toContain("![Main screen](docs/assets/main-screen.png)");
    expect(inventory(repo).assets.find((a) => a.path === "docs/assets/main-screen.png")?.references).toHaveLength(1);
  });

  it("prune moves unused media out of the repository instead of deleting it", () => {
    const repo = repoWith(FILES);
    const { data } = cli(repo, "assets", "prune");
    expect(data.pruned).toEqual([{ path: "docs/assets/old-draft.png", movedTo: ".repokit/assets-pruned/docs/assets/old-draft.png" }]);
    expect(existsSync(join(repo, "docs/assets/old-draft.png"))).toBe(false);
    expect(readFileSync(join(repo, ".repokit/assets-pruned/docs/assets/old-draft.png"), "utf8")).toBe("c");
    expect(existsSync(join(repo, "docs/assets/chart.png"))).toBe(true);
    expect(existsSync(join(repo, "src/logo.png"))).toBe(true);
  });
});

describe("duplicates", () => {
  it("finds identical files and near-identical pictures, not merely similar ones", () => {
    const picture = (changed: number) => {
      const image = new PNG({ width: 40, height: 40 });
      for (let i = 0; i < 1600; i++) image.data.set(i < changed ? [255, 0, 0, 255] : [20, 20, 20, 255], i * 4);
      return PNG.sync.write(image);
    };
    const repo = repoWith({ "README.md": "# App\n" });
    mkdirSync(join(repo, "docs/assets"), { recursive: true });
    writeFileSync(join(repo, "docs/assets/a.png"), picture(0));
    writeFileSync(join(repo, "docs/assets/a-copy.png"), picture(0));
    writeFileSync(join(repo, "docs/assets/b.png"), picture(8));
    writeFileSync(join(repo, "docs/assets/c.png"), picture(800));
    const found = duplicates(repo, ["docs/assets/a.png", "docs/assets/a-copy.png", "docs/assets/b.png", "docs/assets/c.png"]);
    expect(found.map((d) => `${d.a}=${d.b}`)).toEqual(["docs/assets/a.png=docs/assets/a-copy.png", "docs/assets/a.png=docs/assets/b.png"]);
    expect(found[0].difference).toBe(0);
  });
});
