import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { NeedsHumanError, UsageError } from "@repokit/core";
import { analyze } from "@repokit/scan";
import { candidates, envVarNames, hostedStartCommand, planDeploy, runDeploy, waitForUrl, type Executor } from "../src/index.js";

const EXAMPLES = fileURLToPath(new URL("../../../examples/", import.meta.url));
const temps: string[] = [];
afterAll(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A copy of a fixture outside any git repository, so that plans do not depend on repokit's own remote. */
function fixture(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `repokit-deploy-${name}-`));
  temps.push(dir);
  cpSync(join(EXAMPLES, name), dir, { recursive: true, filter: (source) => !source.includes(".repokit") && !source.includes("docs") });
  return dir;
}
const planFor = (name: string, provider?: string) => {
  const repo = fixture(name);
  return { repo, plan: planDeploy(repo, analyze(repo), provider) };
};

describe("decision table", () => {
  const first = (name: string) => candidates(analyze(join(EXAMPLES, name)))[0]?.provider;

  it("recommends a provider that fits the kind of project", () => {
    expect(first("static-site")).toBe("github-pages");
    expect(first("web-app")).toBe("render");
    expect(first("web-app-node")).toBe("render");
  });

  it("recommends nothing for a project that is not a web application", () => {
    expect(candidates(analyze(join(EXAMPLES, "cli-tool")))).toEqual([]);
    expect(() => planFor("cli-tool")).toThrow(UsageError);
  });

  it("rejects a provider it does not know", () => {
    expect(() => planFor("static-site", "geocities")).toThrow(/Неизвестный провайдер/);
  });
});

describe("planDeploy", () => {
  it("generates a GitHub Pages workflow for a static site and asks for a GitHub repository", () => {
    const { plan } = planFor("static-site");
    const [workflow] = plan.files;
    expect(workflow).toMatchObject({ path: ".github/workflows/pages.yml", state: "new" });
    expect(workflow.content).toContain("uses: actions/deploy-pages@v4");
    expect(workflow.content).toContain("          path: .");
    expect(workflow.content).toContain("pages: write");
    // Outside a GitHub repository there is nothing to run automatically yet.
    expect(plan.commands).toEqual([]);
    expect(plan.humanSteps[0]).toContain("создайте репозиторий на GitHub");
    expect(plan.envVars).toEqual([]);
  });

  it("describes a Python API for Render with a start command that listens on the assigned port", () => {
    const { plan } = planFor("web-app");
    expect(plan.files[0].path).toBe("render.yaml");
    expect(plan.files[0].content).toBe([
      "services:", "  - type: web", `    name: ${plan.files[0].content.match(/name: (.+)/)![1]}`, "    runtime: python", "    plan: free",
      "    buildCommand: pip install -r requirements.txt", "    startCommand: uvicorn app.main:app --host 0.0.0.0 --port $PORT", "    healthCheckPath: /health", "",
    ].join("\n"));
    expect(plan.provider.automated).toBe(false);
    expect(plan.warnings.some((w) => w.includes("усыпляет"))).toBe(true);
    expect(plan.humanSteps.some((s) => s.includes("Blueprint"))).toBe(true);
  });

  it("generates a Dockerfile only when the project has none", () => {
    const { repo, plan } = planFor("web-app", "fly");
    expect(plan.files.map((f) => f.path)).toEqual(["Dockerfile", "fly.toml"]);
    expect(plan.files[0].content).toContain('CMD ["uvicorn","app.main:app","--host","0.0.0.0","--port","8080"]');

    writeFileSync(join(repo, "Dockerfile"), "FROM scratch\n");
    expect(planDeploy(repo, analyze(repo), "fly").files.map((f) => f.path)).toEqual(["fly.toml"]);
  });

  it("warns instead of pretending when the provider does not fit", () => {
    expect(planFor("web-app", "github-pages").plan.warnings.join(" ")).toContain("серверная часть проекта работать не будет");
    expect(planFor("web-app-node", "vercel").plan.warnings.join(" ")).toContain("переделать под функции");
  });

  it("reports existing config files without overwriting them", () => {
    const { repo, plan } = planFor("web-app");
    writeFileSync(join(repo, "render.yaml"), plan.files[0].content);
    expect(planDeploy(repo, analyze(repo)).files[0].state).toBe("same");
    writeFileSync(join(repo, "render.yaml"), "services: []\n");
    expect(planDeploy(repo, analyze(repo)).files[0].state).toBe("differs");
  });

  it("lists the names of environment variables the code reads, never their values", () => {
    const repo = fixture("web-app-node");
    writeFileSync(join(repo, "config.js"), 'const key = process.env.STRIPE_KEY;\nconst db = process.env.DATABASE_URL;\nconst port = process.env.PORT;\n');
    writeFileSync(join(repo, ".env"), "STRIPE_KEY=do-not-read-me\n");
    expect(envVarNames(repo)).toEqual(["DATABASE_URL", "STRIPE_KEY"]);
    const plan = planDeploy(repo, analyze(repo));
    expect(plan.files[0].content).toContain("      - key: STRIPE_KEY\n        sync: false");
    expect(JSON.stringify(plan)).not.toContain("do-not-read-me");
    expect(plan.humanSteps[plan.humanSteps.length - 1]).toContain("DATABASE_URL, STRIPE_KEY");
  });

  it("adapts run commands to a host-assigned port", () => {
    expect(hostedStartCommand(analyze(join(EXAMPLES, "web-app")))).toBe("uvicorn app.main:app --host 0.0.0.0 --port $PORT");
    expect(hostedStartCommand(analyze(join(EXAMPLES, "web-app-node")))).toBe("npm start");
    expect(hostedStartCommand(analyze(join(EXAMPLES, "static-site")))).toBeNull();
  });
});

describe("runDeploy", () => {
  const vercelPlan = () => {
    const repo = fixture("web-app-node");
    return { repo, plan: planDeploy(repo, analyze(repo), "vercel") };
  };
  const recorder = (answers: Record<string, { code: number; output: string }>) => {
    const calls: string[] = [];
    const execute: Executor = (command) => {
      calls.push(command.join(" "));
      return answers[command.join(" ")] ?? { code: 0, output: "" };
    };
    return { calls, execute };
  };

  it("stops and names the login command when the user is not signed in", () => {
    const { repo, plan } = vercelPlan();
    const { calls, execute } = recorder({ "vercel whoami": { code: 1, output: "Error: No existing credentials found." } });
    expect(() => runDeploy(repo, plan, execute)).toThrow(/vercel login/);
    expect(() => runDeploy(repo, plan, execute)).toThrow(NeedsHumanError);
    // Nothing beyond the identity check was attempted.
    expect(new Set(calls)).toEqual(new Set(["vercel whoami"]));
  });

  it("says how to install the CLI when it is missing", () => {
    const { repo, plan } = vercelPlan();
    const { execute } = recorder({ "vercel whoami": { code: 1, output: "'vercel' is not recognized as an internal or external command" } });
    expect(() => runDeploy(repo, plan, execute)).toThrow(/npm install -g vercel/);
  });

  it("runs the provider's command and reads the address it prints", () => {
    const { repo, plan } = vercelPlan();
    const { calls, execute } = recorder({ "vercel deploy --prod --yes": { code: 0, output: "Production: https://linkshelf-abc123.vercel.app [2s]" } });
    const outcome = runDeploy(repo, plan, execute);
    expect(calls).toEqual(["vercel whoami", "vercel deploy --prod --yes"]);
    expect(outcome).toMatchObject({ url: "https://linkshelf-abc123.vercel.app", executed: [{ ok: true }] });
  });

  it("reports a failed deployment without hiding the provider's message", () => {
    const { repo, plan } = vercelPlan();
    const { execute } = recorder({ "vercel deploy --prod --yes": { code: 1, output: "Error: Build failed" } });
    expect(runDeploy(repo, plan, execute).executed).toEqual([{ command: "vercel deploy --prod --yes", ok: false, output: "Error: Build failed" }]);
  });

  it("refuses to deploy before the configuration is written", () => {
    const repo = fixture("web-app");
    expect(() => runDeploy(repo, planDeploy(repo, analyze(repo), "fly"), recorder({}).execute)).toThrow(/deploy apply/);
  });

  it("hands over to the person when the provider has no deploy command", () => {
    const { repo, plan } = planFor("web-app");
    writeFileSync(join(repo, "render.yaml"), plan.files[0].content);
    const { calls, execute } = recorder({});
    expect(() => runDeploy(repo, planDeploy(repo, analyze(repo)), execute)).toThrow(NeedsHumanError);
    expect(calls).toEqual([]);
  });
});

describe("waitForUrl", () => {
  let server: Server;
  let requests = 0;
  const listen = (failures: number) =>
    new Promise<string>((resolve) => {
      requests = 0;
      server = createServer((_, res) => {
        requests += 1;
        res.writeHead(requests > failures ? 200 : 503).end();
      }).listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`));
    });
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));

  it("keeps trying while the app wakes up", async () => {
    const url = await listen(2);
    expect(await waitForUrl(url, 5_000, 50)).toMatchObject({ healthy: true, status: 200, attempts: 3 });
    await close();
  });

  it("gives up when the app never answers successfully", async () => {
    const url = await listen(Infinity);
    expect(await waitForUrl(url, 300, 50)).toMatchObject({ healthy: false, status: 503 });
    await close();
  });

  it("treats a refused connection as not healthy rather than crashing", async () => {
    const url = await listen(0);
    await close();
    expect(await waitForUrl(url, 200, 50)).toMatchObject({ healthy: false, status: null });
  });
});

describe("README integration", () => {
  it("is exercised in the readme package: the deployed address is read from .repokit/deploy.json", () => {
    // Guard against the two packages drifting apart on the file's shape.
    const source = readFileSync(fileURLToPath(new URL("../../readme/src/context.ts", import.meta.url)), "utf8");
    expect(source).toContain('readArtifact(repo, "deploy.json")');
  });
});
