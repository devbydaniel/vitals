import pg from 'pg';

import { requireEnv } from './env.js';

export const DOCUMENT_TABLES = [
  'oura_daily_sleep',
  'oura_daily_readiness',
  'oura_daily_activity',
  'oura_daily_stress',
  'oura_daily_resilience',
  'oura_daily_spo2',
  'oura_daily_cardiovascular_age',
  'oura_vo2_max',
  'oura_sleep',
  'oura_sleep_time',
  'oura_workout',
  'oura_session',
  'oura_enhanced_tag',
  'oura_rest_mode_period',
] as const;

export type DocumentTable = (typeof DOCUMENT_TABLES)[number];

export function createPool(): pg.Pool {
  return new pg.Pool({ connectionString: requireEnv('DATABASE_URL') });
}

function assertDocumentTable(table: string): asserts table is DocumentTable {
  if (!(DOCUMENT_TABLES as readonly string[]).includes(table)) {
    throw new Error(`Unknown document table: ${table}`);
  }
}

export interface DocumentRow {
  id: string;
  day: string | null;
  raw: unknown;
}

export async function upsertDocument(
  client: pg.Pool | pg.PoolClient,
  table: string,
  row: DocumentRow,
): Promise<void> {
  assertDocumentTable(table);
  // eslint-disable-next-line sonarjs/sql-queries -- table is whitelist-checked above; values are parameterized
  await client.query(
    `INSERT INTO ${table} (id, day, raw, fetched_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (id) DO UPDATE SET day = EXCLUDED.day, raw = EXCLUDED.raw, fetched_at = now()`,
    [row.id, row.day, JSON.stringify(row.raw)],
  );
}

export interface HeartrateSample {
  ts: string;
  source: string;
  bpm: number;
}

export async function upsertHeartrate(
  client: pg.Pool | pg.PoolClient,
  samples: HeartrateSample[],
): Promise<void> {
  if (samples.length === 0) return;
  const values: unknown[] = [];
  const tuples = samples.map((s, i) => {
    values.push(s.ts, s.source, s.bpm);
    const base = i * 3;
    return `($${base + 1}, $${base + 2}, $${base + 3}, now())`;
  });
  // eslint-disable-next-line sonarjs/sql-queries -- tuples are generated $n placeholders; values are parameterized
  await client.query(
    `INSERT INTO oura_heartrate (ts, source, bpm, fetched_at)
     VALUES ${tuples.join(', ')}
     ON CONFLICT (ts, source) DO UPDATE SET bpm = EXCLUDED.bpm, fetched_at = now()`,
    values,
  );
}
