import { runner as runMigrations } from 'node-pg-migrate';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPool } from './db.js';
import { TRACKER_ROLE, ensureTrackerRole } from './roles.js';

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/vitals';
process.env.DATABASE_URL = DATABASE_URL;

const TRACKER_PASSWORD = 'tracker-test-password';
const DAY_TABLES = ['day_met', 'day_manual', 'day_auto'];

function trackerUrl(password: string): string {
  const url = new URL(DATABASE_URL);
  url.username = TRACKER_ROLE;
  url.password = password;
  return url.toString();
}

async function clearDays(pool: pg.Pool): Promise<void> {
  for (const table of DAY_TABLES) {
    // eslint-disable-next-line sonarjs/sql-queries -- static table names
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
  await clearDays(pool);
});

afterAll(async () => {
  await clearDays(pool);
  await pool.end();
});

interface DayRow {
  travel: boolean | null;
  slept_home: boolean | null;
  office: boolean | null;
  away_from_home_h: string | null;
  away_from_sleep_place_h: string | null;
  had_coffee: boolean | null;
  last_coffee: string | null;
  alcohol_drinks: number | null;
  met_count: number | null;
  met: string[] | null;
}

async function dayRow(day: string): Promise<DayRow> {
  const res = await pool.query<DayRow>('SELECT * FROM v_days WHERE day = $1', [
    day,
  ]);
  expect(res.rows).toHaveLength(1);
  return res.rows[0];
}

describe('v_days', () => {
  it('lets corrections win over computed values', async () => {
    await pool.query(
      `INSERT INTO day_auto (day, travel, slept_home, office, away_from_home_h)
       VALUES ('2026-10-20', false, true, false, 6.5)`,
    );
    await pool.query(
      `INSERT INTO day_manual (day, office) VALUES ('2026-10-20', true)`,
    );
    const row = await dayRow('2026-10-20');
    expect(row.office).toBe(true);
    expect(row.slept_home).toBe(true);
    expect(row.away_from_home_h).toBe('6.50');
  });

  it('blanks away-from-home on travel days, also when travel is a correction', async () => {
    await pool.query(
      `INSERT INTO day_auto (day, travel, away_from_home_h, away_from_sleep_place_h)
       VALUES ('2026-10-21', true, 24, 5), ('2026-10-22', false, 24, 5)`,
    );
    await pool.query(
      `INSERT INTO day_manual (day, travel) VALUES ('2026-10-22', true)`,
    );
    for (const day of ['2026-10-21', '2026-10-22']) {
      const row = await dayRow(day);
      expect(row.away_from_home_h).toBeNull();
      expect(row.away_from_sleep_place_h).toBe('5.00');
    }
  });

  it('counts people only once who-I-met was answered', async () => {
    await pool.query(
      `INSERT INTO day_manual (day, had_coffee, last_coffee, alcohol_drinks, met_recorded)
       VALUES ('2026-10-23', true, '14:30', 2, true),
              ('2026-10-24', false, NULL, 0, true),
              ('2026-10-25', NULL, NULL, NULL, false)`,
    );
    await pool.query(
      `INSERT INTO day_met (day, person) VALUES ('2026-10-23', 'tim'), ('2026-10-23', 'flo_hechinger')`,
    );
    const met = await dayRow('2026-10-23');
    expect(met.met_count).toBe(2);
    expect(met.met).toEqual(['flo_hechinger', 'tim']);
    expect(met.last_coffee).toBe('14:30:00');
    expect(met.alcohol_drinks).toBe(2);

    const nobody = await dayRow('2026-10-24');
    expect(nobody.met_count).toBe(0);
    expect(nobody.met).toEqual([]);
    expect(nobody.had_coffee).toBe(false);

    const unanswered = await dayRow('2026-10-25');
    expect(unanswered.met_count).toBeNull();
    expect(unanswered.met).toBeNull();
  });
});

describe('ensureTrackerRole', () => {
  let tracker: pg.Pool;

  beforeAll(async () => {
    // Twice: the hourly sync runs it on an existing role.
    await ensureTrackerRole(pool, 'first-password');
    await ensureTrackerRole(pool, TRACKER_PASSWORD);
    tracker = new pg.Pool({ connectionString: trackerUrl(TRACKER_PASSWORD) });
  });

  afterAll(async () => {
    await tracker.end();
  });

  it('applies the latest password', async () => {
    const stale = new pg.Pool({
      connectionString: trackerUrl('first-password'),
    });
    await expect(stale.query('SELECT 1')).rejects.toThrow();
    await stale.end();
  });

  it('writes the day tables', async () => {
    await tracker.query(
      `INSERT INTO day_auto (day, office) VALUES ('2026-09-01', true)
       ON CONFLICT (day) DO UPDATE SET office = EXCLUDED.office`,
    );
    const res = await tracker.query(
      `DELETE FROM day_auto WHERE day = '2026-09-01'`,
    );
    expect(res.rowCount).toBe(1);
  });

  it('reads the Oura data but cannot change it', async () => {
    await tracker.query('SELECT count(*) FROM oura_sleep');
    await expect(tracker.query('DELETE FROM oura_sleep')).rejects.toThrow(
      /permission denied/,
    );
  });

  it('cannot read the OAuth tokens', async () => {
    await expect(tracker.query('SELECT * FROM tokens')).rejects.toThrow(
      /permission denied/,
    );
  });
});
