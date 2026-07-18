import type pg from 'pg';

import { upsertDocument, upsertHeartrate } from './db.js';
import type { OuraEndpoint } from './providers/oura/client.js';
import {
  OURA_ENDPOINTS,
  fetchDocuments,
  fetchHeartrate,
} from './providers/oura/client.js';

/** Earliest date worth backfilling — predates the first Oura ring. */
export const BACKFILL_START = '2015-01-01';
/** Nightly window: re-fetch trailing days so late-syncing data self-heals. */
export const TRAILING_DAYS = 7;
/** Date-range chunk size for backfill requests. */
export const CHUNK_DAYS = 30;

export interface SyncOptions {
  accessToken: string;
  /** Inclusive end date (YYYY-MM-DD); defaults to today UTC. */
  today?: string;
  log?: (message: string) => void;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

export interface DateRange {
  start: string;
  end: string;
}

/** Split an inclusive date range into inclusive chunks of at most `days` days. */
export function chunkRange(
  start: string,
  end: string,
  days: number,
): DateRange[] {
  const chunks: DateRange[] = [];
  let cursor = start;
  while (cursor <= end) {
    const chunkEnd = addDays(cursor, days - 1);
    chunks.push({ start: cursor, end: chunkEnd < end ? chunkEnd : end });
    cursor = addDays(chunkEnd, 1);
  }
  return chunks;
}

async function tableIsEmpty(pool: pg.Pool, table: string): Promise<boolean> {
  // eslint-disable-next-line sonarjs/sql-queries -- table names come from the static endpoint registry
  const res = await pool.query(`SELECT 1 FROM ${table} LIMIT 1`);
  return res.rows.length === 0;
}

async function windowFor(
  pool: pg.Pool,
  table: string,
  today: string,
): Promise<DateRange> {
  if (await tableIsEmpty(pool, table)) {
    return { start: BACKFILL_START, end: today };
  }
  return { start: addDays(today, -(TRAILING_DAYS - 1)), end: today };
}

async function syncEndpoint(
  pool: pg.Pool,
  endpoint: OuraEndpoint,
  options: Required<Pick<SyncOptions, 'accessToken' | 'today' | 'log'>>,
): Promise<number> {
  const window = await windowFor(pool, endpoint.table, options.today);
  let count = 0;
  for (const chunk of chunkRange(window.start, window.end, CHUNK_DAYS)) {
    const docs = await fetchDocuments(
      options.accessToken,
      endpoint,
      chunk.start,
      chunk.end,
    );
    for (const doc of docs) {
      await upsertDocument(pool, endpoint.table, {
        id: doc.id,
        day: typeof doc.day === 'string' ? doc.day : null,
        raw: doc,
      });
    }
    count += docs.length;
  }
  options.log(
    `${endpoint.path}: ${String(count)} documents (${window.start}..${window.end})`,
  );
  return count;
}

async function syncHeartrate(
  pool: pg.Pool,
  options: Required<Pick<SyncOptions, 'accessToken' | 'today' | 'log'>>,
): Promise<number> {
  const window = await windowFor(pool, 'oura_heartrate', options.today);
  let count = 0;
  for (const chunk of chunkRange(window.start, window.end, CHUNK_DAYS)) {
    const samples = await fetchHeartrate(
      options.accessToken,
      `${chunk.start}T00:00:00+00:00`,
      `${chunk.end}T23:59:59+00:00`,
    );
    await upsertHeartrate(
      pool,
      samples.map((s) => ({ ts: s.timestamp, source: s.source, bpm: s.bpm })),
    );
    count += samples.length;
  }
  options.log(
    `heartrate: ${String(count)} samples (${window.start}..${window.end})`,
  );
  return count;
}

/**
 * Sync all Oura endpoints. Throws on the first endpoint failure — the caller
 * must only report success (heartbeat) when everything landed.
 */
export async function syncAll(
  pool: pg.Pool,
  options: SyncOptions,
): Promise<number> {
  const resolved = {
    accessToken: options.accessToken,
    today: options.today ?? isoDate(new Date()),
    log: options.log ?? (() => undefined),
  };
  let total = 0;
  for (const endpoint of OURA_ENDPOINTS) {
    total += await syncEndpoint(pool, endpoint, resolved);
  }
  total += await syncHeartrate(pool, resolved);
  return total;
}

/** Report success to an uptime-kuma push monitor. Never throws. */
export async function pingHeartbeat(url: string | undefined): Promise<void> {
  if (url === undefined) return;
  try {
    await fetch(url);
  } catch {
    // Monitoring must never fail the sync itself.
  }
}
