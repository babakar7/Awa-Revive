import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../src/db/index.js";
import {
  clearAgentToolFailure,
  ensureOpenTechnicalHandoff,
  lastTurnsForReplay,
  latestPresentedChoices,
  markAgentToolFailureTripped,
  pauseAwaForTechnicalHandoff,
  clearNoIntentDisengagement,
  recordNoIntentTurn,
  recordAgentToolFailure,
  savePresentedChoices,
} from "../../src/domain/repo.js";
import { reviewTurns } from "../../src/domain/conversationReview.js";
import { seedClient, truncateAll } from "./helpers.js";

afterAll(() => pool.end());

describe("durable agent reliability state", () => {
  beforeEach(truncateAll);

  it("persists, resets and atomically trips repeated tool failures", async () => {
    const client = await seedClient();
    const key = '{"event_id":"ev_1"}';
    const first = await recordAgentToolFailure({
      clientId: client.id,
      toolName: "create_payment_link",
      errorCode: "unknown_slot",
      resourceKey: key,
    });
    const second = await recordAgentToolFailure({
      clientId: client.id,
      toolName: "create_payment_link",
      errorCode: "unknown_slot",
      resourceKey: key,
    });
    expect(first.failureCount).toBe(1);
    expect(second.failureCount).toBe(2);
    expect(
      await markAgentToolFailureTripped({
        clientId: client.id,
        toolName: "create_payment_link",
        errorCode: "unknown_slot",
        resourceKey: key,
      }),
    ).toBe(true);
    expect(
      await markAgentToolFailureTripped({
        clientId: client.id,
        toolName: "create_payment_link",
        errorCode: "unknown_slot",
        resourceKey: key,
      }),
    ).toBe(false);

    await pauseAwaForTechnicalHandoff(client.id);
    const paused = (
      await pool.query(
        `select human_takeover_by, human_takeover_until > now() as active
           from clients where id=$1`,
        [client.id],
      )
    ).rows[0];
    expect(paused).toMatchObject({ human_takeover_by: "awa-technical-failure", active: true });

    await clearAgentToolFailure({
      clientId: client.id,
      toolName: "create_payment_link",
      resourceKey: key,
    });
    expect(
      Number(
        (
          await pool.query(`select count(*) from agent_tool_failures where client_id=$1`, [
            client.id,
          ])
        ).rows[0].count,
      ),
    ).toBe(0);
  });

  it("durably trips no-intent on turn three and only auto-clears that pause kind", async () => {
    const client = await seedClient();
    await pool.query(
      `insert into handoffs (client_id, reason) values ($1, 'Demande devenue sans objet')`,
      [client.id],
    );
    await pool.query(
      `insert into conversation_reviews
         (client_id, last_message_at, outcome, need_category, summary)
       values ($1, now(), 'deadend', 'unknown', 'Boucle à reprendre')`,
      [client.id],
    );

    expect(await recordNoIntentTurn(client.id)).toEqual({ streak: 1, disengaged: false });
    expect(await recordNoIntentTurn(client.id)).toEqual({ streak: 2, disengaged: false });
    expect(
      (
        await pool.query(
          `select count(*)::int as n from handoffs where client_id=$1 and status='OPEN'`,
          [client.id],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(await recordNoIntentTurn(client.id)).toEqual({ streak: 3, disengaged: true });

    let row = (await pool.query(`select * from clients where id=$1`, [client.id])).rows[0];
    expect(row.awa_disengaged_kind).toBe("no_intent");
    expect(new Date(row.awa_disengaged_until).getTime()).toBeGreaterThan(Date.now());
    for (const table of ["handoffs", "conversation_reviews"] as const) {
      const followUp = (
        await pool.query(
          `select status, done_by, done_at, resolution_outcome, resolution_note
             from ${table} where client_id=$1`,
          [client.id],
        )
      ).rows[0];
      expect(followUp).toMatchObject({
        status: "DONE",
        done_by: "awa-system",
        resolution_outcome: "not_applicable",
        resolution_note: "Auto : conversation mise en pause (boucle sans intention)",
      });
      expect(followUp.done_at).toBeInstanceOf(Date);
    }
    expect(await clearNoIntentDisengagement(client.id)).toBe(true);

    await pool.query(
      `update clients
          set awa_disengaged_kind='manual', awa_disengaged_until=now()+interval '1 hour'
        where id=$1`,
      [client.id],
    );
    expect(await clearNoIntentDisengagement(client.id)).toBe(false);
    row = (await pool.query(`select * from clients where id=$1`, [client.id])).rows[0];
    expect(row.awa_disengaged_kind).toBe("manual");
  });

  it("resolves only against the latest delivered option list", async () => {
    const client = await seedClient();
    await savePresentedChoices(client.id, [{ id: "old", title: "Ancien" }]);
    await savePresentedChoices(client.id, [
      { id: "slot_a", title: "Mer 29 juil · 12:30" },
      { id: "slot_b", title: "Jeu 30 juil · 18:00" },
    ]);
    expect(await latestPresentedChoices(client.id)).toEqual([
      { choice_id: "slot_a", title: "Mer 29 juil · 12:30" },
      { choice_id: "slot_b", title: "Jeu 30 juil · 18:00" },
    ]);
  });

  it("labels human takeover messages in replay and quality review", async () => {
    const client = await seedClient();
    await pool.query(
      `insert into conversations (client_id, role, content)
       values ($1,'user','Je veux réserver'), ($1,'assistant','Je regarde')`,
      [client.id],
    );
    await pool.query(
      `insert into admin_outbound_messages
         (request_key, client_id, body, sent_by, status, sent_at)
       values ('11111111-1111-4111-8111-111111111111',$1,
               'Je prends le relais','revive','sent',now())`,
      [client.id],
    );

    const replay = await lastTurnsForReplay(client.id);
    expect(replay.at(-1)?.content).toContain("MESSAGE HUMAIN DE L'ÉQUIPE REVIVE");
    const review = await reviewTurns(client.id);
    expect(review.at(-1)).toMatchObject({
      role: "assistant",
      source: "admin",
      content: "Je prends le relais",
    });
  });

  it("keeps one open task per equivalent technical incident", async () => {
    const client = await seedClient();
    expect(await ensureOpenTechnicalHandoff(client.id, "agent_call", "timeout one")).toBe(true);
    expect(await ensureOpenTechnicalHandoff(client.id, "agent_call", "timeout replay")).toBe(false);
    expect(await ensureOpenTechnicalHandoff(client.id, "output_filter", "blocked twice")).toBe(true);
    const count = await pool.query(
      `select count(*)::int as n from handoffs where client_id=$1 and status='OPEN'`,
      [client.id],
    );
    expect(count.rows[0].n).toBe(2);
  });
});
