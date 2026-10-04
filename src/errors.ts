/**
 * Exit codes are a contract: scripts and agents branch on them, so a code
 * never changes meaning.
 */
export const EXIT = {
  ok: 0,
  /** The tool ran and refused: not found, invalid input, not allowed. */
  refused: 1,
  /**
   * The command line, or a file of the user's it reads, is wrong: unknown
   * command, bad flag value, a link or config file it cannot use. Also a CLI
   * too old for the server, whose message says how to update.
   */
  usage: 2,
  /** Not signed in, or the sign-in is no longer accepted. */
  signIn: 3,
  /** Agentrail or the network could not be reached or failed. */
  unavailable: 4,
  /** A failure the CLI does not know: shown in full, never read as a refusal. */
  unexpected: 5,
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

/**
 * What the innermost cause of a failure says, for a message the user sees:
 * `connect ECONNREFUSED 127.0.0.1:443`, `CERT_HAS_EXPIRED: certificate has
 * expired`. Only its code and message: never a request's headers or a
 * response's body.
 */
export function causeOf(error: unknown): string {
  let inner = error;
  while (inner instanceof Error && inner.cause !== undefined) {
    inner = inner.cause;
  }
  if (!(inner instanceof Error)) return String(inner);
  // A refused connection to a name with several addresses fails once per
  // address, and only those failures carry a message.
  const message =
    inner instanceof AggregateError && inner.message === ''
      ? (inner.errors as unknown[])
          .map((each) => (each instanceof Error ? each.message : String(each)))
          .join('; ')
      : inner.message;
  const code = (inner as { code?: unknown }).code;
  const label =
    typeof code === 'string'
      ? code
      : inner.name === 'Error'
        ? undefined
        : inner.name;
  return label === undefined || message.includes(label)
    ? message
    : `${label}: ${message}`;
}
