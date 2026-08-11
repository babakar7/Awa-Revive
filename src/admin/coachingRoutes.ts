import type { FastifyInstance } from "fastify";
import * as plan from "../domain/classPlanningRepo.js";
import {
  MAX_SLOTS,
  isReformerOrMat,
  nextFullWeekBounds,
  slotsFromCalendarEvents,
  validateClassGridPayload,
} from "../domain/classPlanningRules.js";
import { listProfiles } from "../domain/coachPaymentRepo.js";
import { listServices, listStaffResources, queryCalendarEventsV3 } from "../lib/wix.js";
import { coachingBanner, renderCoachingPlanning, renderCoachingPrint } from "./coachingPage.js";
import { layout } from "./layout.js";

/**
 * /admin/coaching — the class planning sandbox. Team-accessible (no owner hook),
 * like the staff planning. Wix is a suggestion source only: if it's down, the
 * page still works (free-text coach/class), and local coach profiles keep feeding
 * the datalist. The Wix import funnels through the SAME validation as manual saves.
 */

/** Coach + class name suggestions, each source guarded on its own so one outage
 *  never blanks the other. Local profiles (DB) always contribute the coaches. */
async function suggestions(): Promise<{ coachNames: string[]; classNames: string[] }> {
  const coachSet = new Map<string, string>(); // lowercase → display
  const classSet = new Map<string, string>();
  const addCoach = (n: string) => {
    const t = n.trim();
    if (t) coachSet.set(t.toLowerCase(), t);
  };
  const addClass = (n: string) => {
    const t = n.trim();
    if (t && isReformerOrMat(t)) classSet.set(t.toLowerCase(), t);
  };

  const [profiles, staff, services] = await Promise.all([
    listProfiles().catch(() => []),
    listStaffResources().catch(() => []),
    listServices().catch(() => []),
  ]);
  for (const p of profiles) addCoach(p.display_name);
  for (const s of staff) addCoach(s.name);
  for (const s of services) if (s.type === "CLASS" || s.type === "COURSE") addClass(s.name);

  return {
    coachNames: [...coachSet.values()].sort((a, b) => a.localeCompare(b, "fr")),
    classNames: [...classSet.values()].sort((a, b) => a.localeCompare(b, "fr")),
  };
}

export function registerCoachingRoutes(admin: FastifyInstance): void {
  async function view(scheduleId: string | undefined, banner: string, showNew: boolean, reply: any) {
    const schedules = await plan.listSchedules();
    const current =
      (scheduleId ? await plan.getSchedule(scheduleId) : null) ??
      schedules.find((s) => s.status === "published") ??
      schedules[0] ??
      null;
    const [slots, sugg] = await Promise.all([
      current ? plan.getSlots(current.id) : Promise.resolve([]),
      suggestions(),
    ]);
    const body = renderCoachingPlanning({
      schedules,
      current,
      slots,
      coachNames: sugg.coachNames,
      classNames: sugg.classNames,
      banner,
      showNewForm: showNew,
    });
    reply
      .type("text/html")
      .send(await layout("Planning des cours", "/admin/coaching", body, {
        subtitle: "Scénarios de planning coaching (bac à sable)",
        contentWidth: "full",
      }));
  }

  admin.get("/coaching", async (req, reply) => {
    const q = req.query as any;
    return view(q?.s, coachingBanner(q?.done, q?.err), q?.new === "1", reply);
  });

  admin.post("/coaching", async (req, reply) => {
    const name = String((req.body as any)?.name ?? "").trim();
    if (!name) return reply.redirect("/admin/coaching?err=nom obligatoire", 303);
    const s = await plan.createSchedule(name, req.adminUser ?? null);
    return reply.redirect(`/admin/coaching?s=${s.id}&done=created`, 303);
  });

  admin.post("/coaching/duplicate", async (req, reply) => {
    const b = req.body as any;
    const name = String(b?.name ?? "").trim() || "Copie";
    const dup = await plan.duplicateSchedule(String(b?.source_id ?? ""), name, req.adminUser ?? null);
    if (!dup) return reply.redirect("/admin/coaching?err=scénario introuvable", 303);
    return reply.redirect(`/admin/coaching?s=${dup.id}&done=duplicated`, 303);
  });

  admin.post("/coaching/:id/rename", async (req, reply) => {
    const { id } = req.params as { id: string };
    const name = String((req.body as any)?.name ?? "").trim();
    if (name) await plan.renameSchedule(id, name);
    return reply.redirect(`/admin/coaching?s=${id}&done=renamed`, 303);
  });

  admin.post("/coaching/:id/publish", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = await plan.publishSchedule(id);
    req.log.info({ schedule: id, by: req.adminUser }, "Class plan published");
    return reply.redirect(ok ? `/admin/coaching?s=${id}&done=published` : "/admin/coaching?err=scénario introuvable", 303);
  });

  admin.post("/coaching/:id/delete", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = await plan.deleteSchedule(id);
    return reply.redirect(ok ? "/admin/coaching?done=deleted" : "/admin/coaching?err=seul un brouillon peut être supprimé", 303);
  });

  admin.post("/coaching/:id/grid", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as any;
    // Autosave sends ajax=1 and wants a light JSON verdict (no full-page reload);
    // the manual button (no-JS fallback) keeps the classic POST-redirect-GET.
    const ajax = String(body?.ajax ?? "") === "1";
    const schedule = await plan.getSchedule(id);
    if (!schedule) {
      return ajax
        ? reply.send({ ok: false, error: "scénario introuvable" })
        : reply.redirect("/admin/coaching?err=scénario introuvable", 303);
    }
    const parsed = validateClassGridPayload(String(body?.grid ?? ""));
    if ("error" in parsed) {
      return ajax
        ? reply.send({ ok: false, error: parsed.error })
        : reply.redirect(`/admin/coaching?s=${id}&err=${encodeURIComponent(parsed.error)}`, 303);
    }
    await plan.replaceSlots(id, parsed.slots);
    req.log.info({ schedule: id, slots: parsed.slots.length, by: req.adminUser }, "Class grid saved");
    return ajax
      ? reply.send({ ok: true, count: parsed.slots.length })
      : reply.redirect(`/admin/coaching?s=${id}&done=saved`, 303);
  });

  admin.get("/coaching/:id/print", async (req, reply) => {
    const { id } = req.params as { id: string };
    const schedule = await plan.getSchedule(id);
    if (!schedule) return reply.code(404).type("text/plain").send("Scénario introuvable");
    const slots = await plan.getSlots(id);
    const coach = String((req.query as any)?.coach ?? "").trim() || null;
    reply.type("text/html").send(renderCoachingPrint(schedule, slots, coach));
  });

  admin.post("/coaching/import-wix", async (req, reply) => {
    const { fromLocalDate, toLocalDate, label } = nextFullWeekBounds(new Date());
    let events;
    try {
      events = await queryCalendarEventsV3(fromLocalDate, toLocalDate);
    } catch (e) {
      req.log.warn({ err: e }, "Class plan Wix import failed");
      return reply.redirect(`/admin/coaching?err=${encodeURIComponent("Wix injoignable — réessayez plus tard.")}`, 303);
    }
    // Reformer/Mat CONFIRMED classes only. Eligible if the service id is a known
    // Reformer/Mat service OR the name matches (either signal keeps it).
    const services = await listServices().catch(() => []);
    const reformerServiceIds = new Set(
      services.filter((s) => isReformerOrMat(s.name)).map((s) => s.id),
    );
    const eligible = events.filter(
      (e) =>
        (e.type === "CLASS" || e.type === "COURSE") &&
        e.status === "CONFIRMED" &&
        ((e.serviceId && reformerServiceIds.has(e.serviceId)) || isReformerOrMat(e.serviceName || e.title)),
    );
    const staffIds = new Set((await listStaffResources().catch(() => [])).map((r) => r.id));
    const mapped = slotsFromCalendarEvents(eligible, staffIds).slice(0, MAX_SLOTS);
    if (mapped.length === 0) {
      return reply.redirect(`/admin/coaching?err=${encodeURIComponent(`Aucun cours Reformer/Mat trouvé pour la ${label}.`)}`, 303);
    }
    // Same server boundary as manual saves — import never bypasses validation.
    const parsed = validateClassGridPayload(JSON.stringify({ slots: mapped }));
    if ("error" in parsed) {
      req.log.warn({ err: parsed.error }, "Class plan import rejected by validation");
      return reply.redirect(`/admin/coaching?err=${encodeURIComponent(`Import invalide : ${parsed.error}`)}`, 303);
    }
    const s = await plan.createSchedule(`Import Wix — ${label}`, req.adminUser ?? null);
    await plan.replaceSlots(s.id, parsed.slots);
    req.log.info({ schedule: s.id, slots: parsed.slots.length, by: req.adminUser }, "Class plan imported from Wix");
    return reply.redirect(`/admin/coaching?s=${s.id}&done=imported`, 303);
  });
}
