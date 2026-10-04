import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

  // The keychain's refusal tells the agent to sign in with
  // --insecure-storage, so that must finish the sign-in. A code exchanged
  // once is spent: resuming it again only fails until it expires.
  it('finishes in a file when the keychain cannot keep the sign-in, and never resumes a spent code', async () => {
    const cli = await testRuntime({
      mcpUrl: agentrail.mcpUrl,
      keychain: lockedKeychain(),
    });
    const login = async (...flags: string[]) => {
      const each = await testRuntime({
        mcpUrl: agentrail.mcpUrl,
        keychain: lockedKeychain(),
      });
      const exitCode = await run(
        { ...each.runtime, configDir: cli.configDir },
        ['--env', 'dev', 'login', ...flags],
      );
      return { exitCode, stdout: each.stdout(), stderr: each.stderr() };
    };

    expect((await login()).exitCode).toBe(0);
    agentrail.deviceAnswers.push('tokens');
    const notKept = await login();
    expect(notKept.exitCode).toBe(2);
    expect(notKept.stderr).toContain(
      'agentrail login --insecure-storage --env dev',
    );

    const restarted = await login('--insecure-storage');
    expect(restarted.exitCode).toBe(0);
    expect(JSON.parse(restarted.stdout)).toMatchObject({
      status: 'pending',
      next: 'agentrail login --insecure-storage --env dev',
    });
    expect(agentrail.deviceRequests).toHaveLength(2);

    agentrail.deviceAnswers.push('tokens');
    expect((await login('--insecure-storage')).exitCode).toBe(0);

    expect((await login()).exitCode).toBe(0);
    agentrail.deviceAnswers.push('tokens');
    expect(await login('--insecure-storage')).toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining('signed_in') as string,
    });
  });

  // An OAuth error the flow does not expect leaves a code that signs no one
  // in: the next run must start over, not poll it again.
  it('starts over after an unexpected sign-in error', async () => {
    const keychain = memoryKeychain();
    const first = await testRuntime({ mcpUrl: agentrail.mcpUrl, keychain });
    expect(await run(first.runtime, ['--env', 'dev', 'login'])).toBe(0);

    agentrail.deviceAnswers.push({ error: 'invalid_grant' });
    const second = await testRuntime({ mcpUrl: agentrail.mcpUrl, keychain });
    const resumed = { ...second.runtime, configDir: first.configDir };
    expect(await run(resumed, ['--env', 'dev', 'login'])).toBe(3);
    expect(second.stderr()).toContain(
      'Signing in failed (invalid_grant). Run agentrail login --env dev again.',
    );

    const third = await testRuntime({ mcpUrl: agentrail.mcpUrl, keychain });
    const again = { ...third.runtime, configDir: first.configDir };
    expect(await run(again, ['--env', 'dev', 'login'])).toBe(0);
    expect(JSON.parse(third.stdout())).toMatchObject({ status: 'pending' });
  });
});
