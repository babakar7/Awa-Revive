import { assertConfig, config } from "./config.js";
import { migrate, closeDb } from "./db/index.js";
import { expireStaleBookings, expireStalePlanOrders, expireStaleCafeOrders } from "./domain/repo.js";
import { nudgeExpiredLinks } from "./domain/expiryNudge.js";
import { escalateStaleLinkRequests } from "./domain/linkRequests.js";
import { runReviewSweep, maybeSendDailyDigest } from "./domain/conversationReview.js";
import { syncCancellations } from "./domain/cancellationSync.js";
import { sweepWaitlist } from "./domain/waitlistSweep.js";
import { sweepRenewalNudges } from "./domain/renewalNudge.js";
import { sweepStaffNotifications } from "./domain/notificationSweep.js";
import { sweepDeliveries } from "./domain/deliveryNotify.js";
import { reconcileStuckBookings } from "./webhooks/wave.js";
import {
  reconcileStuckPlanOrders,
  reconcileStuckCafeOrders,
  reconcileUnnotifiedRefunds,
  reconcileMissingWixOrders,
} from "./domain/fulfillment.js";
import { startOmTokenKeepAlive } from "./lib/orangeMoney.js";
import { initCafeMenu } from "./domain/cafeMenuRepo.js";
import { notifyReception } from "./lib/notify.js";
import { drainQueues } from "./lib/serialize.js";
import { listenOnAvailablePort } from "./lib/listen.js";
import { buildServer } from "./server.js";
import { closeInactiveBookingJourneys } from "./domain/bookingFunnel.js";

async function main() {
  assertConfig();

  // Last-resort safety nets (mono-instance: an unhandled error = full downtime).
  // uncaughtException leaves the process in an undefined state → notify + let
  // Railway restart us. unhandledRejection is usually a benign background send
  // (a dropped `void sendText(...).catch`) → log loudly, do NOT take the bot down.
  process.on("uncaughtException", (err) => {
    console.error("FATAL uncaughtException:", err);
    try {
      notifyReception(
        "⚠️ Crash technique (uncaughtException)",
        `Awa a rencontré une erreur fatale et redémarre.\n${String(err?.stack ?? err).slice(0, 600)}`,
      );
    } catch {
      /* notify must never itself throw here */
    }
    // Let the notification flush before Railway restarts us.
    setTimeout(() => process.exit(1), 2000).unref();
  });
  process.on("unhandledRejection", (reason) => {
    console.error("unhandledRejection (logged, not fatal):", reason);
  });

  await migrate();

  // Load the bar menu snapshot from DB (seeds from cafe-menu.md on first boot).
  // Before buildServer()/listen so no webhook ever sees an empty menu.
  await initCafeMenu();

  // Warm OM OAuth so the first client payment is not blocked by Sonatel token latency.
  startOmTokenKeepAlive();

  const app = buildServer();

  // Periodic TTL sweep: AWAITING_PAYMENT past link_expires_at → EXPIRED.
  const sweeper = setInterval(async () => {
    try {
      const n =
        (await expireStaleBookings()) +
        (await expireStalePlanOrders()) +
        (await expireStaleCafeOrders());
      if (n > 0) app.log.info({ expired: n }, "Expired stale payment links");
      await closeInactiveBookingJourneys();
      // One-shot "want a fresh link?" follow-up for links that just expired.
      await nudgeExpiredLinks(app.log);
      // Recover paid-but-unfulfilled work (crash between PAID and Wix / notify).
      const reconciled =
        (await reconcileStuckBookings(app.log)) +
        (await reconcileStuckPlanOrders(app.log)) +
        (await reconcileStuckCafeOrders(app.log));
      if (reconciled > 0) app.log.info({ reconciled }, "Reconciled stuck PAID rows");
      const wixOrders = await reconcileMissingWixOrders(app.log);
      if (wixOrders > 0) {
        app.log.info({ wixOrders }, "Reconciled missing Wix order/payment records");
      }
      const refunds = await reconcileUnnotifiedRefunds(app.log);
      if (refunds > 0) app.log.info({ refunds }, "Re-notified REFUND_NEEDED rows");
      // OM lost-callback poller via transaction search: ABANDONNED (13/07 probe) —
      // list API never returns metadata.order, so we cannot join to pending rows.
      // Filet = webhook + verify-by-lookup only; ops recoup manually if needed.
      // Account-link request the client never completed (no email given, code
      // never typed) → hand it to reception so no plan-holder is lost silently.
      const escalated = await escalateStaleLinkRequests();
      if (escalated > 0) app.log.info({ escalated }, "Stale link requests handed to reception");
    } catch (err) {
      app.log.error({ err }, "Expiry/reconciliation sweep failed");
    }
    // Staff notifications (guardian/coach reminders, fixed schedules). Own
    // try/catch: a Wix/notification hiccup must never block expiry work above.
    // Needs ≤1-min granularity (15-min-before precision) → the 60s loop.
    try {
      const notified = await sweepStaffNotifications(app.log);
      if (notified > 0) app.log.info({ notified }, "Staff notifications sent");
    } catch (err) {
      app.log.error({ err }, "Staff-notification sweep failed");
    }
    // Delivery orders: retry pending kitchen/client notifications (crash-safe)
    // and fire one-shot SLA "late" alerts to reception. Own try/catch. Needs
    // ≤1-min granularity for the 20-min SLA → the 60s loop.
    try {
      const alerted = await sweepDeliveries(app.log);
      if (alerted > 0) app.log.info({ alerted }, "Delivery SLA alerts sent");
    } catch (err) {
      app.log.error({ err }, "Delivery sweep failed");
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
    try {
      // Boucle de résultat : classifier les conversations retombées au
      // silence (>45 min) — impasses/échecs → file « À reprendre » + notif
      // des cas graves. Puis le digest quotidien (une fois/jour après 19h).
      const reviewed = await runReviewSweep();
      if (reviewed > 0) app.log.info({ reviewed }, "Conversations classified");
      if (await maybeSendDailyDigest()) app.log.info("Daily digest sent to reception");
    } catch (err) {
      app.log.error({ err }, "Conversation-review sweep failed");
    }
    try {
      // Relance de renouvellement J-N (no-op tant que WA_RENEWAL_TEMPLATE
      // n'est pas configuré — envoi hors fenêtre 24h = template obligatoire).
      const nudged = await sweepRenewalNudges(app.log);
      if (nudged > 0) app.log.info({ nudged }, "Renewal nudges sent");
    } catch (err) {
      app.log.error({ err }, "Renewal-nudge sweep failed");
    }
  }, 5 * 60 * 1000);
  cancellationSweeper.unref();

  const activePort = await listenOnAvailablePort(config.PORT, {
    // Set by `npm run dev` only. `npm start` remains strict in production.
    autoFallback: process.env.DEV_AUTO_PORT === "1",
    listen: (port) => app.listen({ port, host: "0.0.0.0" }),
    onPortBusy: (port, nextPort) => {
      app.log.warn({ port, nextPort }, `Port ${port} occupé, essai sur ${nextPort}…`);
    },
  });
  app.log.info(`Revive booking agent listening on http://localhost:${activePort}`);

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "Shutting down");
    clearInterval(sweeper);
    clearInterval(cancellationSweeper);
    // Stop accepting new webhooks and finish in-flight HTTP requests.
    await app.close();
    // Then drain the DETACHED per-client tasks (model + tools + sendText) that
    // outlive the HTTP response — otherwise a deploy kills conversations
    // mid-turn and, since the message id is already recorded, they're never
    // re-delivered. Railway allows ~30s before SIGKILL, so cap the wait at 25s.
    const drained = await drainQueues(25_000);
    if (drained > 0) app.log.info({ drained }, "Drained in-flight message tasks before exit");
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
