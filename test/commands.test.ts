import { mkdir, writeFile } from 'node:fs/promises';
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

/** A runtime signed in to the fake as dev. */
async function signedIn(options: { terminal?: boolean } = {}) {
  agentrail.accessTokens.add('access-signed-in');
  const keychain = memoryKeychain();
  const credential: Credential = {
    environment: 'dev',
    accessToken: 'access-signed-in',
    refreshToken: undefined,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    tokenEndpoint: new URL('/oauth2/token', agentrail.mcpUrl).href,
    clientId: 'client_test',
    resource: agentrail.mcpUrl,
    email: undefined,
  };
  keychain.set('dev', JSON.stringify(credential));
  return testRuntime({ mcpUrl: agentrail.mcpUrl, keychain, ...options });
}

describe('product commands', () => {
  // CLI-001: a tool is `agentrail <area> <action>` and its inputs are flags,
  // typed as the tool's input schema says.
  it('runs a tool from its flags, and says how each kind of failure ends', async () => {
    const cli = await signedIn();
    expect(
      await run(cli.runtime, [
        '--env',
        'dev',
        'competitors',
        'list',
        '--limit',
        '5',
        '--needs-attention',
      ]),
    ).toBe(0);
    expect(agentrail.toolCalls).toEqual([
      { name: 'competitors_list', input: { limit: 5, needsAttention: true } },
    ]);
    expect(JSON.parse(cli.stdout())).toEqual({
      items: [{ id: 'c-1', name: 'Rival', aliases: [] }],
      nextCursor: null,
    });
    expect(cli.stderr()).toContain('1 competitor.');

    const cases: [string[], number, string][] = [
      [['competitors', 'create', '--name', 'Taken'], 1, 'Rival Taken exists.'],
      [['competitors', 'create'], 2, 'Missing --name.'],
      [
        ['competitors', 'create', '--name', 'X', '--aliases', 'a,b'],
        2,
        'takes JSON',
      ],
      [['nonsense'], 2, 'Run agentrail tools'],
    ];
    for (const [argv, exitCode, message] of cases) {
      const each = await signedIn();
      expect(
        await run(each.runtime, ['--env', 'dev', ...argv]),
        argv.join(' '),
      ).toBe(exitCode);
      expect(each.stderr()).toContain(message);
    }
  });

  // A tool the server added after the catalog was kept must still run: a new
  // tool needs no CLI release.
  it('asks the server again for a command its kept catalog lacks', async () => {
    const cli = await signedIn();
    await mkdir(join(cli.configDir, 'catalog'), { recursive: true });
    await writeFile(
      join(cli.configDir, 'catalog', 'dev.json'),
      JSON.stringify({
        fetchedAt: new Date().toISOString(),
        tools: [{ name: 'workspaces_list', inputSchema: {} }],
      }),
    );

    expect(
      await run(cli.runtime, ['--env', 'dev', 'competitors', 'list']),
    ).toBe(0);
    expect(agentrail.toolCalls.map((call) => call.name)).toEqual([
      'competitors_list',
    ]);
  });

  it('refuses prod until it exists, pointing at dev', async () => {
    const cli = await signedIn();
    expect(await run(cli.runtime, ['competitors', 'list'])).toBe(2);
    expect(cli.stderr()).toContain('--env dev');
  });
});
