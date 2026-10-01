/** Built-in secret scan: well-known token shapes plus high-entropy values assigned to secret-looking names. */

export interface SecretFinding {
  rule: string;
  file: string;
  line: number;
  /** A masked hint: never the secret itself. */
  preview: string;
}

const TOKEN_RULES: [string, RegExp][] = [
  ["private-key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["github-pat", /\bgithub_pat_[A-Za-z0-9_]{40,}/],
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{20,}/],
  ["stripe-live-key", /\b[sr]k_live_[A-Za-z0-9]{20,}/],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["llm-api-key", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/],
];

/** `API_KEY = "…"`, `"password": "…"`, `token: '…'` */
const ASSIGNMENT = /(?:api[_-]?key|secret|token|passw(?:or)?d|credential)[\w.-]*["']?\s*[:=]\s*["']([^"'\s]{16,})["']/i;
/** Values that are obviously not real: documentation examples, templates, references to the environment. */
const PLACEHOLDER = /example|placeholder|changeme|change[_-]me|your[_-]|xxxx|dummy|sample|<|>|\$\{|\{\{|process\.env|os\.environ|0{8,}|12345678/i;
const MIN_ENTROPY = 3.5;
const SKIPPED_FILES = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|poetry\.lock|Cargo\.lock|uv\.lock)$|\.min\.(js|css)$|\.map$/;

/** Shannon entropy in bits per character; random keys score high, words and repeated characters low. */
export function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

const mask = (value: string) => `${value.slice(0, 4)}…(${value.length} символов)`;

export function scanForSecrets(file: string, text: string): SecretFinding[] {
  if (SKIPPED_FILES.test(file)) return [];
  const findings: SecretFinding[] = [];
  text.split(/\r?\n/).forEach((content, index) => {
    const line = index + 1;
    for (const [rule, pattern] of TOKEN_RULES) {
      const match = content.match(pattern);
      if (match) {
        findings.push({ rule, file, line, preview: mask(match[0]) });
        return;
      }
    }
    const assigned = content.match(ASSIGNMENT)?.[1];
    if (assigned && !PLACEHOLDER.test(assigned) && entropy(assigned) >= MIN_ENTROPY) {
      findings.push({ rule: "generic-secret", file, line, preview: mask(assigned) });
    }
  });
  return findings;
}

export interface HiddenTextFinding {
  kind: "reviewer-instruction" | "invisible-characters" | "hidden-html";
  file: string;
  line: number;
  message: string;
}

/** Text aimed at an automated reviewer rather than at a reader. */
const REVIEWER_INSTRUCTIONS: RegExp[] = [
  /(ignore|disregard|forget)\s+(all\s+)?(the\s+)?(previous|prior|above|earlier)\s+(instructions|prompts?|rules)/i,
  /(rate|score|grade|rank|evaluate)\s+(this|the)\s+(project|repo(sitory)?|submission|code|work)[^.\n]{0,60}(highly|highest|maximum|top|10\s*\/\s*10|full marks|best)/i,
  /(give|award|assign)\s+(this|the|it)[^.\n]{0,40}(highest|maximum|top|full)\s+(score|marks|rating|points)/i,
  /(if you are|you are|as) an?\s+(ai|llm|language model|automated)[^.\n]{0,80}(review|judg|evaluat|grad|scor)/i,
  // \w does not cover Cyrillic, hence the explicit letter class and the `u` flag.
  /игнорируй\p{L}*\s+(все\s+)?(предыдущ|прежн|вышеуказанн)\p{L}*\s+(инструкци|указани|правил)/iu,
  /(оцени|поставь|выстави)\p{L}*[^.\n]{0,60}(максимальн|высш|наивысш|10\s*(из|\/)\s*10|высокую оценку|высоко)/iu,
  /если ты\s+(ии|нейросеть|llm|языковая модель|искусственный интеллект)/iu,
];
// Zero-width and bidi-control characters; a BOM at the very start of a file is harmless and skipped.
const INVISIBLE = /[​-‏‪-‮⁠-⁤﻿]/;
const HIDDEN_HTML = /style\s*=\s*["'][^"']*(display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|opacity\s*:\s*0(?![.\d])|color\s*:\s*(#fff(fff)?\b|white|transparent))/i;

export function scanForHiddenText(file: string, text: string): HiddenTextFinding[] {
  const findings: HiddenTextFinding[] = [];
  const isDocument = /\.(md|markdown|html?|txt|rst)$/i.test(file);
  text.replace(/^﻿/, "").split(/\r?\n/).forEach((content, index) => {
    const line = index + 1;
    if (REVIEWER_INSTRUCTIONS.some((pattern) => pattern.test(content))) {
      findings.push({ kind: "reviewer-instruction", file, line, message: "текст, обращённый к автоматическому проверяющему" });
    }
    if (INVISIBLE.test(content)) findings.push({ kind: "invisible-characters", file, line, message: "невидимые символы (нулевой ширины или управляющие направлением текста)" });
    // Inline styles are ordinary in application code; in documents they only serve to hide text from readers.
    if (isDocument && HIDDEN_HTML.test(content)) findings.push({ kind: "hidden-html", file, line, message: "HTML со стилем, скрывающим текст от читателя" });
  });
  return findings;
}
