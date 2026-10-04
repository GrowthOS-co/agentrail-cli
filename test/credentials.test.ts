import { access, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Credential } from '../src/credentials.js';
import { run } from '../src/program.js';
import {
  startFakeAgentrail,
  type FakeAgentrail,
} from './support/fake-agentrail.js';
import {
  lockedKeychain,
  memoryKeychain,
  testRuntime,
} from './support/test-runtime.js';

let agentrail: FakeAgentrail;
beforeEach(async () => {
  agentrail = await startFakeAgentrail();
});
afterEach(async () => {
  await agentrail.close();
});

async function filesUnder(directory: string): Promise<string[]> {
  return (await readdir(directory, { recursive: true })).map(String);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** A dev sign-in to the fake that expires in 30 seconds, so it is refreshed. */
function expiring(overrides: Partial<Credential> = {}): Credential {
  return {
    environment: 'dev',
    accessToken: 'access-old',
    refreshToken: 'refresh-old',
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    tokenEndpoint: new URL('/oauth2/token', agentrail.mcpUrl).href,
    clientId: 'client_test',
    resource: agentrail.mcpUrl,
    email: 'person@example.com',
    ...overrides,
  };
}

describe('credentials', () => {
  // WorkOS accepts each refresh token once: keeping the old one breaks the
  // next refresh.
  it('refreshes an expiring sign-in and keeps only the new refresh token', async () => {
    const keychain = memoryKeychain();
    agentrail.refreshTokens.add('refresh-old');
    keychain.set('dev', JSON.stringify(expiring()));
    const cli = await testRuntime({ mcpUrl: agentrail.mcpUrl, keychain });

    expect(
      await run(cli.runtime, ['--env', 'dev', 'competitors', 'list']),
    ).toBe(0);

    expect(Object.fromEntries(agentrail.tokenRequests[0] ?? [])).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-old',
      client_id: 'client_test',
      resource: agentrail.mcpUrl,
    });
    expect(JSON.parse(keychain.entries.get('dev') ?? '{}')).toMatchObject({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      email: 'person@example.com',
    });
  });

  // Two commands started together both find the sign-in expiring; the one
  // whose refresh lands second must use the first one's, not say "expired".
  it('uses the sign-in another command refreshed a moment earlier', async () => {
    const keychain = memoryKeychain();
    agentrail.refreshTokens.add('refresh-old');
    agentrail.accessTokens.add('access-other');
    keychain.set('dev', JSON.stringify(expiring()));
    const racing: typeof fetch = (input, init) => {
      const form = new URLSearchParams(
        typeof init?.body === 'string' ? init.body : '',
      );
      if (form.get('grant_type') === 'refresh_token') {
        // The other command's refresh spends the token and stores its own.
        agentrail.refreshTokens.delete('refresh-old');
        keychain.set(
          'dev',
          JSON.stringify(
            expiring({
              accessToken: 'access-other',
              refreshToken: 'refresh-other',
              expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            }),
          ),
        );
      }
      return fetch(input, init);
    };
    const cli = await testRuntime({
      mcpUrl: agentrail.mcpUrl,
      keychain,
      fetch: racing,
    });

    expect(
      await run(cli.runtime, ['--env', 'dev', 'competitors', 'list']),
    ).toBe(0);
    expect(agentrail.toolCalls.map((call) => call.name)).toEqual([
      'competitors_list',
    ]);
  });

  // CLI-007: a token handed in through the environment is never stored, and
  // a keychain that cannot keep a sign-in is never quietly replaced by a file.
  it('never writes AGENTRAIL_TOKEN, and keeps a file only when asked to', async () => {
    agentrail.accessTokens.add('given-token');
    const keychain = memoryKeychain();
    const given = await testRuntime({
      mcpUrl: agentrail.mcpUrl,
      env: { AGENTRAIL_TOKEN: 'given-token' },
      keychain,
    });
    expect(
      await run(given.runtime, ['--env', 'dev', 'competitors', 'list']),
    ).toBe(0);
    expect(keychain.entries.size).toBe(0);
    expect(await filesUnder(given.configDir)).not.toContainEqual(
      expect.stringContaining('credentials'),
    );

    const noKeychain = await testRuntime({
      mcpUrl: agentrail.mcpUrl,
      terminal: true,
      keychain: lockedKeychain(),
    });
    agentrail.deviceAnswers.push('tokens');
    expect(await run(noKeychain.runtime, ['--env', 'dev', 'login'])).toBe(2);
    expect(noKeychain.stderr()).toContain(
      'agentrail login --insecure-storage --env dev',
    );
    expect(await filesUnder(noKeychain.configDir)).not.toContainEqual(
      expect.stringContaining('credentials'),
    );

    agentrail.deviceAnswers.push('tokens');
    expect(
      await run(noKeychain.runtime, [
        '--env',
        'dev',
        'login',
        '--insecure-storage',
      ]),
    ).toBe(0);
    const file = join(noKeychain.configDir, 'credentials', 'dev.json');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  // A sign-in left in either place still signs commands in, so logout must
  // empty both, and say which. One kept in the keychain must not be hidden
  // by an older file, which is read first.
  it('signs out of both places, and a keychain sign-in replaces a file', async () => {
    const keychain = memoryKeychain();
    const cli = await testRuntime({
      mcpUrl: agentrail.mcpUrl,
      terminal: true,
      keychain,
    });
    const file = join(cli.configDir, 'credentials', 'dev.json');
    const login = async (...flags: string[]) => {
      agentrail.deviceAnswers.push('tokens');
      expect(await run(cli.runtime, ['--env', 'dev', 'login', ...flags])).toBe(
        0,
      );
    };

    await login('--insecure-storage');
    await login();
    expect(await exists(file)).toBe(false);
    expect(keychain.entries.has('dev')).toBe(true);

    await login('--insecure-storage');
    expect(await run(cli.runtime, ['--env', 'dev', 'logout'])).toBe(0);
    expect(cli.stderr()).toContain(
      'removed the sign-in from the credentials file and the OS keychain',
    );
    expect(await exists(file)).toBe(false);
    expect(keychain.entries.size).toBe(0);
  });

  // Those who sign in with --insecure-storage often have no keychain at all:
  // logout must still remove their file, and never claim the keychain is
  // empty when it could not be asked.
  it('signs out of the file when the keychain cannot be asked, and says so', async () => {
    const cli = await testRuntime({
      mcpUrl: agentrail.mcpUrl,
      terminal: true,
      keychain: lockedKeychain(),
    });
    agentrail.deviceAnswers.push('tokens');
    expect(
      await run(cli.runtime, ['--env', 'dev', 'login', '--insecure-storage']),
    ).toBe(0);

    expect(await run(cli.runtime, ['--env', 'dev', 'logout'])).toBe(0);
    expect(cli.stderr()).toContain(
      'removed the sign-in from the credentials file. Could not check the OS keychain',
    );
    expect(await filesUnder(cli.configDir)).not.toContainEqual(
      expect.stringContaining('dev.json'),
    );

    expect(await run(cli.runtime, ['--env', 'dev', 'logout'])).toBe(3);
  });
});
