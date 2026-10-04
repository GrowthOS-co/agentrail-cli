import { join } from 'node:path';

import { CliError, EXIT } from './errors.js';
import { isSystemError, readJson, writePrivateJson } from './files.js';
import { jsonObjectOf, send } from './http.js';
import type { Runtime } from './runtime.js';
import { VERSION } from './version.js';
import { channelOf, isNewer } from './versions.js';

const DIST_TAGS_URL =
  'https://registry.npmjs.org/-/package/agentrail-cli/dist-tags';
const CHECK_EVERY_MS = 24 * 60 * 60_000;
/** The daily check never holds a command up longer than this. */
const NOTICE_TIMEOUT_MS = 2_000;
/** `agentrail update` is asked for, so it waits longer for an answer. */
export const UPDATE_TIMEOUT_MS = 10_000;

export interface NewestVersion {
  readonly installed: string;
  readonly channel: 'latest' | 'next';
  readonly newest: string | undefined;
  readonly upgrade: string;
}

/**
 * The newest version on the installed version's channel, from npm. An answer
 * other than npm's dist-tags is exit code 4, naming what npm answered.
 */
export async function newestVersion(
  runtime: Runtime,
  timeoutMs: number,
): Promise<NewestVersion> {
  const channel = channelOf(VERSION);
  const answer = await send(
    runtime,
    DIST_TAGS_URL,
    { signal: AbortSignal.timeout(timeoutMs) },
    'the npm registry',
  );
  if (!answer.ok) {
    throw new CliError(
      EXIT.unavailable,
      `The npm registry answered ${answer.status} for agentrail-cli.`,
    );
  }
  const newest = jsonObjectOf(DIST_TAGS_URL, answer)[channel];
  return {
    installed: VERSION,
    channel,
    newest: typeof newest === 'string' ? newest : undefined,
    upgrade: `npm install -g agentrail-cli@${channel}`,
  };
}

function disabled(runtime: Runtime, argv: readonly string[]): boolean {
  return (
    Boolean(runtime.env.AGENTRAIL_NO_UPDATE_CHECK) ||
    argv.includes('--no-update-check') ||
    argv.includes('update')
  );
}

/** When the last check was, in milliseconds; 0 when there was none. */
async function lastCheckedAt(path: string): Promise<number> {
  let last: unknown;
  try {
    last = await readJson(path);
  } catch (error) {
    // A file cut short or edited by hand counts as no check, and the check
    // about to run replaces it.
    if (error instanceof SyntaxError) return 0;
    throw error;
  }
  const checkedAt = (last as { checkedAt?: unknown } | null | undefined)
    ?.checkedAt;
  return typeof checkedAt === 'string' ? new Date(checkedAt).getTime() : 0;
}

/**
 * At most once a day, asks npm whether a newer version exists (CLI-008) and
 * resolves to a one-line notice, or undefined. The day is counted from the
 * attempt, so a registry that cannot be reached is not asked on every
 * command.
 */
export async function updateNotice(
  runtime: Runtime,
  argv: readonly string[],
): Promise<string | undefined> {
  if (disabled(runtime, argv)) return undefined;
  const path = join(runtime.configDir, 'update-check.json');
  try {
    const since = runtime.now().getTime() - (await lastCheckedAt(path));
    if (since < CHECK_EVERY_MS) return undefined;
    await writePrivateJson(path, { checkedAt: runtime.now().toISOString() });
    const found = await newestVersion(runtime, NOTICE_TIMEOUT_MS);
    return found.newest !== undefined && isNewer(found.newest, found.installed)
      ? `agentrail-cli ${found.newest} is available (you have ${found.installed}). Update: ${found.upgrade}`
      : undefined;
  } catch (error) {
    // Best effort: the notice is extra to the command it rides on. A state
    // file that cannot be read or written, or npm unreachable or answering
    // an error, means no notice today, never that command's failure.
    if (error instanceof CliError || isSystemError(error)) return undefined;
    throw error;
  }
}
