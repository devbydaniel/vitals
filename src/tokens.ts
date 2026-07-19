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

/** Reuse the stored access token while it has at least this long to live. */
const REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;

/**
 * Return a valid access token, refreshing the pair only when the stored one
 * is within REFRESH_MARGIN_MS of expiry (or has no known expiry). Sparse
 * refreshes matter: refresh tokens are SINGLE-USE, and every rotation is a
 * small crash-window that could burn the credential.
 *
 * Invariant: when a refresh happens, the new pair is committed to the
 * database BEFORE the access token is returned to any caller, so a crash
 * after the refresh can lose at most one sync run, never the credential.
 */
export async function getFreshAccessToken(
  pool: pg.Pool,
  provider: string,
  config: OAuthClientConfig,
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query<{
      access_token: string;
      refresh_token: string;
      expires_at: Date | null;
    }>(
      `SELECT access_token, refresh_token, expires_at FROM tokens WHERE provider = $1 FOR UPDATE`,
      [provider],
    );
    if (res.rows.length === 0) {
      throw new Error(
        `No tokens stored for provider "${provider}". Run the auth CLI first.`,
      );
    }
    const { access_token, expires_at } = res.rows[0];
    if (
      expires_at !== null &&
      expires_at.getTime() - Date.now() > REFRESH_MARGIN_MS
    ) {
      await client.query('COMMIT');
      return access_token;
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
