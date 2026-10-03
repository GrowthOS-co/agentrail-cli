/**
 * Exit codes are a contract: scripts and agents branch on them, so a code
 * never changes meaning.
 */
export const EXIT = {
  ok: 0,
  /** The tool ran and refused: not found, invalid input, not allowed. */
  refused: 1,
  /** The command line itself is wrong: unknown command, bad flag value. */
  usage: 2,
  /** Not signed in, or the sign-in is no longer accepted. */
  signIn: 3,
  /** Agentrail or the network could not be reached or failed. */
  unavailable: 4,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** A failure the user can act on: its message names what to run next. */
export class CliError extends Error {
  constructor(
    readonly exitCode: ExitCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CliError';
  }
}
