import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

describe('agentrail login', () => {
  // The token must be for the MCP server: without `resource`, AuthKit issues
  // one the server refuses. A slowed-down poll must wait longer, as RFC 8628
  // requires, or the authorization server stops answering.
  it('signs in with the device flow for the MCP resource, waiting longer when told to slow down', async () => {
    const keychain = memoryKeychain();
    const cli = await testRuntime({
      mcpUrl: agentrail.mcpUrl,
      terminal: true,
      keychain,
    });
    agentrail.deviceAnswers.push(
      { error: 'authorization_pending' },
      { error: 'slow_down' },
      'tokens',
    );

    expect(await run(cli.runtime, ['--env', 'dev', 'login'])).toBe(0);

    const [device] = agentrail.deviceRequests;
    expect(Object.fromEntries(device ?? [])).toEqual({
      client_id: 'client_test',
      scope: 'openid profile email offline_access',
      resource: agentrail.mcpUrl,
    });
    expect(cli.sleeps).toEqual([5_000, 5_000, 10_000]);
    expect(cli.opened).toEqual([expect.stringContaining('ABCD-EFGH')]);
    expect(cli.stderr()).toContain('ABCD-EFGH');
    expect(JSON.parse(keychain.entries.get('dev') ?? '{}')).toMatchObject({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      resource: agentrail.mcpUrl,
    });
  });

  // CLI-005: an agent has no terminal to wait in. Its first run hands back
  // what the person must do; its next run finishes.
  it('lets an agent without a terminal start a sign-in and finish it with a second run', async () => {
    const keychain = memoryKeychain();
    const cli = await testRuntime({ mcpUrl: agentrail.mcpUrl, keychain });

    expect(await run(cli.runtime, ['--env', 'dev', 'login'])).toBe(0);
    expect(JSON.parse(cli.stdout())).toEqual({
      status: 'pending',
      verificationUrl: expect.stringContaining('ABCD-EFGH') as string,
      userCode: 'ABCD-EFGH',
      expiresAt: expect.any(String) as string,
      next: 'agentrail login --env dev',
    });
    expect(agentrail.tokenRequests).toEqual([]);

    agentrail.deviceAnswers.push('tokens');
    const second = await testRuntime({ mcpUrl: agentrail.mcpUrl, keychain });
    const finishing = { ...second.runtime, configDir: cli.configDir };
    expect(await run(finishing, ['--env', 'dev', 'login'])).toBe(0);
    expect(JSON.parse(second.stdout())).toEqual({
      status: 'signed_in',
      environment: 'dev',
      email: null,
    });
    expect(keychain.entries.has('dev')).toBe(true);
  });
});
