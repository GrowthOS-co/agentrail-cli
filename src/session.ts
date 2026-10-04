import {
  commandFor,
  loadCredential,
  saveCredential,
  type Credential,
} from './credentials.js';
import type { Environment } from './environments.js';
import { CliError, EXIT } from './errors.js';
import type { Runtime } from './runtime.js';
import { credentialFrom, requestTokens } from './tokens.js';

/** Refreshed this long before it expires, so a call never starts stale. */
const REFRESH_MARGIN_MS = 60_000;
/** How long a refresh that lost a race waits for the winner's sign-in. */
const RACE_CHECKS = 5;
const RACE_CHECK_EVERY_MS = 200;

/**
 * The sign-in another command stored after refreshing with `spent` first.
 * That command stores it once its own answer arrives, which can be a moment
 * after this one's, so the store is read again for a second before giving up.
 */
async function refreshedElsewhere(
  runtime: Runtime,
  environment: Environment,
  spent: string,
): Promise<Credential | undefined> {
  for (let check = 1; ; check += 1) {
    const stored = await loadCredential(runtime, environment);
    if (stored !== undefined && stored.credential.refreshToken !== spent) {
      return stored.credential;
    }
    if (check === RACE_CHECKS) return undefined;
    await runtime.sleep(RACE_CHECK_EVERY_MS);
  }
}

/**
 * The access token for a command. `AGENTRAIL_TOKEN` wins and is never
 * written anywhere (CLI-007); otherwise the stored sign-in, refreshed when it
 * is about to expire.
 */
export async function accessToken(
  runtime: Runtime,
  environment: Environment,
): Promise<string> {
  const given = runtime.env.AGENTRAIL_TOKEN;
  if (given) return given;

  const login = commandFor(environment, 'login');
  const stored = await loadCredential(runtime, environment);
  if (!stored) {
    throw new CliError(
      EXIT.signIn,
      `Not signed in to Agentrail ${environment.name}. Run ${login}.`,
    );
  }
  const { credential, storage } = stored;
  const expiresAt = new Date(credential.expiresAt).getTime();
  if (expiresAt - runtime.now().getTime() > REFRESH_MARGIN_MS) {
    return credential.accessToken;
  }
  if (credential.refreshToken === undefined) {
    throw new CliError(
      EXIT.signIn,
      `Your sign-in to ${environment.name} expired. Run ${login}.`,
    );
  }

  const answer = await requestTokens(runtime, credential.tokenEndpoint, {
    grant_type: 'refresh_token',
    refresh_token: credential.refreshToken,
    client_id: credential.clientId,
    resource: credential.resource,
  });
  if (answer.kind === 'error') {
    // Another command refreshed first: WorkOS accepts each refresh token
    // once, so this one is spent, and the sign-in that command stored is
    // fresh.
    if (answer.error === 'invalid_grant') {
      const fresh = await refreshedElsewhere(
        runtime,
        environment,
        credential.refreshToken,
      );
      if (fresh !== undefined) return fresh.accessToken;
    }
    throw new CliError(
      EXIT.signIn,
      `Your sign-in to ${environment.name} expired (${answer.error}). Run ${login}.`,
    );
  }
  // RFC 6749 §6: a new refresh token replaces the old one; without one, the
  // old one stays good.
  const tokens = {
    ...answer,
    refreshToken: answer.refreshToken ?? credential.refreshToken,
  };
  const refreshed = credentialFrom(runtime, tokens, {
    environment: environment.name,
    tokenEndpoint: credential.tokenEndpoint,
    clientId: credential.clientId,
    resource: credential.resource,
    email: credential.email,
  });
  await saveCredential(runtime, environment, refreshed, storage);
  return refreshed.accessToken;
}
