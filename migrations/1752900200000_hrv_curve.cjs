/* eslint-disable */
// v_hrv_curve: explode the intra-night HRV sample series stored in
// oura_sleep.raw->'hrv' (PublicSample: timestamp start, interval seconds,
// items = rMSSD ms values, nullable) into one row per sample.

exports.up = (pgm) => {
  pgm.sql(`
    CREATE VIEW v_hrv_curve AS
    SELECT
      s.day,
      (s.raw->'hrv'->>'timestamp')::timestamptz
        + ((elem.ordinality - 1) * (s.raw->'hrv'->>'interval')::numeric) * interval '1 second'
        AS ts,
      (elem.value #>> '{}')::numeric AS rmssd_ms
    FROM oura_sleep s
    CROSS JOIN LATERAL jsonb_array_elements(s.raw->'hrv'->'items')
      WITH ORDINALITY AS elem(value, ordinality)
    WHERE s.raw->>'type' = 'long_sleep'
      AND s.raw->'hrv'->'items' IS NOT NULL
      AND elem.value <> 'null'::jsonb;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP VIEW IF EXISTS v_hrv_curve;`);
};
