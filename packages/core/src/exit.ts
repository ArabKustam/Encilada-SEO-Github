/** Exit codes shared by every repokit service. */
export const ExitCode = {
  Ok: 0,
  CheckFailed: 1,
  Usage: 2,
  NeedsHuman: 3,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/** Wrong flags, missing files, invalid input documents → exit 2. */
export class UsageError extends Error {}

/** A login or a decision only the user can make → exit 3. */
export class NeedsHumanError extends Error {}
