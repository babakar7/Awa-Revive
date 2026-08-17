import { assertConfig, config } from "./config.js";
import { migrate, closeDb } from "./db/index.js";
import { expireStaleBookings, expireStalePlanOrders, expireStaleCafeOrders } from "./domain/repo.js";
import { nudgeExpiredLinks, nudgeExpiredPlanOrders } from "./domain/expiryNudge.js";
import { escalateStaleLinkRequests } from "./domain/linkRequests.js";
import { completeStaleCreateAccountRequests } from "./domain/unverifiedAccounts.js";
import { runReviewSweep, maybeSendDailyDigest } from "./domain/conversationReview.js";
import { maybeSendDailyStory } from "./domain/dailyStory.js";
import { syncCancellations } from "./domain/cancellationSync.js";
import { sweepWaitlist } from "./domain/waitlistSweep.js";
import { sweepRenewalNudges } from "./domain/renewalNudge.js";
import { sweepStaffNotifications } from "./domain/notificationSweep.js";
import { sweepAutoCancellations } from "./domain/autoCancelSweep.js";
import { sweepDeliveries } from "./domain/deliveryNotify.js";
import { sweepServeEscalations } from "./domain/opsEscalation.js";
import { activateDueTableTickets, autoCloseStaleTickets } from "./domain/kitchenTicketRepo.js";
import { closeEmptyOpenSessions } from "./domain/serviceSessionRepo.js";
import { expireStaleDeliveryPaymentAttempts } from "./domain/deliveryRepo.js";
import { reconcileStuckBookings } from "./webhooks/wave.js";
import {
  reconcileStuckPlanOrders,
  activateCompletedInviteeRenewals,
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
import { closeOpsSseConnections } from "./ops/opsRoutes.js";
import { closeInactiveBookingJourneys } from "./domain/bookingFunnel.js";
import { sweepDueKeyBonuses } from "./domain/keyProvisioning.js";
import { sweepKeyNudges } from "./domain/keyNudge.js";
import { syncAttendanceLeaderboard } from "./domain/attendanceLeaderboard.js";
import { syncAdInsights } from "./domain/adInsightsSync.js";
import { sweepOmVerifications } from "./domain/orangeMoneyVerification.js";
import { syncWixPayments } from "./domain/wixPaymentSync.js";

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

  // Boot repair for paid Keys whose free bonus was delayed by Wix or a prior
  // process restart. The same idempotent repair also runs in the minute sweep.
  await sweepDueKeyBonuses().catch((err) =>
    console.error("Initial Key bonus repair failed:", err),
  );

  // Warm OM OAuth so the first client payment is not blocked by Sonatel token latency.
  startOmTokenKeepAlive();

  const app = buildServer();

  // A callback may have been persisted immediately before a deploy/crash.
  // Resume it at boot; the periodic worker below handles provider visibility
  // delays without depending on Sonatel sending the callback again.
  void sweepOmVerifications(app.log).catch((err) =>
    app.log.error({ err }, "Initial OM verification sweep failed"),
  );

  const omVerificationSweeper = setInterval(() => {
    void sweepOmVerifications(app.log).catch((err) =>
      app.log.error({ err }, "OM verification sweep failed"),
    );
  }, 10_000);
  omVerificationSweeper.unref();

  // General Wix booking + plan-order mirror (read-only projection for the
  // admin). Boot runs the one-time backfill / weekly full pass in the
  // background under an advisory lock; the 5-min loop runs the incremental
  // watermark pass. Never delay boot on the historical import.
  void syncAttendanceLeaderboard().catch((err) =>
    app.log.warn({ err }, "Initial Wix booking mirror sync failed"),
  );
  void syncAdInsights().catch((err) =>
    app.log.warn({ err }, "Initial Meta Ads sync failed"),
  );
  void syncWixPayments(app.log).catch((err) =>
    app.log.warn({ err }, "Initial Wix payment sync failed"),
  );

  // Periodic TTL sweep: AWAITING_PAYMENT past link_expires_at → EXPIRED.
  const sweeper = setInterval(async () => {
    try {
      const n =
        (await expireStaleBookings()) +
        (await expireStalePlanOrders()) +
        (await expireStaleCafeOrders()) +
        (await expireStaleDeliveryPaymentAttempts());
      if (n > 0) app.log.info({ expired: n }, "Expired stale payment links");
      await closeInactiveBookingJourneys();
      // One-shot "want a fresh link?" follow-up for links that just expired.
      await nudgeExpiredLinks(app.log);
      // Same for expired plan/Key orders, plus an OM/Max It reception alert so a
      // lost Sonatel callback (invisible otherwise) can be recovered manually.
      await nudgeExpiredPlanOrders(app.log);
      // Recover paid-but-unfulfilled work (crash between PAID and Wix / notify).
      const earlyKeys = await activateCompletedInviteeRenewals(app.log);
      if (earlyKeys > 0) {
        app.log.info({ earlyKeys }, "Activated next Keys after completed L'Invitée");
      }
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
      const keyBonuses = await sweepDueKeyBonuses();
      if (keyBonuses > 0) app.log.info({ keyBonuses }, "Repaired missing Key bonuses");
      // OM lost-callback polling via transaction search remains impossible:
      // the list API omits metadata.order, so it cannot be joined to pending
      // rows. Once a callback arrives, however, its exact transaction id is now
      // persisted and retried by the dedicated 10-second worker above.
      // New-account verification the client abandoned (email + name given,
      // code never typed) → create the account WITHOUT verification and tell
      // them they can finish their booking (Babakar 08/08). Runs BEFORE the
      // reception escalation, which then only sees existing-account linkings.
      const autoCreated = await completeStaleCreateAccountRequests();
      if (autoCreated > 0) app.log.info({ autoCreated }, "Accounts created without verification");
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
    // Empty-class auto-cancellation. Own try/catch: a Wix hiccup must never
    // block the sweeps around it, and vice-versa. Needs ≤1-min granularity for
    // the 15-min empty timer + min-notice floor → the 60s loop. Fresh Wix reads
    // (never the notif 5-min cache). Globally disabled until an admin enables a rule.
    try {
      const cancelled = await sweepAutoCancellations(app.log);
      if (cancelled > 0) app.log.info({ cancelled }, "Empty classes auto-cancelled");
    } catch (err) {
      app.log.error({ err }, "Auto-cancel sweep failed");
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
    // Room service: escalate a READY table order nobody took to the owner. Own
    // try/catch; the ~90s threshold is fine at 60s granularity.
    try {
      const escalated = await sweepServeEscalations(app.log);
      if (escalated > 0) app.log.info({ escalated }, "Room serve escalations sent to owner");
    } catch (err) {
      app.log.error({ err }, "Serve-escalation sweep failed");
    }
    // Future TABLE orders enter Cuisine only when their 15-minute preparation
    // window opens. The DB claim is atomic, so overlapping instances emit once.
    try {
      const activated = await activateDueTableTickets();
      if (activated.length > 0) app.log.info({ activated: activated.length }, "Scheduled table orders activated");
    } catch (err) {
      app.log.error({ err }, "Scheduled table-order activation failed");
    }
    // Kitchen board self-cleaning: an open TABLE/BAR ticket older than
    // OPS_TICKET_AUTOCLOSE_MINUTES has in reality long been handled — mark it
    // ready + completed so the iPad never accumulates stale cards, then free any
    // session left empty (a forgotten table once sat on the board for two days).
    try {
      if (config.OPS_TICKET_AUTOCLOSE_MINUTES > 0) {
        const closed = await autoCloseStaleTickets(config.OPS_TICKET_AUTOCLOSE_MINUTES);
        if (closed.length > 0) {
          await closeEmptyOpenSessions().catch(() => {});
          app.log.info({ closed: closed.length }, "Stale kitchen tickets auto-closed");
        }
      }
    } catch (err) {
      app.log.error({ err }, "Ticket auto-close sweep failed");
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
    try {
      // Lifecycle des Clés. No-op until the corresponding approved Meta
      // templates are configured; durable claims prevent duplicate sends.
      const nudged = await sweepKeyNudges(app.log);
      if (nudged > 0) app.log.info({ nudged }, "Key lifecycle nudges sent");
    } catch (err) {
      app.log.error({ err }, "Key lifecycle nudge sweep failed");
    }
    try {
      const synced = await syncAttendanceLeaderboard();
      if (synced.ran) app.log.info({ attendanceRecords: synced.recordCount }, "Wix attendance synced");
    } catch (err) {
      app.log.warn({ err }, "Wix attendance sync failed");
    }
    try {
      const synced = await syncAdInsights();
      if (synced.ran) app.log.info({ adInsightRecords: synced.recordCount }, "Meta Ads insights synced");
    } catch (err) {
      app.log.warn({ err }, "Meta Ads insights sync failed");
    }
    try {
      const synced = await syncWixPayments(app.log);
      if (synced.ran) app.log.info({ paymentRecords: synced.recordCount }, "Wix payments synced");
    } catch (err) {
      app.log.warn({ err }, "Wix payment sync failed");
    }
    try {
      // Story Instagram du soir : image des cours de demain envoyée au gérant
      // une fois par jour (garde app_state). En cas d'échec, retry au prochain
      // passage jusqu'à 22h.
      if (await maybeSendDailyStory(app.log)) app.log.info("Daily story sent to owner");
    } catch (err) {
      app.log.error({ err }, "Daily story failed (will retry within window)");
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
    clearInterval(omVerificationSweeper);
    // End open SSE streams first — they never complete on their own, so
    // app.close() would otherwise hang waiting on them past the SIGKILL window.
    closeOpsSseConnections();
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
