import { describe, expect, it } from 'vitest';

import { outputMode } from '../src/output.js';
import { testRuntime } from './support/test-runtime.js';

describe('output mode', () => {
  // CLI-003: an agent or a pipe gets JSON; only a person at a terminal gets a
  // table.
  it.each([
    ['a terminal', 'table', true, {}, false],
    ['a pipe', 'json', false, {}, false],
    ['a terminal with --json', 'json', true, {}, true],
    ['a terminal inside Claude Code', 'json', true, { CLAUDECODE: '1' }, false],
    ['a terminal inside Cursor', 'json', true, { CURSOR_AGENT: '1' }, false],
    ['a terminal an agent names', 'json', true, { AGENT: 'codex' }, false],
  ])('prints to %s as %s', async (_case, expected, terminal, env, json) => {
    const { runtime } = await testRuntime({
      mcpUrl: 'http://127.0.0.1:1/mcp',
      terminal,
      env,
    });
    expect(outputMode(runtime, json)).toBe(expected);
  });
});
