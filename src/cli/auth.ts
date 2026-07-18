// One-time OAuth consent flow: opens the Oura authorize page, catches the
// redirect on localhost, exchanges the code, and stores the initial token pair.
// Run with DATABASE_URL pointing at the vitals Postgres (kubectl port-forward
// for the cluster instance), OURA_CLIENT_ID / OURA_CLIENT_SECRET set.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import type pg from 'pg';

import { createPool } from '../db.js';
import type { OAuthClientConfig } from '../oauth.js';
import { exchangeCode } from '../oauth.js';
import { requireEnv } from '../env.js';
import {
  OURA_AUTHORIZE_URL,
  OURA_SCOPES,
  OURA_TOKEN_URL,
} from '../providers/oura/client.js';
import { saveTokenPair } from '../tokens.js';

const PORT = 8484;
const REDIRECT_URI = `http://localhost:${String(PORT)}/callback`;

export function buildAuthorizeUrl(clientId: string, state: string): string {
  const url = new URL(OURA_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', OURA_SCOPES);
  url.searchParams.set('state', state);
  return url.toString();
}

/**
 * Validate the OAuth callback, exchange the code, and persist the token pair
 * for the provider. Throws on state mismatch or missing code.
 */
export async function processCallback(
  params: URLSearchParams,
  expectedState: string,
  config: OAuthClientConfig,
  pool: pg.Pool,
): Promise<void> {
  const error = params.get('error');
  if (error !== null) {
    throw new Error(`Authorization denied: ${error}`);
  }
  if (params.get('state') !== expectedState) {
    throw new Error('State mismatch — possible CSRF, aborting.');
  }
  const code = params.get('code');
  if (code === null) {
    throw new Error('Callback is missing the authorization code.');
  }
  const pair = await exchangeCode(config, 'oura', code, REDIRECT_URI);
  await saveTokenPair(pool, 'oura', pair);
}

function main(): void {
  const config: OAuthClientConfig = {
    tokenUrl: OURA_TOKEN_URL,
    clientId: requireEnv('OURA_CLIENT_ID'),
    clientSecret: requireEnv('OURA_CLIENT_SECRET'),
  };
  const pool = createPool();
  const state = randomUUID();

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${String(PORT)}`);
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    processCallback(url.searchParams, state, config, pool)
      .then(async () => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>vitals: Oura connected.</h1>You can close this tab.');
        console.log('Token pair stored for provider "oura".');
        server.close();
        await pool.end();
      })
      .catch(async (err: unknown) => {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(String(err));
        console.error(err);
        server.close();
        await pool.end();
        process.exitCode = 1;
      });
  });

  server.listen(PORT, () => {
    const authorizeUrl = buildAuthorizeUrl(config.clientId, state);
    console.log(`Open this URL to authorize:\n\n${authorizeUrl}\n`);
  });
}

if (process.argv[1]?.endsWith('auth.ts') === true) {
  main();
}
