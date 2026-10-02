#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { commonFlags, ExitCode, runCommand, say, VERSION, type CommonFlags } from "@repokit/core";
import { registerAssets } from "@repokit/assets";
import { registerBrief } from "@repokit/brief";
import { registerDeploy } from "@repokit/deploy";
import { registerReadme } from "@repokit/readme";
import { registerRelease } from "@repokit/release";
import { registerScan } from "@repokit/scan";
import { QUICKSTART_DESCRIPTION, quickstartCommand, registerVerify } from "@repokit/verify";
import { registerDoctor } from "./doctor.js";
import { registerRun } from "./run.js";
import { delegate, MEDIA_SERVICES, registerSetup } from "./setup.js";

/** Services from DESIGN.md that are not built yet, with the milestone that delivers them. */
const PLANNED: Record<string, string> = {
  polish: "M7",
};

const program = new Command("repokit")
  .description("README как презентация проекта: анализ репозитория, план и сборка README, настоящие скриншоты и демо, проверки")
  .version(VERSION)
  .exitOverride();

/**
 * The media services pull in a browser engine and a video renderer. A checkout has them;
 * the packaged build leaves them out and hands their commands to the full build once
 * `repokit setup` has installed it.
 */
const MEDIA: Record<(typeof MEDIA_SERVICES)[number], { load: () => Promise<(program: Command) => void>; description: string }> = {
  capture: { load: async () => (await import("@repokit/capture")).registerCapture, description: "запись реального демо: веб-приложение по сценарию, скриншот страницы, вывод команды в терминале" },
  studio: { load: async () => (await import("@repokit/studio")).registerStudio, description: "монтаж записей: оформление, авто-зум, 3D-сцены, баннеры, слайды" },
  preview: { load: async () => (await import("@repokit/preview")).registerPreview, description: "предпросмотр README как на GitHub: веб-интерфейс, снимки, проверки вида" },
};

async function registerMedia(name: keyof typeof MEDIA): Promise<void> {
  try {
    (await MEDIA[name].load())(program);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw error;
    program
      .command(name)
      .description(`${MEDIA[name].description} (после repokit setup)`)
      .helpOption(false)
      .allowUnknownOption()
      .allowExcessArguments()
      .action(() => delegate(name));
  }
}

registerScan(program);
await registerMedia("capture");
await registerMedia("studio");
registerBrief(program);
registerReadme(program);
registerAssets(program);
await registerMedia("preview");
registerVerify(program);
registerDeploy(program);
registerRelease(program);
registerRun(program);
registerDoctor(program);
registerSetup(program);

// The same check under the name a README author looks for.
commonFlags(program.commands.find((c) => c.name() === "readme")!.command("verify-quickstart").description(QUICKSTART_DESCRIPTION))
  .option("--source <kind>", "head или worktree", "worktree")
  .action((flags: CommonFlags & { source: string }) => runCommand("readme", "verify-quickstart", flags, () => quickstartCommand(flags)));

for (const [name, milestone] of Object.entries(PLANNED)) {
  program
    .command(name, { hidden: true })
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => {
      say(`Сервис «${name}» ещё не реализован (запланирован на веху ${milestone}, см. DESIGN.md).`);
      process.exitCode = ExitCode.Usage;
    });
}

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (!(error instanceof CommanderError)) throw error;
  // --help and --version are not errors; everything else commander rejects is a usage error.
  process.exitCode = error.exitCode === 0 ? ExitCode.Ok : ExitCode.Usage;
}
