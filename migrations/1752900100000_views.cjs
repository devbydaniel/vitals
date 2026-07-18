/* eslint-disable */
// Interpretation-layer views over the raw Oura jsonb document tables.
//
// Field names are taken verbatim from the Oura v2 OpenAPI component schemas
// (~/Downloads/oura-openapi.json): PublicDailySleep / PublicDailyReadiness /
// PublicDailyActivity carry `score`; PublicDailyStress carries `stress_high`,
// `recovery_high` (seconds) and `day_summary` (restored|normal|stressful);
// DailyResilienceModel carries `level` (limited..exceptional); PublicDailySpO2
// carries `spo2_percentage.average`; PublicDailyCardiovascularAge carries
// `vascular_age`; PublicVO2Max carries `vo2_max`; PublicModifiedSleepModel
// (endpoint /usercollection/sleep, table oura_sleep) carries `type`
// (deleted|sleep|long_sleep|late_nap|rest), `average_hrv`, `lowest_heart_rate`,
// `average_heart_rate`, `total_sleep_duration`, `time_in_bed`,
// `deep_sleep_duration`, `light_sleep_duration`, `rem_sleep_duration`,
// `awake_time` (all seconds), `efficiency`, `bedtime_start`, `bedtime_end`.
//
// oura_sleep holds multiple periods per day (naps); everything sleep-derived is
// filtered to type = 'long_sleep', the main nightly sleep.

exports.up = (pgm) => {
  pgm.sql(`
    -- ================================================================
    -- v_daily_scores: one row per calendar day, LEFT JOINed across every
    -- per-endpoint table on day so a missing endpoint never drops the day.
    -- resting_hr uses Oura's lowest_heart_rate during long sleep, the
    -- standard resting-HR proxy (the API exposes no separate RHR document).
    -- ================================================================
    CREATE VIEW v_daily_scores AS
    WITH days AS (
      SELECT day FROM oura_daily_sleep WHERE day IS NOT NULL
      UNION SELECT day FROM oura_daily_readiness WHERE day IS NOT NULL
      UNION SELECT day FROM oura_daily_activity WHERE day IS NOT NULL
      UNION SELECT day FROM oura_daily_stress WHERE day IS NOT NULL
      UNION SELECT day FROM oura_daily_resilience WHERE day IS NOT NULL
      UNION SELECT day FROM oura_daily_spo2 WHERE day IS NOT NULL
      UNION SELECT day FROM oura_daily_cardiovascular_age WHERE day IS NOT NULL
      UNION SELECT day FROM oura_vo2_max WHERE day IS NOT NULL
      UNION SELECT day FROM oura_sleep WHERE day IS NOT NULL
    ),
    sleep_by_day AS (
      SELECT
        day,
        AVG((raw->>'average_hrv')::numeric)        AS average_hrv,
        AVG((raw->>'lowest_heart_rate')::numeric)  AS lowest_heart_rate,
        AVG((raw->>'average_heart_rate')::numeric) AS average_heart_rate
      FROM oura_sleep
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

    -- ================================================================
    -- v_baselines_30d: 30-day trailing rolling mean + sample stddev for the
    -- key metrics. The window is the 30 rows BEFORE the current day
    -- (ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING) so the current day is
    -- compared against its own recent history, not itself.
    -- ================================================================
    CREATE VIEW v_baselines_30d AS
    SELECT
      day,
      sleep_score,
      AVG(sleep_score)         OVER w AS sleep_score_mean_30d,
      STDDEV_SAMP(sleep_score) OVER w AS sleep_score_std_30d,
      readiness_score,
      AVG(readiness_score)         OVER w AS readiness_score_mean_30d,
      STDDEV_SAMP(readiness_score) OVER w AS readiness_score_std_30d,
      activity_score,
      AVG(activity_score)         OVER w AS activity_score_mean_30d,
      STDDEV_SAMP(activity_score) OVER w AS activity_score_std_30d,
      average_hrv,
      AVG(average_hrv)         OVER w AS hrv_mean_30d,
      STDDEV_SAMP(average_hrv) OVER w AS hrv_std_30d,
      resting_hr,
      AVG(resting_hr)         OVER w AS resting_hr_mean_30d,
      STDDEV_SAMP(resting_hr) OVER w AS resting_hr_std_30d
    FROM v_daily_scores
    WINDOW w AS (ORDER BY day ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING);

    -- ================================================================
    -- v_sleep: one row per day for the main (long_sleep) sleep. Durations are
    -- stored in seconds by Oura and converted to hours here. If a day somehow
    -- has more than one long_sleep record, the longest one wins (DISTINCT ON).
    -- ================================================================
    CREATE VIEW v_sleep AS
    SELECT DISTINCT ON (day)
      day,
      (raw->>'total_sleep_duration')::numeric / 3600.0 AS total_sleep_hours,
      (raw->>'time_in_bed')::numeric          / 3600.0 AS time_in_bed_hours,
      (raw->>'deep_sleep_duration')::numeric  / 3600.0 AS deep_sleep_hours,
      (raw->>'light_sleep_duration')::numeric / 3600.0 AS light_sleep_hours,
      (raw->>'rem_sleep_duration')::numeric   / 3600.0 AS rem_sleep_hours,
      (raw->>'awake_time')::numeric           / 3600.0 AS awake_hours,
      (raw->>'efficiency')::numeric                    AS efficiency,
      (raw->>'bedtime_start')::timestamptz             AS bedtime_start,
      (raw->>'bedtime_end')::timestamptz               AS bedtime_end
    FROM oura_sleep
    WHERE raw->>'type' = 'long_sleep'
    ORDER BY day, (raw->>'total_sleep_duration')::numeric DESC NULLS LAST;

    -- ================================================================
    -- v_sleep_debt_14d: cumulative sleep deficit vs an 8h/night target over
    -- the trailing 14 days (13 preceding rows + the current day). Choice:
    -- surplus nights offset deficit nights inside the window, but the running
    -- total is floored at 0 with GREATEST so a well-rested stretch reads as
    -- "no debt" rather than a negative (nonsensical) debt.
    -- ================================================================
    CREATE VIEW v_sleep_debt_14d AS
    SELECT
      day,
      total_sleep_hours,
      GREATEST(
        SUM(8.0 - total_sleep_hours)
          OVER (ORDER BY day ROWS BETWEEN 13 PRECEDING AND CURRENT ROW),
        0
      ) AS sleep_debt_hours
    FROM v_sleep;

    -- ================================================================
    -- v_sleep_consistency: per ISO week (Monday-anchored via date_trunc),
    -- the sample stddev of bedtime-of-day in minutes. Bedtimes straddle
    -- midnight (e.g. 23:40 vs 00:20), so we shift each bedtime back 12h before
    -- taking time-of-day: that maps a cluster around midnight to a cluster
    -- around noon, avoiding the 0/1440-minute wraparound blowing up the stddev.
    -- ================================================================
    CREATE VIEW v_sleep_consistency AS
    SELECT
      date_trunc('week', day)::date AS day,
      STDDEV_SAMP(
        EXTRACT(EPOCH FROM ((bedtime_start - INTERVAL '12 hours')::time)) / 60.0
      ) AS bedtime_stddev_minutes
    FROM v_sleep
    WHERE bedtime_start IS NOT NULL
    GROUP BY date_trunc('week', day);

    -- ================================================================
    -- v_weekly_deltas: per ISO week (Monday-anchored) averages of the key
    -- metrics plus the week-over-week delta (LAG over ordered weeks).
    -- ================================================================
    CREATE VIEW v_weekly_deltas AS
    WITH weekly AS (
      SELECT
        date_trunc('week', day)::date AS week,
        AVG(sleep_score)     AS sleep_score,
        AVG(readiness_score) AS readiness_score,
        AVG(activity_score)  AS activity_score,
        AVG(average_hrv)     AS hrv,
        AVG(resting_hr)      AS resting_hr
      FROM v_daily_scores
      GROUP BY date_trunc('week', day)
    )
    SELECT
      week AS day,
      sleep_score,
      sleep_score - LAG(sleep_score) OVER (ORDER BY week)         AS sleep_score_delta,
      readiness_score,
      readiness_score - LAG(readiness_score) OVER (ORDER BY week) AS readiness_score_delta,
      activity_score,
      activity_score - LAG(activity_score) OVER (ORDER BY week)   AS activity_score_delta,
      hrv,
      hrv - LAG(hrv) OVER (ORDER BY week)                         AS hrv_delta,
      resting_hr,
      resting_hr - LAG(resting_hr) OVER (ORDER BY week)           AS resting_hr_delta
    FROM weekly;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP VIEW IF EXISTS v_weekly_deltas;
    DROP VIEW IF EXISTS v_sleep_consistency;
    DROP VIEW IF EXISTS v_sleep_debt_14d;
    DROP VIEW IF EXISTS v_sleep;
    DROP VIEW IF EXISTS v_baselines_30d;
    DROP VIEW IF EXISTS v_daily_scores;
  `);
};
