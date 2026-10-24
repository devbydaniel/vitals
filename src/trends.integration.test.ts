import { runner as runMigrations } from 'node-pg-migrate';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPool, upsertDocument } from './db.js';

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/vitals';
process.env.DATABASE_URL = DATABASE_URL;

// Every table the trend views read. Cleared so the windows see only our rows.
const TABLES = [
  'oura_daily_sleep',
  'oura_daily_readiness',
  'oura_daily_activity',
  'oura_daily_stress',
  'oura_daily_resilience',
  'oura_daily_spo2',
  'oura_daily_cardiovascular_age',
  'oura_vo2_max',
  'oura_sleep',
  'oura_workout',
  'day_met',
  'day_manual',
  'day_auto',
];

// Day 0 is 2027-03-01. Nights exist on days 0..39 except 20..24 (a gap).
const NIGHTS = Array.from({ length: 40 }, (_, i) => i).filter(
  (i) => i < 20 || i > 24,
);
const hrv = (i: number): number => 20 + (i % 10);

function isoDate(offset: number): string {
  const d = new Date(Date.UTC(2027, 2, 1));
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

function mean(nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

async function clear(pool: pg.Pool): Promise<void> {
  for (const table of TABLES) {
    // eslint-disable-next-line sonarjs/sql-queries -- static table names
    await pool.query(`DELETE FROM ${table}`);
  }
}

async function seedNight(pool: pg.Pool, i: number): Promise<void> {
  const day = isoDate(i);
  await upsertDocument(pool, 'oura_sleep', {
    id: `tr-sl-${i}`,
    day,
    raw: {
      day,
      type: 'long_sleep',
      average_hrv: hrv(i),
      lowest_heart_rate: 55,
      average_heart_rate: 60,
      total_sleep_duration: 7 * 3600,
      deep_sleep_duration: 3600,
      rem_sleep_duration: 3600,
      efficiency: 85,
      bedtime_start: `${isoDate(i - 1)}T23:30:00+01:00`,
      bedtime_end: `${day}T07:00:00+01:00`,
    },
  });
}

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
  await clear(pool);
  for (const i of NIGHTS) {
    await seedNight(pool, i);
  }
  // Oura re-issued day 0's daily documents under new ids.
  for (const [id, steps] of [
    ['tr-da-a', 9000],
    ['tr-da-b', 250],
  ] as const) {
    await upsertDocument(pool, 'oura_daily_activity', {
      id,
      day: isoDate(0),
      raw: { day: isoDate(0), score: 80, steps },
    });
  }
  for (const id of ['tr-ds-a', 'tr-ds-b']) {
    await upsertDocument(pool, 'oura_daily_sleep', {
      id,
      day: isoDate(0),
      raw: { day: isoDate(0), score: 70 },
    });
  }
  // Day 33: two drinks; day 34: none. Nights 34 and 35 follow them.
  await pool.query(
    `INSERT INTO day_manual (day, alcohol_drinks, met_recorded)
     VALUES ($1, 2, true), ($2, 0, true)`,
    [isoDate(33), isoDate(34)],
  );
  await pool.query(`INSERT INTO day_met (day, person) VALUES ($1, 'tim')`, [
    isoDate(33),
  ]);
}, 60_000);

afterAll(async () => {
  await clear(pool);
  await pool.end();
});

describe('v_daily_scores', () => {
  it('keeps one row per day when Oura re-issues a daily document', async () => {
    const res = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM v_daily_scores WHERE day = $1',
      [isoDate(0)],
    );
    expect(Number(res.rows[0]?.n)).toBe(1);
  });
});

describe('v_daily', () => {
  it('takes the activity copy with the most steps', async () => {
    const res = await pool.query<{ steps: number }>(
      'SELECT steps FROM v_daily WHERE day = $1',
      [isoDate(0)],
    );
    expect(res.rows[0]?.steps).toBe(9000);
  });

  it('expresses bedtime as hours after the evening before midnight', async () => {
    const res = await pool.query<{ bedtime_h: string }>(
      'SELECT bedtime_h FROM v_daily WHERE day = $1',
      [isoDate(5)],
    );
    // 23:30 CET is 23:30 in Europe/Berlin in March 2027 (before DST).
    expect(Number(res.rows[0]?.bedtime_h)).toBeCloseTo(23.5, 5);
  });
});

describe('v_trends', () => {
  async function hrvRow(i: number): Promise<{
    ma30: string | null;
    base30: string | null;
  }> {
    const res = await pool.query<{
      ma30: string | null;
      base30: string | null;
    }>(`SELECT ma30, base30 FROM v_trends WHERE metric = 'hrv' AND day = $1`, [
      isoDate(i),
    ]);
    expect(res.rows).toHaveLength(1);
    return res.rows[0] as { ma30: string | null; base30: string | null };
  }

  it('leaves the 30-day average empty until 10 values are in the window', async () => {
    expect((await hrvRow(8)).ma30).toBeNull();
    expect(Number((await hrvRow(9)).ma30)).toBeCloseTo(
      mean(NIGHTS.filter((i) => i <= 9).map(hrv)),
      6,
    );
  });

  it('averages over 30 calendar days, not 30 rows, across a gap', async () => {
    // Day 35's window is days 6..35; nights 20..24 are missing.
    const window = NIGHTS.filter((i) => i >= 6 && i <= 35);
    expect(window).toHaveLength(25);
    expect(Number((await hrvRow(35)).ma30)).toBeCloseTo(
      mean(window.map(hrv)),
      6,
    );
  });

  it('compares a day against the 30 days before it, excluding the day', async () => {
    const before = NIGHTS.filter((i) => i >= 5 && i <= 34);
    expect(Number((await hrvRow(35)).base30)).toBeCloseTo(
      mean(before.map(hrv)),
      6,
    );
  });
});

describe('v_nights and v_effects', () => {
  it('joins each night with the day before it', async () => {
    const res = await pool.query<{
      prev_alcohol_drinks: number | null;
      prev_met_count: number | null;
      hrv_delta: string | null;
    }>(
      `SELECT prev_alcohol_drinks, prev_met_count, hrv_delta
       FROM v_nights WHERE day = $1`,
      [isoDate(34)],
    );
    const night = res.rows[0];
    expect(night.prev_alcohol_drinks).toBe(2);
    expect(night.prev_met_count).toBe(1);
    const base = mean(NIGHTS.filter((i) => i >= 4 && i <= 33).map(hrv));
    expect(Number(night.hrv_delta)).toBeCloseTo(hrv(34) - base, 6);
  });

  it('groups nights into ordered buckets', async () => {
    const res = await pool.query<{ bucket: string; nights: number }>(
      `SELECT bucket, nights FROM v_effects
       WHERE factor = 'Drinks the evening before'
       ORDER BY bucket_sort`,
    );
    expect(res.rows).toEqual([
      { bucket: '0', nights: 1 },
      { bucket: '1-2', nights: 1 },
    ]);
  });
});
