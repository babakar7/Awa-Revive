import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { migrate, pool } from "../../src/db/index.js";
import { makeFetchMock, truncateAll, type FetchMock } from "./helpers.js";

const FORM = "application/x-www-form-urlencoded";
const BASE = "/admin/paiements-coachs";

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
  await migrate();
  mock.reset();
});

async function login(username: string, password: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/admin/login",
    headers: { "content-type": FORM },
    payload: new URLSearchParams({
      username,
      password,
      next: BASE,
    }).toString(),
  });
  expect(response.statusCode).toBe(303);
  const setCookie = String(response.headers["set-cookie"]);
  expect(setCookie).toContain("Path=/admin");
  return setCookie.split(";")[0];
}

const loginAsOwner = () => login("owner", "test-owner-password");
const loginAsTeam = () => login("revive", "revive@5000");

function post(url: string, fields: Record<string, string>, cookie: string) {
  return app.inject({
    method: "POST",
    url,
    headers: { cookie, "content-type": FORM },
    payload: new URLSearchParams(fields).toString(),
  });
}

async function configureYass(): Promise<string> {
  const profile = (await pool.query(`select * from coach_payment_profiles where slug='yass'`)).rows[0];
  await pool.query(
    `update coach_payment_profiles set wix_resource_id='coach-yass', email='yass@test.local' where id=$1`,
    [profile.id],
  );
  mock.wix.staffResources = [{ id: "coach-yass", name: "Yass", email: "yass@test.local", tags: ["staff"] }];
  return profile.id;
}

function calendarEvent(id: string, start: string, overrides: Record<string, unknown> = {}) {
  const end = new Date(new Date(`${start}Z`).getTime() + 50 * 60_000).toISOString().slice(0, 19);
  return {
    id,
    externalScheduleId: "svc_1",
    scheduleName: "Pilates Reformer",
    title: "Pilates Reformer",
    type: "CLASS",
    status: "CONFIRMED",
    adjustedStart: { localDate: start, timeZone: "Africa/Dakar" },
    adjustedEnd: { localDate: end, timeZone: "Africa/Dakar" },
    resources: [{ id: "coach-yass", name: "Yass", type: "staff" }],
    ...overrides,
  };
}

async function createJuneDraft(cookie: string, profileId: string): Promise<string> {
  const response = await post(`${BASE}/etats`, { profile_id: profileId, month: "2026-06" }, cookie);
  expect(response.statusCode).toBe(303);
  const match = String(response.headers.location).match(/\/etats\/([0-9a-f-]+)/i);
  expect(match).not.toBeNull();
  return match![1];
}

describe("owner payment authorization", () => {
  it("blocks the team account while one owner login grants direct access", async () => {
    const teamCookie = await loginAsTeam();
    const page = await app.inject({ method: "GET", url: BASE, headers: { cookie: teamCookie, accept: "text/html" } });
    expect(page.statusCode).toBe(403);
    expect(page.body).toContain("Accès propriétaire requis");
    expect(page.body).toContain("Changer de compte");

    const directPost = await app.inject({ method: "POST", url: `${BASE}/etats`, headers: { cookie: teamCookie } });
    expect(directPost.statusCode).toBe(403);

    const cookie = await loginAsOwner();
    const open = await app.inject({ method: "GET", url: BASE, headers: { cookie } });
    expect(open.statusCode).toBe(200);
    expect(open.body).toContain("Yass");
    expect(open.body).toContain("Leslie");
  });
});

describe("monthly statement lifecycle", () => {
  it("snapshots Wix, edits, validates, emails a PDF, marks paid and creates a correction", async () => {
    const cookie = await loginAsOwner();
    const profileId = await configureYass();
    mock.wix.calendarEvents = [
      calendarEvent("event-a", "2026-06-03T10:00:00"),
      calendarEvent("event-b", "2026-06-10T10:00:00"),
      calendarEvent("event-a", "2026-06-03T10:00:00"), // duplicate from Wix
      calendarEvent("cancelled", "2026-06-11T10:00:00", { status: "CANCELLED" }),
      calendarEvent("yoga", "2026-06-12T10:00:00", { externalScheduleId: "yoga-service", scheduleName: "Yoga", title: "Yoga" }),
      calendarEvent("other-coach", "2026-06-13T10:00:00", { resources: [{ id: "coach-leslie", name: "Leslie" }] }),
    ];

    const id = await createJuneDraft(cookie, profileId);
    let statement = (await pool.query(`select * from coach_payment_statements where id=$1`, [id])).rows[0];
    expect(statement.sync_status).toBe("ok");
    expect(statement.course_count).toBe(2);
    expect(statement.total_xof).toBe(19_048);

    const wixCourse = (await pool.query(`select id from coach_payment_courses where statement_id=$1 order by starts_at limit 1`, [id])).rows[0];
    await post(`${BASE}/etats/${id}/cours/${wixCourse.id}/toggle`, {}, cookie);
    await post(`${BASE}/etats/${id}/cours-manuel`, {
      starts_at: "2026-06-20T09:00",
      service_name: "Reformer remplacement",
      reason: "Cours donné mais absent du calendrier",
    }, cookie);
    const bonus = await post(`${BASE}/etats/${id}/ajustements`, {
      kind: "bonus",
      amount_xof: "1000",
      reason: "Remplacement tardif",
    }, cookie);
    expect(bonus.headers.location).toContain("done=adjustment");
    const negative = await post(`${BASE}/etats/${id}/ajustements`, {
      kind: "deduction",
      amount_xof: "999999",
      reason: "Erreur",
    }, cookie);
    expect(negative.headers.location).toContain("err=");
    expect(Number((await pool.query(`select count(*) from coach_payment_adjustments where statement_id=$1`, [id])).rows[0].count)).toBe(1);

    statement = (await pool.query(`select * from coach_payment_statements where id=$1`, [id])).rows[0];
    expect(statement.course_count).toBe(2); // one excluded + one manual replaces it
    expect(statement.total_xof).toBe(20_048);

    const validated = await post(`${BASE}/etats/${id}/valider`, {}, cookie);
    expect(validated.headers.location).toContain("done=validated");
    const immutableAttempt = await post(`${BASE}/etats/${id}/cours/${wixCourse.id}/toggle`, {}, cookie);
    expect(immutableAttempt.headers.location).toContain("err=");

    const pdfBefore = await app.inject({ method: "GET", url: `${BASE}/etats/${id}/pdf`, headers: { cookie } });
    expect(pdfBefore.statusCode).toBe(200);
    expect(pdfBefore.rawPayload.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    const sent = await post(`${BASE}/etats/${id}/envoyer`, { recipient_email: "new-yass@test.local" }, cookie);
    expect(sent.headers.location).toContain("done=sent");
    expect(mock.emailCalls()).toHaveLength(1);
    const attachment = mock.emailCalls()[0].body.attachment[0];
    expect(attachment.name).toMatch(/Etat-paiement-Yass-2026-06-v1\.pdf/);
    expect(Buffer.from(attachment.content, "base64").subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect((await pool.query(`select email from coach_payment_profiles where id=$1`, [profileId])).rows[0].email).toBe("new-yass@test.local");

    const paid = await post(`${BASE}/etats/${id}/payer`, { paid_on: "2026-07-05" }, cookie);
    expect(paid.headers.location).toContain("done=paid");
    const pdfAfter = await app.inject({ method: "GET", url: `${BASE}/etats/${id}/pdf`, headers: { cookie } });
    expect(pdfAfter.rawPayload.equals(pdfBefore.rawPayload)).toBe(true);

    const correction = await post(`${BASE}/etats/${id}/correction`, {}, cookie);
    const correctionId = String(correction.headers.location).match(/\/etats\/([0-9a-f-]+)/i)?.[1];
    expect(correctionId).toBeTruthy();
    const versions = (await pool.query(`select version, status, is_current, revises_statement_id from coach_payment_statements where coach_profile_id=$1 order by version`, [profileId])).rows;
    expect(versions).toEqual([
      expect.objectContaining({ version: 1, status: "paid", is_current: false }),
      expect.objectContaining({ version: 2, status: "draft", is_current: true, revises_statement_id: id }),
    ]);

    mock.failEmail = true;
    const failedResend = await post(`${BASE}/etats/${id}/envoyer`, { recipient_email: "new-yass@test.local" }, cookie);
    expect(failedResend.headers.location).toContain("err=");
    const logs = (await pool.query(`select status from coach_payment_send_log where statement_id=$1 order by attempted_at`, [id])).rows.map((r) => r.status);
    expect(logs).toEqual(["success", "error"]);
  });

  it("blocks validation on an open month and after a Wix outage", async () => {
    const cookie = await loginAsOwner();
    const profileId = await configureYass();
    mock.wix.calendarEvents = [calendarEvent("july", "2026-07-05T10:00:00")];
    const julyCreate = await post(`${BASE}/etats`, { profile_id: profileId, month: "2026-07" }, cookie);
    const julyId = String(julyCreate.headers.location).match(/\/etats\/([0-9a-f-]+)/i)![1];
    const early = await post(`${BASE}/etats/${julyId}/valider`, {}, cookie);
    expect(decodeURIComponent(String(early.headers.location))).toMatch(/fin du mois civil/i);

    // A separate coach/month whose initial historical sync fails must never be
    // interpreted as a valid zero-course state.
    const leslie = (await pool.query(`select id from coach_payment_profiles where slug='leslie'`)).rows[0];
    await pool.query(`update coach_payment_profiles set wix_resource_id='coach-leslie' where id=$1`, [leslie.id]);
    mock.wix.failCalendar = true;
    const failedCreate = await post(`${BASE}/etats`, { profile_id: leslie.id, month: "2026-06" }, cookie);
    const failedId = String(failedCreate.headers.location).match(/\/etats\/([0-9a-f-]+)/i)![1];
    const failed = (await pool.query(`select * from coach_payment_statements where id=$1`, [failedId])).rows[0];
    expect(failed.sync_status).toBe("failed");
    expect(failed.course_count).toBe(0);
    const blocked = await post(`${BASE}/etats/${failedId}/valider`, {}, cookie);
    expect(decodeURIComponent(String(blocked.headers.location))).toMatch(/Wix indisponible/i);
  });
});
