import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { pool, migrate } from "../../src/db/index.js";
import * as plan from "../../src/domain/classPlanningRepo.js";
import { makeFetchMock, type FetchMock, truncateAll } from "./helpers.js";

/**
 * Class planning sandbox end-to-end: CRUD + grid save/validation, the exactly-one-
 * published invariant, the Wix import (Reformer/Mat + CONFIRMED only, through the
 * same validation as manual saves, degrading when Wix is down), and that the
 * rendered board <script> stays syntactically safe with hostile free-text names.
 */

const AUTH = `Basic ${Buffer.from("revive:revive@5000").toString("base64")}`;

let app: FastifyInstance;
let mock: FetchMock;

beforeAll(async () => {
  await migrate();
  mock = makeFetchMock();
  mock.install();
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  mock.restore();
  await app.close();
  await pool.end();
});

beforeEach(async () => {
  await truncateAll();
  mock.reset();
});

const post = (url: string, fields: Record<string, string>) =>
  app.inject({
    method: "POST",
    url,
    headers: { authorization: AUTH, "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams(fields).toString(),
  });

const get = (url: string) => app.inject({ method: "GET", url, headers: { authorization: AUTH } });

const count = async (sql: string, params: any[] = []) =>
  Number((await pool.query(sql, params)).rows[0].count);

describe("class planning CRUD + grid", () => {
  it("creates a scenario, saves a grid, rejects an invalid one without wiping", async () => {
    const created = await post("/admin/coaching", { name: "Rentrée" });
    expect(created.statusCode).toBe(303);
    const id = (await pool.query(`select id from class_plan_schedules limit 1`)).rows[0].id;

    const view = await get(`/admin/coaching?s=${id}`);
    expect(view.statusCode).toBe(200);
    expect(view.body).toContain("Planning des cours");

    const grid = JSON.stringify({
      slots: [
        { weekday: 0, start_min: 435, duration_min: 50, coach_name: "Leslie", class_name: "Pilates Reformer (Sculpt)" },
        { weekday: 0, start_min: 435, duration_min: 50, coach_name: "Serena", class_name: "Pilates Reformer (Foundation)" },
      ],
    });
    const saved = await post(`/admin/coaching/${id}/grid`, { grid });
    expect(saved.headers.location).toContain("done=saved");
    expect(await count(`select count(*) from class_plan_slots where schedule_id=$1`, [id])).toBe(2);

    // Same coach, same weekday+time → conflict → rejected, previous grid intact.
    const bad = JSON.stringify({
      slots: [
        { weekday: 0, start_min: 435, duration_min: 50, coach_name: "Leslie", class_name: "Reformer" },
        { weekday: 0, start_min: 435, duration_min: 50, coach_name: "Leslie", class_name: "Reformer" },
      ],
    });
    const rejected = await post(`/admin/coaching/${id}/grid`, { grid: bad });
    expect(rejected.headers.location).toContain("err=");
    expect(await count(`select count(*) from class_plan_slots where schedule_id=$1`, [id])).toBe(2);
  });

  it("duplicates slots and protects a published scenario from deletion", async () => {
    const src = await plan.createSchedule("Src", "test");
    await plan.replaceSlots(src.id, [
      { weekday: 1, start_min: 495, duration_min: 50, coach_name: "Maty", class_name: "Pilates Reformer (Foundation)", coach_wix_id: null, class_wix_id: null },
    ]);
    await post("/admin/coaching/duplicate", { source_id: src.id, name: "Copie" });
    const dup = (await pool.query(`select id from class_plan_schedules where name='Copie'`)).rows[0];
    expect(await count(`select count(*) from class_plan_slots where schedule_id=$1`, [dup.id])).toBe(1);

    await plan.publishSchedule(src.id);
    await post(`/admin/coaching/${src.id}/delete`, {});
    expect(await plan.getSchedule(src.id)).not.toBeNull();
  });

  it("keeps exactly one published across repeated publishes", async () => {
    const a = await plan.createSchedule("A", "test");
    const b = await plan.createSchedule("B", "test");
    const published = () => count(`select count(*) from class_plan_schedules where status='published'`);
    await post(`/admin/coaching/${a.id}/publish`, {});
    expect(await published()).toBe(1);
    await post(`/admin/coaching/${b.id}/publish`, {});
    expect(await published()).toBe(1);
    expect((await plan.getSchedule(b.id))!.status).toBe("published");
  });
});

describe("Wix import", () => {
  function rawEvent(over: Record<string, any> = {}): any {
    return {
      id: "ev-" + Math.random().toString(36).slice(2),
      type: "CLASS",
      status: "CONFIRMED",
      scheduleName: "Pilates Reformer (Sculpt)",
      title: "Pilates Reformer (Sculpt)",
      externalScheduleId: "svc_1",
      adjustedStart: { localDate: "2026-08-17T09:15:00" },
      adjustedEnd: { localDate: "2026-08-17T10:05:00" },
      totalCapacity: 7,
      remainingCapacity: 3,
      resources: [{ id: "r-yass", name: "Yass" }],
      ...over,
    };
  }

  it("imports only Reformer/Mat CONFIRMED classes into a new draft", async () => {
    mock.wix.staffResources = [{ id: "r-yass", name: "Yass" }];
    mock.wix.calendarEvents = [
      rawEvent(),
      rawEvent({ status: "CANCELLED", adjustedStart: { localDate: "2026-08-18T09:15:00" }, adjustedEnd: { localDate: "2026-08-18T10:05:00" } }),
      rawEvent({ scheduleName: "Aquabike", title: "Aquabike", externalScheduleId: "svc_aqua", adjustedStart: { localDate: "2026-08-18T11:15:00" }, adjustedEnd: { localDate: "2026-08-18T12:05:00" } }),
    ];

    const res = await post("/admin/coaching/import-wix", {});
    expect(res.headers.location).toContain("done=imported");
    const sched = (await pool.query(`select * from class_plan_schedules order by created_at desc limit 1`)).rows[0];
    expect(sched.status).toBe("draft");
    const slots = await plan.getSlots(sched.id);
    expect(slots).toHaveLength(1); // cancelled + aquabike dropped
    expect(slots[0]).toMatchObject({ weekday: 0, start_min: 555, coach_name: "Yass", class_name: "Pilates Reformer (Sculpt)", class_wix_id: "svc_1", coach_wix_id: "r-yass" });
  });

  it("creates no scenario when nothing eligible is found", async () => {
    mock.wix.calendarEvents = [rawEvent({ scheduleName: "Aquabike", title: "Aquabike", externalScheduleId: "svc_aqua" })];
    const res = await post("/admin/coaching/import-wix", {});
    expect(res.headers.location).toContain("err=");
    expect(await count(`select count(*) from class_plan_schedules`)).toBe(0);
  });

  it("degrades gracefully when Wix calendar is down", async () => {
    mock.wix.failCalendar = true;
    const res = await post("/admin/coaching/import-wix", {});
    expect(res.headers.location).toContain("err=");
    expect(await count(`select count(*) from class_plan_schedules`)).toBe(0);
  });
});

describe("render safety", () => {
  it("keeps the board script safe with hostile free-text names", async () => {
    const s = await plan.createSchedule("Test", "test");
    await plan.replaceSlots(s.id, [
      { weekday: 0, start_min: 555, duration_min: 50, coach_name: `</script><script>alert(1)`, class_name: `Reformer "\\ é`, coach_wix_id: null, class_wix_id: null },
    ]);
    const view = await get(`/admin/coaching?s=${s.id}`);
    expect(view.statusCode).toBe(200);
    // The raw closing tag must NOT appear verbatim in the document (it's escaped).
    expect(view.body).not.toContain("</script><script>alert(1)");
    expect(view.body).toContain("\\u003c/script");
  });

  it("still renders the page when Wix suggestions are unavailable", async () => {
    mock.wix.failCalendar = true; // and services/resources return empty by default
    const s = await plan.createSchedule("Test", "test");
    const view = await get(`/admin/coaching?s=${s.id}`);
    expect(view.statusCode).toBe(200);
    expect(view.body).toContain("Planning des cours");
  });
});
