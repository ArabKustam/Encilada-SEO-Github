# Visuals

Read this before making screenshots, terminal recordings, demo GIFs, banners or 3D scenes.

Everything here needs the media services: if a command answers with exit code 3 and mentions setup, ask the user to
allow `repokit setup` (one-time, about 1 GB). External tools: a Chromium browser and `ffmpeg` (`repokit doctor`).

## Which visual, if any

| Project | What helps | Command |
|---|---|---|
| Web app, site | 1–3 screenshots or a GIF of the main scenario | `capture screenshot`, `capture run` + `studio render` |
| CLI, developer tool | the real output of the first command a user would run | `capture terminal -- <command>` |
| Library, SDK, API | nothing — a code example does the job | — |
| Several screens to show | a 3D scene made from screenshots | `studio scene gallery`, `studio scene make` |
| "How it works" | architecture walk-through built from the code | `studio explain [--detail full]` |
| Top of the README, social preview | banner | `studio banner` |

Do not add a picture for the sake of having one. Do not show the same thing twice: `repokit assets check` reports
near-identical images.

## Honesty of visuals

- Screens show only real recordings and screenshots of the running project. Never edit the application to get a nicer
  frame and never fake its responses.
- Demo data is fine if it is labelled: `--demo-data` on a screenshot, `demoData: true` in a scenario.
- Log in only with a test account; passwords and tokens come from the environment (`${env:NAME}` in a scenario) and
  fields that show them are masked.
- Look at every image before proposing it: no personal paths, names, secrets or private data in the frame.
- A terminal recording is the true output of the command. A failed run is shown as failed. Do not pick an invocation
  only because its output looks good, and do not trim the output by hand.

## Commands

Running the user's project is their call: agree the command first; `--dry-run` shows the plan.

```bash
repokit capture terminal -- python tool.py --help
repokit capture screenshot --url http://localhost:8000/ --start "npm run dev" --themes light,dark
```

Results go to `docs/assets/` (`terminal.svg` + `terminal-dark.svg`, `screenshot.png` + `screenshot-dark.png`) with a
provenance record in `.repokit/media.manifest.json`. Use them as the main image:

```bash
repokit readme plan --hero docs/assets/terminal.svg --hero-dark docs/assets/terminal-dark.svg
```

A recorded demo of a web app needs a scenario: `repokit capture scenario draft` gives a skeleton; write the steps
after reading the interface code (selectors from the real markup), show the scenario to the user, then
`capture scenario validate`, `capture run`, and `studio render --out docs/media/hero.mp4 --gif` (GIF within 8 MB).

Several screens in 3D:

```bash
repokit studio scene gallery          # one frame of every template on this project's screenshots → .repokit/scenes/index.html
repokit studio scene make --template cube --out pages.scene.json
repokit studio still --scene pages.scene.json --at 2 --out .repokit/out/look.png
repokit studio render --scene pages.scene.json --out docs/media/pages.mp4 --gif
```

Choose a template by looking at the frames, not by its name, and show the user the gallery page. A scene file is plain
JSON: positions, rotations, camera and effects can be edited, then checked with `studio still` before a full render.

Banner and slides: `repokit studio banner --out docs/assets/banner.png [--size wide]`, `repokit studio deck init`,
`repokit studio deck render --deck slides.deck.json --out-dir docs/slides --pdf`. Text comes from the author's fields
and proven claims; technologies from the dependencies.

## Files

- Working files stay in `.repokit/`; finished media lives in one folder (`docs/assets/` unless the repository already
  uses another). `repokit assets check` finds broken links, heavy, unused, duplicate and badly named files.
- `<video>` in a README plays only from a link GitHub issues when a file is dragged into its web editor. Use a GIF or
  WebP as the main media and let the user add a video link themselves.
- Music is never chosen for the user: `--music` takes only a file they provided.
