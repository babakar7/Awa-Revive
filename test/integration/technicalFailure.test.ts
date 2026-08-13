import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../../src/config.js";
import { pool } from "../../src/db/index.js";
import { handleTechnicalFailure } from "../../src/domain/technicalFailure.js";
import { findClientByPhone } from "../../src/domain/repo.js";
import {
  makeFetchMock,
  seedClient,
  truncateAll,
  waitFor,
  type FetchMock,
} from "./helpers.js";

let mock: FetchMock;

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

describe("terminal technical handoff deduplication", () => {
  it("deduplicates a replay but alerts staff again for a distinct inbound event", async () => {
    const seeded = await seedClient({
      wa_phone: "221770000081",
      name: "Aïcha",
      language: "fr",
    });
    const client = await findClientByPhone([seeded.wa_phone]);
    expect(client).toBeTruthy();

    const first = {
      client: client!,
      waMessageId: "wamid.client.1",
      stage: "agent_call",
      cause: new Error("provider timeout"),
    };
    await handleTechnicalFailure(first);
    await handleTechnicalFailure(first);
    await waitFor(
      async () => (await pool.query(
        `select count(*)::int as n from notification_log where source='technical' and status like 'sent%'`,
      )).rows[0].n === 3,
      "first technical alert set",
    );

    expect(mock.waTextsTo(seeded.wa_phone)).toHaveLength(1);
    expect((await pool.query(
      `select count(*)::int as n from handoffs where client_id=$1 and status='OPEN'`,
      [seeded.id],
    )).rows[0].n).toBe(1);
    expect((await pool.query(
      `select dedup_key from notification_log where source='technical' order by dedup_key`,
    )).rows.map((row) => row.dedup_key)).toEqual([
      `technical:${seeded.id}:wamid.client.1:agent_call:client`,
      `technical:${seeded.id}:wamid.client.1:agent_call:owner`,
      `technical:${seeded.id}:wamid.client.1:agent_call:reception`,
    ]);

    await handleTechnicalFailure({ ...first, waMessageId: "wamid.client.2" });
    await waitFor(
      async () => (await pool.query(
        `select count(*)::int as n from notification_log where source='technical' and status like 'sent%'`,
      )).rows[0].n === 6,
      "second technical alert set",
    );

    expect(mock.waTextsTo(config.RECEPTION_PHONE.replace(/\D/g, ""))).toHaveLength(2);
    expect(mock.waTextsTo(config.OWNER_PHONE.replace(/\D/g, ""))).toHaveLength(2);
    expect(mock.waTextsTo(seeded.wa_phone)).toHaveLength(2);
    expect((await pool.query(
      `select count(*)::int as n from handoffs where client_id=$1 and status='OPEN'`,
      [seeded.id],
    )).rows[0].n).toBe(1);
  });
});
