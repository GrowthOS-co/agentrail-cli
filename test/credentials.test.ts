import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Credential } from '../src/credentials.js';
import { run } from '../src/program.js';
import {
  startFakeAgentrail,
  type FakeAgentrail,
} from './support/fake-agentrail.js';
import { memoryKeychain, testRuntime } from './support/test-runtime.js';

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

describe('credentials', () => {
  // WorkOS accepts each refresh token once: keeping the old one breaks the
  // next refresh.
  it('refreshes an expiring sign-in and keeps only the new refresh token', async () => {
    const keychain = memoryKeychain();
    agentrail.refreshTokens.add('refresh-old');
    const expiring: Credential = {
      environment: 'dev',
      accessToken: 'access-old',
      refreshToken: 'refresh-old',
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      tokenEndpoint: new URL('/oauth2/token', agentrail.mcpUrl).href,
      clientId: 'client_test',
      resource: agentrail.mcpUrl,
      email: 'person@example.com',
    };
    keychain.set('dev', JSON.stringify(expiring));
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

  // CLI-007: a token handed in through the environment is never stored, and
  // a missing keychain is never quietly replaced by a file.
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
      keychain: undefined,
    });
    agentrail.deviceAnswers.push('tokens');
    expect(await run(noKeychain.runtime, ['--env', 'dev', 'login'])).toBe(2);
    expect(noKeychain.stderr()).toContain('--insecure-storage');
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
});
