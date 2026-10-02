# Workflow in detail

Read this when a step in SKILL.md needs more than its one line.

## 1. Facts about the repository

- `repokit doctor` — external tools. Nothing is installed.
- `repokit scan audit --json` — project types, stack, install/run/test commands, entry points, routes, data models,
  places that look like stubs, repository problems. Entries with `confidence` below 0.6 need a look at the file.
- `repokit scan context` — a digest in `.repokit/context.md` with `keyFiles`; read those files yourself.
- `repokit readme layout --json` — project type, audience, primary action, sections with priorities and reasons, and
  `mode`: `generate` or `improve`.
- `repokit examples extract --json` — real usage examples (files in `examples/`, code blocks in docs, short tests) with
  file, lines and a hash, plus sub-commands and options read from argparse, click, commander, cobra and clap.
- `repokit diagram architecture` — a Mermaid diagram from imports, at most eight blocks. Fewer than three connected
  blocks: do not put a diagram in the README.

## 2. Claims with evidence

The "Features" section is built only from claims that point at code.

1. `repokit scan claims extract` — claims from the existing README go to `.repokit/claims.json` as `unverified`.
2. For each claim find the code that implements it and edit `claims.json`:
   - implemented → `"status": "implemented", "evidence": [{ "file": "app/main.py", "lines": [41, 43] }]`
   - partly → `"partial"` plus a `note` saying what is missing
   - a stub from `scan.mocks` stands behind it → `"mock"`
   - no code found → leave `unverified`. Do not pick "similar" lines.
   You may add claims of your own (`"source": "claude"`) for things the code does and the README does not mention.
3. `repokit scan claims pin`, then `repokit scan claims check`. Exit code 1: fix `claims.json`, not the check.

Unproven claims do not reach the README; stubs go to "Limitations".

## 3. What the author has to say

`repokit readme human` creates `.repokit/readme.human.yaml`: `title`, `tagline`, `problem`, `solution`, `demoUrl`,
`videoUrl`, `heroAlt`, `team`, `stack`, `roadmap`, `skip`. Ask the user; you may propose wording, but write down only
what they confirmed. `repokit preview serve --open` gives them a form in the browser.

## 4. Draft, look, write

- `repokit readme plan [--style …] [--lang en] [--hero <file>] [--hero-dark <file>] [--banner <file>]` — draft in
  `.repokit/readme.draft.md`. "empty" means data is needed, not that it should be made up.
- `repokit readme audit --draft` — check the draft before it becomes the README.
- `repokit preview shot` — PNGs of the draft as GitHub would show it, light and dark, desktop and phone. Open them.
- `repokit readme apply --dry-run` — the diff. Show it. `repokit readme apply` writes; the previous version is kept in
  `.repokit/readme.backup.md`. For a hand-written README the command stops with exit code 3 unless `--regenerate`.
- Do not remove `<!-- FILL: … -->` marks by hand and do not fill them with guesses: they are the list of what the
  person decides.

## 5. Final checks

- `repokit readme audit` — eight categories, each line a concrete check.
- `repokit assets check` — broken media links, heavy, unused, duplicate and badly named files. `assets optimize`,
  `prune`, `normalize` change the user's files: `--dry-run` first, then ask.
- `repokit verify run --source worktree` before a commit, `repokit verify run` after. `--exec` runs the quick-start
  commands from the README in a temporary copy and `--online` follows external links: both need the user's consent.
- A secret found by `verify` is not fixed by deleting it from the file: tell the user the key must be revoked.

## Less common tasks

- **Whole pipeline:** `repokit run <path>` walks scan → claims → demo → readme → audit → verify and stops with exit
  code 3 where a person is needed. Pass `--approve demo` / `--approve readme` only after the user agreed to that step.
- **Hackathon entry:** `repokit brief extract --file <rules>`, fill `.repokit/brief.json` strictly from the text of
  the rules (every criterion with a verbatim `quote`), `repokit brief validate`. A "For judges" section then appears.
- **Deploy:** `repokit deploy detect`, `deploy plan`, `deploy apply --dry-run`, `deploy apply`. `deploy run --confirm`
  publishes the project: the user runs it, after an explicit "yes, publish". Never log in for the user.
- **Release:** `repokit release plan` drafts notes from facts; `release create --confirm` is the user's to run.
