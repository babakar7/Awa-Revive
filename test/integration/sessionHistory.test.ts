import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../src/db/index.js";
import { executeTool } from "../../src/agent/tools.js";
import { makeFetchMock, seedClient, truncateAll, type FetchMock } from "./helpers.js";

let mock: FetchMock;

const asClient = (client: { id: string; wa_phone: string }) => ({
  id: client.id,
  wa_phone: client.wa_phone,
  name: "Test",
  language: "fr",
  email_prompted_at: null,
  claimed_email: null,
  capability_menu_at: null,
});

beforeAll(async () => {
  mock = makeFetchMock();
  mock.install();
});

afterAll(async () => {
  mock.restore();
  await pool.end();
});

beforeEach(async () => {
  await truncateAll();
  mock.reset();
});

describe("get_session_history", () => {
  it("returns only the client's confirmed past mirror rows and never calls an unmarked session absent", async () => {
    const client = await seedClient();
    const other = await seedClient({ wa_phone: "221770000099" });
    const started = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const otherStarted = new Date(Date.now() - 3 * 86_400_000).toISOString();
    await pool.query(
      `insert into wix_booking_records
        (booking_id, service_name, session_start, status, matched_client_id, synced_at, raw)
       values
        ('history-mine','Pilates Reformer (Sculpt)',$1,'CONFIRMED',$2,now(),$3::jsonb),
        ('history-other','Yoga',$4,'CONFIRMED',$5,now(),$3::jsonb)`,
      [started, client.id, JSON.stringify({ bookedEntity: { slot: { eventId: "event-mine" } } }), otherStarted, other.id],
    );
    await pool.query(
      `insert into wix_attendance_records
        (attendance_id, booking_id, status, synced_at)
       values ('attendance-mine','history-mine','ATTENDED',now())`,
    );

    const out = JSON.parse(await executeTool(asClient(client), "get_session_history", {}));
    expect(out.period_days).toBe(90);
    expect(out.sessions).toHaveLength(1);
    expect(out.sessions[0]).toMatchObject({
      class: "Pilates Reformer (Sculpt)",
      attendance: "marked_present",
      usage: { type: "unknown", proven: false },
    });
  });
});
