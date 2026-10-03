import { dirname, join } from 'node:path';

import type { Environment, EnvironmentName } from './environments.js';
import { readJson, removeFile, writePrivateJson } from './files.js';
import type { Runtime } from './runtime.js';

/** What `agentrail link` records for a directory and those under it. */
export interface Link {
  readonly environment: EnvironmentName;
  readonly workspaceId: string;
  readonly workspaceName: string;
}

const LINK_FILE = join('.agentrail', 'link.json');

/** The nearest link file at or above a directory. */
export async function findLink(
  from: string,
): Promise<{ link: Link; path: string } | undefined> {
  for (let directory = from; ; directory = dirname(directory)) {
    const path = join(directory, LINK_FILE);
    const link = (await readJson(path)) as Link | undefined;
    if (link) return { link, path };
    if (dirname(directory) === directory) return undefined;
  }
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
