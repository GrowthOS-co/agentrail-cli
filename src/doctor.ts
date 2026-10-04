import { fetchCatalog } from './catalog.js';
import { commandFor, loadCredential } from './credentials.js';
import { discoverSignIn } from './discovery.js';
import { clientIdOf, type Environment } from './environments.js';
import { CliError, EXIT, type ExitCode } from './errors.js';
import type { Runtime } from './runtime.js';
import { findLink } from './workspace.js';

export interface Check {
  readonly check: string;
  readonly status: 'ok' | 'failed' | 'skipped' | 'note';
  readonly detail: string;
}

const MINIMUM_NODE_MAJOR = 22;

function failed(error: unknown): { detail: string; exitCode: ExitCode } {
  if (error instanceof CliError) {
    return { detail: error.message, exitCode: error.exitCode };
  }
  throw error;
}

/**
 * Checks what a command depends on, in the order it depends on it. A check
 * whose prerequisite failed is skipped rather than failing for the same
 * reason. The exit code is the first failure's.
 */
export async function diagnose(
  runtime: Runtime,
  environment: Environment,
): Promise<{ checks: Check[]; exitCode: ExitCode }> {
  const checks: Check[] = [];
  let exitCode: ExitCode = EXIT.ok;
  const fail = (check: string, error: unknown) => {
    const { detail, exitCode: code } = failed(error);
    checks.push({ check, status: 'failed', detail });
    if (exitCode === EXIT.ok) exitCode = code;
  };

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor >= MINIMUM_NODE_MAJOR) {
    checks.push({
      check: 'Node.js',
      status: 'ok',
      detail: process.versions.node,
    });
  } else {
    fail(
      'Node.js',
      new CliError(
        EXIT.usage,
        `Node ${process.versions.node} is too old; agentrail-cli needs ${String(MINIMUM_NODE_MAJOR)} or later.`,
      ),
    );
  }

  let reachable = false;
  try {
    clientIdOf(environment);
    const endpoints = await discoverSignIn(runtime, environment.mcpUrl);
    checks.push({
      check: `Agentrail ${environment.name}`,
      status: 'ok',
      detail: `${environment.mcpUrl}, signing in at ${new URL(endpoints.tokenEndpoint).origin}`,
    });
    reachable = true;
  } catch (error) {
    fail(`Agentrail ${environment.name}`, error);
  }

  let signedIn = false;
  if (runtime.env.AGENTRAIL_TOKEN) {
    checks.push({ check: 'Sign-in', status: 'ok', detail: 'AGENTRAIL_TOKEN' });
    signedIn = true;
  } else {
    try {
      const stored = await loadCredential(runtime, environment);
      if (!stored) {
        throw new CliError(
          EXIT.signIn,
          `Not signed in. Run ${commandFor(environment, 'login')}.`,
        );
      }
      checks.push({
        check: 'Sign-in',
        status: 'ok',
        detail: `${stored.credential.email ?? 'signed in'}, kept in the ${stored.storage === 'file' ? 'credentials file' : 'OS keychain'}, refreshed as needed`,
      });
      signedIn = true;
    } catch (error) {
      fail('Sign-in', error);
    }
  }

  if (reachable && signedIn) {
    try {
      const { tools } = await fetchCatalog(runtime, environment);
      checks.push({
        check: 'Tools',
        status: 'ok',
        detail: `${String(tools.length)} available to you`,
      });
    } catch (error) {
      fail('Tools', error);
    }
  } else {
    checks.push({
      check: 'Tools',
      status: 'skipped',
      detail: 'needs Agentrail reachable and a sign-in',
    });
  }

  try {
    const link = await findLink(runtime.cwd);
    checks.push({
      check: 'Workspace link',
      status: 'note',
      detail: link
        ? `${link.link.workspaceName} (${link.link.environment}), from ${link.path}`
        : 'none: commands use your default workspace',
    });
  } catch (error) {
    fail('Workspace link', error);
  }
  return { checks, exitCode };
}
