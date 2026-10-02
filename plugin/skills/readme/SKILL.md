---
name: readme
description: Turn a repository's README into a clear, professional presentation of the project — structure chosen by project type, real screenshots, terminal recordings and demo GIFs, examples taken from the code, checks of the first screen. Use when asked to write, improve or review a README, make a GitHub repository look professional or easier to understand, add screenshots, a demo, a banner or an architecture diagram, or prepare a repo for publication. Также по запросам «оформи README», «улучши README», «сделай красивый README», «сделай презентацию GitHub-проекта», «добавь скриншоты и демо в README».
argument-hint: "[what to do, optional]"
---

# README as a presentation of the project

Goal: a first-time visitor understands within a minute what the project is, who it is for, what it does and how to try it.
A good README is structure, plain wording, real visuals and working examples — not decoration.

You work with `repokit`, a command-line tool that is on PATH while this plugin is enabled. It gives facts and checks;
wording and decisions are yours and the user's. It never calls a model and never uses the network unless a command says so.

User's request: $ARGUMENTS

## Rules that hold in every case

1. **Only what is true.** Never invent features, APIs, benchmarks, URLs, compatibility, install commands, environment
   variables, users or integrations. If repokit did not find it and you did not read it in the code, it does not go in.
2. **The existing README matters more than a template.** If `mode` is `improve`, edit the author's text: keep what is
   good, cut noise, reorder, add what is missing. Replace it wholesale only when the user asks for that.
3. **The user decides.** Show a diff before writing README.md. Deploying, releasing, pushing, deleting or renaming the
   user's files happen only after an explicit yes. Exit code 3 means "a person is needed": relay what is asked and wait.
4. **Secrets stay secret.** Do not read `.env` aloud, do not put tokens in commands. If a login is needed, stop and ask.
5. **Do the least that answers the request.** Fixing a table does not need a demo video. A library needs a code example,
   not a browser screenshot.

## How to call repokit

- Shell: `repokit <service> <command> --json` — one JSON envelope on stdout: `ok`, `exitCode`, `data`, `warnings`,
  `humanTodo`, `artifacts`. Human-readable lines go to stderr. `--dry-run` writes nothing. The current directory is the
  target repository; `--repo <path>` names another.
- MCP tools of this plugin do the same with structured input: `analyze_repository`, `plan_readme`, `audit_readme`,
  `generate_presentation`, `capture_demo`, `verify_repository`, `run_repokit`. Prefer them when available; fall back to
  the shell otherwise. Both run the same engine.
- Exit codes: `0` ok · `1` a check failed · `2` wrong usage · `3` a person is needed.
- Working files go to `.repokit/` in the target repository. Suggest adding it to `.gitignore` (`repokit scan init --write-gitignore`).
- Collect `humanTodo` from every answer and show the user one list at the end.

## Workflow

Pick the steps the request needs; this is the full path for "make this README good".

1. **Understand the repository** — `analyze_repository` (or `repokit scan audit`, `repokit readme layout`,
   `repokit examples extract`). Read `projectType` and its `signals`; if `confidence` is below 0.6, open the code and
   confirm with the user. Read the key files yourself before writing about them.
2. **Read the existing README** — `audit_readme` (or `repokit readme audit`). The failed checks are your task list.
3. **Plan** — `plan_readme`. Each section has a priority (`must`, `should`, `optional`, `omit`) and a reason. To change
   the plan, edit `.repokit/readme.layout.json` rather than working around it. A section marked empty needs data from
   the user (`.repokit/readme.human.yaml`: tagline, problem, solution, team) — ask, do not fill it in yourself.
4. **Plan the visuals before making any** — `repokit readme storyboard` writes `.repokit/storyboard.md`: the one picture
   at the top, up to five things to show in the order a newcomer meets them, how to make each, and what is deliberately
   left out. Read it against the code, correct it, and show it to the user. Make only what is in the agreed plan: see
   [references/visuals.md](references/visuals.md). Anything that runs the user's project is agreed with the user first.
5. **Write** — in `improve` mode edit README.md by hand, guided by the audit. Otherwise `generate_presentation`
   without `apply` to get the diff, show it, and only then `apply: true`. Wording rules:
   [references/readme-authoring.md](references/readme-authoring.md).
6. **Check** — `audit_readme` again, then `verify_repository`. Fix the cause (a broken link, a missing alt text), never
   weaken the check. `repokit readme audit --fix` repairs markup only: heading levels, blank lines, very long code blocks.
7. **Report** — files changed, what was verified, and the list of decisions left to the user.

Details of every step and of the less common ones (claims with evidence, hackathon rules, deploy, release, banners,
3D scenes): [references/workflow.md](references/workflow.md). All commands and flags:
[references/cli-reference.md](references/cli-reference.md).

## Language

Write the README in the language of the existing README, or the language the user writes in. repokit generates Russian
by default; pass `--lang en` (or `lang: "en"`) for English.

## When something is missing

- `repokit: command not found` — the plugin is disabled or the shell predates it; ask the user to run `/reload-plugins`.
- A `capture`, `studio` or `preview` command answers with exit code 3 and mentions setup — these need a one-time
  `repokit setup` (downloads a browser engine and a renderer, about 1 GB). Ask the user before running it.
- `repokit doctor` lists external tools (git, ffmpeg, a Chromium browser, gh) and what stops working without each.
