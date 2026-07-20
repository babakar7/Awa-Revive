import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import * as payments from "../domain/coachPaymentRepo.js";
import {
  calendarLocalBounds,
  currentMonthKey,
  monthIsClosed,
  parseMonthKey,
  reformerServices,
  selectEligibleReformerEvents,
  storedMonthKey,
  tariffFromProfile,
  validateManualCourseDate,
  type CoachTariff,
} from "../domain/coachPaymentRules.js";
import { coachPaymentPdfFilename, renderCoachPaymentPdf } from "../lib/coachPaymentPdf.js";
import { emailNotificationsEnabled, sendEmail } from "../lib/notify.js";
import { listServices, listStaffResources, queryCalendarEventsV3 } from "../lib/wix.js";
import {
  clearOwnerPaymentsCookieHeader,
  mintOwnerPaymentsToken,
  ownerAttemptAllowed,
  ownerPaymentsAuthHook,
  ownerPaymentsConfigured,
  ownerPaymentsCookieHeader,
  recordOwnerAttempt,
  safeOwnerNext,
  verifyOwnerPaymentsPassword,
} from "./coachPaymentsAuth.js";
import {
  coachPaymentBanner,
  renderCoachPaymentSettings,
  renderCoachPaymentsDashboard,
  renderCoachPaymentStatement,
  renderOwnerUnlockPage,
} from "./coachPaymentsPage.js";
import { layout } from "./layout.js";

const BASE = "/admin/paiements-coachs";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statementUrl(id: string, kind: "done" | "err", value: string): string {
  return `${BASE}/etats/${id}?${kind}=${encodeURIComponent(value)}`;
}

function parsePositiveInt(raw: unknown, label: string, allowZero = false): number {
  const text = String(raw ?? "").trim();
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new payments.CoachPaymentError(`${label} invalide`);
  }
  return value;
}

function parseTariff(body: Record<string, unknown>): CoachTariff {
  if (body.formula_type === "monthly_ratio") {
    return {
      type: "monthly_ratio",
      baseAmountXof: parsePositiveInt(body.base_amount_xof, "Montant de référence", true),
      baseSessionCount: parsePositiveInt(body.base_session_count, "Nombre de cours de référence"),
    };
  }
  if (body.formula_type === "per_session") {
    return {
      type: "per_session",
      perSessionXof: parsePositiveInt(body.per_session_xof, "Montant par cours", true),
    };
  }
  throw new payments.CoachPaymentError("Formule tarifaire invalide");
}

function validEmail(raw: unknown): string | null {
  const email = String(raw ?? "").trim().toLowerCase();
  if (!email) return null;
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new payments.CoachPaymentError("Adresse e-mail invalide");
  }
  return email;
}

async function fetchEligibleCourses(
  profile: payments.CoachPaymentProfile,
  month: string,
  now = new Date(),
) {
  if (!profile.wix_resource_id) throw new payments.CoachPaymentError("Aucune ressource Wix associée à cette coach");
  const bounds = calendarLocalBounds(month);
  const [services, events] = await Promise.all([
    listServices(),
    queryCalendarEventsV3(bounds.fromLocalDate, bounds.toLocalDate),
  ]);
  if (reformerServices(services).length === 0) {
    throw new payments.CoachPaymentError("Aucun service Reformer identifiable dans Wix");
  }
  return selectEligibleReformerEvents({
    events,
    services,
    coachResourceId: profile.wix_resource_id,
    month,
    now,
  });
}

/** Registers an encapsulated owner-only section under /admin/paiements-coachs. */
export function registerCoachPaymentRoutes(admin: FastifyInstance): void {
  admin.register(
    async (section) => {
      section.addHook("onRequest", ownerPaymentsAuthHook);

      section.get("/unlock", async (req, reply) => {
        const query = req.query as { next?: string; err?: string };
        const next = safeOwnerNext(query.next);
        reply.type("text/html").send(
          renderOwnerUnlockPage({
            next,
            error: query.err,
            configured: ownerPaymentsConfigured(),
          }),
        );
      });

      section.post("/unlock", async (req, reply) => {
        const body = (req.body ?? {}) as Record<string, string>;
        const next = safeOwnerNext(body.next);
        if (!ownerPaymentsConfigured()) {
          return reply
            .code(503)
            .type("text/html")
            .send(renderOwnerUnlockPage({ next, configured: false }));
        }
        if (!ownerAttemptAllowed(req)) {
          return reply
            .code(429)
            .type("text/html")
            .send(renderOwnerUnlockPage({
              next,
              configured: true,
              error: "Trop de tentatives. Réessaie dans 15 minutes.",
            }));
        }
        const ok = verifyOwnerPaymentsPassword(String(body.password ?? ""));
        recordOwnerAttempt(req, ok);
        if (!ok) {
          return reply
            .code(401)
            .type("text/html")
            .send(renderOwnerUnlockPage({
              next,
              configured: true,
              error: "Mot de passe incorrect.",
            }));
        }
        const token = mintOwnerPaymentsToken(req.adminUser ?? "?");
        return reply
          .header("Set-Cookie", ownerPaymentsCookieHeader(token))
          .redirect(`${next}${next.includes("?") ? "&" : "?"}done=unlocked`, 303);
      });

      section.post("/lock", async (_req, reply) =>
        reply
          .header("Set-Cookie", clearOwnerPaymentsCookieHeader())
          .redirect(`${BASE}/unlock`, 303),
      );

      section.get("/", async (req, reply) => {
        const query = req.query as { month?: string; done?: string; err?: string };
        const month = parseMonthKey(String(query.month ?? "")) ?? currentMonthKey();
        const [profiles, statements] = await Promise.all([
          payments.listProfiles(),
          payments.listCurrentStatements(month),
        ]);
        const body = renderCoachPaymentsDashboard({
          month,
          profiles,
          statements,
          banner: coachPaymentBanner(query.done, query.err),
        });
        reply.type("text/html").send(await layout("Paiements coachs", BASE, body, { subtitle: "États mensuels confidentiels", contentWidth: "wide" }));
      });

      section.get("/reglages", async (req, reply) => {
        const query = req.query as { done?: string; err?: string };
        const profiles = await payments.listProfiles();
        let resources: Awaited<ReturnType<typeof listStaffResources>> = [];
        let wixError: string | undefined;
        try {
          resources = await listStaffResources();
        } catch (error) {
          wixError = message(error);
        }
        const body = renderCoachPaymentSettings({
          profiles,
          resources,
          wixError,
          banner: coachPaymentBanner(query.done, query.err),
        });
        reply.type("text/html").send(await layout("Réglages paiements coachs", BASE, body, { contentWidth: "standard", breadcrumbs: [{ href: BASE, label: "Paiements coachs" }, { label: "Réglages" }] }));
      });

      section.post("/reglages/:profileId", async (req, reply) => {
        const { profileId } = req.params as { profileId: string };
        const body = (req.body ?? {}) as Record<string, string>;
        try {
          const displayName = String(body.display_name ?? "").trim();
          if (!displayName) throw new payments.CoachPaymentError("Nom de coach obligatoire");
          const wixResourceId = String(body.wix_resource_id ?? "").trim() || null;
          let email = validEmail(body.email);
          if (wixResourceId) {
            const resource = (await listStaffResources()).find((r) => r.id === wixResourceId);
            if (!resource) throw new payments.CoachPaymentError("Ressource coach Wix introuvable");
            email ??= resource.email;
          }
          const updated = await payments.updateProfile(profileId, {
            displayName,
            wixResourceId,
            email,
            tariff: parseTariff(body),
          });
          if (!updated) throw new payments.CoachPaymentError("Fiche coach introuvable");
          req.log.info({ profileId, by: req.adminUser }, "Coach payment profile updated");
          return reply.redirect(`${BASE}/reglages?done=profile`, 303);
        } catch (error) {
          return reply.redirect(`${BASE}/reglages?err=${encodeURIComponent(message(error))}`, 303);
        }
      });

      section.post("/etats", async (req, reply) => {
        const body = (req.body ?? {}) as Record<string, string>;
        const month = parseMonthKey(String(body.month ?? ""));
        if (!month) return reply.redirect(`${BASE}?err=${encodeURIComponent("Mois invalide")}`, 303);
        const profile = await payments.findProfile(String(body.profile_id ?? ""));
        if (!profile) return reply.redirect(`${BASE}?month=${month}&err=${encodeURIComponent("Fiche coach introuvable")}`, 303);
        const existing = await payments.findCurrentStatement(profile.id, month);
        if (existing) return reply.redirect(`${BASE}/etats/${existing.id}`, 303);

        let courses: Awaited<ReturnType<typeof fetchEligibleCourses>> = [];
        let syncStatus: "ok" | "failed" | "unlinked" = profile.wix_resource_id ? "ok" : "unlinked";
        let syncError: string | null = profile.wix_resource_id ? null : "Aucune ressource Wix associée à cette coach";
        if (profile.wix_resource_id) {
          try {
            courses = await fetchEligibleCourses(profile, month);
          } catch (error) {
            syncStatus = "failed";
            syncError = message(error);
          }
        }
        const statement = await payments.createDraft({
          profile,
          month,
          courses,
          syncStatus,
          syncError,
          createdBy: req.adminUser ?? null,
        });
        req.log.info({ statement: statement.id, month, by: req.adminUser, syncStatus }, "Coach payment draft created");
        return reply.redirect(
          statementUrl(statement.id, syncStatus === "ok" ? "done" : "err", syncStatus === "ok" ? "created" : syncError ?? "Synchronisation impossible"),
          303,
        );
      });

      section.get("/etats/:id", async (req, reply) => {
        const { id } = req.params as { id: string };
        const query = req.query as { done?: string; err?: string };
        const detail = await payments.getStatementDetail(id);
        if (!detail) return reply.code(404).type("text/plain").send("État de paiement introuvable");
        const body = renderCoachPaymentStatement({
          detail,
          banner: coachPaymentBanner(query.done, query.err),
          emailEnabled: emailNotificationsEnabled(),
        });
        reply.type("text/html").send(await layout(`Paiement ${detail.statement.coach_name_snapshot}`, BASE, body, { contentWidth: "wide", breadcrumbs: [{ href: BASE, label: "Paiements coachs" }, { label: detail.statement.coach_name_snapshot }] }));
      });

      section.post("/etats/:id/synchroniser", async (req, reply) => {
        const { id } = req.params as { id: string };
        const detail = await payments.getStatementDetail(id);
        if (!detail) return reply.redirect(`${BASE}?err=état introuvable`, 303);
        if (detail.statement.status !== "draft") return reply.redirect(statementUrl(id, "err", "Un état validé est immuable"), 303);
        // A draft created while unlinked can be repaired from Settings, then
        // synchronized. The refreshed identity becomes immutable at validate.
        await payments.refreshDraftProfileSnapshot(id, detail.profile);
        const resourceId = detail.profile.wix_resource_id;
        if (!resourceId) {
          return reply.redirect(statementUrl(id, "err", "Aucune ressource Wix associée à cette coach"), 303);
        }
        const profileForSnapshot = { ...detail.profile, wix_resource_id: resourceId };
        try {
          const courses = await fetchEligibleCourses(profileForSnapshot, storedMonthKey(detail.statement.month));
          await payments.replaceWixSnapshot(id, courses);
          req.log.info({ statement: id, courses: courses.length, by: req.adminUser }, "Coach payment Wix snapshot synced");
          return reply.redirect(statementUrl(id, "done", "synced"), 303);
        } catch (error) {
          const detailError = message(error);
          await payments.recordSyncFailure(id, detailError);
          req.log.error({ err: error, statement: id }, "Coach payment Wix sync failed");
          return reply.redirect(statementUrl(id, "err", `Wix indisponible : ${detailError}`), 303);
        }
      });

      section.post("/etats/:id/cours/:courseId/toggle", async (req, reply) => {
        const { id, courseId } = req.params as { id: string; courseId: string };
        const ok = await payments.toggleCourse(id, courseId);
        return reply.redirect(statementUrl(id, ok ? "done" : "err", ok ? "toggled" : "Modification refusée"), 303);
      });

      section.post("/etats/:id/cours-manuel", async (req, reply) => {
        const { id } = req.params as { id: string };
        const body = (req.body ?? {}) as Record<string, string>;
        try {
          const detail = await payments.getStatementDetail(id);
          if (!detail) throw new payments.CoachPaymentError("État introuvable");
          const rawDate = String(body.starts_at ?? "").trim();
          const startsAt = new Date(`${rawDate}${/(?:Z|[+-]\d{2}:?\d{2})$/.test(rawDate) ? "" : "Z"}`);
          const dateError = validateManualCourseDate(storedMonthKey(detail.statement.month), startsAt);
          if (dateError) throw new payments.CoachPaymentError(dateError);
          const serviceName = String(body.service_name ?? "").trim();
          const reason = String(body.reason ?? "").trim();
          if (!serviceName || !reason) throw new payments.CoachPaymentError("Séance et motif sont obligatoires");
          await payments.addManualCourse({ statementId: id, serviceName, startsAt, reason });
          return reply.redirect(statementUrl(id, "done", "manual"), 303);
        } catch (error) {
          return reply.redirect(statementUrl(id, "err", message(error)), 303);
        }
      });

      section.post("/etats/:id/ajustements", async (req, reply) => {
        const { id } = req.params as { id: string };
        const body = (req.body ?? {}) as Record<string, string>;
        try {
          const kind = body.kind === "deduction" ? "deduction" : body.kind === "bonus" ? "bonus" : null;
          if (!kind) throw new payments.CoachPaymentError("Type d'ajustement invalide");
          const reason = String(body.reason ?? "").trim();
          if (!reason) throw new payments.CoachPaymentError("Le motif est obligatoire");
          await payments.addAdjustment({
            statementId: id,
            kind,
            amountXof: parsePositiveInt(body.amount_xof, "Montant"),
            reason,
          });
          return reply.redirect(statementUrl(id, "done", "adjustment"), 303);
        } catch (error) {
          return reply.redirect(statementUrl(id, "err", message(error)), 303);
        }
      });

      section.post("/etats/:id/ajustements/:adjustmentId/supprimer", async (req, reply) => {
        const { id, adjustmentId } = req.params as { id: string; adjustmentId: string };
        const ok = await payments.removeAdjustment(id, adjustmentId);
        return reply.redirect(statementUrl(id, ok ? "done" : "err", ok ? "removed" : "Modification refusée"), 303);
      });

      section.post("/etats/:id/tarif", async (req, reply) => {
        const { id } = req.params as { id: string };
        try {
          await payments.updateDraftTariff(id, parseTariff((req.body ?? {}) as Record<string, string>));
          return reply.redirect(statementUrl(id, "done", "tariff"), 303);
        } catch (error) {
          return reply.redirect(statementUrl(id, "err", message(error)), 303);
        }
      });

      section.post("/etats/:id/valider", async (req, reply) => {
        const { id } = req.params as { id: string };
        try {
          const detail = await payments.getStatementDetail(id);
          if (!detail) throw new payments.CoachPaymentError("État introuvable");
          if (detail.statement.status !== "draft") {
            throw new payments.CoachPaymentError("Un état validé est immuable");
          }
          const month = storedMonthKey(detail.statement.month);
          // Once the month is closed, always refresh the complete Wix snapshot
          // immediately before freezing it. An outage at validation time must
          // block the action even if an older mid-month sync had succeeded.
          if (monthIsClosed(month)) {
            await payments.refreshDraftProfileSnapshot(id, detail.profile);
            if (!detail.profile.wix_resource_id) {
              throw new payments.CoachPaymentError(
                "Validation bloquée : aucune ressource Wix associée à cette coach",
              );
            }
            try {
              const courses = await fetchEligibleCourses(detail.profile, month);
              await payments.replaceWixSnapshot(id, courses);
            } catch (error) {
              await payments.recordSyncFailure(id, message(error));
              throw new payments.CoachPaymentError(
                `Validation bloquée : Wix indisponible (${message(error)})`,
              );
            }
          }
          await payments.validateStatement(id, req.adminUser ?? null);
          req.log.info({ statement: id, by: req.adminUser }, "Coach payment statement validated");
          return reply.redirect(statementUrl(id, "done", "validated"), 303);
        } catch (error) {
          return reply.redirect(statementUrl(id, "err", message(error)), 303);
        }
      });

      section.post("/etats/:id/correction", async (req, reply) => {
        const { id } = req.params as { id: string };
        try {
          const correction = await payments.createCorrection(id, req.adminUser ?? null);
          req.log.info({ source: id, correction: correction.id, by: req.adminUser }, "Coach payment correction created");
          return reply.redirect(statementUrl(correction.id, "done", "correction"), 303);
        } catch (error) {
          return reply.redirect(statementUrl(id, "err", message(error)), 303);
        }
      });

      section.get("/etats/:id/pdf", async (req, reply) => {
        const { id } = req.params as { id: string };
        const detail = await payments.getStatementDetail(id);
        if (!detail) return reply.code(404).type("text/plain").send("État de paiement introuvable");
        const pdf = await renderCoachPaymentPdf(detail);
        return reply
          .type("application/pdf")
          .header("content-disposition", `inline; filename="${coachPaymentPdfFilename(detail)}"`)
          .send(pdf);
      });

      section.post("/etats/:id/envoyer", async (req, reply) => {
        const { id } = req.params as { id: string };
        const detail = await payments.getStatementDetail(id);
        if (!detail) return reply.redirect(`${BASE}?err=état introuvable`, 303);
        if (detail.statement.status === "draft") {
          return reply.redirect(statementUrl(id, "err", "Seul un état validé peut être envoyé"), 303);
        }
        let recipient: string;
        try {
          recipient = validEmail((req.body as Record<string, string>)?.recipient_email) ?? "";
          if (!recipient) throw new payments.CoachPaymentError("Adresse e-mail obligatoire");
          if (!emailNotificationsEnabled()) throw new payments.CoachPaymentError("Envoi désactivé : Brevo n'est pas configuré");
          await payments.rememberProfileEmail(detail.profile.id, recipient);
          const pdf = await renderCoachPaymentPdf(detail);
          await sendEmail(
            recipient,
            `État de paiement ${detail.statement.coach_name_snapshot} — ${storedMonthKey(detail.statement.month)}`,
            `Bonjour ${detail.statement.coach_name_snapshot},\n\nVeuillez trouver en pièce jointe votre état de paiement validé pour ${storedMonthKey(detail.statement.month)}.\n\nTotal : ${detail.statement.total_xof.toLocaleString("fr-FR")} FCFA.\n\nBien à vous,\nRevive Dakar`,
            [{ name: coachPaymentPdfFilename(detail), content: pdf }],
          );
          await payments.recordSend({
            statementId: id,
            recipientEmail: recipient,
            status: "success",
            sentBy: req.adminUser ?? null,
          });
          req.log.info({ statement: id, recipient, by: req.adminUser }, "Coach payment PDF emailed");
          return reply.redirect(statementUrl(id, "done", "sent"), 303);
        } catch (error) {
          recipient = (() => {
            try { return validEmail((req.body as Record<string, string>)?.recipient_email) ?? "adresse-invalide"; }
            catch { return String((req.body as Record<string, string>)?.recipient_email ?? "adresse-invalide").slice(0, 254); }
          })();
          await payments.recordSend({
            statementId: id,
            recipientEmail: recipient || "adresse-invalide",
            status: "error",
            error: message(error),
            sentBy: req.adminUser ?? null,
          });
          req.log.error({ err: error, statement: id, recipient }, "Coach payment email failed");
          return reply.redirect(statementUrl(id, "err", `Échec de l'envoi : ${message(error)}`), 303);
        }
      });

      section.post("/etats/:id/payer", async (req, reply) => {
        const { id } = req.params as { id: string };
        const paidOn = String((req.body as Record<string, string>)?.paid_on ?? "");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) {
          return reply.redirect(statementUrl(id, "err", "Date de règlement invalide"), 303);
        }
        const paidAt = new Date(`${paidOn}T12:00:00Z`);
        const ok = await payments.markPaid(id, paidAt, req.adminUser ?? null);
        if (ok) req.log.info({ statement: id, paidOn, by: req.adminUser }, "Coach payment marked paid");
        return reply.redirect(statementUrl(id, ok ? "done" : "err", ok ? "paid" : "Seul un état validé peut être marqué payé"), 303);
      });
    },
    { prefix: "/paiements-coachs" },
  );
}
