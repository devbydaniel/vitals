import { runner as runMigrations } from 'node-pg-migrate';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPool, upsertDocument } from './db.js';

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/vitals';
process.env.DATABASE_URL = DATABASE_URL;

const ID_PREFIX = 'vtest-';
const DAYS = 40;
const SLEEP_TARGET_HOURS = 8;

// Every table that feeds the v_daily_scores day spine. Cleared before seeding
// so the rolling-window views compute over exactly our synthetic rows.
const SPINE_TABLES = [
  'oura_daily_sleep',
  'oura_daily_readiness',
  'oura_daily_activity',
  'oura_daily_stress',
  'oura_daily_resilience',
  'oura_daily_spo2',
  'oura_daily_cardiovascular_age',
  'oura_vo2_max',
  'oura_sleep',
];

// --- deterministic seed formulas (indexed by day offset) --------------------
const sleepScore = (i: number): number => 60 + (i % 25);
const readinessScore = (i: number): number => 55 + (i % 30);
const activityScore = (i: number): number => 50 + (i % 35);
const hrv = (i: number): number => 40 + (i % 20);
const lowestHr = (i: number): number => 45 + (i % 10);
const avgHr = (i: number): number => 60 + (i % 8);
const totalSleepHours = (i: number): number => 6 + (i % 4) * 0.5;

// Base day is a Monday (2026-01-05) so ISO weeks (date_trunc('week', ...))
// align to blocks of 7 consecutive offsets.
function isoDate(offset: number): string {
  const d = new Date(Date.UTC(2026, 0, 5));
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

function mean(nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function sampleStd(nums: number[]): number {
  const m = mean(nums);
  const sumSq = nums.reduce((a, x) => a + (x - m) ** 2, 0);
  return Math.sqrt(sumSq / (nums.length - 1));
}

function offsets(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, k) => start + k);
}

function sleepRaw(i: number): Record<string, unknown> {
  const total = totalSleepHours(i);
  const lightHours = total - 1.5 - 1.5;
  const hours = (h: number): number => Math.round(h * 3600);
  return {
    day: isoDate(i),
    type: 'long_sleep',
    average_hrv: hrv(i),
    lowest_heart_rate: lowestHr(i),
    average_heart_rate: avgHr(i),
    total_sleep_duration: hours(total),
    time_in_bed: hours(total + 0.5),
    deep_sleep_duration: hours(1.5),
    rem_sleep_duration: hours(1.5),
    light_sleep_duration: hours(lightHours),
    awake_time: hours(0.5),
    efficiency: 90,
    bedtime_start: `${isoDate(i)}T23:30:00+01:00`,
    bedtime_end: `${isoDate(i)}T07:30:00+01:00`,
  };
}

async function seedDay(pool: pg.Pool, i: number): Promise<void> {
  const day = isoDate(i);
  await upsertDocument(pool, 'oura_daily_sleep', {
    id: `${ID_PREFIX}ds-${i}`,
    day,
    raw: { day, score: sleepScore(i) },
  });
  await upsertDocument(pool, 'oura_daily_readiness', {
    id: `${ID_PREFIX}dr-${i}`,
    day,
    raw: { day, score: readinessScore(i) },
  });
  await upsertDocument(pool, 'oura_daily_activity', {
    id: `${ID_PREFIX}da-${i}`,
    day,
    raw: { day, score: activityScore(i) },
  });
  await upsertDocument(pool, 'oura_sleep', {
    id: `${ID_PREFIX}sl-${i}`,
    day,
    raw: sleepRaw(i),
  });
}

async function clearSpine(pool: pg.Pool): Promise<void> {
  for (const table of SPINE_TABLES) {
    // eslint-disable-next-line sonarjs/sql-queries -- static table name from a fixed whitelist, no interpolation of user input
    await pool.query(`DELETE FROM ${table}`);
  }
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
  await clearSpine(pool);
  for (const i of offsets(0, DAYS - 1)) {
    await seedDay(pool, i);
  }
  // A nap the same day as the long sleep on day 0 — must be excluded by the
  // type = 'long_sleep' filter throughout the sleep-derived views.
  await upsertDocument(pool, 'oura_sleep', {
    id: `${ID_PREFIX}nap-0`,
    day: isoDate(0),
    raw: {
      day: isoDate(0),
      type: 'late_nap',
      total_sleep_duration: 1800,
      average_hrv: 999,
    },
  });
}, 60_000);

afterAll(async () => {
  for (const table of [
    'oura_daily_sleep',
    'oura_daily_readiness',
    'oura_daily_activity',
    'oura_sleep',
  ]) {
    // eslint-disable-next-line sonarjs/sql-queries -- static table name from a fixed whitelist, no interpolation of user input
    await pool.query(`DELETE FROM ${table} WHERE id LIKE $1`, [
      `${ID_PREFIX}%`,
    ]);
  }
  await pool.end();
});

describe('v_daily_scores', () => {
  it('exposes the seeded scores and sleep-derived metrics per day', async () => {
    const res = await pool.query(
      `SELECT sleep_score, readiness_score, activity_score, average_hrv, resting_hr
       FROM v_daily_scores WHERE day = $1`,
      [isoDate(5)],
    );
    expect(res.rows).toHaveLength(1);
    const row = res.rows[0];
    expect(row.sleep_score).toBe(sleepScore(5));
    expect(row.readiness_score).toBe(readinessScore(5));
    expect(row.activity_score).toBe(activityScore(5));
    expect(Number(row.average_hrv)).toBeCloseTo(hrv(5), 6);
    expect(Number(row.resting_hr)).toBeCloseTo(lowestHr(5), 6);
  });

  it('excludes nap (non-long_sleep) rows from the HRV average', async () => {
    const res = await pool.query(
      `SELECT average_hrv FROM v_daily_scores WHERE day = $1`,
      [isoDate(0)],
    );
    // hrv(0) = 40, not the nap's decoy 999.
    expect(Number(res.rows[0].average_hrv)).toBeCloseTo(hrv(0), 6);
  });
});

describe('v_baselines_30d', () => {
  it('rolling mean/stddev at day 31 equal the prior 30 days', async () => {
    const res = await pool.query(
      `SELECT sleep_score_mean_30d, sleep_score_std_30d
       FROM v_baselines_30d WHERE day = $1`,
      [isoDate(30)],
    );
    const prior30 = offsets(0, 29).map(sleepScore);
    expect(Number(res.rows[0].sleep_score_mean_30d)).toBeCloseTo(
      mean(prior30),
      6,
    );
    expect(Number(res.rows[0].sleep_score_std_30d)).toBeCloseTo(
      sampleStd(prior30),
      6,
    );
  });

  it('leaves the first day without a baseline (empty preceding window)', async () => {
    const res = await pool.query(
      `SELECT sleep_score_mean_30d FROM v_baselines_30d WHERE day = $1`,
      [isoDate(0)],
    );
    expect(res.rows[0].sleep_score_mean_30d).toBeNull();
  });
});

describe('v_sleep_debt_14d', () => {
  it('sums the trailing-14-day deficit vs the 8h target', async () => {
    const res = await pool.query(
      `SELECT sleep_debt_hours FROM v_sleep_debt_14d WHERE day = $1`,
      [isoDate(39)],
    );
    const window = offsets(26, 39).map(
      (i) => SLEEP_TARGET_HOURS - totalSleepHours(i),
    );
    const expected = window.reduce((a, b) => a + b, 0);
    expect(Number(res.rows[0].sleep_debt_hours)).toBeCloseTo(expected, 6);
  });

  it('sums a partial (early) window correctly', async () => {
    const res = await pool.query(
      `SELECT sleep_debt_hours FROM v_sleep_debt_14d WHERE day = $1`,
      [isoDate(5)],
    );
    const window = offsets(0, 5).map(
      (i) => SLEEP_TARGET_HOURS - totalSleepHours(i),
    );
    const expected = window.reduce((a, b) => a + b, 0);
    expect(Number(res.rows[0].sleep_debt_hours)).toBeCloseTo(expected, 6);
  });
});

describe('v_weekly_deltas', () => {
  it('computes the week-over-week sleep-score delta', async () => {
    const week1 = mean(offsets(7, 13).map(sleepScore));
    const week2 = mean(offsets(14, 20).map(sleepScore));
    const res = await pool.query(
      `SELECT sleep_score, sleep_score_delta
       FROM v_weekly_deltas WHERE day = $1`,
      [isoDate(14)],
    );
    expect(Number(res.rows[0].sleep_score)).toBeCloseTo(week2, 6);
    expect(Number(res.rows[0].sleep_score_delta)).toBeCloseTo(week2 - week1, 6);
  });

  it('has no delta for the first week', async () => {
    const res = await pool.query(
      `SELECT sleep_score_delta FROM v_weekly_deltas WHERE day = $1`,
      [isoDate(0)],
    );
    expect(res.rows[0].sleep_score_delta).toBeNull();
  });
});
