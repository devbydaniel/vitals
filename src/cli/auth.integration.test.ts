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

import { createPool } from '../db.js';
import { processCallback } from './auth.js';

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
  await pool.query(`DELETE FROM tokens WHERE provider = 'oura'`);
  await pool.end();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('processCallback', () => {
  it('rejects a state mismatch without calling the token endpoint', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const params = new URLSearchParams({ code: 'c', state: 'wrong' });

    await expect(
      processCallback(params, 'expected', CONFIG, pool),
    ).rejects.toThrow(/State mismatch/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects when the user denied consent', async () => {
    const params = new URLSearchParams({ error: 'access_denied', state: 's' });
    await expect(processCallback(params, 's', CONFIG, pool)).rejects.toThrow(
      /denied/,
    );
  });

  it('exchanges the code and stores the token pair', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: 'boot-access',
            refresh_token: 'boot-refresh',
            expires_in: 86400,
          }),
          { status: 200 },
        ),
      ),
    );
    const params = new URLSearchParams({ code: 'auth-code', state: 's' });

    await processCallback(params, 's', CONFIG, pool);

    const row = await pool.query(
      `SELECT access_token, refresh_token FROM tokens WHERE provider = 'oura'`,
    );
    expect(row.rows[0].access_token).toBe('boot-access');
    expect(row.rows[0].refresh_token).toBe('boot-refresh');
  });
});
