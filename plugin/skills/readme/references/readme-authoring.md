# Writing the README

Read this before editing or writing README text.

## The first screen

Before the first `##` heading a visitor should get: the name, one or two sentences saying what the project does and
for whom, and an obvious next step (a link to a demo or docs, or an install section right below). For projects with an
interface — one real image. At most six badges; three is typical. No table of contents above the description.
`repokit readme hero-check` checks exactly this.

## Structure by kind of project

Starting points, not templates — a section goes in only if it has something to show.

| Kind | Lead with | Must have |
|---|---|---|
| Web app | screenshot or GIF of the main scenario | features, quick start |
| CLI | install and one command with its output | quick start, usage, commands |
| Library | minimal code example | install, usage |
| SDK | minimal code example | install, usage, configuration |
| API / backend | how to run it, list of endpoints | quick start, API, configuration |
| AI agent | what it can do and what it needs | features, quick start, configuration, usage |
| Mobile, desktop, game | screenshots | features, quick start |
| ML / research | the idea and how to reproduce | quick start, usage |
| Developer tool | install and example | quick start, usage |
| Template | what is inside, how to start | features, quick start |
| Monorepo | list of packages | packages, quick start |
| Infrastructure | what it deploys and what that takes | architecture, quick start, configuration |

Priorities: **must** — without it the README does not answer the main question; **should** — useful to most readers;
**optional** — nice to have; **hide** — long reference material goes into `<details>` or `docs/`. Installing and
running are never collapsed.

## Wording

- Start with what the project does. Not "Welcome to", not "This is a powerful modern solution".
- No empty praise: powerful, revolutionary, next-generation, cutting-edge, seamless, game-changing, best-in-class,
  мощный, революционный, инновационный, уникальное решение.
- Measurable qualities — fast, scalable, production-ready, secure — only next to a number or a link to a measurement.
- Do not explain the obvious and do not say the same thing in two sections.
- Short paragraphs. A paragraph over 120 words is split or cut.
- Commands in fenced blocks with a language (`bash`), one logical step per block.

## Examples

Use real ones: `repokit examples extract` gives code with its file and lines. Copy verbatim and link to the source.
If the repository has no example, propose adding a file to `examples/` and make sure it runs — do not compose an
example in the README that nothing has ever executed.

## Tables, details, formatting

- A table earns its place from three rows; two items read better as a list. No more than six columns.
- `<details>` for long reference sections (full option lists, many endpoints, long configuration).
- One `#` heading — the project name. Heading levels go down one step at a time. No emoji in headings.
- `<picture>` with `prefers-color-scheme` when an image has light and dark variants. Every image has alt text that says
  what is shown.
- Mermaid diagrams only when they explain the system: five to ten blocks.
- Keep it short: well-kept READMEs run around 160 lines and six sections. Detail belongs in `docs/`.
- Relative links for files in the repository; do not hardcode the default branch name.

## Environment variables and quick start

The quick start must work from a clean clone: clone, install, set what is required, run. `repokit readme audit` lists
environment variables the code reads that the README does not mention, with file and line; required ones are an error.
Mention `.env.example` if the repository has one. Never write a value of a secret.
