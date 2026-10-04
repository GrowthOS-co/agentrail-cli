import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Credential } from '../src/credentials.js';
import { run } from '../src/program.js';
import { VERSION } from '../src/version.js';
import {
  startFakeAgentrail,
  type FakeAgentrail,
} from './support/fake-agentrail.js';
import {
  memoryKeychain,
  testRuntime,
  type TestRuntime,
} from './support/test-runtime.js';

let agentrail: FakeAgentrail;
beforeEach(async () => {
  agentrail = await startFakeAgentrail();
});
afterEach(async () => {
  await agentrail.close();
});

/** A runtime signed in to the fake as dev. */
async function signedIn(
  options: { terminal?: boolean; mcpUrl?: string; cwd?: string } = {},
) {
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

/** A local MCP URL nothing listens on, so connecting is refused. */
async function unreachableUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${String(port)}/mcp`;
}

/** Writes a file as a person or a crash might leave it. */
async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
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
      [
        ['competitors', 'create', '--input-file', 'missing.json'],
        2,
        '--input-file: cannot read',
      ],
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

  // CLI-008: the server can only refuse an outdated CLI it can recognise,
  // and its refusal must reach the person with the update command.
  it('names its version to the server, and passes on the server’s refusal of an outdated CLI', async () => {
    const cli = await signedIn();
    expect(
      await run(cli.runtime, ['--env', 'dev', 'competitors', 'list']),
    ).toBe(0);
    expect(new Set(agentrail.userAgents)).toEqual(
      new Set([`agentrail-cli/${VERSION}`]),
    );

    agentrail.refuseOutdatedCli = true;
    const outdated = await signedIn();
    expect(
      await run(outdated.runtime, [
        '--env',
        'dev',
        'competitors',
        'list',
        '--no-update-check',
      ]),
    ).toBe(2);
    expect(outdated.stderr()).toContain('npm install -g agentrail-cli@latest');
    expect(outdated.stderr()).not.toContain('Run agentrail tools');
  });

  it('refuses prod until it exists, pointing at dev', async () => {
    const cli = await signedIn();
    expect(await run(cli.runtime, ['competitors', 'list'])).toBe(2);
    expect(cli.stderr()).toContain('--env dev');
  });

  // Each exit code means one thing to a script, and each message names what
  // is wrong and the command that fixes it, or the failure is shown whole.
  it.each<{
    case: string;
    cli: () => Promise<TestRuntime>;
    argv: string[];
    exitCode: number;
    message: string;
  }>([
    {
      case: 'an organization that turned agent access off',
      cli: () => {
        agentrail.forbidden = {
          code: 'AGENT_ACCESS_DISABLED',
          message:
            'An administrator turned off agent access for this organization',
        };
        return signedIn();
      },
      argv: ['competitors', 'list'],
      exitCode: 1,
      message:
        'refused: An administrator turned off agent access for this organization (AGENT_ACCESS_DISABLED).',
    },
    {
      case: 'a refused AGENTRAIL_TOKEN',
      cli: () =>
        testRuntime({
          mcpUrl: agentrail.mcpUrl,
          env: { AGENTRAIL_TOKEN: 'revoked-token' },
        }),
      argv: ['competitors', 'list'],
      exitCode: 3,
      message: 'did not accept the token in AGENTRAIL_TOKEN',
    },
    {
      case: 'an MCP server that cannot be reached',
      cli: async () => signedIn({ mcpUrl: await unreachableUrl() }),
      argv: ['competitors', 'list'],
      exitCode: 4,
      message: 'ECONNREFUSED',
    },
    {
      case: 'a sign-in server that cannot be reached',
      cli: async () => testRuntime({ mcpUrl: await unreachableUrl() }),
      argv: ['login'],
      exitCode: 4,
      message: 'ECONNREFUSED',
    },
    {
      case: 'a credentials file cut short',
      cli: async () => {
        const cli = await testRuntime({ mcpUrl: agentrail.mcpUrl });
        await put(join(cli.configDir, 'credentials', 'dev.json'), '{"access');
        return cli;
      },
      argv: ['competitors', 'list'],
      exitCode: 3,
      message: 'is not one this CLI wrote. Run agentrail login --env dev',
    },
    {
      case: 'a link file edited by hand',
      cli: async () => {
        const cli = await signedIn();
        await put(join(cli.runtime.cwd, '.agentrail', 'link.json'), '{,}');
        return cli;
      },
      argv: ['competitors', 'list'],
      exitCode: 2,
      message: 'is not a link this CLI wrote. Run agentrail unlink',
    },
    {
      case: 'a failure the CLI does not know',
      cli: () =>
        testRuntime({
          mcpUrl: agentrail.mcpUrl,
          fetch: () => Promise.reject(new RangeError('a bug in fetch')),
        }),
      argv: ['login'],
      exitCode: 5,
      message: 'RangeError: a bug in fetch',
    },
  ])('ends $case with $exitCode', async (row) => {
    const cli = await row.cli();
    expect(await run(cli.runtime, ['--env', 'dev', ...row.argv])).toBe(
      row.exitCode,
    );
    expect(cli.stderr()).toContain(row.message);
  });

  // Files the CLI reads on every command must not stop every command once
  // damaged: logout and unlink remove them, and a kept catalog is only a
  // copy, so a damaged one is asked for again.
  it('removes a damaged sign-in or link, and asks again for a damaged catalog', async () => {
    const cli = await signedIn();
    const credentials = join(cli.configDir, 'credentials', 'dev.json');
    await put(credentials, '{"access');
    expect(await run(cli.runtime, ['--env', 'dev', 'logout'])).toBe(0);

    await put(join(cli.runtime.cwd, '.agentrail', 'link.json'), '{,}');
    expect(await run(cli.runtime, ['--env', 'dev', 'unlink'])).toBe(0);

    await put(join(cli.configDir, 'catalog', 'dev.json'), '{"tools":');
    const fresh = await signedIn({ cwd: cli.runtime.cwd });
    expect(
      await run({ ...fresh.runtime, configDir: cli.configDir }, [
        '--env',
        'dev',
        'competitors',
        'list',
      ]),
    ).toBe(0);
  });
});
