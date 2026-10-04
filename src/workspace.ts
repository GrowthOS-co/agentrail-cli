import { dirname, join } from 'node:path';

import {
  ENVIRONMENT_NAMES,
  type Environment,
  type EnvironmentName,
} from './environments.js';
import { CliError, EXIT } from './errors.js';
import { readJson, removeFile, writePrivateJson } from './files.js';
import type { Runtime } from './runtime.js';

/** What `agentrail link` records for a directory and those under it. */
export interface Link {
  readonly environment: EnvironmentName;
  readonly workspaceId: string;
  readonly workspaceName: string;
}

const LINK_FILE = join('.agentrail', 'link.json');

function isLink(value: unknown): value is Link {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    (ENVIRONMENT_NAMES as readonly unknown[]).includes(record.environment) &&
    typeof record.workspaceId === 'string' &&
    typeof record.workspaceName === 'string'
  );
}

/**
 * The nearest link file at or above a directory, read or not: `unlink` must
 * be able to remove one cut short or edited by hand.
 */
export async function findLinkFile(
  from: string,
): Promise<{ path: string; value: unknown } | undefined> {
  for (let directory = from; ; directory = dirname(directory)) {
    const path = join(directory, LINK_FILE);
    try {
      const value = await readJson(path);
      if (value !== undefined) return { path, value };
    } catch (error) {
      // There, but not JSON: no value read from it.
      if (error instanceof SyntaxError) return { path, value: undefined };
      throw error;
    }
    if (dirname(directory) === directory) return undefined;
  }
}

/** The nearest link at or above a directory; one this CLI cannot read is named. */
export async function findLink(
  from: string,
): Promise<{ link: Link; path: string } | undefined> {
  const found = await findLinkFile(from);
  if (found === undefined) return undefined;
  if (!isLink(found.value)) {
    throw new CliError(
      EXIT.usage,
      `${found.path} is not a link this CLI wrote. Run agentrail unlink to remove it, or agentrail link <workspaceId> to replace it.`,
    );
  }
  return { link: found.value, path: found.path };
}

export async function writeLink(cwd: string, link: Link): Promise<string> {
  const path = join(cwd, LINK_FILE);
  await writePrivateJson(path, link);
  return path;
}

export async function removeLink(path: string): Promise<void> {
  await removeFile(path);
}

/**
 * The workspace a command acts in (CLI-006): `--workspace`, then
 * `AGENTRAIL_WORKSPACE`, then the directory's link for this environment.
 * Undefined leaves it to the server, which uses the caller's default.
 */
export async function workspaceFor(
  runtime: Runtime,
  environment: Environment,
  flag: string | undefined,
): Promise<string | undefined> {
  if (flag !== undefined) return flag;
  const variable = runtime.env.AGENTRAIL_WORKSPACE;
  if (variable) return variable;
  const found = await findLink(runtime.cwd);
  return found?.link.environment === environment.name
    ? found.link.workspaceId
    : undefined;
}
