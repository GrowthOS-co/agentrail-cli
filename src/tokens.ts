import type { Credential } from './credentials.js';
import type { EnvironmentName } from './environments.js';
import { CliError, EXIT } from './errors.js';
import { jsonObjectOf, send } from './http.js';
import type { Runtime } from './runtime.js';

/** A token endpoint's answer (RFC 6749 §5), success or error. */
export type TokenAnswer =
  | {
      readonly kind: 'tokens';
      readonly accessToken: string;
      readonly refreshToken: string | undefined;
      readonly expiresInSeconds: number;
      readonly idToken: string | undefined;
    }
  | { readonly kind: 'error'; readonly error: string };

/**
 * POSTs a form to an OAuth endpoint and returns its JSON object. OAuth errors
 * come back as JSON too (RFC 6749 §5.2); any other answer is exit code 4.
 */
export async function postForm(
  runtime: Runtime,
  url: string,
  form: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const answer = await send(runtime, url, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(form).toString(),
  });
  return { status: answer.status, body: jsonObjectOf(url, answer) };
}

export async function requestTokens(
  runtime: Runtime,
  tokenEndpoint: string,
  form: Record<string, string>,
): Promise<TokenAnswer> {
  const { status, body } = await postForm(runtime, tokenEndpoint, form);
  if (typeof body.error === 'string') {
    return { kind: 'error', error: body.error };
  }
  if (
    status !== 200 ||
    typeof body.access_token !== 'string' ||
    typeof body.expires_in !== 'number'
  ) {
    throw new CliError(
      EXIT.unavailable,
      `${tokenEndpoint} answered ${status} without tokens.`,
    );
  }
  return {
    kind: 'tokens',
    accessToken: body.access_token,
    refreshToken:
      typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
    expiresInSeconds: body.expires_in,
    idToken: typeof body.id_token === 'string' ? body.id_token : undefined,
  };
}

/** The email an OpenID ID token names, for display only; never trusted. */
function emailOf(idToken: string | undefined): string | undefined {
  const payload = idToken?.split('.')[1];
  if (payload === undefined) return undefined;
  const claims = JSON.parse(
    Buffer.from(payload, 'base64url').toString('utf8'),
  ) as { email?: unknown };
  return typeof claims.email === 'string' ? claims.email : undefined;
}

export function credentialFrom(
  runtime: Runtime,
  tokens: Extract<TokenAnswer, { kind: 'tokens' }>,
  context: {
    environment: EnvironmentName;
    tokenEndpoint: string;
    clientId: string;
    resource: string;
    email?: string | undefined;
  },
): Credential {
  return {
    environment: context.environment,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: new Date(
      runtime.now().getTime() + tokens.expiresInSeconds * 1_000,
    ).toISOString(),
    tokenEndpoint: context.tokenEndpoint,
    clientId: context.clientId,
    resource: context.resource,
    email: emailOf(tokens.idToken) ?? context.email,
  };
}
