import { join } from 'node:path';

import { readJson, writePrivateJson } from './files.js';
import type { Runtime } from './runtime.js';
import { VERSION } from './version.js';
import { channelOf, isNewer } from './versions.js';

const DIST_TAGS_URL =
  'https://registry.npmjs.org/-/package/agentrail-cli/dist-tags';
const CHECK_EVERY_MS = 24 * 60 * 60_000;
/** A slow registry never holds a command up longer than this. */
const TIMEOUT_MS = 2_000;

export interface NewestVersion {
  readonly installed: string;
  readonly channel: 'latest' | 'next';
  readonly newest: string | undefined;
  readonly upgrade: string;
}

/** The newest version on the installed version's channel, from npm. */
export async function newestVersion(runtime: Runtime): Promise<NewestVersion> {
  const channel = channelOf(VERSION);
  const response = await runtime.fetch(DIST_TAGS_URL, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const tags = response.ok
    ? ((await response.json()) as Partial<Record<string, unknown>>)
    : {};
  const newest = tags[channel];
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

/**
 * At most once a day, asks npm whether a newer version exists (CLI-008) and
 * resolves to a one-line notice, or undefined. The day is counted from the
 * attempt, so a registry that cannot be reached is not asked on every
 * command. Being unable to ask is not the command's failure, so a network
 * error or a timeout resolves to no notice.
 */
export async function updateNotice(
  runtime: Runtime,
  argv: readonly string[],
): Promise<string | undefined> {
  if (disabled(runtime, argv)) return undefined;
  const path = join(runtime.configDir, 'update-check.json');
  const last = (await readJson(path)) as { checkedAt?: string } | undefined;
  const lastAt = last?.checkedAt ? new Date(last.checkedAt).getTime() : 0;
  if (runtime.now().getTime() - lastAt < CHECK_EVERY_MS) return undefined;
  await writePrivateJson(path, { checkedAt: runtime.now().toISOString() });
  let found: NewestVersion;
  try {
    found = await newestVersion(runtime);
  } catch (error) {
    if (
      error instanceof TypeError ||
      (error instanceof DOMException && error.name === 'TimeoutError')
    ) {
      return undefined;
    }
    throw error;
  }
  return found.newest !== undefined && isNewer(found.newest, found.installed)
    ? `agentrail-cli ${found.newest} is available (you have ${found.installed}). Update: ${found.upgrade}`
    : undefined;
}
