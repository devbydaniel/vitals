import { runner as runMigrations } from 'node-pg-migrate';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DOCUMENT_TABLES,
  createPool,
  upsertDocument,
  upsertHeartrate,
} from './db.js';

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/vitals';
process.env.DATABASE_URL = DATABASE_URL;

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
  await pool.end();
});

describe('migrations', () => {
  it('creates all document tables, tokens, and heartrate', async () => {
    const res = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const names = res.rows.map((r: { table_name: string }) => r.table_name);
    for (const table of DOCUMENT_TABLES) {
      expect(names).toContain(table);
    }
    expect(names).toContain('tokens');
    expect(names).toContain('oura_heartrate');
  });
});

describe('upsertDocument', () => {
  it('is idempotent by id', async () => {
    const row = { id: 'test-doc-1', day: '2026-07-17', raw: { score: 80 } };
    await upsertDocument(pool, 'oura_daily_sleep', row);
    await upsertDocument(pool, 'oura_daily_sleep', {
      ...row,
      raw: { score: 81 },
    });
    const res = await pool.query(
      `SELECT raw FROM oura_daily_sleep WHERE id = $1`,
      [row.id],
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].raw.score).toBe(81);
    await pool.query(`DELETE FROM oura_daily_sleep WHERE id = $1`, [row.id]);
  });

  it('rejects unknown tables', async () => {
    await expect(
      upsertDocument(pool, 'pg_catalog.pg_tables; DROP TABLE tokens', {
        id: 'x',
        day: null,
        raw: {},
      }),
    ).rejects.toThrow(/Unknown document table/);
  });
});

describe('upsertHeartrate', () => {
  it('handles batches larger than the wire-protocol-safe chunk', async () => {
    const many = Array.from({ length: 12_000 }, (_, i) => ({
      ts: new Date(Date.UTC(2020, 0, 1, 0, 0, i)).toISOString(),
      source: 'bulk-test',
      bpm: 50 + (i % 40),
    }));
    await upsertHeartrate(pool, many);
    const res = await pool.query(
      `SELECT count(*) FROM oura_heartrate WHERE source = 'bulk-test'`,
    );
    expect(Number(res.rows[0].count)).toBe(12_000);
    await pool.query(`DELETE FROM oura_heartrate WHERE source = 'bulk-test'`);
  });

  it('is idempotent by (ts, source)', async () => {
    const samples = [
      { ts: '2026-07-17T01:00:00Z', source: 'test', bpm: 52 },
      { ts: '2026-07-17T01:05:00Z', source: 'test', bpm: 54 },
    ];
    await upsertHeartrate(pool, samples);
    await upsertHeartrate(pool, [
      { ts: '2026-07-17T01:00:00Z', source: 'test', bpm: 53 },
    ]);
    const res = await pool.query(
      `SELECT bpm FROM oura_heartrate WHERE source = 'test' ORDER BY ts`,
    );
    expect(res.rows).toHaveLength(2);
    expect(res.rows[0].bpm).toBe(53);
    await pool.query(`DELETE FROM oura_heartrate WHERE source = 'test'`);
  });
});
