import { assertConfig, config } from "./config.js";
import { migrate, closeDb } from "./db/index.js";
import { expireStaleBookings, expireStalePlanOrders, expireStaleCafeOrders } from "./domain/repo.js";
import { nudgeExpiredLinks } from "./domain/expiryNudge.js";
import { syncCancellations } from "./domain/cancellationSync.js";
import { sweepWaitlist } from "./domain/waitlistSweep.js";
import { reconcileStuckBookings } from "./webhooks/wave.js";
import { buildServer } from "./server.js";

async function main() {
  assertConfig();
  await migrate();

  const app = buildServer();

  // Periodic TTL sweep: AWAITING_PAYMENT past link_expires_at → EXPIRED.
  const sweeper = setInterval(async () => {
    try {
      const n =
        (await expireStaleBookings()) +
        (await expireStalePlanOrders()) +
        (await expireStaleCafeOrders());
      if (n > 0) app.log.info({ expired: n }, "Expired stale payment links");
      // One-shot "want a fresh link?" follow-up for links that just expired.
      await nudgeExpiredLinks(app.log);
      // Recover any booking that was paid but never turned into a Wix booking
      // (a crash between the PAID transition and fulfillment).
      const reconciled = await reconcileStuckBookings(app.log);
      if (reconciled > 0) app.log.info({ reconciled }, "Reconciled stuck PAID bookings");
    } catch (err) {
      app.log.error({ err }, "Expiry/reconciliation sweep failed");
    }
  }, 60 * 1000);
  sweeper.unref();

  // Cancellation sweep: bookings cancelled in the Wix dashboard → CANCELLED
  // locally + proactive WhatsApp notification (Phase 1 stand-in for webhooks).
  const cancellationSweeper = setInterval(async () => {
    try {
      const n = await syncCancellations(app.log);
      if (n > 0) app.log.info({ cancelled: n }, "Synced Wix cancellations");
    } catch (err) {
      app.log.error({ err }, "Cancellation sweep failed");
    }
    try {
      // Freed spots → one-shot nudges to the clients waiting on them.
      const nudged = await sweepWaitlist(app.log);
      if (nudged > 0) app.log.info({ nudged }, "Waitlist nudges sent");
    } catch (err) {
      app.log.error({ err }, "Waitlist sweep failed");
    }
  }, 5 * 60 * 1000);
  cancellationSweeper.unref();

  await app.listen({ port: config.PORT, host: "0.0.0.0" });
  app.log.info(`Revive booking agent listening on :${config.PORT}`);

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "Shutting down");
    clearInterval(sweeper);
    clearInterval(cancellationSweeper);
    await app.close();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
