import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import * as fiches from "../domain/ficheRepo.js";
import {
  buildFicheMessage,
  contactMatchesFiche,
  ficheUrl,
  matchFicheRecipients,
  parseFicheForm,
  renderFicheBodyHtml,
  rolesWithoutFiche,
} from "../domain/ficheRules.js";
import { listStaffContacts, recordFicheLog } from "../domain/notificationRepo.js";
import { recordAdminAudit } from "../domain/adminOperations.js";
import { sendWhatsAppNotificationDetailed } from "../lib/notify.js";
import { fichesBanner, renderFichePrint, renderFichesPage } from "./fichesPage.js";
import { layout } from "./layout.js";

/**
 * /admin/fiches — responsabilités par rôle, poussées sur WhatsApp.
 *
 * Deux invariants serveur, non négociables (l'UI seule ne suffit pas) :
 *  1. On n'envoie JAMAIS une fiche non publiée : le message porterait un lien
 *     en 404. Le bouton désactivé est un confort, ce contrôle est la garantie.
 *  2. L'envoi lit un INSTANTANÉ chargé une seule fois en début de route
 *     (published_*), et cible published_role_keys — pas les clés brouillon.
 *     Sans ça, changer les destinataires sans publier enverrait l'ancien
 *     artefact au nouveau rôle.
 */

const back = (reply: any, params = "") => reply.redirect(`/admin/fiches${params}`, 303);
const errBack = (reply: any, msg: string) =>
  back(reply, `?err=${encodeURIComponent(msg)}`);

export function registerFichesRoutes(admin: FastifyInstance): void {
  admin.get("/fiches", async (req, reply) => {
    const q = req.query as { done?: string; err?: string };
    const [all, contacts, knownRoles] = await Promise.all([
      fiches.listFiches(),
      listStaffContacts(),
      fiches.distinctStaffRoles(),
    ]);
    const cards = await Promise.all(
      all.map(async (fiche) => ({
        fiche,
        // clés PUBLIÉES : c'est ce que l'envoi utilisera
        recipients: matchFicheRecipients(contacts, fiche.published_role_keys),
        lastSends: await fiches.lastFicheSendByPhone(fiche.id),
        url: ficheUrl(config.BASE_URL, fiche.public_token),
      })),
    );
    const body = renderFichesPage({
      cards,
      knownRoles,
      rolesWithoutFiche: rolesWithoutFiche(contacts, all),
      templateConfigured: !!config.WA_RECEPTION_TEMPLATE,
      banner: fichesBanner(q?.done, q?.err),
    });
    reply
      .type("text/html")
      .send(
        await layout("Fiches de poste", "/admin/fiches", body, {
          subtitle: "Responsabilités par rôle",
          contentWidth: "wide",
        }),
      );
  });

  admin.post("/fiches", async (req, reply) => {
    const parsed = parseFicheForm((req.body ?? {}) as Record<string, unknown>);
    if ("error" in parsed) return errBack(reply, parsed.error);
    const conflict = await fiches.findRoleConflict(parsed.roleKeys);
    if (conflict)
      return errBack(
        reply,
        `« ${conflict.keys.join(", ")} » est déjà couvert par la fiche « ${conflict.role_label} »`,
      );
    const created = await fiches.createFiche({ ...parsed, by: req.adminUser ?? null });
    req.log.info({ by: req.adminUser, id: created.id, role: parsed.roleLabel }, "Fiche created");
    return back(reply, "?done=created");
  });

  admin.post("/fiches/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const op = String((req.body as any)?.op ?? "");
    const fiche = await fiches.getFiche(id);
    if (!fiche) return errBack(reply, "fiche introuvable");

    if (op === "unpublish") {
      await fiches.unpublishFiche(id, req.adminUser ?? null);
      await recordAdminAudit(
        { username: req.adminUser ?? "?", role: req.adminRole ?? "team" },
        "fiche.unpublished",
        "job_fiche",
        id,
        { role_label: fiche.role_label },
      );
      req.log.info({ by: req.adminUser, id }, "Fiche unpublished");
      return back(reply, "?done=unpublished");
    }
    if (op !== "save" && op !== "publish") return errBack(reply, "action inconnue");

    const parsed = parseFicheForm((req.body ?? {}) as Record<string, unknown>);
    if ("error" in parsed) return errBack(reply, parsed.error);
    const conflict = await fiches.findRoleConflict(parsed.roleKeys, id);
    if (conflict)
      return errBack(
        reply,
        `« ${conflict.keys.join(", ")} » est déjà couvert par la fiche « ${conflict.role_label} »`,
      );
    await fiches.saveDraft(id, { ...parsed, by: req.adminUser ?? null });

    if (op === "publish") {
      // Publier un corps vide donnerait un lien qui n'affiche rien : refusé en SQL.
      const ok = await fiches.publishFiche(id, req.adminUser ?? null);
      if (!ok) return errBack(reply, "impossible de publier une fiche vide");
      req.log.info({ by: req.adminUser, id }, "Fiche published");
      return back(reply, "?done=published");
    }
    req.log.info({ by: req.adminUser, id }, "Fiche draft saved");
    return back(reply, "?done=saved");
  });

  admin.post("/fiches/:id/regenerate-link", async (req, reply) => {
    const { id } = req.params as { id: string };
    const fiche = await fiches.getFiche(id);
    if (!fiche) return errBack(reply, "fiche introuvable");
    const token = await fiches.regenerateToken(id, req.adminUser ?? null);
    if (!token) return errBack(reply, "fiche introuvable");
    // JAMAIS de valeur de token dans l'audit : c'est un secret porteur, et
    // l'écrire dans un journal durable annulerait l'intérêt de la rotation.
    await recordAdminAudit(
      { username: req.adminUser ?? "?", role: req.adminRole ?? "team" },
      "fiche.link_rotated",
      "job_fiche",
      id,
      { role_label: fiche.role_label },
    );
    req.log.info({ by: req.adminUser, id }, "Fiche link rotated");
    return back(reply, "?done=link-rotated");
  });

  admin.post("/fiches/:id/delete", async (req, reply) => {
    const { id } = req.params as { id: string };
    const fiche = await fiches.getFiche(id);
    if (!fiche) return errBack(reply, "fiche introuvable");
    const ok = await fiches.deleteFiche(id);
    if (!ok)
      return errBack(
        reply,
        "cette fiche a déjà été envoyée : des liens circulent, utilise « Dépublier »",
      );
    await recordAdminAudit(
      { username: req.adminUser ?? "?", role: req.adminRole ?? "team" },
      "fiche.deleted",
      "job_fiche",
      id,
      { role_label: fiche.role_label },
    );
    req.log.info({ by: req.adminUser, id, role: fiche.role_label }, "Fiche deleted");
    return back(reply, "?done=deleted");
  });

  admin.get("/fiches/:id/print", async (req, reply) => {
    const { id } = req.params as { id: string };
    const fiche = await fiches.getFiche(id);
    if (!fiche) return reply.code(404).send("Fiche introuvable");
    const text = fiche.published_body ?? fiche.body;
    reply.type("text/html").send(renderFichePrint(fiche, renderFicheBodyHtml(text)));
  });

  // ---------- envois ----------

  /**
   * Staff = fenêtre 24h ~toujours fermée → template d'abord, comme tout ping
   * staff. On enregistre le wamid pour que le webhook puisse requalifier en
   * échec un message accepté puis jeté par Meta.
   */
  async function sendOne(
    fiche: fiches.JobFiche,
    contact: { id: string; name: string; phone: string },
    url: string,
    log: any,
  ): Promise<"sent" | "failed"> {
    const { subject, body } = buildFicheMessage({
      staffName: contact.name,
      roleLabel: fiche.published_role_label ?? fiche.role_label,
      publishedAt: fiche.published_at,
      url,
    });
    const tag = `[fiche ${fiche.published_role_label ?? fiche.role_label}] ${contact.name}`;
    try {
      const { path, waMessageId } = await sendWhatsAppNotificationDetailed(
        contact.phone,
        subject,
        body,
        { preferTemplate: true },
      );
      await recordFicheLog(fiche.id, contact.phone, tag, path, null, waMessageId);
      return "sent";
    } catch (e) {
      await recordFicheLog(fiche.id, contact.phone, tag, "failed", String(e).slice(0, 300), null);
      log.error({ err: e, fiche: fiche.id, contact: contact.id }, "Fiche send failed");
      return "failed";
    }
  }

  admin.post("/fiches/:id/send", async (req, reply) => {
    const { id } = req.params as { id: string };
    const fiche = await fiches.getFiche(id);
    if (!fiche) return errBack(reply, "fiche introuvable");
    if (fiche.published_body === null)
      return errBack(reply, "publie la fiche avant de l’envoyer (le lien serait mort)");

    const url = ficheUrl(config.BASE_URL, fiche.public_token);
    const contacts = await listStaffContacts();
    const { targets, noPhone, muted } = matchFicheRecipients(contacts, fiche.published_role_keys);
    if (targets.length === 0)
      return errBack(reply, "aucun membre joignable pour ce rôle — ajoute un numéro au répertoire");

    // Séquentiel : 3 à 8 destinataires, compteurs simples, pas de rafale Meta.
    let ok = 0;
    let failed = 0;
    for (const c of targets) {
      const r = await sendOne(fiche, c, url, req.log);
      if (r === "sent") ok += 1;
      else failed += 1;
    }
    await fiches.markSent(id, ok);
    req.log.info(
      { by: req.adminUser, fiche: id, ok, failed, noPhone: noPhone.length, muted: muted.length },
      "Fiche sent to role",
    );
    return back(
      reply,
      `?done=sent-all:${ok}:${noPhone.length}:${muted.length}:${failed}`,
    );
  });

  admin.post("/fiches/:id/send/:contactId", async (req, reply) => {
    const { id, contactId } = req.params as { id: string; contactId: string };
    const fiche = await fiches.getFiche(id);
    if (!fiche) return errBack(reply, "fiche introuvable");
    if (fiche.published_body === null)
      return errBack(reply, "publie la fiche avant de l’envoyer (le lien serait mort)");

    // Seule route où le client fournit un id de contact (« envoyer quand même »
    // à une personne en sourdine) → revalider rôle ET numéro côté serveur.
    const contact = (await listStaffContacts()).find((c) => c.id === contactId);
    if (!contact) return errBack(reply, "employée introuvable");
    if (!contactMatchesFiche(contact, fiche.published_role_keys))
      return errBack(reply, `${contact.name} ne relève plus de cette fiche, ou n’a pas de numéro valide`);

    const url = ficheUrl(config.BASE_URL, fiche.public_token);
    const r = await sendOne(fiche, contact, url, req.log);
    if (r === "failed") return errBack(reply, `échec de l’envoi WhatsApp à ${contact.name}`);
    req.log.info({ by: req.adminUser, fiche: id, contact: contactId }, "Fiche sent to one");
    return back(reply, `?done=${encodeURIComponent("sent:" + contact.name)}`);
  });
}
