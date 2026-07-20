import { assertConfig, config } from "./config.js";
import { closeDb, migrate } from "./db/index.js";
import { initCafeMenu } from "./domain/cafeMenuRepo.js";
import { drainQueues } from "./lib/serialize.js";
import { listenOnAvailablePort } from "./lib/listen.js";
import { buildServer } from "./server.js";

/**
 * Local UI against production data. Deliberately excludes every recurring
 * production worker so a developer instance cannot double-run expirations,
 * reconciliations, reminders, digests or staff/delivery notifications.
 */
async function main(): Promise<void> {
  assertConfig();
  if (process.env.LOCAL_PROD_DATABASE !== "1") {
    throw new Error("Ce point d’entrée doit être lancé avec `npm run dev:prod-db`.");
  }

  await migrate();
  await initCafeMenu();

  const app = buildServer();
  const activePort = await listenOnAvailablePort(config.PORT, {
    autoFallback: true,
    listen: (port) => app.listen({ port, host: "0.0.0.0" }),
    onPortBusy: (port, nextPort) => {
      app.log.warn({ port, nextPort }, `Port ${port} occupé, essai sur ${nextPort}…`);
    },
  });

  app.log.warn(
    { port: activePort },
    "LOCAL → BASE DE PRODUCTION. Tâches automatiques désactivées; les actions admin restent réelles.",
  );
  app.log.info(`Admin local disponible sur http://localhost:${activePort}/admin`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "Shutting down local production-data server");
    await app.close();
    await drainQueues(25_000);
    await closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
