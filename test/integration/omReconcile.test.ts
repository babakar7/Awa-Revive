import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate, pool } from "../../src/db/index.js";
import * as repo from "../../src/domain/repo.js";
import { omReconcileCandidates } from "../../src/admin/omReconcilePage.js";
import { seedClient, truncateAll } from "./helpers.js";

beforeAll(async () => {
  await migrate();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await truncateAll();
});

// Page /admin/paiements-om (panne callbacks OM du 31/07) : la liste ne doit
// montrer QUE les ordres OM/Max It encore réconciliables — pas le Wave, pas le
// déjà-payé, pas l'ancien.
describe("omReconcileCandidates", () => {
  async function seedBooking(args: {
    clientId: string;
    method: string;
    status: string;
    createdDaysAgo?: number;
  }): Promise<string> {
    const draft = await repo.createDraftBooking({
      clientId: args.clientId,
      serviceId: "svc_aquabike",
      serviceName: "Aquabike (Intermédiaire)",
      eventId: `evt_${Math.random().toString(36).slice(2)}`,
      slotJson: {},
      slotStart: new Date(Date.now() + 3 * 3600_000).toISOString(),
      slotEnd: null,
      amountXof: 10_000,
      participants: 1,
    });
    await pool.query(
      `update pending_bookings
          set status=$2, payment_method=$3, payment_link='https://sugu.example/mp/x',
              link_expires_at=now() - interval '10 minutes',
              created_at=now() - make_interval(days => $4)
        where id=$1`,
      [draft.id, args.status, args.method, args.createdDaysAgo ?? 0],
    );
    return draft.id;
  }

  it("lists recent unpaid OM/Max It bookings and plan orders, excluding wave/paid/old", async () => {
    const client = await seedClient();

    const maxitExpired = await seedBooking({ clientId: client.id, method: "maxit", status: "EXPIRED" });
    const omAwaiting = await seedBooking({ clientId: client.id, method: "orange_money", status: "AWAITING_PAYMENT" });
    await seedBooking({ clientId: client.id, method: "wave", status: "EXPIRED" }); // wrong rail
    await seedBooking({ clientId: client.id, method: "maxit", status: "BOOKED" }); // already delivered
    await seedBooking({ clientId: client.id, method: "maxit", status: "EXPIRED", createdDaysAgo: 9 }); // too old

    const plan = await repo.createDraftPlanOrder({
      clientId: client.id,
      planId: "plan_invitee",
      planName: "L'Invitée — Clé 3 séances",
      amountXof: 30_000,
      memberId: null,
    });
    await pool.query(
      `update pending_plan_orders
          set status='EXPIRED', payment_method='maxit',
              payment_link='https://sugu.example/mp/y',
              link_expires_at=now() - interval '5 minutes'
        where id=$1`,
      [plan.id],
    );

    const rows = await omReconcileCandidates();
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(maxitExpired);
    expect(ids).toContain(omAwaiting);
    expect(ids).toContain(plan.id);
    expect(rows).toHaveLength(3);

    const planRow = rows.find((r) => r.id === plan.id)!;
    expect(planRow.kind).toBe("Abonnement");
    expect(planRow.label).toBe("L'Invitée — Clé 3 séances");
    expect(planRow.amount_xof).toBe(30_000);
  });
});
