import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate, pool } from "../../src/db/index.js";
import { conversationsToReview } from "../../src/domain/conversationReview.js";
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

async function addTurn(clientId: string, role: string, content: string, minutesAgo: number) {
  await pool.query(
    `insert into conversations (client_id, role, content, created_at)
     values ($1, $2, $3, now() - ($4 || ' minutes')::interval)`,
    [clientId, role, content, String(minutesAgo)],
  );
}

async function addAdminOutbound(clientId: string, body: string, minutesAgo: number) {
  await pool.query(
    `insert into admin_outbound_messages (request_key, client_id, body, sent_by, status, sent_at, created_at)
     values (gen_random_uuid(), $1, $2, 'reception', 'sent',
             now() - ($3 || ' minutes')::interval, now() - ($3 || ' minutes')::interval)`,
    [clientId, body, String(minutesAgo)],
  );
}

async function addDoneTechnicalReview(clientId: string, lastMsgMinutesAgo: number) {
  await pool.query(
    `insert into conversation_reviews
       (client_id, last_message_at, outcome, need_category, severity, summary,
        suggested_action, status, done_by, done_at)
     values ($1, now() - ($2 || ' minutes')::interval, 'technical_failure', 'booking',
             'normal', 'souci technique', 'confirmer horaire', 'DONE', 'staff', now())`,
    [clientId, String(lastMsgMinutesAgo)],
  );
}

describe("conversationsToReview — re-open only on a new client inbound", () => {
  it("does NOT re-open a resolved technical_failure when only reception replied", async () => {
    const { id } = await seedClient({ wa_phone: "221770000091", name: "Kadidiatou" });

    // Original incident, ~3h ago: client asks, Awa hits the technical error.
    await addTurn(id, "user", "je veux réserver dimanche", 185);
    await addTurn(id, "assistant", "j'ai un souci technique, je reviens vers toi", 184);
    // The review the sweep produced, resolved by staff.
    await addDoneTechnicalReview(id, 184);
    // Reception handled it and replied to the client (this is the resolution act).
    await addAdminOutbound(id, "Bonjour, on vous confirme 10h15 dimanche", 120);

    const pending = await conversationsToReview();
    expect(pending.map((p) => p.client_id)).not.toContain(id);
  });

  it("DOES re-open once the client writes back", async () => {
    const { id } = await seedClient({ wa_phone: "221770000092", name: "Kadidiatou" });

    await addTurn(id, "user", "je veux réserver dimanche", 185);
    await addTurn(id, "assistant", "j'ai un souci technique, je reviens vers toi", 184);
    await addDoneTechnicalReview(id, 184);
    await addAdminOutbound(id, "Bonjour, on vous confirme 10h15 dimanche", 120);
    // Client genuinely re-engages after the resolution.
    await addTurn(id, "user", "finalement je préfère 11h15", 60);

    const pending = await conversationsToReview();
    expect(pending.map((p) => p.client_id)).toContain(id);
  });

  it("still reviews a first-time silent conversation (no prior review)", async () => {
    const { id } = await seedClient({ wa_phone: "221770000093", name: "Awa Test" });

    await addTurn(id, "user", "vous ouvrez à quelle heure ?", 90);
    await addTurn(id, "assistant", "on ouvre à 7h", 89);

    const pending = await conversationsToReview();
    expect(pending.map((p) => p.client_id)).toContain(id);
  });
});
