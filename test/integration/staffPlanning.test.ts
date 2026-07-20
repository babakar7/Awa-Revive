import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { pool, migrate } from "../../src/db/index.js";
import * as staffPlan from "../../src/domain/staffPlanningRepo.js";
import { makeFetchMock, type FetchMock, truncateAll, settle } from "./helpers.js";

/**
 * Staff planning end-to-end: the one-shot boot seed, the grid save/validation,
 * the exactly-one-published invariant, and the per-employee WhatsApp send.
 * Each test seeds its own data — truncateAll wipes the boot seed and migrate()
 * only runs in beforeAll (except the seed test, which re-runs it explicitly).
 */

const AUTH = `Basic ${Buffer.from("revive:revive").toString("base64")}`;

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

async function mkStaff(name: string, role: string, phone = ""): Promise<string> {
  const r = await pool.query(
    `insert into staff_contacts (name, phone, role) values ($1,$2,$3) returning id`,
    [name, phone, role],
  );
  return r.rows[0].id;
}

const post = (url: string, fields: Record<string, string>) =>
  app.inject({
    method: "POST",
    url,
    headers: { authorization: AUTH, "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams(fields).toString(),
  });

describe("boot seed (one-shot, idempotent)", () => {
  it("seeds 7 employees + a published 'Planning actuel' with 35 shifts, and never resurrects", async () => {
    // truncateAll (beforeEach) wiped app_state → the seed runs on this migrate.
    await migrate();
    expect(Number((await pool.query(`select count(*) from staff_contacts where phone=''`)).rows[0].count)).toBe(7);
    const sched = (await pool.query(`select * from staff_schedules where status='published'`)).rows;
    expect(sched.length).toBe(1);
    expect(sched[0].name).toBe("Planning actuel");
    expect(Number((await pool.query(`select count(*) from staff_shifts`)).rows[0].count)).toBe(35);

    await migrate(); // idempotent
    expect(Number((await pool.query(`select count(*) from staff_shifts`)).rows[0].count)).toBe(35);

    await pool.query(`delete from staff_shifts where id = (select id from staff_shifts limit 1)`);
    await migrate(); // sentinel set → does NOT resurrect
    expect(Number((await pool.query(`select count(*) from staff_shifts`)).rows[0].count)).toBe(34);
  });
});

describe("grid create / save / validate", () => {
  it("creates a schedule, saves a grid, rejects an invalid one", async () => {
    const s1 = await mkStaff("Awa", "accueil");
    const created = await post("/admin/staff", { name: "Semaine type" });
    expect(created.statusCode).toBe(303);
    const id = (await pool.query(`select id from staff_schedules limit 1`)).rows[0].id;

    const view = await app.inject({ method: "GET", url: `/admin/staff?s=${id}`, headers: { authorization: AUTH } });
    expect(view.statusCode).toBe(200);
    expect(view.body).toContain("Awa");

    const grid = JSON.stringify({ shifts: [{ staff_id: s1, weekday: 0, start_min: 555, end_min: 1175 }] });
    const saved = await post(`/admin/staff/${id}/grid`, { grid });
    expect(saved.headers.location).toContain("done=saved");
    expect(Number((await pool.query(`select count(*) from staff_shifts where schedule_id=$1`, [id])).rows[0].count)).toBe(1);

    const badGrid = JSON.stringify({ shifts: [{ staff_id: s1, weekday: 0, start_min: 600, end_min: 600 }] });
    const bad = await post(`/admin/staff/${id}/grid`, { grid: badGrid });
    expect(bad.headers.location).toContain("err=");
    // previous grid intact (1 shift), not wiped by the rejected save
    expect(Number((await pool.query(`select count(*) from staff_shifts where schedule_id=$1`, [id])).rows[0].count)).toBe(1);
  });
});

describe("exactly one published", () => {
  it("stays at one published across repeated publishes", async () => {
    const a = await staffPlan.createSchedule("A", "test");
    const b = await staffPlan.createSchedule("B", "test");
    const published = async () =>
      Number((await pool.query(`select count(*) from staff_schedules where status='published'`)).rows[0].count);

    await post(`/admin/staff/${a.id}/publish`, {});
    expect(await published()).toBe(1);
    await post(`/admin/staff/${b.id}/publish`, {});
    expect(await published()).toBe(1);
    await post(`/admin/staff/${a.id}/publish`, {});
    expect(await published()).toBe(1);
    expect((await staffPlan.getSchedule(a.id))!.status).toBe("published");
  });
});

describe("duplicate / delete / print", () => {
  it("duplicates shifts, protects a published from deletion, prints", async () => {
    const s1 = await mkStaff("Awa", "bar");
    const src = await staffPlan.createSchedule("Src", "test");
    await staffPlan.replaceShifts(src.id, [{ staff_id: s1, weekday: 0, start_min: 555, end_min: 1175 }]);

    await post("/admin/staff/duplicate", { source_id: src.id, name: "Copie" });
    const dup = (await pool.query(`select id from staff_schedules where name='Copie'`)).rows[0];
    expect(Number((await pool.query(`select count(*) from staff_shifts where schedule_id=$1`, [dup.id])).rows[0].count)).toBe(1);

    await staffPlan.publishSchedule(src.id);
    await post(`/admin/staff/${src.id}/delete`, {}); // published → refused
    expect(await staffPlan.getSchedule(src.id)).not.toBeNull();

    const print = await app.inject({ method: "GET", url: `/admin/staff/${src.id}/print`, headers: { authorization: AUTH } });
    expect(print.statusCode).toBe(200);
    expect(print.body).toContain("Awa");
    expect(print.body).toContain("9h20"); // one Monday shift 9h15–19h35 = 620−60 break = 9h20
  });
});

describe("send to employees", () => {
  it("sends one employee her planning (text in test env) and logs it", async () => {
    const s1 = await mkStaff("Fatou", "entretien", "221771112233");
    const sched = await staffPlan.createSchedule("S", "test");
    await staffPlan.replaceShifts(sched.id, [{ staff_id: s1, weekday: 0, start_min: 480, end_min: 1025 }]);

    const res = await post(`/admin/staff/${sched.id}/send/${s1}`, {});
    expect(res.headers.location).toContain("done=sent");
    await settle();
    expect(mock.waTextsTo("221771112233").join("\n")).toContain("Planning");
    const log = (await pool.query(`select count(*) from notification_log where source='staff_planning' and status='sent'`)).rows[0];
    expect(Number(log.count)).toBe(1);
  });

  it("refuses to send when the employee has no phone", async () => {
    const s1 = await mkStaff("Meryl", "accueil"); // no phone
    const sched = await staffPlan.createSchedule("S", "test");
    await staffPlan.replaceShifts(sched.id, [{ staff_id: s1, weekday: 0, start_min: 555, end_min: 1175 }]);

    const res = await post(`/admin/staff/${sched.id}/send/${s1}`, {});
    expect(res.headers.location).toContain("err=no-phone");
    await settle();
    expect(mock.waTextsTo("").length + mock.waCalls().length).toBe(0);
  });

  it("send-all counts sent / no-phone / no-shift", async () => {
    const withPhone = await mkStaff("Fatou", "entretien", "221771112233");
    await mkStaff("Meryl", "accueil"); // no phone
    const noShift = await mkStaff("Ama", "bar", "221774445566"); // phone but no shift
    void noShift;
    const sched = await staffPlan.createSchedule("S", "test");
    await staffPlan.replaceShifts(sched.id, [{ staff_id: withPhone, weekday: 0, start_min: 480, end_min: 1025 }]);

    const res = await post(`/admin/staff/${sched.id}/send-all`, {});
    expect(res.headers.location).toContain("done=sent-all:1:1:1");
    await settle();
  });
});

describe("team management on the planning page", () => {
  it("adds an employee (normalized phone), sets/clears her number, then removes her", async () => {
    // Add — local number normalized to wa_id.
    const add = await post("/admin/staff/contact", { name: "Nafi", role: "bar", phone: "77 555 44 33" });
    expect(add.headers.location).toContain("done=contact-added");
    const staff = await staffPlan.listPlanningStaff();
    const nafi = staff.find((s) => s.name === "Nafi")!;
    expect(nafi.role).toBe("bar");
    expect(nafi.phone).toBe("221775554433");

    // Now she can receive a schedule (has a phone).
    const sched = await staffPlan.createSchedule("S", "test");
    await staffPlan.replaceShifts(sched.id, [{ staff_id: nafi.id, weekday: 0, start_min: 555, end_min: 1175 }]);
    const send = await post(`/admin/staff/${sched.id}/send/${nafi.id}`, {});
    expect(send.headers.location).toContain("done=sent");

    // Edit the number, then clear it.
    await post(`/admin/staff/contact/${nafi.id}/phone`, { phone: "781112233" });
    expect((await staffPlan.listPlanningStaff()).find((s) => s.id === nafi.id)!.phone).toBe("221781112233");
    await post(`/admin/staff/contact/${nafi.id}/phone`, { phone: "" });
    expect((await staffPlan.listPlanningStaff()).find((s) => s.id === nafi.id)!.phone).toBe("");

    // Remove — cascades her shifts.
    const del = await post(`/admin/staff/contact/${nafi.id}/delete`, {});
    expect(del.headers.location).toContain("done=contact-removed");
    expect((await staffPlan.listPlanningStaff()).some((s) => s.id === nafi.id)).toBe(false);
    expect(Number((await pool.query(`select count(*) from staff_shifts where staff_id=$1`, [nafi.id])).rows[0].count)).toBe(0);
  });

  it("rejects an invalid phone on add", async () => {
    const add = await post("/admin/staff/contact", { name: "X", role: "accueil", phone: "12" });
    expect(add.headers.location).toContain("err=");
    expect((await staffPlan.listPlanningStaff()).some((s) => s.name === "X")).toBe(false);
  });
});
