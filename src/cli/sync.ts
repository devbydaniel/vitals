// Cron entrypoint: refresh the OAuth token pair (rotation-safe), sync all
// Oura data, then report success to the uptime-kuma heartbeat.
import { createPool } from '../db.js';
import { optionalEnv, requireEnv } from '../env.js';
import { OURA_TOKEN_URL } from '../providers/oura/client.js';
import { pingHeartbeat, syncAll } from '../sync.js';
import { getFreshAccessToken } from '../tokens.js';

async function main(): Promise<void> {
  const pool = createPool();
  try {
    const accessToken = await getFreshAccessToken(pool, 'oura', {
      tokenUrl: OURA_TOKEN_URL,
      clientId: requireEnv('OURA_CLIENT_ID'),
      clientSecret: requireEnv('OURA_CLIENT_SECRET'),
    });
    const total = await syncAll(pool, {
      accessToken,
      log: (message) => {
        console.log(message);
      },
    });
    console.log(`Sync complete: ${String(total)} items.`);
    await pingHeartbeat(optionalEnv('HEARTBEAT_URL'));
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
