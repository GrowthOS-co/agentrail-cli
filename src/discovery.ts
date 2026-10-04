import { CliError, EXIT } from './errors.js';
import { jsonObjectOf, send } from './http.js';
import type { Runtime } from './runtime.js';

/** Where an environment's MCP server says to sign in, and its endpoints. */
export interface SignInEndpoints {
  readonly resource: string;
  readonly deviceAuthorizationEndpoint: string;
  readonly tokenEndpoint: string;
}

async function getJson(
  runtime: Runtime,
  url: string,
): Promise<Record<string, unknown>> {
  const answer = await send(runtime, url, {
    headers: { accept: 'application/json' },
  });
  if (!answer.ok) {
    throw new CliError(EXIT.unavailable, `${url} answered ${answer.status}.`);
  }
  return jsonObjectOf(url, answer);
}

function stringField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const field = value[key];
  return typeof field === 'string' ? field : undefined;
}

/**
 * The MCP server's protected-resource metadata (RFC 9728) names its
 * authorization server, whose metadata names the device and token endpoints:
 * the same discovery an MCP host does. Nothing is guessed when a step fails.
 */
export async function discoverSignIn(
  runtime: Runtime,
  mcpUrl: string,
): Promise<SignInEndpoints> {
  const server = new URL(mcpUrl);
  const metadataUrl = new URL(
    `/.well-known/oauth-protected-resource${server.pathname}`,
    server,
  ).href;
  const resourceMetadata = await getJson(runtime, metadataUrl);
  const resource = stringField(resourceMetadata, 'resource');
  const servers = resourceMetadata.authorization_servers;
  const authorizationServer = Array.isArray(servers)
    ? (servers as unknown[])[0]
    : undefined;
  if (resource !== mcpUrl || typeof authorizationServer !== 'string') {
    throw new CliError(
      EXIT.unavailable,
      `${metadataUrl} does not describe ${mcpUrl} and where to sign in.`,
    );
  }

  const issuer = new URL(authorizationServer);
  const serverMetadata = await getJson(
    runtime,
    new URL('/.well-known/oauth-authorization-server', issuer).href,
  );
  const deviceAuthorizationEndpoint = stringField(
    serverMetadata,
    'device_authorization_endpoint',
  );
  const tokenEndpoint = stringField(serverMetadata, 'token_endpoint');
  if (!deviceAuthorizationEndpoint || !tokenEndpoint) {
    throw new CliError(
      EXIT.unavailable,
      `${issuer.origin} does not offer device sign-in.`,
    );
  }
  return { resource, deviceAuthorizationEndpoint, tokenEndpoint };
}
