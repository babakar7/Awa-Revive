import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Engine-level flow for the empty-class auto-cancellation sweep, with Wix, the
 * notification layer, and the DB repo fully mocked. Covers the happy path
 * (empty long enough → Calendar V3 cancel + 3 notices), the fail-closed
 * not-empty case, and the "someone booked during the grace period" abort in the
 * final fresh check.
 */

const mocks = vi.hoisted(() => ({
  // autoCancelRepo
  isAutoCancelPaused: vi.fn(),
  listEnabledRules: vi.fn(),
  ruleActivationError: vi.fn(),
  hasActivePaymentForSession: vi.fn(),
  getLedger: vi.fn(),
  getLedgerTx: vi.fn(),
  recordObservation: vi.fn(),
  markCancellingTx: vi.fn(),
  markCancelledTx: vi.fn(),
  markCancelledByEvent: vi.fn(),
  markFailed: vi.fn(),
  purgeSlotCacheForSession: vi.fn(),
  ownerRecipient: vi.fn(),
  managerContactForRule: vi.fn(),
  openingContactForRule: vi.fn(),
  withOccurrenceLock: vi.fn(),
  staleCancellingRows: vi.fn(),
  revertToObserving: vi.fn(),
  getRule: vi.fn(),
  // wix
  queryAvailabilityMulti: vi.fn(),
  getCalendarOccurrence: vi.fn(),
  cancelClassOccurrence: vi.fn(),
  listStaffResources: vi.fn(),
  // notificationRepo
  findStaffByName: vi.fn(),
  claimOrReclaim: vi.fn(),
  finishLog: vi.fn(),
  markRetryable: vi.fn(),
  // notify
  sendWhatsAppNotification: vi.fn(),
}));

vi.mock("../src/config.js", () => ({
  config: { TIMEZONE: "Africa/Dakar", AUTO_CANCEL_MIN_NOTICE_MINUTES: 120, OWNER_PHONE: "+221774982711" },
}));
vi.mock("../src/lib/wix.js", () => ({
  queryAvailabilityMulti: mocks.queryAvailabilityMulti,
  getCalendarOccurrence: mocks.getCalendarOccurrence,
  cancelClassOccurrence: mocks.cancelClassOccurrence,
  listStaffResources: mocks.listStaffResources,
}));
vi.mock("../src/lib/notify.js", () => ({
  sendWhatsAppNotification: mocks.sendWhatsAppNotification,
}));
vi.mock("../src/domain/notificationRepo.js", () => ({
  findStaffByName: mocks.findStaffByName,
  claimOrReclaim: mocks.claimOrReclaim,
  finishLog: mocks.finishLog,
  markRetryable: mocks.markRetryable,
  phoneDigits: (p: string) => p.replace(/\D/g, ""),
}));
vi.mock("../src/domain/autoCancelRepo.js", () => mocks);

import { openingRecipientFor, sweepAutoCancellations } from "../src/domain/autoCancelSweep.js";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const RULE = {
  id: "rule-1",
  label: "reformer matin",
  enabled: true,
  service_ids: ["svc-1"],
  weekdays: [],
  start_min_from: null,
  start_min_to: null,
  owner_contact_id: "o1",
  manager_contact_id: "m1",
  opening_contact_id: "op1",
};

/** A slot 2.5h ahead → inside the daytime [start-3h, start-2h] window now. */
function inWindowStartIso(): string {
  return new Date(Date.now() + 150 * 60_000).toISOString();
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.isAutoCancelPaused.mockResolvedValue(false);
  mocks.listEnabledRules.mockResolvedValue([RULE]);
  mocks.ruleActivationError.mockResolvedValue(null);
  mocks.hasActivePaymentForSession.mockResolvedValue(false);
  mocks.markFailed.mockResolvedValue(undefined);
  mocks.recordObservation.mockResolvedValue(undefined);
  mocks.purgeSlotCacheForSession.mockResolvedValue(undefined);
  mocks.markCancellingTx.mockResolvedValue(undefined);
  mocks.markCancelledTx.mockResolvedValue(undefined);
  mocks.markCancelledByEvent.mockResolvedValue(undefined);
  mocks.staleCancellingRows.mockResolvedValue([]);
  mocks.revertToObserving.mockResolvedValue(undefined);
  mocks.getRule.mockResolvedValue(RULE);
  mocks.ownerRecipient.mockReturnValue({ name: "Propriétaire", phone: "+221774982711" });
  mocks.managerContactForRule.mockResolvedValue({
    id: "m1",
    name: "Manager",
    phone: "+221771112202",
    muted: false,
  });
  // Default: no opening contact (keeps the full-sweep tests at 3 recipients,
  // independent of the real wall-clock morning/daytime split).
  mocks.openingContactForRule.mockResolvedValue(null);
  mocks.findStaffByName.mockResolvedValue(null);
  mocks.listStaffResources.mockResolvedValue([{ id: "c1", name: "Alou", phone: "+221770000009", email: null }]);
  mocks.claimOrReclaim.mockResolvedValue(true);
  mocks.finishLog.mockResolvedValue(undefined);
  mocks.sendWhatsAppNotification.mockResolvedValue("sent");
  // Ledger: already empty 16 min, last observed 30s ago → continuous & long enough.
  const led = {
    event_id: "ev-1",
    session_id: "sess-1",
    state: "OBSERVING",
    first_empty_at: new Date(Date.now() - 16 * 60_000).toISOString(),
    last_observed_at: new Date(Date.now() - 30_000).toISOString(),
  };
  mocks.getLedger.mockResolvedValue(led);
  mocks.getLedgerTx.mockResolvedValue(led);
  // Lock runs the callback with a fake client.
  mocks.withOccurrenceLock.mockImplementation(async (_s: string, fn: any) => ({
    acquired: true,
    value: await fn({}),
  }));

  const start = inWindowStartIso();
  mocks.queryAvailabilityMulti.mockResolvedValue([
    {
      eventId: "sess-1",
      rescheduleEventId: "ev-1",
      serviceId: "svc-1",
      startDate: start,
      endDate: new Date(Date.parse(start) + 30 * 60_000).toISOString(),
      openSpots: 8,
      totalSpots: 8,
      coach: "Alou",
      coachId: "c1",
      raw: {},
    },
  ]);
});

describe("sweepAutoCancellations", () => {
  it("cancels an empty in-window occurrence and notifies coach, owner and manager", async () => {
    mocks.getCalendarOccurrence.mockResolvedValue({
      status: "CONFIRMED",
      participantCount: 0,
      serviceName: "Pilates Reformer",
    });
    mocks.cancelClassOccurrence.mockResolvedValue({ status: "CANCELLED" });

    const n = await sweepAutoCancellations(log);
    expect(n).toBe(1);
    expect(mocks.cancelClassOccurrence).toHaveBeenCalledWith("ev-1");
    expect(mocks.markCancellingTx).toHaveBeenCalled(); // phase A
    expect(mocks.markCancelledByEvent).toHaveBeenCalledWith("ev-1"); // phase B
    // Three distinct recipients.
    expect(mocks.sendWhatsAppNotification).toHaveBeenCalledTimes(3);
    expect(mocks.purgeSlotCacheForSession).toHaveBeenCalledWith("sess-1");
  });

  it("recovers a stuck CANCELLING row: finalizes + notifies when Wix confirms CANCELLED", async () => {
    mocks.listEnabledRules.mockResolvedValue([]); // recovery runs even with no rules
    mocks.staleCancellingRows.mockResolvedValue([
      { event_id: "ev-9", session_id: "sess-9", rule_id: "rule-1", service_id: "svc-1", start_at: inWindowStartIso() },
    ]);
    mocks.getCalendarOccurrence.mockResolvedValue({
      status: "CANCELLED",
      participantCount: 0,
      serviceName: "Pilates Reformer",
      startDate: inWindowStartIso(),
      resources: [{ id: "c1", name: "Alou", type: "STAFF" }],
    });

    const n = await sweepAutoCancellations(log);
    expect(n).toBe(0); // recovery is not a fresh cancel
    expect(mocks.markCancelledByEvent).toHaveBeenCalledWith("ev-9");
    expect(mocks.sendWhatsAppNotification).toHaveBeenCalled(); // notices delivered
  });

  it("reverts a stuck CANCELLING row when Wix still shows CONFIRMED", async () => {
    mocks.listEnabledRules.mockResolvedValue([]);
    mocks.staleCancellingRows.mockResolvedValue([
      { event_id: "ev-8", session_id: "sess-8", rule_id: "rule-1", service_id: "svc-1", start_at: inWindowStartIso() },
    ]);
    mocks.getCalendarOccurrence.mockResolvedValue({ status: "CONFIRMED", participantCount: 0, serviceName: "R" });

    await sweepAutoCancellations(log);
    expect(mocks.revertToObserving).toHaveBeenCalledWith("ev-8", expect.any(Date));
    expect(mocks.markCancelledByEvent).not.toHaveBeenCalled();
  });

  it("does not cancel when the class is not empty (fail-closed)", async () => {
    mocks.getCalendarOccurrence.mockResolvedValue({
      status: "CONFIRMED",
      participantCount: 2,
      serviceName: "Pilates Reformer",
    });
    const n = await sweepAutoCancellations(log);
    expect(n).toBe(0);
    expect(mocks.cancelClassOccurrence).not.toHaveBeenCalled();
  });

  it("aborts if a participant appears in the final fresh check (grace-period race)", async () => {
    // Empty at first look, but someone books before the locked re-fetch.
    mocks.getCalendarOccurrence
      .mockResolvedValueOnce({ status: "CONFIRMED", participantCount: 0, serviceName: "R" })
      .mockResolvedValue({ status: "CONFIRMED", participantCount: 1, serviceName: "R" });

    const n = await sweepAutoCancellations(log);
    expect(n).toBe(0);
    expect(mocks.cancelClassOccurrence).not.toHaveBeenCalled();
  });

  it("skips entirely when globally paused", async () => {
    mocks.isAutoCancelPaused.mockResolvedValue(true);
    const n = await sweepAutoCancellations(log);
    expect(n).toBe(0);
    expect(mocks.queryAvailabilityMulti).not.toHaveBeenCalled();
  });

  it("does not cancel when capacity is unknown (participantCount null)", async () => {
    mocks.getCalendarOccurrence.mockResolvedValue({
      status: "CONFIRMED",
      participantCount: null,
      serviceName: "R",
    });
    const n = await sweepAutoCancellations(log);
    expect(n).toBe(0);
    expect(mocks.cancelClassOccurrence).not.toHaveBeenCalled();
  });
});

describe("openingRecipientFor (accueil/ouverture, morning-only)", () => {
  const MORNING = { startIso: "2026-08-24T07:00:00.000Z" }; // 07:00 ≤ 09:15
  const DAYTIME = { startIso: "2026-08-24T18:00:00.000Z" };
  const contact = { id: "op1", name: "Accueil Fatou", phone: "+221770001122", muted: false };

  it("adds the opening recipient for a morning class", async () => {
    mocks.openingContactForRule.mockResolvedValue(contact);
    const r = await openingRecipientFor(RULE as any, MORNING);
    expect(r).toEqual({ role: "opening", name: "Accueil Fatou", phone: "+221770001122" });
  });

  it("does NOT add it for a later (daytime) class even if configured", async () => {
    mocks.openingContactForRule.mockResolvedValue(contact);
    expect(await openingRecipientFor(RULE as any, DAYTIME)).toBeNull();
  });

  it("skips a muted or unset opening contact", async () => {
    mocks.openingContactForRule.mockResolvedValue({ ...contact, muted: true });
    expect(await openingRecipientFor(RULE as any, MORNING)).toBeNull();
    mocks.openingContactForRule.mockResolvedValue(null);
    expect(await openingRecipientFor(RULE as any, MORNING)).toBeNull();
  });
});
