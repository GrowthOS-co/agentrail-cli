import { CliError, EXIT } from './errors.js';

/**
 * An Agentrail environment: its MCP server, which publishes where to sign in,
 * and the public OAuth client the CLI signs in with there. A client ID is not
 * a secret; each environment has its own, so a token from one is never sent
 * to the other.
 */
export interface Environment {
  readonly name: EnvironmentName;
  readonly mcpUrl: string;
  /** Absent until the environment exists. */
  readonly clientId: string | undefined;
}

export const ENVIRONMENT_NAMES = ['prod', 'dev'] as const;
export type EnvironmentName = (typeof ENVIRONMENT_NAMES)[number];

export type Environments = Readonly<Record<EnvironmentName, Environment>>;

export const ENVIRONMENTS: Environments = {
  prod: {
    name: 'prod',
    mcpUrl: 'https://mcp.agentrail.co/mcp',
    clientId: undefined,
  },
  dev: {
    name: 'dev',
    mcpUrl: 'https://mcp-dev.usegrowthos.com/mcp',
    clientId: 'client_01M419D7ZGXFG7EYMBGNGP61GY',
  },
};

function isEnvironmentName(value: string): value is EnvironmentName {
  return (ENVIRONMENT_NAMES as readonly string[]).includes(value);
}

/**
 * The environment a command uses: `--env`, then `AGENTRAIL_ENV`, then prod.
 * Dev is only ever chosen explicitly.
 */
export function selectEnvironment(
  flag: string | undefined,
  runtime: {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly environments: Environments;
  },
): Environment {
  const chosen = flag ?? runtime.env.AGENTRAIL_ENV ?? 'prod';
  if (!isEnvironmentName(chosen)) {
    throw new CliError(
      EXIT.usage,
      `Unknown environment "${chosen}". Use one of: ${ENVIRONMENT_NAMES.join(', ')}.`,
    );
  }
  return runtime.environments[chosen];
}

/** The client ID of an environment that exists; a clear refusal otherwise. */
export function clientIdOf(environment: Environment): string {
  if (environment.clientId === undefined) {
    throw new CliError(
      EXIT.usage,
      `Agentrail ${environment.name} is not available yet. Use the dev environment: pass --env dev or set AGENTRAIL_ENV=dev.`,
    );
  }
  return environment.clientId;
}
