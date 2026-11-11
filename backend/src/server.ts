import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDbClient } from './db/client.js';
import { runMigrations } from './db/schema.js';

async function main() {
  const config = loadConfig();
  const db = await createDbClient(config.databaseUrl);
  await runMigrations(db);

  const app = createApp({ db, config });
  const server = app.listen(config.port, () => {
    console.log(
      `[backend] Listening on port ${config.port} (inactivityTimeout=${config.inactivityTimeoutMinutes}m, initialBalanceCents=${config.initialWalletBalanceCents})`
    );
  });

  const shutdown = async () => {
    console.log('[backend] Shutting down gracefully...');
    server.close(async () => {
      await db.close();
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[backend] Fatal startup error:', err);
  process.exit(1);
});

