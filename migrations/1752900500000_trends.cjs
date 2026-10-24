/* eslint-disable */
// Trend layer for the dashboard: one row per day with every metric, the
// value / 30d / 90d average series per metric, and nights compared by what
// happened the day before.
//
// Also fixes two bugs in the existing views:
// - Oura occasionally re-issues a daily document under a new id (seen
//   2026-10-03..05, and on many spo2 days). v_daily_scores joined every copy,
//   multiplying a day up to 64 times. Each daily table is now reduced to one
//   document per day: the newest fetch, and for activity the one with the
//   most steps (the stray copy carried a few hundred steps).
// - v_hr_trends averaged over the last 30/90 ROWS, so duplicate days shrank
//   the window and missing nights stretched it. Windows are calendar ranges now.
//
// v_daily: one row per day. Oura metrics plus the day log (v_days).
//   bedtime_h / last_coffee_h are local clock hours; bedtimes before noon get
//   +24 so the scale stays continuous across midnight (00:30 = 24.5).
// v_trends: long format (metric, day, value, ma30, ma90, base30). ma30/ma90
//   are calendar-window averages including the day, NULL while the window
//   holds fewer than 10 / 30 values. base30 is the average of the 30 days
//   BEFORE the day, the baseline a single day is compared against.
//   0/1 metrics (office, met, slept_home) average to a share.
// v_nights: one row per night (Oura sleep day D, the morning the night ends),
//   each night metric with its delta to base30, joined with the day before
//   (D-1: drinks, coffee, people, office, meetings, steps, training) and the
//   night itself (slept_home, travel).
// v_effects: v_nights grouped by factor and bucket over all data, the mean
//   deltas per bucket, ordered by sort / bucket_sort. Small buckets are kept;
//   the nights column shows n.

const DAILY_TABLES = [
  'oura_daily_sleep',
  'oura_daily_readiness',
  'oura_daily_stress',
  'oura_daily_resilience',
  'oura_daily_spo2',
  'oura_daily_cardiovascular_age',
  'oura_vo2_max',
];

const latest = (table) => `
      ${table} AS (
        SELECT DISTINCT ON (day) day, raw FROM public.${table}
        WHERE day IS NOT NULL
        ORDER BY day, fetched_at DESC, id
      )`;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE VIEW v_daily_scores AS
    WITH ${DAILY_TABLES.map(latest).join(',')},
    oura_daily_activity AS (
      SELECT DISTINCT ON (day) day, raw FROM public.oura_daily_activity
      WHERE day IS NOT NULL
      ORDER BY day, (raw->>'steps')::int DESC NULLS LAST, fetched_at DESC, id
    ),
    days AS (
      SELECT day FROM oura_daily_sleep
      UNION SELECT day FROM oura_daily_readiness
      UNION SELECT day FROM oura_daily_activity
      UNION SELECT day FROM oura_daily_stress
      UNION SELECT day FROM oura_daily_resilience
      UNION SELECT day FROM oura_daily_spo2
      UNION SELECT day FROM oura_daily_cardiovascular_age
      UNION SELECT day FROM oura_vo2_max
      UNION SELECT day FROM public.oura_sleep WHERE day IS NOT NULL
    ),
    sleep_by_day AS (
      SELECT
        day,
        AVG((raw->>'average_hrv')::numeric)        AS average_hrv,
        AVG((raw->>'lowest_heart_rate')::numeric)  AS lowest_heart_rate,
        AVG((raw->>'average_heart_rate')::numeric) AS average_heart_rate
      FROM public.oura_sleep
      WHERE raw->>'type' = 'long_sleep'
      GROUP BY day
    )
    SELECT
      d.day                                              AS day,
      (ds.raw->>'score')::int                            AS sleep_score,
      (dr.raw->>'score')::int                            AS readiness_score,
      (da.raw->>'score')::int                            AS activity_score,
      (st.raw->>'stress_high')::int                      AS stress_high_seconds,
      (st.raw->>'recovery_high')::int                    AS recovery_high_seconds,
      (st.raw->>'day_summary')                           AS stress_day_summary,
      (rs.raw->>'level')                                 AS resilience_level,
      sbd.average_hrv                                    AS average_hrv,
      sbd.lowest_heart_rate                              AS resting_hr,
      sbd.average_heart_rate                             AS average_hr,
      (sp.raw->'spo2_percentage'->>'average')::numeric   AS spo2_average,
      (cv.raw->>'vascular_age')::int                     AS cardiovascular_age,
      (vo.raw->>'vo2_max')::numeric                      AS vo2_max
    FROM days d
    LEFT JOIN oura_daily_sleep              ds ON ds.day = d.day
    LEFT JOIN oura_daily_readiness          dr ON dr.day = d.day
    LEFT JOIN oura_daily_activity           da ON da.day = d.day
    LEFT JOIN oura_daily_stress             st ON st.day = d.day
    LEFT JOIN oura_daily_resilience         rs ON rs.day = d.day
    LEFT JOIN oura_daily_spo2               sp ON sp.day = d.day
    LEFT JOIN oura_daily_cardiovascular_age cv ON cv.day = d.day
    LEFT JOIN oura_vo2_max                  vo ON vo.day = d.day
    LEFT JOIN sleep_by_day                  sbd ON sbd.day = d.day;

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
      w30 AS (ORDER BY day RANGE BETWEEN INTERVAL '29 days' PRECEDING AND CURRENT ROW),
      w90 AS (ORDER BY day RANGE BETWEEN INTERVAL '89 days' PRECEDING AND CURRENT ROW);

    CREATE VIEW v_daily AS
    WITH activity AS (
      SELECT DISTINCT ON (day)
        day,
        (raw->>'steps')::int           AS steps,
        (raw->>'active_calories')::int AS active_kcal
      FROM oura_daily_activity
      WHERE day IS NOT NULL
      ORDER BY day, (raw->>'steps')::int DESC NULLS LAST, fetched_at DESC, id
    ),
    training AS (
      SELECT day, SUM(duration_min) AS training_min
      FROM v_workouts
      WHERE activity <> 'walking'
      GROUP BY day
    ),
    days AS (
      SELECT day FROM v_daily_scores
      UNION SELECT day FROM v_days
    )
    SELECT
      d.day,
      s.average_hrv                                   AS hrv,
      s.resting_hr,
      ROUND(s.stress_high_seconds / 3600.0, 2)        AS stress_h,
      sl.total_sleep_hours                            AS sleep_h,
      sl.deep_sleep_hours                             AS deep_h,
      sl.rem_sleep_hours                              AS rem_h,
      sl.efficiency,
      (
        EXTRACT(EPOCH FROM (sl.bedtime_start AT TIME ZONE 'Europe/Berlin')::time) / 3600.0
        + CASE WHEN (sl.bedtime_start AT TIME ZONE 'Europe/Berlin')::time < '12:00' THEN 24 ELSE 0 END
      )                                               AS bedtime_h,
      a.steps,
      a.active_kcal,
      COALESCE(t.training_min, 0)                     AS training_min,
      v.workday,
      v.travel,
      v.slept_home,
      v.office,
      v.meeting_h,
      v.away_from_home_h,
      v.away_from_sleep_place_h,
      v.had_coffee,
      EXTRACT(EPOCH FROM v.last_coffee) / 3600.0      AS last_coffee_h,
      v.alcohol_drinks,
      v.met_count
    FROM days d
    LEFT JOIN v_daily_scores s ON s.day = d.day
    LEFT JOIN v_sleep        sl ON sl.day = d.day
    LEFT JOIN activity       a ON a.day = d.day
    LEFT JOIN training       t ON t.day = d.day
    LEFT JOIN v_days         v ON v.day = d.day;

    CREATE VIEW v_trends AS
    WITH series AS (
      SELECT d.day, m.metric, m.value::numeric AS value
      FROM v_daily d
      CROSS JOIN LATERAL (VALUES
        ('hrv',              d.hrv),
        ('resting_hr',       d.resting_hr),
        ('stress_h',         d.stress_h),
        ('sleep_h',          d.sleep_h),
        ('deep_h',           d.deep_h),
        ('efficiency',       d.efficiency),
        ('bedtime_h',        d.bedtime_h),
        ('steps',            d.steps::numeric),
        ('meeting_h',        CASE WHEN d.workday THEN d.meeting_h END),
        ('away_from_home_h', d.away_from_home_h),
        ('last_coffee_h',    d.last_coffee_h),
        ('alcohol_drinks',   d.alcohol_drinks::numeric),
        ('met',              CASE WHEN d.met_count IS NOT NULL THEN (d.met_count > 0)::int END),
        ('office',           CASE WHEN d.workday AND d.travel IS NOT TRUE THEN d.office::int END),
        ('slept_home',       d.slept_home::int)
      ) AS m(metric, value)
      WHERE m.value IS NOT NULL
    )
    SELECT
      metric,
      day,
      value,
      CASE WHEN COUNT(value) OVER w30 >= 10 THEN AVG(value) OVER w30 END AS ma30,
      CASE WHEN COUNT(value) OVER w90 >= 30 THEN AVG(value) OVER w90 END AS ma90,
      CASE WHEN COUNT(value) OVER b30 >= 10 THEN AVG(value) OVER b30 END AS base30
    FROM series
    WINDOW
      w30 AS (PARTITION BY metric ORDER BY day RANGE BETWEEN INTERVAL '29 days' PRECEDING AND CURRENT ROW),
      w90 AS (PARTITION BY metric ORDER BY day RANGE BETWEEN INTERVAL '89 days' PRECEDING AND CURRENT ROW),
      b30 AS (PARTITION BY metric ORDER BY day RANGE BETWEEN INTERVAL '30 days' PRECEDING AND INTERVAL '1 day' PRECEDING);

    CREATE VIEW v_nights AS
    WITH deltas AS (
      SELECT
        day,
        MAX(value - base30) FILTER (WHERE metric = 'hrv')        AS hrv_delta,
        MAX(value - base30) FILTER (WHERE metric = 'resting_hr') AS resting_hr_delta,
        MAX(value - base30) FILTER (WHERE metric = 'sleep_h')    AS sleep_h_delta,
        MAX(value - base30) FILTER (WHERE metric = 'deep_h')     AS deep_h_delta
      FROM v_trends
      WHERE metric IN ('hrv', 'resting_hr', 'sleep_h', 'deep_h')
      GROUP BY day
    )
    SELECT
      n.day,
      n.hrv,
      n.resting_hr,
      n.sleep_h,
      n.deep_h,
      n.bedtime_h,
      x.hrv_delta,
      x.resting_hr_delta,
      x.sleep_h_delta,
      x.deep_h_delta,
      n.slept_home,
      COALESCE(n.travel, p.travel) AS travel,
      p.workday                    AS prev_workday,
      p.office                     AS prev_office,
      p.meeting_h                  AS prev_meeting_h,
      p.away_from_home_h           AS prev_away_from_home_h,
      p.had_coffee                 AS prev_had_coffee,
      p.last_coffee_h              AS prev_last_coffee_h,
      p.alcohol_drinks             AS prev_alcohol_drinks,
      p.met_count                  AS prev_met_count,
      p.steps                      AS prev_steps,
      p.training_min               AS prev_training_min
    FROM v_daily n
    LEFT JOIN v_daily p ON p.day = n.day - 1
    LEFT JOIN deltas  x ON x.day = n.day
    WHERE n.sleep_h IS NOT NULL;

    CREATE VIEW v_effects AS
    WITH buckets AS (
      SELECT n.*, f.sort, f.factor, f.bucket
      FROM v_nights n
      CROSS JOIN LATERAL (VALUES
        (10, 'Drinks the evening before',
             CASE WHEN n.prev_alcohol_drinks = 0 THEN '0'
                  WHEN n.prev_alcohol_drinks <= 2 THEN '1-2'
                  WHEN n.prev_alcohol_drinks > 2 THEN '3+' END),
        (20, 'Last coffee',
             CASE WHEN n.prev_had_coffee IS FALSE THEN 'none'
                  WHEN n.prev_last_coffee_h < 12 THEN 'before 12:00'
                  WHEN n.prev_last_coffee_h < 15 THEN '12:00-15:00'
                  WHEN n.prev_last_coffee_h >= 15 THEN 'after 15:00' END),
        (30, 'Met people',
             CASE WHEN n.prev_met_count > 0 THEN 'yes'
                  WHEN n.prev_met_count = 0 THEN 'no' END),
        (40, 'Workday at',
             CASE WHEN n.prev_workday AND n.travel IS NOT TRUE AND n.prev_office THEN 'office'
                  WHEN n.prev_workday AND n.travel IS NOT TRUE AND n.prev_office IS FALSE THEN 'home office' END),
        (50, 'Meetings',
             CASE WHEN n.prev_workday IS NOT TRUE OR n.prev_meeting_h IS NULL THEN NULL
                  WHEN n.prev_meeting_h < 2 THEN 'under 2 h'
                  WHEN n.prev_meeting_h < 4 THEN '2-4 h'
                  ELSE '4 h+' END),
        (60, 'Away from home',
             CASE WHEN n.prev_away_from_home_h < 2 THEN 'under 2 h'
                  WHEN n.prev_away_from_home_h < 6 THEN '2-6 h'
                  WHEN n.prev_away_from_home_h >= 6 THEN '6 h+' END),
        (70, 'Slept in',
             CASE WHEN n.slept_home THEN 'own bed'
                  WHEN n.slept_home IS FALSE THEN 'elsewhere' END),
        (80, 'Bedtime',
             CASE WHEN n.bedtime_h < 23 THEN 'before 23:00'
                  WHEN n.bedtime_h < 24 THEN '23:00-24:00'
                  WHEN n.bedtime_h >= 24 THEN 'after 24:00' END),
        (90, 'Steps the day before',
             CASE WHEN n.prev_steps < 5000 THEN 'under 5k'
                  WHEN n.prev_steps < 10000 THEN '5-10k'
                  WHEN n.prev_steps >= 10000 THEN '10k+' END),
        (100, 'Training the day before',
             CASE WHEN n.prev_training_min >= 20 THEN 'yes'
                  WHEN n.prev_training_min IS NOT NULL AND n.prev_steps IS NOT NULL THEN 'no' END)
      ) AS f(sort, factor, bucket)
      WHERE f.bucket IS NOT NULL
    )
    SELECT
      MIN(sort)                                AS sort,
      factor,
      bucket,
      array_position(ARRAY[
        '0', '1-2', '3+',
        'none', 'before 12:00', '12:00-15:00', 'after 15:00',
        'no', 'yes', 'home office', 'office',
        'under 2 h', '2-4 h', '2-6 h', '4 h+', '6 h+',
        'own bed', 'elsewhere',
        'before 23:00', '23:00-24:00', 'after 24:00',
        'under 5k', '5-10k', '10k+'
      ], bucket)                               AS bucket_sort,
      COUNT(*)::int                            AS nights,
      ROUND(AVG(hrv_delta), 1)                 AS hrv_delta,
      ROUND(AVG(resting_hr_delta), 1)          AS resting_hr_delta,
      ROUND(AVG(sleep_h_delta) * 60)           AS sleep_min_delta,
      ROUND(AVG(deep_h_delta) * 60)            AS deep_min_delta
    FROM buckets
    GROUP BY factor, bucket;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP VIEW IF EXISTS v_effects;
    DROP VIEW IF EXISTS v_nights;
    DROP VIEW IF EXISTS v_trends;
    DROP VIEW IF EXISTS v_daily;

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
  `);
  // v_daily_scores keeps the de-duplicated definition: the old one was a bug.
};
