import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { workspaceFor, writeLink } from '../src/workspace.js';
import { testRuntime } from './support/test-runtime.js';

describe('the workspace a command uses', () => {
  // CLI-006: flag, then environment variable, then the directory's link for
  // this environment, then the server's default.
  it.each([
    ['the flag over everything', 'ws-flag', 'ws-variable', 'dev', 'ws-flag'],
    [
      'the variable over the link',
      undefined,
      'ws-variable',
      'dev',
      'ws-variable',
    ],
    [
      'the link from a directory below it',
      undefined,
      undefined,
      'dev',
      'ws-link',
    ],
    [
      'no link made for another environment',
      undefined,
      undefined,
      'prod',
      undefined,
    ],
  ] as const)(
    'takes %s',
    async (_case, flag, variable, linkedEnvironment, expected) => {
      const project = await mkdtemp(join(tmpdir(), 'agentrail-project-'));
      await writeLink(project, {
        environment: linkedEnvironment,
        workspaceId: 'ws-link',
        workspaceName: 'Linked',
      });
      const below = join(project, 'packages', 'app');
      await mkdir(below, { recursive: true });
      const { runtime } = await testRuntime({
        mcpUrl: 'http://127.0.0.1:1/mcp',
        cwd: below,
        env: variable === undefined ? {} : { AGENTRAIL_WORKSPACE: variable },
      });

      expect(await workspaceFor(runtime, runtime.environments.dev, flag)).toBe(
        expected,
      );
    },
  );
});
