import { causeOf, CliError, EXIT } from './errors.js';
import type { Runtime } from './runtime.js';

/** A response, read whole. */
export interface Answer {
  readonly status: number;
  readonly ok: boolean;
  readonly text: string;
}

/**
 * Sends a request and reads its whole answer. Not reaching `url` — its name,
 * a refused or dropped connection, TLS, a timeout — is exit code 4, naming
 * the innermost cause; `what` names the server in that message.
 */
export async function send(
  runtime: Runtime,
  url: string,
  init: RequestInit,
  what: string = url,
): Promise<Answer> {
  try {
    const response = await runtime.fetch(url, init);
    return {
      status: response.status,
      ok: response.ok,
      text: await response.text(),
    };
  } catch (error) {
    // fetch rejects with a TypeError when the network fails, and with the
    // signal's TimeoutError when its time runs out.
    if (
      error instanceof TypeError ||
      (error instanceof DOMException && error.name === 'TimeoutError')
    ) {
      throw new CliError(
        EXIT.unavailable,
        `Could not reach ${what} (${causeOf(error)}).`,
        { cause: error },
      );
    }
    throw error;
  }
}

/** The JSON object an answer carries; exit code 4 when it carries none. */
export function jsonObjectOf(
  url: string,
  answer: Answer,
): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(answer.text);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new CliError(
        EXIT.unavailable,
        `${url} answered ${answer.status} without JSON.`,
        { cause: error },
      );
    }
    throw error;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CliError(
      EXIT.unavailable,
      `${url} answered ${answer.status} without a JSON object.`,
    );
  }
  return value as Record<string, unknown>;
}
