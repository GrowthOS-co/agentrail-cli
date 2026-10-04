import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { run } from '../src/program.js';
import { testRuntime } from './support/test-runtime.js';
import { VERSION } from '../src/version.js';
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

  // The check rides on every command, so nothing it meets may end one: a
  // state file cut short is replaced, and npm down or answering a page means
  // no notice today.
  it.each<[string, string | undefined, () => Promise<Response>, string]>([
    [
      'a state file cut short',
      '{"checkedAt":',
      () => Promise.resolve(Response.json({ next: '99.0.0-dev.1' })),
      `agentrail-cli 99.0.0-dev.1 is available (you have ${VERSION}). Update: npm install -g agentrail-cli@next\n`,
    ],
    [
      'npm answering a page',
      undefined,
      () => Promise.resolve(new Response('<html>', { status: 200 })),
      '',
    ],
    [
      'npm answering an error',
      undefined,
      () => Promise.resolve(new Response('Not Found', { status: 404 })),
      '',
    ],
  ])(
    'lets the command end as it would after %s',
    async (_case, state, answer, notice) => {
      const cli = await testRuntime({
        mcpUrl: 'http://127.0.0.1:1/mcp',
        env: { AGENTRAIL_NO_UPDATE_CHECK: '' },
        fetch: answer,
      });
      const path = join(cli.configDir, 'update-check.json');
      if (state !== undefined) await writeFile(path, state);

      expect(await run(cli.runtime, ['--env', 'dev', 'logout'])).toBe(0);
      expect(cli.stderr()).toBe(`Not signed in to Agentrail dev.\n${notice}`);
      expect(JSON.parse(await readFile(path, 'utf8'))).toHaveProperty(
        'checkedAt',
      );
    },
  );

  // A bug in the check must be seen, but the command it rode on succeeded.
  it('shows a failure of the check it does not know, keeping the command’s exit code', async () => {
    const cli = await testRuntime({
      mcpUrl: 'http://127.0.0.1:1/mcp',
      env: { AGENTRAIL_NO_UPDATE_CHECK: '' },
      fetch: () => Promise.reject(new RangeError('a bug in the check')),
    });
    expect(await run(cli.runtime, ['--env', 'dev', 'logout'])).toBe(0);
    expect(cli.stderr()).toContain(
      'The update check failed:\nRangeError: a bug in the check',
    );
  });

  // `update` is asked for: npm's error must not read as "up to date".
  it.each<[string, () => Promise<Response>, string]>([
    [
      'an error',
      () => Promise.resolve(new Response('Not Found', { status: 404 })),
      'The npm registry answered 404',
    ],
    [
      'no answer',
      () => Promise.reject(new TypeError('fetch failed')),
      'Could not reach the npm registry (TypeError: fetch failed)',
    ],
  ])('says so when npm gives %s', async (_case, answer, message) => {
    const cli = await testRuntime({
      mcpUrl: 'http://127.0.0.1:1/mcp',
      fetch: answer,
    });
    expect(await run(cli.runtime, ['update'])).toBe(4);
    expect(cli.stderr()).toContain(message);
    expect(cli.stdout()).toBe('');
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
