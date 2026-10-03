import { describe, expect, it } from 'vitest';

import { run } from '../src/program.js';
import { testRuntime } from './support/test-runtime.js';
import { isNewer } from '../src/versions.js';

/** npm's dist-tags endpoint, counting how often it is asked. */
function registry(tags: Record<string, string>) {
  const asked: string[] = [];
  const fetch = ((input: string | URL | Request) => {
    asked.push(input instanceof Request ? input.url : input.toString());
    return Promise.resolve(Response.json(tags));
  }) as typeof globalThis.fetch;
  return { asked, fetch };
}

describe('the update check', () => {
  // CLI-008: at most daily, off on request, and never in a command's data.
  it('asks npm at most once a day, tells stderr only, and can be turned off', async () => {
    const npm = registry({ latest: '0.0.0', next: '99.0.0-dev.1' });
    const first = await testRuntime({
      mcpUrl: 'http://127.0.0.1:1/mcp',
      env: { AGENTRAIL_NO_UPDATE_CHECK: '' },
      fetch: npm.fetch,
    });
    expect(await run(first.runtime, ['--env', 'dev', 'logout'])).toBe(0);
    expect(npm.asked).toHaveLength(1);
    expect(first.stderr()).toContain('agentrail-cli 99.0.0-dev.1 is available');
    expect(first.stdout()).toBe('');

    const again = await testRuntime({
      mcpUrl: 'http://127.0.0.1:1/mcp',
      env: { AGENTRAIL_NO_UPDATE_CHECK: '' },
      fetch: npm.fetch,
    });
    const sameDay = { ...again.runtime, configDir: first.configDir };
    expect(await run(sameDay, ['--env', 'dev', 'logout'])).toBe(0);
    expect(npm.asked).toHaveLength(1);

    for (const off of [
      { env: { AGENTRAIL_NO_UPDATE_CHECK: '1' }, argv: [] },
      { env: { AGENTRAIL_NO_UPDATE_CHECK: '' }, argv: ['--no-update-check'] },
    ]) {
      const quiet = await testRuntime({
        mcpUrl: 'http://127.0.0.1:1/mcp',
        env: off.env,
        fetch: npm.fetch,
      });
      expect(
        await run(quiet.runtime, ['--env', 'dev', ...off.argv, 'logout']),
      ).toBe(0);
    }
    expect(npm.asked).toHaveLength(1);
  });

  it.each([
    ['0.1.0-dev.2', '0.1.0-dev.1', true],
    ['0.1.0-dev.10', '0.1.0-dev.9', true],
    ['0.1.0', '0.1.0-dev.9', true],
    ['0.1.0-dev.9', '0.1.0', false],
    ['0.1.0', '0.1.0', false],
    ['1.0.0', '0.9.9', true],
  ])('treats %s as newer than %s: %s', (candidate, installed, newer) => {
    expect(isNewer(candidate, installed)).toBe(newer);
  });
});
