import { runner as runMigrations } from 'node-pg-migrate';
import type pg from 'pg';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { createPool, DOCUMENT_TABLES } from './db.js';
import { BACKFILL_START, chunkRange, pingHeartbeat, syncAll } from './sync.js';

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/vitals';
process.env.DATABASE_URL = DATABASE_URL;

const TODAY = '2026-07-18';

let pool: pg.Pool;

async function wipe(): Promise<void> {
  for (const table of DOCUMENT_TABLES) {
    // eslint-disable-next-line sonarjs/sql-queries -- static registry table names
    await pool.query(`DELETE FROM ${table}`);
  }
  await pool.query(`DELETE FROM oura_heartrate`);
}

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
  await wipe();
  await pool.end();
});

beforeEach(async () => {
  await wipe();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function apiResponse(docs: unknown[]): Response {
  return new Response(JSON.stringify({ data: docs, next_token: null }), {
    status: 200,
  });
}

/** Mock the Oura API: returns one deterministic document per request. */
function stubOuraApi(): ReturnType<typeof vi.fn> {
  let counter = 0;
  const fetchMock = vi.fn((input: URL | string) => {
    const url = input instanceof URL ? input : new URL(String(input));
    if (url.pathname.includes('heartrate')) {
      return Promise.resolve(
        apiResponse([
          { bpm: 55, source: 'sleep', timestamp: '2026-07-17T02:00:00+00:00' },
        ]),
      );
    }
    counter += 1;
    const start = url.searchParams.get('start_date') ?? 'unknown';
    return Promise.resolve(
      apiResponse([
        { id: `${url.pathname}-${start}-${String(counter)}`, day: start },
      ]),
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function documentCalls(fetchMock: ReturnType<typeof vi.fn>): URL[] {
  return fetchMock.mock.calls
    .map((c) => c[0] as URL)
    .filter((u) => u.pathname.includes('daily_sleep'));
}

describe('chunkRange', () => {
  it('splits an inclusive range into inclusive chunks', () => {
    const chunks = chunkRange('2026-01-01', '2026-02-15', 30);
    expect(chunks).toEqual([
      { start: '2026-01-01', end: '2026-01-30' },
      { start: '2026-01-31', end: '2026-02-15' },
    ]);
  });

  it('handles a range smaller than the chunk size', () => {
    expect(chunkRange('2026-07-12', '2026-07-18', 30)).toEqual([
      { start: '2026-07-12', end: '2026-07-18' },
    ]);
  });
});

describe('syncAll', () => {
  it('backfills from BACKFILL_START when tables are empty', async () => {
    const fetchMock = stubOuraApi();

    await syncAll(pool, { accessToken: 'tok', today: TODAY });

    const calls = documentCalls(fetchMock);
    expect(calls[0].searchParams.get('start_date')).toBe(BACKFILL_START);
    expect(calls.length).toBeGreaterThan(100); // ~11.5 years / 30-day chunks
    const rows = await pool.query(`SELECT count(*) FROM oura_daily_sleep`);
    expect(Number(rows.rows[0].count)).toBe(calls.length);
  });

  it('uses a trailing 7-day window when data exists, and is idempotent', async () => {
    await pool.query(
      `INSERT INTO oura_daily_sleep (id, day, raw) VALUES ('existing', '2026-07-10', '{}')`,
    );
    const fetchMock = stubOuraApi();

    await syncAll(pool, { accessToken: 'tok', today: TODAY });

    const calls = documentCalls(fetchMock);
    expect(calls).toHaveLength(1);
    expect(calls[0].searchParams.get('start_date')).toBe('2026-07-12');
    expect(calls[0].searchParams.get('end_date')).toBe(TODAY);

    // Re-run with identical responses: no duplicate rows.
    const before = await pool.query(`SELECT count(*) FROM oura_daily_sleep`);
    stubOuraApi();
    await syncAll(pool, { accessToken: 'tok', today: TODAY });
    const after = await pool.query(`SELECT count(*) FROM oura_daily_sleep`);
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });

  it('stores heartrate samples idempotently', async () => {
    await pool.query(
      `INSERT INTO oura_daily_sleep (id, day, raw) VALUES ('existing', '2026-07-10', '{}')`,
    );
    stubOuraApi();
    await syncAll(pool, { accessToken: 'tok', today: TODAY });
    stubOuraApi();
    await syncAll(pool, { accessToken: 'tok', today: TODAY });

    const rows = await pool.query(`SELECT count(*) FROM oura_heartrate`);
    expect(Number(rows.rows[0].count)).toBe(1);
  });

  it('throws when an endpoint fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response('{"detail":"nope"}', { status: 401 })),
    );
    await expect(
      syncAll(pool, { accessToken: 'tok', today: TODAY }),
    ).rejects.toThrow(/401/);
  });
});

describe('pingHeartbeat', () => {
  it('pings the URL when set and swallows network errors', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('down'));
    vi.stubGlobal('fetch', fetchMock);
    await pingHeartbeat('https://kuma.test/api/push/abc');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does nothing when unset', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await pingHeartbeat(undefined);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
