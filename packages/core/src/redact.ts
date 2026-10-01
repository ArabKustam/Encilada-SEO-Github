/**
 * Secret masking. Everything repokit prints or writes as a log goes through
 * `redact`, so a service cannot leak a token even by accident.
 */

const SECRET_ENV_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|CREDENTIAL)/i;
const MIN_SECRET_LENGTH = 8;
const MASK = "[REDACTED]";

const TOKEN_PATTERNS: RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

/** Values of environment variables whose names look like secrets. */
export function secretEnvValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const values: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value && value.length >= MIN_SECRET_LENGTH && SECRET_ENV_NAME.test(name)) values.push(value);
  }
  // Longest first, so a secret containing another one is masked whole.
  return values.sort((a, b) => b.length - a.length);
}

export function redact(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const value of secretEnvValues(env)) out = out.split(value).join(MASK);
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, MASK);
  return out;
}
