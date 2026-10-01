#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { ExitCode, say, VERSION } from "@repokit/core";
import { registerBrief } from "@repokit/brief";
import { registerCapture } from "@repokit/capture";
import { registerPreview } from "@repokit/preview";
import { registerReadme } from "@repokit/readme";
import { registerScan } from "@repokit/scan";
import { registerStudio } from "@repokit/studio";
import { registerDoctor } from "./doctor.js";

/** Services from DESIGN.md that are not built yet, with the milestone that delivers them. */
const PLANNED: Record<string, string> = {
  verify: "M5", deploy: "M6", polish: "M7", run: "M5",
};

const program = new Command("repokit")
  .description("Инструменты для честного оформления хакатонного репозитория")
  .version(VERSION)
  .exitOverride();

registerScan(program);
registerCapture(program);
registerStudio(program);
registerBrief(program);
registerReadme(program);
registerPreview(program);
registerDoctor(program);

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
