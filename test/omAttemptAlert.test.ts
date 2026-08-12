import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isOmOutageActive: vi.fn(),
  notifyReception: vi.fn(),
  query: vi.fn(),
}));

vi.mock("../src/domain/omOutage.js", () => ({
  isOmOutageActive: mocks.isOmOutageActive,
}));
vi.mock("../src/lib/notify.js", () => ({
  notifyReception: mocks.notifyReception,
}));
vi.mock("../src/db/index.js", () => ({
  pool: { query: mocks.query },
}));

import {
  formatOmAttemptAlert,
  notifyOmPaymentAttempt,
  type OmAttemptOrderInfo,
} from "../src/domain/omAttemptAlert.js";
import { shouldAlertOwner } from "../src/domain/ownerAlertRules.js";

const order: OmAttemptOrderInfo = {
  kind: "Abonnement",
  label: "La Clé L'Invitée",
  client_name: "Awa Ka",
  wa_phone: "+221786603672",
  is_test: false,
};

describe("formatOmAttemptAlert", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("wakes the owner with client, amount, order and the reconcile page", () => {
    const alert = formatOmAttemptAlert({
      method: "orange_money",
      amountXof: 15_000,
      order,
    });

    expect(alert.subject).toBe("⚠️ Paiement Orange Money à réconcilier manuellement");
    expect(shouldAlertOwner(alert.subject)).toBe(true);
    expect(alert.body).toContain("Awa Ka (+221786603672)");
    expect(alert.body).toContain("Orange Money");
    expect(alert.body).toContain("FCFA");
    expect(alert.body).toContain("Abonnement : La Clé L'Invitée");
    expect(alert.body).toContain("/admin/paiements-om");
  });

  it("labels Max It attempts with the client-facing app name", () => {
    const alert = formatOmAttemptAlert({ method: "maxit", amountXof: 10_000, order });

    expect(alert.subject).toContain("Max It");
    expect(alert.body).toContain("lien Max It");
  });

  it("still alerts with the fallback label when the order row is not found", () => {
    const alert = formatOmAttemptAlert({
      method: "orange_money",
      amountXof: 10_000,
      fallbackLabel: "Pilates Reformer (Foundation)",
      order: null,
    });

    expect(shouldAlertOwner(alert.subject)).toBe(true);
    expect(alert.body).toContain("Client vient de recevoir");
    expect(alert.body).toContain("Pilates Reformer (Foundation)");
    expect(alert.body).toContain("/admin/paiements-om");
  });

  it("never wakes the owner for a team/test number", () => {
    const alert = formatOmAttemptAlert({
      method: "orange_money",
      amountXof: 10_000,
      order: { ...order, is_test: true },
    });

    expect(alert.subject).toMatch(/^🧪 TEST — /u);
    expect(shouldAlertOwner(alert.subject)).toBe(false);
  });

  it("does not send a reconciliation alert when outage mode is off", async () => {
    mocks.isOmOutageActive.mockResolvedValue(false);

    await notifyOmPaymentAttempt({
      orderId: "order-1",
      method: "maxit",
      amountXof: 10_000,
    });

    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.notifyReception).not.toHaveBeenCalled();
  });

  it("keeps the reconciliation alert available when outage mode is on", async () => {
    mocks.isOmOutageActive.mockResolvedValue(true);
    mocks.query.mockResolvedValue({ rows: [order] });

    await notifyOmPaymentAttempt({
      orderId: "order-1",
      method: "maxit",
      amountXof: 10_000,
    });

    expect(mocks.notifyReception).toHaveBeenCalledWith(
      expect.stringContaining("Paiement Max It à réconcilier manuellement"),
      expect.stringContaining("/admin/paiements-om"),
    );
  });
});
