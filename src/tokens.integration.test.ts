import { runner as runMigrations } from 'node-pg-migrate';
import type pg from 'pg';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { createPool } from './db.js';
import { OAuthInvalidGrantError } from './oauth.js';
import { getFreshAccessToken, saveTokenPair } from './tokens.js';

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/vitals';
process.env.DATABASE_URL = DATABASE_URL;

const CONFIG = {
  tokenUrl: 'https://example.test/oauth/token',
  clientId: 'cid',
  clientSecret: 'csecret',
};

let pool: pg.Pool;

beforeAll(async () => {
  await runMigrations({
    databaseUrl: DATABASE_URL,
    dir: 'migrations',
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => undefined,
  });
  pool = createPool();
});

afterAll(async () => {
  await pool.query(`DELETE FROM tokens WHERE provider = 'test-provider'`);
  await pool.end();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function tokenResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('getFreshAccessToken', () => {
  it('persists the rotated pair before returning the access token', async () => {
    await saveTokenPair(pool, 'test-provider', {
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: null,
    });
    const fetchMock = vi.fn().mockResolvedValue(
      tokenResponse({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 86400,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const accessToken = await getFreshAccessToken(
      pool,
      'test-provider',
      CONFIG,
    );

    expect(accessToken).toBe('new-access');
    const row = await pool.query(
      `SELECT refresh_token, expires_at FROM tokens WHERE provider = 'test-provider'`,
    );
    expect(row.rows[0].refresh_token).toBe('new-refresh');
    expect(row.rows[0].expires_at).not.toBeNull();

    const body = fetchMock.mock.calls[0][1] as { body: string };
    expect(body.body).toContain('refresh_token=old-refresh');
  });

  it('throws OAuthInvalidGrantError on invalid_grant and keeps the old row', async () => {
    await saveTokenPair(pool, 'test-provider', {
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: null,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(tokenResponse({ error: 'invalid_grant' }, 400)),
    );

    await expect(
      getFreshAccessToken(pool, 'test-provider', CONFIG),
    ).rejects.toBeInstanceOf(OAuthInvalidGrantError);
    const row = await pool.query(
      `SELECT refresh_token FROM tokens WHERE provider = 'test-provider'`,
    );
    expect(row.rows[0].refresh_token).toBe('old-refresh');
  });

  it('fails clearly when no tokens are stored', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await expect(
      getFreshAccessToken(pool, 'nonexistent-provider', CONFIG),
    ).rejects.toThrow(/Run the auth CLI first/);
  });
});
