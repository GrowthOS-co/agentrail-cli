import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { run } from '../src/program.js';
import type { Executed } from '../src/runtime.js';
import { testRuntime } from './support/test-runtime.js';

const MCP_URL = 'https://mcp.dev.example.com/mcp';

/** An agent CLI whose `mcp get` finds a server only once `mcp add` added it. */
function agentCli() {
  const added = new Set<string>();
  return (args: readonly string[]): Executed => {
    const [, action, ...rest] = args;
    if (action === 'add') {
      added.add(rest.find((arg) => arg.startsWith('agentrail')) ?? '');
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    const found = added.has(rest[0] ?? '');
    return {
      exitCode: found ? 0 : 1,
      stdout: '',
      stderr: found ? '' : 'not found',
    };
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('agentrail agent setup', () => {
  // CLI-009: each agent gets the skill and the MCP server through its own
  // configuration, nothing already there is lost, and running it again
  // changes nothing.
  it('installs the skill and the MCP server into every agent, keeping their other servers', async () => {
    const cli = await testRuntime({
      mcpUrl: MCP_URL,
      commands: {
        claude: agentCli(),
        codex: agentCli(),
        'cursor-agent': agentCli(),
      },
    });
    const cursorConfig = join(cli.runtime.homeDir, '.cursor', 'mcp.json');
    await mkdir(join(cli.runtime.homeDir, '.cursor'), { recursive: true });
    await writeFile(
      cursorConfig,
      JSON.stringify({
        theme: 'dark',
        mcpServers: { other: { command: 'other-mcp' } },
      }),
    );

    expect(await run(cli.runtime, ['--env', 'dev', 'agent', 'setup'])).toBe(0);

    expect(cli.executed).toEqual([
      ['claude', 'mcp', 'get', 'agentrail-dev'],
      [
        'claude',
        'mcp',
        'add',
        '--transport',
        'http',
        '--scope',
        'user',
        'agentrail-dev',
        MCP_URL,
      ],
      ['codex', 'mcp', 'get', 'agentrail-dev'],
      ['codex', 'mcp', 'add', 'agentrail-dev', '--url', MCP_URL],
    ]);
    const afterFirst = await readFile(cursorConfig, 'utf8');
    expect(JSON.parse(afterFirst)).toEqual({
      theme: 'dark',
      mcpServers: {
        other: { command: 'other-mcp' },
        'agentrail-dev': { url: MCP_URL },
      },
    });
    for (const folder of ['.claude', '.agents']) {
      expect(
        await exists(
          join(cli.runtime.homeDir, folder, 'skills', 'agentrail', 'SKILL.md'),
        ),
      ).toBe(true);
    }

    expect(await run(cli.runtime, ['--env', 'dev', 'agent', 'setup'])).toBe(0);
    expect(cli.executed.filter((call) => call[2] === 'add')).toHaveLength(2);
    expect(await readFile(cursorConfig, 'utf8')).toBe(afterFirst);
  });

  it('points at the read-only server when asked, and skips an agent that is not installed', async () => {
    const cli = await testRuntime({
      mcpUrl: MCP_URL,
      commands: { claude: agentCli() },
    });

    expect(
      await run(cli.runtime, ['--env', 'dev', 'agent', 'setup', '--read-only']),
    ).toBe(0);

    expect(cli.executed).toEqual([
      ['claude', 'mcp', 'get', 'agentrail-dev-readonly'],
      [
        'claude',
        'mcp',
        'add',
        '--transport',
        'http',
        '--scope',
        'user',
        'agentrail-dev-readonly',
        `${MCP_URL}/readonly`,
      ],
    ]);
    expect(JSON.parse(cli.stdout())).toContainEqual({
      agent: 'codex',
      part: 'mcp',
      status: 'skipped',
      detail: 'not installed',
    });
  });
});
