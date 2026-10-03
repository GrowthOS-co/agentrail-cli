import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { clientIdOf, type Environment } from './environments.js';
import { CliError, EXIT } from './errors.js';
import { readJson } from './files.js';
import type { Runtime } from './runtime.js';

export const AGENTS = ['claude', 'codex', 'cursor'] as const;
export type AgentName = (typeof AGENTS)[number];

export interface SetupOptions {
  readonly only: readonly AgentName[] | undefined;
  /** Into this repository instead of the user's own configuration. */
  readonly project: boolean;
  /** The read-only MCP server (MCP-007) instead of the full one. */
  readonly readOnly: boolean;
}

export interface SetupStep {
  readonly agent: AgentName;
  readonly part: 'skill' | 'mcp';
  readonly status: 'installed' | 'already set up' | 'skipped';
  readonly detail: string;
}

/** The skill this package ships, next to `dist/` (or `src/` in tests). */
const SKILL_SOURCE = fileURLToPath(
  new URL('../skills/agentrail', import.meta.url),
);

/** `agentrail`, `agentrail-dev`, `agentrail-dev-readonly`. */
export function serverName(environment: Environment, readOnly: boolean) {
  return ['agentrail', environment.name === 'prod' ? '' : environment.name]
    .concat(readOnly ? ['readonly'] : [])
    .filter(Boolean)
    .join('-');
}

function serverUrl(environment: Environment, readOnly: boolean): string {
  return readOnly ? `${environment.mcpUrl}/readonly` : environment.mcpUrl;
}

async function installed(runtime: Runtime, agent: AgentName): Promise<boolean> {
  switch (agent) {
    case 'claude':
      return runtime.hasCommand('claude');
    case 'codex':
      return runtime.hasCommand('codex');
    case 'cursor':
      return (
        (await runtime.hasCommand('cursor')) ||
        (await runtime.hasCommand('cursor-agent'))
      );
  }
}

/**
 * Where each agent reads skills. Codex and Cursor both read `.agents/skills`,
 * so one copy there serves both; Claude Code reads `.claude/skills`.
 */
function skillDirectory(
  runtime: Runtime,
  agent: AgentName,
  project: boolean,
): string {
  const root = project ? runtime.cwd : runtime.homeDir;
  const folder = agent === 'claude' ? '.claude' : '.agents';
  return join(root, folder, 'skills', 'agentrail');
}

/** Replaces the skill with this version's, so no file of an older one stays. */
async function installSkill(target: string): Promise<void> {
  await rm(target, { recursive: true, force: true });
  await cp(SKILL_SOURCE, target, { recursive: true });
}

async function runAgentCommand(
  runtime: Runtime,
  command: string,
  args: readonly string[],
): Promise<void> {
  const result = await runtime.exec(command, args);
  if (result.exitCode !== 0) {
    throw new CliError(
      EXIT.unavailable,
      `${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
}

async function addClaudeServer(
  runtime: Runtime,
  name: string,
  url: string,
  project: boolean,
): Promise<SetupStep> {
  const existing = await runtime.exec('claude', ['mcp', 'get', name]);
  if (existing.exitCode === 0) {
    return {
      agent: 'claude',
      part: 'mcp',
      status: 'already set up',
      detail: name,
    };
  }
  await runAgentCommand(runtime, 'claude', [
    'mcp',
    'add',
    '--transport',
    'http',
    '--scope',
    project ? 'project' : 'user',
    name,
    url,
  ]);
  return {
    agent: 'claude',
    part: 'mcp',
    status: 'installed',
    detail: `${name}: run /mcp in Claude Code to sign in.`,
  };
}

async function addCodexServer(
  runtime: Runtime,
  name: string,
  url: string,
  project: boolean,
): Promise<SetupStep> {
  if (project) {
    return {
      agent: 'codex',
      part: 'mcp',
      status: 'skipped',
      detail:
        'Codex keeps MCP servers per user: run agentrail agent setup without --project.',
    };
  }
  const existing = await runtime.exec('codex', ['mcp', 'get', name]);
  if (existing.exitCode === 0) {
    return {
      agent: 'codex',
      part: 'mcp',
      status: 'already set up',
      detail: name,
    };
  }
  await runAgentCommand(runtime, 'codex', ['mcp', 'add', name, '--url', url]);
  return {
    agent: 'codex',
    part: 'mcp',
    status: 'installed',
    detail: `${name}: run codex mcp login ${name} to sign in.`,
  };
}

/** Adds the server to Cursor's mcp.json, keeping every server already there. */
async function addCursorServer(
  runtime: Runtime,
  name: string,
  url: string,
  project: boolean,
): Promise<SetupStep> {
  const path = join(
    project ? runtime.cwd : runtime.homeDir,
    '.cursor',
    'mcp.json',
  );
  const config = ((await readJson(path)) ?? {}) as {
    mcpServers?: Record<string, unknown>;
  };
  if (config.mcpServers?.[name] !== undefined) {
    return {
      agent: 'cursor',
      part: 'mcp',
      status: 'already set up',
      detail: name,
    };
  }
  const updated = {
    ...config,
    mcpServers: { ...config.mcpServers, [name]: { url } },
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(updated, null, 2)}\n`);
  return {
    agent: 'cursor',
    part: 'mcp',
    status: 'installed',
    detail: `${name}: Cursor asks you to sign in the first time it uses it.`,
  };
}

/**
 * Installs the Agentrail skill and MCP server into each coding agent on this
 * machine (CLI-009). Each agent signs in to the MCP server itself; the CLI's
 * own sign-in is never handed to it.
 */
export async function setUpAgents(
  runtime: Runtime,
  environment: Environment,
  options: SetupOptions,
): Promise<SetupStep[]> {
  clientIdOf(environment);
  const name = serverName(environment, options.readOnly);
  const url = serverUrl(environment, options.readOnly);
  const steps: SetupStep[] = [];
  const skillsDone = new Set<string>();
  for (const agent of options.only ?? AGENTS) {
    if (!(await installed(runtime, agent))) {
      steps.push(
        { agent, part: 'skill', status: 'skipped', detail: 'not installed' },
        { agent, part: 'mcp', status: 'skipped', detail: 'not installed' },
      );
      continue;
    }
    const skill = skillDirectory(runtime, agent, options.project);
    if (!skillsDone.has(skill)) {
      await installSkill(skill);
      skillsDone.add(skill);
    }
    steps.push({ agent, part: 'skill', status: 'installed', detail: skill });
    switch (agent) {
      case 'claude':
        steps.push(await addClaudeServer(runtime, name, url, options.project));
        break;
      case 'codex':
        steps.push(await addCodexServer(runtime, name, url, options.project));
        break;
      case 'cursor':
        steps.push(await addCursorServer(runtime, name, url, options.project));
        break;
    }
  }
  return steps;
}

/** `--only claude,cursor`, checked against the agents setup knows. */
export function agentsFrom(text: string | undefined): AgentName[] | undefined {
  if (text === undefined) return undefined;
  const names = text.split(',').map((name) => name.trim());
  const unknown = names.filter(
    (name) => !(AGENTS as readonly string[]).includes(name),
  );
  if (unknown.length > 0) {
    throw new CliError(
      EXIT.usage,
      `Unknown agent ${unknown.join(', ')}. Use any of: ${AGENTS.join(', ')}.`,
    );
  }
  return names as AgentName[];
}
