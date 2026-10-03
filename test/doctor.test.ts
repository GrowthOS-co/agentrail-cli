import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { run } from '../src/program.js';
import {
  startFakeAgentrail,
  type FakeAgentrail,
} from './support/fake-agentrail.js';
import { testRuntime } from './support/test-runtime.js';

let agentrail: FakeAgentrail;
beforeEach(async () => {
  agentrail = await startFakeAgentrail();
});
afterEach(async () => {
  await agentrail.close();
});

describe('agentrail doctor', () => {
  // A failed check must end the command with that failure's code, or a
  // script running doctor reads a broken setup as a working one.
  it('ends with the first failure’s code, and skips what depends on it', async () => {
    const signedOut = await testRuntime({ mcpUrl: agentrail.mcpUrl });
    expect(await run(signedOut.runtime, ['--env', 'dev', 'doctor'])).toBe(3);
    const checks = JSON.parse(signedOut.stdout()) as {
      check: string;
      status: string;
    }[];
    expect(checks.map(({ check, status }) => `${check}: ${status}`)).toEqual([
      'Node.js: ok',
      'Agentrail dev: ok',
      'Sign-in: failed',
      'Tools: skipped',
      'Workspace link: note',
    ]);

    agentrail.accessTokens.add('given-token');
    const signedIn = await testRuntime({
      mcpUrl: agentrail.mcpUrl,
      env: { AGENTRAIL_TOKEN: 'given-token' },
    });
    expect(await run(signedIn.runtime, ['--env', 'dev', 'doctor'])).toBe(0);
    expect(signedIn.stdout()).toContain('3 available to you');
  });
});
