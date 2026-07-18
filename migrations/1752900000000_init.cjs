/* eslint-disable */
// Initial schema: tokens (multi-provider OAuth) + Oura raw document tables.
// Raw API responses live in `raw` jsonb; views (later migration) extract from it.

const DOCUMENT_TABLES = [
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
];

exports.up = (pgm) => {
  pgm.createTable('tokens', {
    provider: { type: 'text', primaryKey: true },
    access_token: { type: 'text', notNull: true },
    refresh_token: { type: 'text', notNull: true },
    expires_at: { type: 'timestamptz' },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  for (const table of DOCUMENT_TABLES) {
    pgm.createTable(table, {
      id: { type: 'text', primaryKey: true },
      day: { type: 'date' },
      raw: { type: 'jsonb', notNull: true },
      fetched_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    });
    pgm.createIndex(table, 'day');
  }

  pgm.createTable('oura_heartrate', {
    ts: { type: 'timestamptz', notNull: true },
    source: { type: 'text', notNull: true },
    bpm: { type: 'integer', notNull: true },
    fetched_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('oura_heartrate', 'oura_heartrate_pkey', {
    primaryKey: ['ts', 'source'],
  });
};

exports.down = (pgm) => {
  pgm.dropTable('oura_heartrate');
  for (const table of [...DOCUMENT_TABLES].reverse()) {
    pgm.dropTable(table);
  }
  pgm.dropTable('tokens');
};
