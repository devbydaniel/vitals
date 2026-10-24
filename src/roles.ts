import pg from 'pg';

export const TRACKER_ROLE = 'tracker';

/** Tables the tracker role may write; everything else is read-only to it. */
export const TRACKER_WRITABLE_TABLES = [
  'day_auto',
  'day_manual',
  'day_met',
] as const;

/**
 * Create or update the login role the assistant uses to write the day log.
 * Idempotent, so the hourly sync can run it every time: a changed password
 * is applied on the next run, and tables added by later migrations become
 * readable. The OAuth token table stays off-limits.
 */
export async function ensureTrackerRole(
  client: pg.Pool | pg.PoolClient,
  password: string,
): Promise<void> {
  const role = pg.escapeIdentifier(TRACKER_ROLE);
  const exists = await client.query(
    'SELECT 1 FROM pg_roles WHERE rolname = $1',
    [TRACKER_ROLE],
  );
  const verb = exists.rows.length === 0 ? 'CREATE' : 'ALTER';
  // DDL cannot take bind parameters: the role is a constant identifier and
  // the password goes through escapeLiteral. One multi-statement query runs
  // as a single implicit transaction, so the grants never apply halfway.
  const statements = [
    `${verb} ROLE ${role} LOGIN PASSWORD ${pg.escapeLiteral(password)}`,
    `GRANT USAGE ON SCHEMA public TO ${role}`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`,
    `REVOKE ALL ON tokens FROM ${role}`,
    `GRANT INSERT, UPDATE, DELETE ON ${TRACKER_WRITABLE_TABLES.join(', ')} TO ${role}`,
  ];
  await client.query(statements.join(';\n'));
}
