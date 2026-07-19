/* eslint-disable */
// Training-focused interpretation views.
//
// v_hr_trends: nightly HRV / resting HR with 30d and 90d rolling means, so a
//   short dashboard window still shows position vs the mid/long-term baseline.
// v_hr_zones_daily: minutes per day in grouped HR zones, computed from the
//   ~5-second workout-source heartrate samples. Max HR 190 (highest observed
//   workout sample); Z1–2 < 70% (<133 bpm), Z3 70–80% (133–151), Z4–5 >= 80%
//   (>=152). Per-sample duration is the gap to the previous sample, capped at
//   30s so pauses between workouts contribute nothing.
// v_workouts: one row per logged workout with avg/max HR and zone minutes
//   joined from the samples inside its window (counted at 5s per sample).
//
// CREATE OR REPLACE / IF EXISTS: these views were applied to the live DB ahead
// of this release, so the migration must tolerate them already existing.

exports.up = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE VIEW v_hr_trends AS
    SELECT
      day,
      average_hrv,
      resting_hr,
      AVG(average_hrv) OVER w30 AS hrv_ma30,
      AVG(average_hrv) OVER w90 AS hrv_ma90,
      AVG(resting_hr)  OVER w30 AS rhr_ma30,
      AVG(resting_hr)  OVER w90 AS rhr_ma90
    FROM v_daily_scores
    WINDOW
      w30 AS (ORDER BY day ROWS BETWEEN 29 PRECEDING AND CURRENT ROW),
      w90 AS (ORDER BY day ROWS BETWEEN 89 PRECEDING AND CURRENT ROW);

    CREATE OR REPLACE VIEW v_hr_zones_daily AS
    WITH samples AS (
      SELECT
        ts,
        bpm,
        EXTRACT(EPOCH FROM (ts - lag(ts) OVER (ORDER BY ts))) AS gap_s
      FROM oura_heartrate
      WHERE source = 'workout'
    ),
    timed AS (
      SELECT
        (ts AT TIME ZONE 'Europe/Berlin')::date AS day,
        bpm,
        CASE WHEN gap_s IS NULL OR gap_s > 30 THEN 5 ELSE gap_s END AS dur_s
      FROM samples
    )
    SELECT
      day,
      ROUND(COALESCE(SUM(dur_s) FILTER (WHERE bpm < 133), 0) / 60.0, 1) AS z12_min,
      ROUND(COALESCE(SUM(dur_s) FILTER (WHERE bpm >= 133 AND bpm < 152), 0) / 60.0, 1) AS z3_min,
      ROUND(COALESCE(SUM(dur_s) FILTER (WHERE bpm >= 152), 0) / 60.0, 1) AS z45_min
    FROM timed
    GROUP BY day;

    CREATE OR REPLACE VIEW v_workouts AS
    SELECT
      w.day,
      (w.raw->>'start_datetime')::timestamptz AS started_at,
      (w.raw->>'end_datetime')::timestamptz   AS ended_at,
      w.raw->>'activity'  AS activity,
      w.raw->>'intensity' AS intensity,
      ROUND((w.raw->>'calories')::numeric) AS calories,
      ROUND((w.raw->>'distance')::numeric / 1000, 2) AS distance_km,
      ROUND(EXTRACT(EPOCH FROM (
        (w.raw->>'end_datetime')::timestamptz - (w.raw->>'start_datetime')::timestamptz
      )) / 60.0) AS duration_min,
      hr.avg_bpm,
      hr.max_bpm,
      hr.z12_min,
      hr.z3_min,
      hr.z45_min
    FROM oura_workout w
    LEFT JOIN LATERAL (
      SELECT
        ROUND(AVG(bpm)) AS avg_bpm,
        MAX(bpm) AS max_bpm,
        ROUND(COUNT(*) FILTER (WHERE bpm < 133) * 5 / 60.0, 1) AS z12_min,
        ROUND(COUNT(*) FILTER (WHERE bpm >= 133 AND bpm < 152) * 5 / 60.0, 1) AS z3_min,
        ROUND(COUNT(*) FILTER (WHERE bpm >= 152) * 5 / 60.0, 1) AS z45_min
      FROM oura_heartrate h
      WHERE h.source = 'workout'
        AND h.ts >= (w.raw->>'start_datetime')::timestamptz
        AND h.ts <  (w.raw->>'end_datetime')::timestamptz
    ) hr ON TRUE
    WHERE w.raw->>'activity' IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP VIEW IF EXISTS v_workouts;
    DROP VIEW IF EXISTS v_hr_zones_daily;
    DROP VIEW IF EXISTS v_hr_trends;
  `);
};
