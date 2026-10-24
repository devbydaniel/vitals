/* eslint-disable */
// Day log: daily context to correlate against the Oura data, one row per
// calendar day (Europe/Berlin).
//
// day_auto: values computed by the assistant from location (OwnTracks), the
//   Oura sleep window and the work calendar. Overwritten on every recompute.
// day_manual: Daniel's answers to the morning question, plus corrections of
//   automatic values. NULL means "not answered" / "no correction".
// day_met: who Daniel met that day, one row per person (org tag or name).
//   Only meaningful when day_manual.met_recorded is true; no rows then means
//   he met nobody.
// v_days: the two joined, corrections winning over computed values.
//
// Day alignment follows Oura: slept_home on day D is the night that ended on
// the morning of D, the same night as v_sleep's row for D.
// NULL means not applicable or not known, never a made-up value: e.g.
// away_from_home_h is NULL on travel days, meeting_h on out-of-office days.

exports.up = (pgm) => {
  pgm.createTable('day_auto', {
    day: { type: 'date', primaryKey: true },
    workday: { type: 'boolean', comment: 'Weekday without an own out-of-office event' },
    travel: { type: 'boolean', comment: 'Night before or after was spent away from home (>30 km)' },
    slept_home: { type: 'boolean', comment: 'Night ending on the morning of this day was spent at home' },
    office: { type: 'boolean', comment: 'At least 2 h in the office region' },
    office_h: { type: 'numeric(4,2)' },
    meeting_h: { type: 'numeric(4,2)', comment: 'Merged hours of work-calendar meetings with other attendees' },
    away_from_home_h: { type: 'numeric(4,2)', comment: 'Hours outside the home region; NULL on travel days' },
    away_from_sleep_place_h: {
      type: 'numeric(4,2)',
      comment: 'Hours away from where the previous night was spent',
    },
    computed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTable('day_manual', {
    day: { type: 'date', primaryKey: true },
    had_coffee: { type: 'boolean' },
    last_coffee: { type: 'time', comment: 'Local time of the last coffee; NULL when had_coffee is false' },
    alcohol_drinks: { type: 'smallint' },
    met_recorded: { type: 'boolean', notNull: true, default: false },
    workday: { type: 'boolean', comment: 'Correction of day_auto.workday' },
    travel: { type: 'boolean', comment: 'Correction of day_auto.travel' },
    slept_home: { type: 'boolean', comment: 'Correction of day_auto.slept_home' },
    office: { type: 'boolean', comment: 'Correction of day_auto.office' },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTable('day_met', {
    day: { type: 'date', notNull: true },
    person: { type: 'text', notNull: true },
  });
  pgm.addConstraint('day_met', 'day_met_pkey', { primaryKey: ['day', 'person'] });

  pgm.sql(`
    CREATE VIEW v_days AS
    WITH met AS (
      SELECT day, array_agg(person ORDER BY person) AS people
      FROM day_met
      GROUP BY day
    ),
    merged AS (
      SELECT
        COALESCE(a.day, m.day)                  AS day,
        COALESCE(m.workday, a.workday)          AS workday,
        COALESCE(m.travel, a.travel)            AS travel,
        COALESCE(m.slept_home, a.slept_home)    AS slept_home,
        COALESCE(m.office, a.office)            AS office,
        a.office_h,
        a.meeting_h,
        a.away_from_home_h,
        a.away_from_sleep_place_h,
        m.had_coffee,
        m.last_coffee,
        m.alcohol_drinks,
        m.met_recorded
      FROM day_auto a
      FULL OUTER JOIN day_manual m ON m.day = a.day
    )
    SELECT
      d.day,
      d.workday,
      d.travel,
      d.slept_home,
      d.office,
      d.office_h,
      d.meeting_h,
      CASE WHEN d.travel THEN NULL ELSE d.away_from_home_h END AS away_from_home_h,
      d.away_from_sleep_place_h,
      d.had_coffee,
      d.last_coffee,
      d.alcohol_drinks,
      CASE WHEN d.met_recorded THEN COALESCE(cardinality(met.people), 0) END AS met_count,
      CASE WHEN d.met_recorded THEN COALESCE(met.people, '{}') END           AS met
    FROM merged d
    LEFT JOIN met ON met.day = d.day
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP VIEW IF EXISTS v_days');
  pgm.dropTable('day_met');
  pgm.dropTable('day_manual');
  pgm.dropTable('day_auto');
};
