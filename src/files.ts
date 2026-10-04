import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** A failure the operating system reported for a file: `ENOENT`, `EACCES`… */
export function isSystemError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    typeof (error as NodeJS.ErrnoException).code === 'string'
  );
}

/**
 * A JSON file, or undefined when it does not exist. A file that is not JSON
 * (cut short, or edited by hand) throws a SyntaxError for the caller to name.
 */
export async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if (isSystemError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Writes a file only its owner can read, creating its directory. It is
 * written whole beside the file and renamed over it, so a reader never sees
 * half of it and of two writers one wins whole.
 */
export async function writePrivateJson(
  path: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Removes a file; false when there was none. */
export async function removeFile(path: string): Promise<boolean> {
  try {
    await rm(path);
    return true;
  } catch (error) {
    if (isSystemError(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}
