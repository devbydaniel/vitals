import type pg from 'pg';

import type { OAuthClientConfig, TokenPair } from './oauth.js';
import { refreshTokenPair } from './oauth.js';

export async function saveTokenPair(
  client: pg.Pool | pg.PoolClient,
  provider: string,
  pair: TokenPair,
): Promise<void> {
  await client.query(
    `INSERT INTO tokens (provider, access_token, refresh_token, expires_at, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (provider) DO UPDATE SET
       access_token = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       expires_at = EXCLUDED.expires_at,
       updated_at = now()`,
    [provider, pair.accessToken, pair.refreshToken, pair.expiresAt],
  );
}

/**
 * Refresh the provider's token pair and return a fresh access token.
 *
 * Invariant: refresh tokens are SINGLE-USE. The new pair is committed to the
 * database BEFORE the access token is returned to any caller, so a crash after
 * the refresh can lose at most one sync run, never the credential.
 */
export async function getFreshAccessToken(
  pool: pg.Pool,
  provider: string,
  config: OAuthClientConfig,
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query<{ refresh_token: string }>(
      `SELECT refresh_token FROM tokens WHERE provider = $1 FOR UPDATE`,
      [provider],
    );
    if (res.rows.length === 0) {
      throw new Error(
        `No tokens stored for provider "${provider}". Run the auth CLI first.`,
      );
    }
    const pair = await refreshTokenPair(
      config,
      provider,
      res.rows[0].refresh_token,
    );
    await saveTokenPair(client, provider, pair);
    await client.query('COMMIT');
    return pair.accessToken;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
