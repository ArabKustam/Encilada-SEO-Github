import MarkdownIt from "markdown-it";
import sanitizeHtml from "sanitize-html";
import { slug } from "@repokit/readme";

export type Theme = "light" | "dark";

/** Prefix under which the preview server exposes files of the repository. */
export const REPO_PREFIX = "/repo/";

const ALERTS: Record<string, string> = { NOTE: "Note", TIP: "Tip", IMPORTANT: "Important", WARNING: "Warning", CAUTION: "Caution" };

const isRelative = (url: string) => !/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(url);
const toRepoUrl = (url: string) => (isRelative(url) ? REPO_PREFIX + url.replace(/^\.\//, "") : url);
const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function createMarkdown() {
  const md = new MarkdownIt({ html: true, linkify: true });

  // GitHub gives every heading an anchor; repeated headings get -1, -2, …
  md.core.ruler.push("heading_ids", (state) => {
    const seen = new Map<string, number>();
    state.tokens.forEach((token, index) => {
      if (token.type !== "heading_open") return;
      const base = slug(state.tokens[index + 1].children?.map((t) => t.content).join("") ?? "");
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      token.attrSet("id", count === 0 ? base : `${base}-${count}`);
    });
  });

  const fence = md.renderer.rules.fence!;
  md.renderer.rules.fence = (tokens, index, options, env, self) => {
    const token = tokens[index];
    if (token.info.trim() === "mermaid") return `<pre class="mermaid">${escapeHtml(token.content)}</pre>\n`;
    return fence(tokens, index, options, env, self);
  };
  return md;
}

const markdown = createMarkdown();

/** The tags and attributes GitHub keeps in a README. Styles, scripts and event handlers are dropped. */
const SANITIZE: sanitizeHtml.IOptions = {
  allowedTags: [
    "h1", "h2", "h3", "h4", "h5", "h6", "p", "div", "span", "a", "img", "picture", "source", "details", "summary",
    "table", "thead", "tbody", "tr", "th", "td", "pre", "code", "blockquote", "ul", "ol", "li", "hr", "br",
    "strong", "b", "em", "i", "del", "s", "sub", "sup", "kbd", "dl", "dt", "dd",
  ],
  allowedAttributes: {
    "*": ["align", "id"],
    a: ["href", "title"],
    img: ["src", "alt", "width", "height", "title"],
    source: ["srcset", "media"],
    details: ["open"],
    th: ["align", "colspan", "rowspan"],
    td: ["align", "colspan", "rowspan"],
    pre: ["class"],
    code: ["class"],
    div: ["class", "align"],
    p: ["class", "align"],
  },
  allowedClasses: {
    pre: ["mermaid"],
    code: [/^language-/],
    div: [/^markdown-alert/],
    p: ["markdown-alert-title"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowProtocolRelative: false,
  transformTags: {
    img: (tagName, attribs) => ({ tagName, attribs: { ...attribs, ...(attribs.src ? { src: toRepoUrl(attribs.src) } : {}) } }),
    source: (tagName, attribs) => ({ tagName, attribs: { ...attribs, ...(attribs.srcset ? { srcset: toRepoUrl(attribs.srcset) } : {}) } }),
    a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, ...(attribs.href ? { href: toRepoUrl(attribs.href) } : {}) } }),
  },
};

/** `> [!NOTE]` blockquotes become GitHub-style alerts. */
function alerts(html: string): string {
  return html.replace(/<blockquote>\s*<p>\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(?:<br\s*\/?>)?\s*([\s\S]*?)<\/blockquote>/g, (_, kind: string, rest: string) =>
    `<div class="markdown-alert markdown-alert-${kind.toLowerCase()}"><p class="markdown-alert-title">${ALERTS[kind]}</p><p>${rest}</div>`);
}

/**
 * GitHub picks a `<picture>` source by the reader's colour scheme. The preview has an
 * explicit theme switch instead, so the matching source is chosen here.
 */
function resolvePictures(html: string, theme: Theme): string {
  return html.replace(/<picture>([\s\S]*?)<\/picture>/g, (_, inner: string) => {
    const img = inner.match(/<img\b[^>]*>/)?.[0];
    if (!img) return "";
    const sources = [...inner.matchAll(/<source\b[^>]*>/g)].map((m) => m[0]);
    const chosen = sources.find((s) => new RegExp(`prefers-color-scheme:\\s*${theme}`).test(s))?.match(/srcset="([^"]+)"/)?.[1];
    return chosen ? img.replace(/src="[^"]*"/, `src="${chosen}"`) : img;
  });
}

/** Render README Markdown the way GitHub would show it, for the given theme. */
export function renderMarkdown(source: string, theme: Theme): string {
  return resolvePictures(sanitizeHtml(alerts(markdown.render(source)), SANITIZE), theme);
}

export interface PageOptions {
  theme: Theme;
  title: string;
}

/** A standalone page with the rendered README inside a GitHub-like frame. */
export function renderPage(source: string, { theme, title }: PageOptions): string {
  const dark = theme === "dark";
  return `<!doctype html>
<html lang="ru" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/vendor/github-markdown-${theme}.css">
<style>
  html { color-scheme: ${theme}; }
  body { margin: 0; padding: 24px 16px 48px; background: ${dark ? "#0d1117" : "#ffffff"}; }
  .frame { box-sizing: border-box; max-width: 1012px; margin: 0 auto; border: 1px solid ${dark ? "#30363d" : "#d0d7de"}; border-radius: 6px; }
  .frame-title { padding: 12px 16px; border-bottom: 1px solid ${dark ? "#30363d" : "#d0d7de"}; font: 600 14px -apple-system, "Segoe UI", sans-serif; color: ${dark ? "#e6edf3" : "#1f2328"}; }
  .markdown-body { box-sizing: border-box; padding: 32px; }
  .markdown-body pre.mermaid { background: transparent; text-align: center; }
  .markdown-alert { padding: 8px 16px; margin-bottom: 16px; border-left: 4px solid #0969da; }
  .markdown-alert-title { font-weight: 600; margin-bottom: 4px; }
  @media (max-width: 600px) { body { padding: 8px 0 24px; } .markdown-body { padding: 16px; } .frame { border-left: 0; border-right: 0; border-radius: 0; } }
</style>
</head>
<body>
<div class="frame">
  <div class="frame-title">README.md</div>
  <article class="markdown-body">${renderMarkdown(source, theme)}</article>
</div>
<script src="/vendor/mermaid.min.js"></script>
<script>
  // data-ready tells screenshot tools that diagrams are drawn and the page is final.
  (async () => {
    const done = () => { document.documentElement.dataset.ready = "1"; };
    try {
      if (document.querySelector("pre.mermaid")) {
        mermaid.initialize({ startOnLoad: false, theme: ${JSON.stringify(dark ? "dark" : "default")}, securityLevel: "strict" });
        await mermaid.run();
      }
    } catch (error) {
      document.documentElement.dataset.mermaidError = String(error && error.message || error);
    }
    done();
  })();
</script>
</body>
</html>`;
}
