import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { pool } from "../db/index.js";
import { transition } from "../domain/stateMachine.js";
import * as repo from "../domain/repo.js";
import { extrasFromJson, getCafeMenu, computeExtras } from "../lib/cafeMenu.js";
import {
  adminAuthHook,
  adminUsers,
  clearSessionCookieHeader,
  mintSessionToken,
  safeNextPath,
  sessionCookieHeader,
  verifyCredentials,
} from "./auth.js";
import { escapeHtml as escLogin } from "./helpers.js";
import * as delivery from "../domain/deliveryRepo.js";
import {
  attemptClientNotify,
  notifyKitchenForOrder,
  renotifyKitchen,
} from "../domain/deliveryNotify.js";
import { normalizeDeliveryPhone, parseDeliveryQtyFields } from "../domain/deliveryRules.js";
import {
  livraisonsBanner,
  renderLivraisonForm,
  renderLivraisonsBoard,
} from "./livraisonsPage.js";
import * as q from "./queries.js";
import {
  auditActiveSubscribers,
  auditContacts,
  fetchAllContacts,
  linkCandidates,
  phoneKey,
  planMerge,
} from "../lib/crmAudit.js";
import {
  addPhoneToContact,
  contactBookingActivity,
  findContactIdByPhone,
  mergeContacts,
  getContactById,
  listAllActiveOrders,
  findMemberContactIds,
  phoneMatchVariants,
} from "../lib/wix.js";
import { invalidateMembershipCache } from "../lib/membershipContext.js";
import {
  composeBusinessDescription,
  getBusinessProfile,
  sendImage,
  sendText,
  updateBusinessProfile,
  uploadProfilePictureHandle,
} from "../lib/whatsapp.js";
import * as invoices from "../domain/invoiceRepo.js";
import { normalizeSourceKind, parseInvoiceLineFields } from "../domain/invoiceRules.js";
import { renderInvoiceImage } from "../lib/invoiceImage.js";
import { formatXof } from "../lib/receiptImage.js";
import {
  facturesBanner,
  renderFactureForm,
  renderFacturePrint,
  renderFactureView,
  renderFacturesList,
} from "./facturesPage.js";
import * as quotes from "../domain/quoteRepo.js";
import { parseQuoteForm } from "../domain/quoteRules.js";
import { renderQuotePdf } from "../lib/quotePdf.js";
import { devisBanner, renderQuoteForm, renderQuotesList } from "./devisPage.js";
import * as menu from "../domain/cafeMenuRepo.js";
import { menuBanner, renderMenuPage } from "./menuPage.js";
import * as giftCards from "../domain/giftCardRepo.js";
import { parseGiftCardForm } from "../domain/giftCardRules.js";
import { renderGiftCardImage } from "../lib/giftCardImage.js";
import {
  cartesCadeauxBanner,
  renderGiftCardForm,
  renderGiftCardsList,
  renderGiftCardView,
} from "./cartesCadeauxPage.js";
import * as links from "../domain/linkRequests.js";
import * as reviews from "../domain/conversationReview.js";
import { renderTestChecklist } from "./testChecklist.js";
import { renderNotificationsPage } from "./notificationsPage.js";
import * as nrepo from "../domain/notificationRepo.js";
import { cachedCoachNames } from "../domain/notificationSweep.js";
import { renderMessage, STAFF_FOOTER } from "../domain/notificationRules.js";
import { sendWhatsAppNotification } from "../lib/notify.js";
import { ago, badge, escapeHtml, fmtDate, fmtFcfa } from "./helpers.js";
import { layout } from "./layout.js";
import { loadNavBadges } from "./navBadges.js";
import { renderInbox } from "./inboxPage.js";
import * as staffPlan from "../domain/staffPlanningRepo.js";
import { buildEmployeeScheduleMessage, validateGridPayload } from "../domain/staffPlanningRules.js";
import { renderStaffPlanning, renderStaffPrint, staffBanner } from "./staffPage.js";

export { escapeHtml } from "./helpers.js";

/** contactId → active plan names, for the CRM duplicates page & merge guard. */
async function activePlansByContact(): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  for (const o of await listAllActiveOrders()) {
    const cid = o?.buyer?.contactId;
    if (!cid) continue;
    map.set(cid, [...(map.get(cid) ?? []), o.planName ?? "abonnement"]);
  }
  return map;
}

/**
 * Admin dashboard — server-rendered HTML, no dependencies, no build step.
 * Read-only views + two bookkeeping actions ("remboursement effectué",
 * "abonnement activé"). NEVER any money movement from here: refunds are done
 * by a human in the Wave portal, these buttons only record that fact.
 *
 * Chrome (sidebar IA, search, badges) lives in layout.ts; home inbox in inboxPage.ts.
 */

/** Sample values used by the "Envoyer un test" button so the message reads real. */
const TEST_VARS: Record<string, string> = {
  class_name: "Aquabike",
  date: "samedi 18 juillet",
  start_time: "10:00",
  end_time: "10:45",
  coach: "Awa",
  booked_count: "8",
  open_spots: "2",
  total_spots: "10",
  classes: "• Aquabike à 10:00 — 8 inscrit(s)\n• Power Yoga à 11:00 — 5 inscrit(s)",
};

function renderLoginPage(opts: { error?: string; next?: string }): string {
  const next = safeNextPath(opts.next);
  const err = opts.error
    ? `<div class="err">⚠️ ${escLogin(opts.error)}</div>`
    : "";
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Connexion — Awa admin</title>
<style>
:root{color-scheme:light}
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f6f3ee;color:#1f2328;padding:1rem}
.card{background:#fff;border:1px solid #e4ddd3;border-radius:14px;padding:1.5rem;width:100%;max-width:380px;box-shadow:0 8px 24px rgba(31,35,40,.06)}
h1{font-size:1.15rem;margin:0 0 .3rem}
p{color:#6e7781;font-size:.9rem;margin:0 0 1.1rem}
label{display:block;font-size:.82rem;font-weight:600;margin:.7rem 0 .3rem;color:#424a53}
input{width:100%;padding:.55rem .75rem;border:1px solid #e4ddd3;border-radius:8px;font-size:1rem}
button{margin-top:1rem;width:100%;background:#1a7f37;color:#fff;border:none;border-radius:8px;padding:.65rem;font-size:.95rem;font-weight:600;cursor:pointer}
button:hover{background:#166f30}
.err{background:#fff8f0;border:1px solid #f0d8b6;border-radius:8px;padding:.55rem .7rem;margin-bottom:.9rem;font-size:.88rem}
.muted{color:#6e7781;font-size:.78rem;margin-top:1rem;text-align:center}
</style></head>
<body>
<div class="card">
  <h1>🤖 Awa — admin</h1>
  <p>Connexion réception · une session dure 30 jours</p>
  ${err}
  <form method="post" action="/admin/login">
    <input type="hidden" name="next" value="${escLogin(next)}">
    <label for="user">Identifiant</label>
    <input id="user" name="username" autocomplete="username" required autofocus>
    <label for="pass">Mot de passe</label>
    <input id="pass" name="password" type="password" autocomplete="current-password" required>
    <button type="submit">Se connecter</button>
  </form>
  <p class="muted">Le navigateur se souvient de toi — plus de popup à chaque visite.</p>
</div>
</body></html>`;
}

export function registerAdmin(app: FastifyInstance): void {
  app.register(
    async (admin) => {
      admin.addHook("onRequest", adminAuthHook);

      // ---------- Login (public — hook skips /login) ----------
      admin.get("/login", async (req, reply) => {
        const next = (req.query as { next?: string })?.next;
        reply
          .type("text/html")
          .header("Cache-Control", "no-store")
          .send(renderLoginPage({ next }));
      });

      admin.post("/login", async (req, reply) => {
        const body = (req.body ?? {}) as Record<string, string>;
        const username = String(body.username ?? "").trim();
        const password = String(body.password ?? "");
        const next = safeNextPath(body.next);
        const user = verifyCredentials(username, password, adminUsers());
        if (!user) {
          reply
            .code(401)
            .type("text/html")
            .header("Cache-Control", "no-store")
            .send(renderLoginPage({ error: "Identifiant ou mot de passe incorrect.", next }));
          return;
        }
        const token = mintSessionToken(user);
        reply
          .header("Set-Cookie", sessionCookieHeader(token))
          .redirect(next, 303);
      });

      admin.post("/logout", async (_req, reply) => {
        reply
          .header("Set-Cookie", clearSessionCookieHeader())
          .redirect("/admin/login", 303);
      });

      // ---------- À tester (checklist de recette) ----------
      admin.get("/tests", async (_req, reply) => {
        const pendingLinks = await links
          .receptionQueue()
          .then((q2) => q2.length)
          .catch(() => 0);
        reply
          .type("text/html")
          .send(await layout("À tester", "/admin/tests", renderTestChecklist(pendingLinks)));
      });

      // ---------- À faire (inbox) ----------
      admin.get("/", async (req, reply) => {
        const [actions, s, badges, openReviews, openHandoffs, openDeliveries] = await Promise.all([
          q.pendingActions(),
          q.stats(),
          loadNavBadges(),
          reviews.openReviews().catch(() => [] as Awaited<ReturnType<typeof reviews.openReviews>>),
          q
            .listHandoffs(30)
            .then((rows) => rows.filter((h) => h.status === "OPEN"))
            .catch(() => [] as any[]),
          delivery
            .listOpenDeliveryOrders()
            .catch(() => [] as Awaited<ReturnType<typeof delivery.listOpenDeliveryOrders>>),
        ]);
        const now = Date.now();
        let late = 0;
        let kitchenFailed = 0;
        let clientFailed = 0;
        for (const o of openDeliveries) {
          if (o.status === "IN_KITCHEN" && o.kitchen_notify_status === "failed") kitchenFailed++;
          if (o.status === "IN_KITCHEN") {
            const slaMs = (o.sla_minutes ?? 20) * 60_000;
            if (o.alerted_at || now - new Date(o.created_at).getTime() >= slaMs) late++;
          }
          if (o.status === "READY" && o.client_notify_status === "failed") clientFailed++;
        }
        const body = renderInbox({
          refunds: actions.refunds,
          planActivations: actions.planActivations,
          openHandoffs,
          openReviews,
          crmLinks: badges.crmLinks,
          livraisonAlerts: {
            late,
            kitchenFailed,
            clientFailed,
            open: openDeliveries.length,
          },
          stats: s,
          badges,
          adminUser: req.adminUser ?? "?",
        });
        reply.type("text/html").send(await layout("À faire", "/admin", body, { badges }));
      });

      // ---------- Conversations ----------
      admin.get("/conversations", async (req, reply) => {
        const search = (req.query as any)?.q as string | undefined;
        const clients = await q.listClients(search);
        const rows = clients
          .map(
            (c) => `<tr>
<td><a class="rowlink" href="/admin/conversations/${c.id}"><b>${escapeHtml(c.name ?? "(sans nom)")}</b><div class="muted">+${escapeHtml(c.wa_phone)}</div></a></td>
<td>${escapeHtml((c.last_message ?? "").slice(0, 90))}${(c.last_message ?? "").length > 90 ? "…" : ""}<div class="muted">${ago(c.last_message_at)} · ${c.message_count} messages</div></td>
<td class="hide-sm">${escapeHtml(c.language ?? "—")}</td>
</tr>`,
          )
          .join("");
        const body = `
<form method="get" action="/admin/conversations"><input type="search" name="q" placeholder="Rechercher un nom ou un numéro…" value="${escapeHtml(search ?? "")}"></form>
<div class="card"><table><tr><th>Client</th><th>Dernier message</th><th class="hide-sm">Langue</th></tr>${rows || `<tr><td colspan="3" class="muted">Aucun client trouvé.</td></tr>`}</table></div>`;
        reply.type("text/html").send(await layout("Conversations", "/admin/conversations", body));
      });

      admin.get("/conversations/:clientId", async (req, reply) => {
        const { clientId } = req.params as { clientId: string };
        const client = await q.getClient(clientId);
        if (!client) {
          reply.code(404).type("text/plain").send("Client introuvable");
          return;
        }
        const turns = await q.getThread(clientId);
        const thread = turns
          .map((t) => {
            if (t.role === "tool") {
              return `<details class="tool"><summary>🔧 ${escapeHtml(t.content.slice(0, 80))}…</summary><pre>${escapeHtml(t.content)}</pre></details>`;
            }
            const side = t.role === "user" ? "user" : "assistant";
            return `<div class="turnrow"><div class="bubble ${side}">${escapeHtml(t.content)}</div><span class="muted" style="${t.role === "user" ? "" : "text-align:right"}">${fmtDate(t.created_at)}</span></div>`;
          })
          .join("");
        const body = `
<div class="card">
<b>${escapeHtml(client.name ?? "(sans nom)")}</b> · +${escapeHtml(client.wa_phone)}
<div class="muted">Langue : ${escapeHtml(client.language ?? "—")} · Email déclaré : ${escapeHtml(client.claimed_email ?? "—")} · Client depuis : ${fmtDate(client.created_at)}</div>
</div>
${thread || `<p class="muted">Aucun message.</p>`}`;
        reply
          .type("text/html")
          .send(await layout(client.name ?? client.wa_phone, "/admin/conversations", body));
      });

      // ---------- Réservations & abonnements ----------
      admin.get("/bookings", async (req, reply) => {
        const status = ((req.query as any)?.status as string | undefined)?.toUpperCase();
        const [bookings, planOrders] = await Promise.all([
          q.listBookings(status),
          q.listPlanOrders(status),
        ]);
        const bookingRows = bookings
          .map((b) => {
            const extras =
              b.extras_amount_xof > 0
                ? `<div class="muted">+ bar : ${fmtFcfa(b.extras_amount_xof)}</div>`
                : "";
            return `<tr>
<td>${fmtDate(b.created_at)}</td>
<td><a href="/admin/conversations/${b.client_id}">${escapeHtml(b.client_name ?? "?")}</a></td>
<td>${escapeHtml(b.service_name)}<div class="muted">${fmtDate(b.slot_start)} · ${b.participants} pl. · ${escapeHtml(b.payment_method)}</div>${extras}</td>
<td><b>${fmtFcfa(b.amount_xof)}</b></td>
<td>${badge(b.status)}</td>
</tr>`;
          })
          .join("");
        const planRows = planOrders
          .map(
            (p) => `<tr>
<td>${fmtDate(p.created_at)}</td>
<td><a href="/admin/conversations/${p.client_id}">${escapeHtml(p.client_name ?? "?")}</a></td>
<td>${escapeHtml(p.plan_name)}</td>
<td><b>${fmtFcfa(p.amount_xof)}</b></td>
<td>${badge(p.status)}</td>
</tr>`,
          )
          .join("");
        const filters = ["", "BOOKED", "AWAITING_PAYMENT", "REFUND_NEEDED", "REFUNDED", "CANCELLED", "EXPIRED"]
          .map(
            (st) =>
              `<a href="/admin/bookings${st ? `?status=${st}` : ""}" style="margin-right:.6rem;${(status ?? "") === st ? "font-weight:700" : ""}">${st || "Tous"}</a>`,
          )
          .join("");
        const body = `
<p class="muted">${filters}</p>
<h2>Réservations</h2>
<div class="card"><table><tr><th>Créée</th><th>Client</th><th>Cours</th><th>Montant</th><th>Statut</th></tr>${bookingRows || `<tr><td colspan="5" class="muted">Rien.</td></tr>`}</table></div>
<h2>Abonnements vendus</h2>
<div class="card"><table><tr><th>Créé</th><th>Client</th><th>Formule</th><th>Montant</th><th>Statut</th></tr>${planRows || `<tr><td colspan="5" class="muted">Rien.</td></tr>`}</table></div>`;
        reply.type("text/html").send(await layout("Réservations", "/admin/bookings", body));
      });

      // ---------- Commandes bar ----------
      admin.get("/orders", async (_req, reply) => {
        const { today, upcoming } = await q.listCafeOrders();

        const orderRow = (b: any) => {
          const items = extrasFromJson(b.extras_json)
            .map((l) => `${l.qty}× ${escapeHtml(l.name)}`)
            .join("<br>");
          const note = b.order_note
            ? `<div class="muted">📝 ${escapeHtml(b.order_note)}</div>`
            : "";
          return `<tr>
<td><b>${fmtDate(b.slot_start)}</b><div class="muted">${escapeHtml(b.service_name)}</div></td>
<td><a href="/admin/conversations/${b.client_id}">${escapeHtml(b.client_name ?? "?")}</a><div class="muted">+${escapeHtml(b.wa_phone)}</div></td>
<td>${items || "—"}${note}</td>
<td><b>${fmtFcfa(b.extras_amount_xof)}</b></td>
</tr>`;
        };

        // Quantités agrégées par article → liste de préparation du jour.
        const prepTotals = new Map<string, number>();
        for (const b of today) {
          for (const l of extrasFromJson(b.extras_json)) {
            prepTotals.set(l.name, (prepTotals.get(l.name) ?? 0) + l.qty);
          }
        }
        const prepList = [...prepTotals.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([name, qty]) => `<b>${qty}×</b> ${escapeHtml(name)}`)
          .join(" · ");
        const cafeTotal = today.reduce((sum, b) => sum + b.extras_amount_xof, 0);

        const body = `
<h2>☕ Commandes du jour ${today.length ? `(${today.length})` : ""}</h2>
<div class="stat-grid">
<div class="stat"><span class="muted">Commandes aujourd'hui</span><b>${today.length}</b></div>
<div class="stat"><span class="muted">Total bar du jour</span><b>${fmtFcfa(cafeTotal)}</b></div>
</div>
${prepList ? `<div class="card" style="margin-top:.8rem">À préparer : ${prepList}</div>` : ""}
<div class="card" style="margin-top:.8rem">
${
  today.length
    ? `<table><tr><th>Cours</th><th>Client</th><th>Commande</th><th>Montant</th></tr>${today.map(orderRow).join("")}</table>`
    : `<span class="muted">Aucune commande bar pour aujourd'hui.</span>`
}
</div>

<h2>Commandes à venir</h2>
<div class="card">
${
  upcoming.length
    ? `<table><tr><th>Cours</th><th>Client</th><th>Commande</th><th>Montant</th></tr>${upcoming.map(orderRow).join("")}</table>`
    : `<span class="muted">Aucune commande à venir.</span>`
}
</div>
<p class="muted">Seules les commandes payées (résa confirmée) apparaissent ici.</p>`;
        reply
          .type("text/html")
          .send(
            await layout(
              "Commandes payées",
              "/admin/orders",
              `<p class="subhead">Bar ☕ · commandes rattachées à une résa (paiement Wave / OM). Pour les livraisons téléphoniques → <a href="/admin/livraisons">Livraisons</a>.</p>${body}`,
            ),
          );
      });

      // ---------- Livraisons (commandes bar à livrer) ----------
      admin.get("/livraisons", async (req, reply) => {
        const done = (req.query as any)?.done as string | undefined;
        const err = (req.query as any)?.err as string | undefined;
        const [open, recent, stats] = await Promise.all([
          delivery.listOpenDeliveryOrders(),
          delivery.recentClosedDeliveryOrders(20),
          delivery.deliveryStats(),
        ]);
        const body = renderLivraisonsBoard({
          open,
          recent,
          stats,
          banner: livraisonsBanner(done, err),
        });
        // Auto-refresh only on the board (never on the create form).
        reply.type("text/html").send(await layout("Livraisons", "/admin/livraisons", body, { refreshSeconds: 60 }));
      });

      admin.get("/livraisons/new", async (req, reply) => {
        const err = (req.query as any)?.err as string | undefined;
        const body = renderLivraisonForm(getCafeMenu().items, livraisonsBanner(undefined, err));
        reply.type("text/html").send(await layout("Nouvelle livraison", "/admin/livraisons", body));
      });

      admin.post("/livraisons", async (req, reply) => {
        const b = (req.body ?? {}) as Record<string, string>;
        const name = String(b.client_name ?? "").trim();
        const address = String(b.address ?? "").trim();
        const note = String(b.note ?? "").trim() || null;
        const phone = normalizeDeliveryPhone(String(b.client_phone ?? ""));
        const backErr = (msg: string) => reply.redirect(`/admin/livraisons/new?err=${encodeURIComponent(msg)}`, 303);
        if (!name) return backErr("le nom du client est obligatoire");
        if (!phone) return backErr("numéro de téléphone invalide");
        if (!address) return backErr("l'adresse de livraison est obligatoire");
        const parsed = parseDeliveryQtyFields(b);
        if ("error" in parsed) return backErr(parsed.error);
        // Prices/total resolved server-side from the menu (never trusted from the form).
        const priced = computeExtras(getCafeMenu().items, parsed.entries);
        if (!priced.ok) return backErr(priced.message);
        const slaRaw = parseInt(String(b.sla_minutes ?? "").trim(), 10);
        const sla = Number.isFinite(slaRaw) && slaRaw >= 5 && slaRaw <= 180 ? slaRaw : config.DELIVERY_SLA_MINUTES;

        const { order, token } = await delivery.createDeliveryOrder({
          client_name: name,
          client_phone: phone,
          address,
          note,
          items: priced.lines,
          amount_xof: priced.totalXof,
          sla_minutes: sla,
          created_by: req.adminUser ?? null,
        });
        req.log.info({ order: order.id, by: req.adminUser }, "Delivery order created");
        // Notify the kitchen now (await so the banner is truthful). Claim first
        // so a concurrent sweep can't double-send.
        let kitchenOk = false;
        const claimed = await delivery.claimKitchenNotify(order.id);
        if (claimed) {
          try {
            await notifyKitchenForOrder(claimed, token, req.log);
            const fresh = await delivery.findDeliveryOrder(order.id);
            kitchenOk = !!fresh && ["sent", "sent_template", "partial", "fallback_reception"].includes(fresh.kitchen_notify_status);
          } catch (e) {
            req.log.error({ err: e, order: order.id }, "Delivery kitchen notify threw");
          }
        }
        return reply.redirect(`/admin/livraisons?done=${kitchenOk ? "created" : "created-kitchen-failed"}`, 303);
      });

      admin.post("/livraisons/:id/ready", async (req, reply) => {
        const { id } = req.params as { id: string };
        const updated = await delivery.markReady(id, `admin-${req.adminUser ?? "?"}`);
        if (updated) {
          req.log.info({ order: id, by: req.adminUser }, "Delivery order marked ready from dashboard");
          await attemptClientNotify(id, req.log); // await so the board shows the ping outcome
          return reply.redirect("/admin/livraisons?done=ready", 303);
        }
        return reply.redirect("/admin/livraisons?err=commande déjà traitée — recharge la page", 303);
      });

      admin.post("/livraisons/:id/delivered", async (req, reply) => {
        const { id } = req.params as { id: string };
        const updated = await delivery.markDelivered(id, `admin-${req.adminUser ?? "?"}`);
        if (updated) req.log.info({ order: id, by: req.adminUser }, "Delivery order marked delivered");
        return reply.redirect(updated ? "/admin/livraisons?done=delivered" : "/admin/livraisons?err=commande déjà traitée", 303);
      });

      admin.post("/livraisons/:id/cancel", async (req, reply) => {
        const { id } = req.params as { id: string };
        const updated = await delivery.markCancelled(id, `admin-${req.adminUser ?? "?"}`);
        if (updated) req.log.info({ order: id, by: req.adminUser }, "Delivery order cancelled");
        return reply.redirect(updated ? "/admin/livraisons?done=cancelled" : "/admin/livraisons?err=commande déjà traitée", 303);
      });

      admin.post("/livraisons/:id/renotify-kitchen", async (req, reply) => {
        const { id } = req.params as { id: string };
        const order = await delivery.findDeliveryOrder(id);
        if (!order) return reply.redirect("/admin/livraisons?err=commande introuvable", 303);
        const ok = await renotifyKitchen(order, req.log);
        return reply.redirect(ok ? "/admin/livraisons?done=renotified" : "/admin/livraisons?err=commande déjà prête/close", 303);
      });

      // ---------- Factures (demande client → la réception la crée ici) ----------
      admin.get("/factures", async (req, reply) => {
        const done = (req.query as any)?.done as string | undefined;
        const err = (req.query as any)?.err as string | undefined;
        const rows = await invoices.listInvoices(100);
        const body = renderFacturesList(rows, facturesBanner(done, err));
        reply.type("text/html").send(await layout("Factures", "/admin/factures", body));
      });

      admin.get("/factures/new", async (req, reply) => {
        const err = (req.query as any)?.err as string | undefined;
        const candidates = await invoices.recentPaidCandidates().catch(() => []);
        const body = renderFactureForm(candidates, facturesBanner(undefined, err));
        reply.type("text/html").send(await layout("Nouvelle facture", "/admin/factures", body));
      });

      admin.post("/factures", async (req, reply) => {
        const b = (req.body ?? {}) as Record<string, string>;
        const backErr = (msg: string) => reply.redirect(`/admin/factures/new?err=${encodeURIComponent(msg)}`, 303);
        const name = String(b.client_name ?? "").trim();
        if (!name) return backErr("le nom du client est obligatoire");
        const phoneRaw = String(b.client_phone ?? "").trim();
        const phone = phoneRaw ? normalizeDeliveryPhone(phoneRaw) : null;
        if (phoneRaw && !phone) return backErr("numéro de téléphone invalide (laisse vide si aucun)");
        const parsed = parseInvoiceLineFields(b);
        if ("error" in parsed) return backErr(parsed.error);
        const paidAtRaw = String(b.paid_at ?? "").trim();
        const paidAt = paidAtRaw ? new Date(paidAtRaw) : null;
        const inv = await invoices.createInvoice({
          client_name: name,
          client_phone: phone,
          client_ref: String(b.client_ref ?? "").trim() || null,
          lines: parsed.lines,
          total_xof: parsed.totalXof,
          note: String(b.note ?? "").trim() || null,
          source_kind: normalizeSourceKind(b.source_kind),
          source_id: String(b.source_id ?? "").trim() || null,
          payment_method: String(b.payment_method ?? "").trim() || null,
          payment_ref: String(b.payment_ref ?? "").trim() || null,
          paid_at: paidAt && !isNaN(paidAt.getTime()) ? paidAt : null,
          created_by: req.adminUser ?? null,
        });
        req.log.info({ invoice: inv.id, number: inv.number, by: req.adminUser }, "Invoice created");
        return reply.redirect(`/admin/factures/${inv.id}?done=created`, 303);
      });

      admin.get("/factures/:id", async (req, reply) => {
        const { id } = req.params as { id: string };
        const inv = await invoices.findInvoice(id);
        if (!inv) return reply.code(404).type("text/plain").send("Facture introuvable");
        const done = (req.query as any)?.done as string | undefined;
        const err = (req.query as any)?.err as string | undefined;
        const body = renderFactureView(inv, facturesBanner(done, err));
        reply.type("text/html").send(await layout(`Facture ${inv.number}`, "/admin/factures", body));
      });

      admin.get("/factures/:id/print", async (req, reply) => {
        const { id } = req.params as { id: string };
        const inv = await invoices.findInvoice(id);
        if (!inv) return reply.code(404).type("text/plain").send("Facture introuvable");
        reply.type("text/html").send(renderFacturePrint(inv));
      });

      admin.post("/factures/:id/send", async (req, reply) => {
        const { id } = req.params as { id: string };
        const inv = await invoices.findInvoice(id);
        if (!inv) return reply.redirect("/admin/factures?err=facture introuvable", 303);
        if (!inv.client_phone)
          return reply.redirect(`/admin/factures/${id}?err=${encodeURIComponent("pas de numéro — envoi impossible")}`, 303);
        const png = renderInvoiceImage({
          number: inv.number,
          clientName: inv.client_name,
          clientRef: inv.client_ref,
          lines: invoices.invoiceLines(inv),
          totalXof: inv.total_xof,
          note: inv.note,
          paidVia: inv.payment_method,
          paymentRef: inv.payment_ref,
          paidAt: inv.paid_at,
          createdAt: inv.created_at,
        });
        const caption = `Facture ${inv.number} — Revive · ${formatXof(inv.total_xof)}`;
        const logBody = `[facture ${inv.number}] ${caption}`;
        try {
          const wamid = await sendImage(inv.client_phone, png, caption);
          await invoices.markInvoiceSent(id, "sent");
          await nrepo.recordInvoiceLog(inv.client_phone, logBody, "sent", null, wamid ?? null);
          req.log.info({ invoice: id, by: req.adminUser }, "Invoice sent on WhatsApp");
          return reply.redirect(`/admin/factures/${id}?done=sent`, 303);
        } catch (e) {
          const windowClosed = String(e).includes("131047");
          await invoices.markInvoiceSent(id, windowClosed ? "window_closed" : "failed");
          await nrepo.recordInvoiceLog(inv.client_phone, logBody, "failed", String(e).slice(0, 300));
          req.log.error({ err: e, invoice: id }, "Invoice WhatsApp send failed");
          const msg = windowClosed
            ? "fenêtre WhatsApp fermée — le client doit d'abord écrire à Awa, puis réessaie"
            : "échec de l'envoi WhatsApp — réessaie";
          return reply.redirect(`/admin/factures/${id}?err=${encodeURIComponent(msg)}`, 303);
        }
      });

      // ---------- Devis (événements privés — création + PDF téléchargeable) ----------
      admin.get("/devis", async (req, reply) => {
        const done = (req.query as any)?.done as string | undefined;
        const err = (req.query as any)?.err as string | undefined;
        const rows = await quotes.listQuotes(100);
        const body = renderQuotesList(rows, devisBanner(done, err));
        reply.type("text/html").send(await layout("Devis", "/admin/devis", body));
      });

      admin.get("/devis/new", async (req, reply) => {
        const err = (req.query as any)?.err as string | undefined;
        const body = renderQuoteForm(null, devisBanner(undefined, err));
        reply.type("text/html").send(await layout("Nouveau devis", "/admin/devis", body));
      });

      admin.post("/devis", async (req, reply) => {
        const b = (req.body ?? {}) as Record<string, string>;
        const parsed = parseQuoteForm(b);
        if ("error" in parsed)
          return reply.redirect(`/admin/devis/new?err=${encodeURIComponent(parsed.error)}`, 303);
        const quote = await quotes.createQuote(parsed.data, req.adminUser ?? null);
        req.log.info({ quote: quote.id, number: quote.number, by: req.adminUser }, "Quote created");
        return reply.redirect(`/admin/devis/${quote.id}?done=created`, 303);
      });

      admin.get("/devis/:id", async (req, reply) => {
        const { id } = req.params as { id: string };
        const quote = await quotes.findQuote(id);
        if (!quote) return reply.redirect("/admin/devis?err=devis introuvable", 303);
        const done = (req.query as any)?.done as string | undefined;
        const err = (req.query as any)?.err as string | undefined;
        const body = renderQuoteForm(quote, devisBanner(done, err));
        reply.type("text/html").send(await layout(`Devis ${quote.number}`, "/admin/devis", body));
      });

      admin.post("/devis/:id", async (req, reply) => {
        const { id } = req.params as { id: string };
        const b = (req.body ?? {}) as Record<string, string>;
        const parsed = parseQuoteForm(b);
        if ("error" in parsed)
          return reply.redirect(`/admin/devis/${id}?err=${encodeURIComponent(parsed.error)}`, 303);
        const updated = await quotes.updateQuote(id, parsed.data);
        if (!updated) return reply.redirect("/admin/devis?err=devis introuvable", 303);
        req.log.info({ quote: id, by: req.adminUser }, "Quote updated");
        return reply.redirect(`/admin/devis/${id}?done=saved`, 303);
      });

      admin.post("/devis/:id/status", async (req, reply) => {
        const { id } = req.params as { id: string };
        const b = (req.body ?? {}) as Record<string, string>;
        const ok = await quotes.setQuoteStatus(id, String(b.status ?? ""));
        return reply.redirect(ok ? `/admin/devis/${id}?done=status` : "/admin/devis?err=statut invalide", 303);
      });

      admin.get("/devis/:id/pdf", async (req, reply) => {
        const { id } = req.params as { id: string };
        const quote = await quotes.findQuote(id);
        if (!quote) return reply.code(404).type("text/plain").send("Devis introuvable");
        const pdf = await renderQuotePdf({
          quoteNumber: quote.number,
          issuedOn: new Date(quote.issued_on),
          validityDays: quote.validity_days,
          clientName: quote.client_name,
          clientCompany: quote.client_company,
          clientRole: quote.client_role,
          eventTitle: quote.event_title,
          description: quote.description,
          eventDate: quote.event_date ? new Date(quote.event_date) : null,
          eventTime: quote.event_time,
          participants: quote.participants,
          location: quote.location,
          items: quotes.quoteItems(quote),
          conditions: quote.conditions.split("\n").map((l) => l.trim()).filter(Boolean),
        });
        reply
          .type("application/pdf")
          .header("content-disposition", `attachment; filename="Devis_${quote.number}.pdf"`)
          .send(pdf);
      });

      // ---------- Menu bar (éditable — DB source de vérité) ----------
      admin.get("/menu", async (req, reply) => {
        const editId = (req.query as any)?.edit as string | undefined;
        const done = (req.query as any)?.done as string | undefined;
        const err = (req.query as any)?.err as string | undefined;
        const items = await menu.listMenuItems();
        const body = renderMenuPage({ items, editId, banner: menuBanner(done, err) });
        reply.type("text/html").send(await layout("Menu bar", "/admin/menu", body));
      });

      admin.post("/menu/items", async (req, reply) => {
        const parsed = menu.parseMenuItemForm((req.body ?? {}) as Record<string, string>);
        if ("error" in parsed)
          return reply.redirect(`/admin/menu?err=${encodeURIComponent(parsed.error)}`, 303);
        const { id } = await menu.createMenuItem(parsed);
        await menu.refreshCafeMenu();
        req.log.info({ by: req.adminUser, id }, "Menu item created");
        return reply.redirect("/admin/menu?done=created", 303);
      });

      admin.post("/menu/items/:id/update", async (req, reply) => {
        const { id } = req.params as { id: string };
        const parsed = menu.parseMenuItemForm((req.body ?? {}) as Record<string, string>);
        if ("error" in parsed)
          return reply.redirect(`/admin/menu?edit=${encodeURIComponent(id)}&err=${encodeURIComponent(parsed.error)}`, 303);
        const ok = await menu.updateMenuItem(id, parsed);
        if (!ok) return reply.redirect("/admin/menu?err=article introuvable", 303);
        await menu.refreshCafeMenu();
        req.log.info({ by: req.adminUser, id }, "Menu item updated");
        return reply.redirect("/admin/menu?done=updated", 303);
      });

      admin.post("/menu/items/:id/toggle", async (req, reply) => {
        const { id } = req.params as { id: string };
        const item = await menu.getMenuItem(id);
        if (!item) return reply.redirect("/admin/menu?err=article introuvable", 303);
        await menu.setMenuItemEnabled(id, !item.enabled);
        await menu.refreshCafeMenu();
        req.log.info({ by: req.adminUser, id, enabled: !item.enabled }, "Menu item toggled");
        return reply.redirect(`/admin/menu?done=${item.enabled ? "retired" : "restored"}`, 303);
      });

      // ---------- Cartes cadeaux (visuel PNG + envoi WhatsApp) ----------
      admin.get("/cartes-cadeaux", async (req, reply) => {
        const done = (req.query as any)?.done as string | undefined;
        const err = (req.query as any)?.err as string | undefined;
        const rows = await giftCards.listGiftCards(100);
        const body = renderGiftCardsList(rows, cartesCadeauxBanner(done, err));
        reply.type("text/html").send(await layout("Cartes cadeaux", "/admin/cartes-cadeaux", body));
      });

      admin.get("/cartes-cadeaux/new", async (req, reply) => {
        const err = (req.query as any)?.err as string | undefined;
        const body = renderGiftCardForm(cartesCadeauxBanner(undefined, err));
        reply.type("text/html").send(await layout("Nouvelle carte cadeau", "/admin/cartes-cadeaux", body));
      });

      admin.post("/cartes-cadeaux", async (req, reply) => {
        const b = (req.body ?? {}) as Record<string, string>;
        const parsed = parseGiftCardForm(b);
        if ("error" in parsed)
          return reply.redirect(`/admin/cartes-cadeaux/new?err=${encodeURIComponent(parsed.error)}`, 303);
        const gc = await giftCards.createGiftCard(parsed.data, req.adminUser ?? null);
        req.log.info({ giftCard: gc.id, by: req.adminUser }, "Gift card created");
        return reply.redirect(`/admin/cartes-cadeaux/${gc.id}?done=created`, 303);
      });

      admin.get("/cartes-cadeaux/:id", async (req, reply) => {
        const { id } = req.params as { id: string };
        const gc = await giftCards.findGiftCard(id);
        if (!gc) return reply.redirect("/admin/cartes-cadeaux?err=carte introuvable", 303);
        const done = (req.query as any)?.done as string | undefined;
        const err = (req.query as any)?.err as string | undefined;
        const body = renderGiftCardView(gc, cartesCadeauxBanner(done, err));
        reply.type("text/html").send(await layout("Carte cadeau", "/admin/cartes-cadeaux", body));
      });

      admin.get("/cartes-cadeaux/:id/png", async (req, reply) => {
        const { id } = req.params as { id: string };
        const gc = await giftCards.findGiftCard(id);
        if (!gc) return reply.code(404).type("text/plain").send("Carte introuvable");
        const png = await renderGiftCardImage({
          offerLine1: gc.offer_line1,
          offerLine2: gc.offer_line2,
          recipientName: gc.recipient_name,
          fromName: gc.from_name,
        });
        const inline = (req.query as any)?.inline === "1";
        reply.type("image/png");
        if (!inline) {
          const safe = gc.recipient_name.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") || "carte";
          reply.header("content-disposition", `attachment; filename="Carte-Cadeau-${safe}.png"`);
        }
        return reply.send(png);
      });

      admin.post("/cartes-cadeaux/:id/send", async (req, reply) => {
        const { id } = req.params as { id: string };
        const gc = await giftCards.findGiftCard(id);
        if (!gc) return reply.redirect("/admin/cartes-cadeaux?err=carte introuvable", 303);
        if (!gc.send_phone)
          return reply.redirect(`/admin/cartes-cadeaux/${id}?err=${encodeURIComponent("pas de numéro — envoi impossible")}`, 303);
        const png = await renderGiftCardImage({
          offerLine1: gc.offer_line1,
          offerLine2: gc.offer_line2,
          recipientName: gc.recipient_name,
          fromName: gc.from_name,
        });
        const caption = `Carte Cadeau Revive 🎁 — ${gc.offer_line1}`;
        const logBody = `[carte cadeau ${gc.recipient_name}] ${caption}`;
        try {
          const wamid = await sendImage(gc.send_phone, png, caption);
          await giftCards.markGiftCardSent(id, "sent");
          await nrepo.recordGiftCardLog(gc.send_phone, logBody, "sent", null, wamid ?? null);
          req.log.info({ giftCard: id, by: req.adminUser }, "Gift card sent on WhatsApp");
          return reply.redirect(`/admin/cartes-cadeaux/${id}?done=sent`, 303);
        } catch (e) {
          const windowClosed = String(e).includes("131047");
          await giftCards.markGiftCardSent(id, windowClosed ? "window_closed" : "failed");
          await nrepo.recordGiftCardLog(gc.send_phone, logBody, "failed", String(e).slice(0, 300));
          req.log.error({ err: e, giftCard: id }, "Gift card WhatsApp send failed");
          const msg = windowClosed
            ? "fenêtre WhatsApp fermée — le destinataire doit d'abord écrire à Awa, puis réessaie"
            : "échec de l'envoi WhatsApp — réessaie";
          return reply.redirect(`/admin/cartes-cadeaux/${id}?err=${encodeURIComponent(msg)}`, 303);
        }
      });

      // ---------- Handoffs ----------
      admin.get("/handoffs", async (_req, reply) => {
        const handoffs = await q.listHandoffs();
        const open = handoffs.filter((h) => h.status === "OPEN").length;
        const rows = handoffs
          .map(
            (h) => `<tr${h.status === "DONE" ? ` style="opacity:.55"` : ""}>
<td>${fmtDate(h.created_at)}</td>
<td><a href="/admin/conversations/${h.client_id}">${escapeHtml(h.client_name ?? "?")}</a><div class="muted">+${escapeHtml(h.wa_phone)}</div></td>
<td>${escapeHtml(h.reason ?? "")}</td>
<td>${
              h.status === "OPEN"
                ? `<form class="inline" method="post" action="/admin/handoffs/${h.id}/done"><button class="act">✅ Traité</button></form>`
                : `<span class="muted">✓ ${escapeHtml(h.done_by ?? "")}</span>`
            }</td>
</tr>`,
          )
          .join("");
        const body = `<div class="card ${open ? "warn" : ""}">
${open ? `<p class="muted">${open} handoff(s) à traiter — un handoff = un client dont le besoin attend un humain. « Traité » = le client a été recontacté (ou son cas réglé).</p>` : `<p class="muted"><span class="ok">✓ Tous les handoffs sont traités.</span></p>`}
<table><tr><th>Quand</th><th>Client</th><th>Motif</th><th></th></tr>${rows || `<tr><td colspan="4" class="muted">Aucun handoff.</td></tr>`}</table></div>`;
        reply.type("text/html").send(await layout("Handoffs", "/admin/handoffs", body));
      });

      admin.post("/handoffs/:id/done", async (req, reply) => {
        const { id } = req.params as { id: string };
        const updated = await q.markHandoffDone(id, req.adminUser ?? "?");
        if (updated) {
          req.log.info({ handoffId: id, by: req.adminUser }, "Handoff marked done");
        }
        reply.redirect("/admin/handoffs", 303);
      });

      // ---------- À reprendre (boucle de résultat, §4.31) ----------
      const OUTCOME_BADGES: Record<string, [string, string]> = {
        resolved: ["#1a7f37", "résolue"],
        handed_off: ["#0969da", "transmise"],
        dropoff: ["#6e7781", "abandon libre"],
        deadend: ["#cf222e", "impasse"],
        technical_failure: ["#9a6700", "échec technique"],
      };
      const outcomeBadge = (outcome: string) => {
        const [color, label] = OUTCOME_BADGES[outcome] ?? ["#6e7781", outcome];
        return `<span class="badge" style="background:${color}">${escapeHtml(label)}</span>`;
      };

      admin.get("/reviews", async (_req, reply) => {
        const [open, recent, stats7, stats30] = await Promise.all([
          reviews.openReviews(),
          reviews.recentReviews(30),
          reviews.reviewStats(7),
          reviews.reviewStats(30),
        ]);
        const rate7 = reviews.satisfactionRate(stats7.byOutcome);
        const rate30 = reviews.satisfactionRate(stats30.byOutcome);

        const openCards = open
          .map(
            (r) => `<div class="card ${r.severity === "severe" ? "warn" : ""}">
${r.severity === "severe" ? `<span class="badge" style="background:#cf222e">🔴 grave</span> ` : ""}${outcomeBadge(r.outcome)} <span class="badge" style="background:#6e7781">${escapeHtml(r.need_category)}</span>
<div style="margin:.45rem 0"><a href="/admin/conversations/${r.client_id}"><b>${escapeHtml(r.client_name ?? "?")}</b></a> <span class="muted">+${escapeHtml(r.wa_phone)} · ${ago(r.created_at)}</span></div>
<div>${escapeHtml(r.summary ?? "")}</div>
${r.suggested_action ? `<div class="muted" style="margin-top:.25rem">→ ${escapeHtml(r.suggested_action)}</div>` : ""}
<div style="margin-top:.55rem">
<form class="inline" method="post" action="/admin/reviews/${r.id}/done"><button class="act">✅ Traité</button></form>
<form class="inline" method="post" action="/admin/reviews/${r.id}/ignore" style="margin-left:.4rem"><button class="act" style="background:#6e7781">Ignorer</button></form>
</div>
</div>`,
          )
          .join("");

        const statLine = (label: string, s: reviews.ReviewStats, rate: number | null) => {
          const parts = s.byOutcome
            .map((o) => `${o.n} ${(OUTCOME_BADGES[o.outcome] ?? ["", o.outcome])[1]}`)
            .join(" · ");
          return `<div class="stat"><span class="muted">${label}</span><b>${rate === null ? "—" : `${rate} %`}</b><span class="muted">${s.total ? parts : "rien de classé"}</span></div>`;
        };
        const topUnserved = stats30.topUnserved
          .map((t) => `<li><b>${escapeHtml(t.need_category)}</b> — ${t.n} conversation(s) perdue(s)</li>`)
          .join("");

        const recentRows = recent
          .map(
            (r) => `<tr>
<td>${ago(r.created_at)}</td>
<td><a href="/admin/conversations/${r.client_id}">${escapeHtml(r.client_name ?? "?")}</a></td>
<td>${outcomeBadge(r.outcome)}</td>
<td>${escapeHtml((r.summary ?? "").slice(0, 110))}</td>
</tr>`,
          )
          .join("");

        const body = `
<div class="stat-grid">
${statLine("Clients servis (7 j)", stats7, rate7)}
${statLine("Clients servis (30 j)", stats30, rate30)}
<div class="stat"><span class="muted">À reprendre</span><b>${open.length}</b></div>
</div>
${
  stats30.topUnserved.length
    ? `<div class="card"><b>Top besoins non servis (30 j)</b> — la matière pour améliorer Awa :<ul style="margin:.4rem 0 0">${topUnserved}</ul></div>`
    : ""
}
<h2>🔁 À reprendre (${open.length})</h2>
<p class="muted">Ces clients sont repartis sans obtenir ce qu'ils voulaient à cause d'une impasse ou
d'un échec technique (les abandons volontaires ne sont PAS listés). À recontacter par la réception —
« Traité » quand c'est fait. Les cas graves ont déjà déclenché une notification.</p>
${openCards || `<div class="card"><span class="ok">✓ Personne à reprendre — toutes les conversations classées se sont bien terminées.</span></div>`}
<h2>Dernières classifications (${recent.length})</h2>
<div class="card"><details><summary>Voir (contrôle qualité du classement)</summary>
<table><tr><th>Quand</th><th>Client</th><th>Issue</th><th>Résumé</th></tr>${recentRows || `<tr><td colspan="4" class="muted">Rien de classé encore — le classement tourne toutes les 5 min sur les conversations silencieuses depuis 45 min.</td></tr>`}</table>
</details></div>`;
        reply.type("text/html").send(await layout("À reprendre", "/admin/reviews", body));
      });

      const closeReviewRoute = (ignored: boolean) => async (req: any, reply: any) => {
        const { id } = req.params as { id: string };
        const updated = await reviews.closeReview(id, req.adminUser ?? "?", ignored);
        if (updated) {
          req.log.info({ reviewId: id, by: req.adminUser, ignored }, "Review closed");
        }
        reply.redirect("/admin/reviews", 303);
      };
      admin.post("/reviews/:id/done", closeReviewRoute(false));
      admin.post("/reviews/:id/ignore", closeReviewRoute(true));

      // ---------- Hygiène CRM (fiches sans téléphone, doublons à fusionner) ----------
      admin.get("/crm", async (req, reply) => {
        const done = (req.query as any)?.done as string | undefined;
        const err = (req.query as any)?.err as string | undefined;
        // One contacts fetch + one orders fetch feed everything: the audit
        // (duplicates/no-phone), the link-queue candidates, the plan badges
        // AND the unreachable-subscribers section.
        const [rawContacts, orders, linkQueue] = await Promise.all([
          fetchAllContacts(),
          listAllActiveOrders().catch(() => [] as any[]),
          links.receptionQueue().catch(() => []),
        ]);
        const plansByContact = new Map<string, string[]>();
        for (const o of orders) {
          const cid = o?.buyer?.contactId;
          if (!cid) continue;
          plansByContact.set(cid, [...(plansByContact.get(cid) ?? []), o.planName ?? "abonnement"]);
        }
        const unreachable = auditActiveSubscribers(orders, rawContacts, phoneMatchVariants);
        const audit = auditContacts(rawContacts);
        const allDupIds = audit.duplicates.flatMap((g) => g.contacts.map((c) => c.id));
        const [memberIds, dismissedSet, noPhoneActivity] = await Promise.all([
          findMemberContactIds(allDupIds).catch(() => new Set<string>()),
          q.dismissedDuplicateGroups().catch(() => new Set<string>()),
          contactBookingActivity(audit.noPhone.map((c) => c.id)).catch(() => ({
            upcoming: new Set<string>(),
            recent: new Set<string>(),
          })),
        ]);

        const banner = done
          ? `<div class="card" style="border-color:#1a7f37"><span class="ok">✓ ${
              done === "link"
                ? "Fiche liée — Awa reconnaît maintenant ce client."
                : done === "link-nowa"
                  ? "Fiche liée. Le client n'a PAS pu être prévenu sur WhatsApp (fenêtre 24h fermée) — il verra son abonnement à son prochain message."
                  : done === "dismissed"
                    ? "Demande ignorée."
                    : done === "traite"
                      ? "Groupe marqué traité — il n'apparaîtra plus (sauf si ses fiches changent). Restaurable en bas de la section doublons."
                      : done === "restaure"
                        ? "Groupe ré-affiché dans la liste."
                        : `Fusion effectuée (${escapeHtml(done)} fiche(s) absorbée(s)).`
            }</span></div>`
          : err
            ? `<div class="card warn">⚠️ Action refusée : ${escapeHtml(err)}</div>`
            : "";

        // ---------- Liaisons en attente (1 clic) ----------
        const linkCards = linkQueue
          .map((r) => {
            const claimedEmail = r.claimed_email ?? r.client_claimed_email;
            const candidates = linkCandidates(
              { claimedEmail, clientName: r.client_name },
              rawContacts,
            );
            const candRows = candidates
              .slice(0, 6)
              .map((c) => {
                const plans = plansByContact.get(c.id) ?? [];
                const badges =
                  (plans.length
                    ? ` <span class="badge" style="background:#8250df">🎫 ${escapeHtml(plans.join(" · "))}</span>`
                    : "") +
                  ` <span class="muted">(match : ${c.matchedBy.join(" + ")})</span>`;
                return `<tr>
<td><b>${escapeHtml(c.name)}</b>${badges}${c.email ? `<div class="muted">${escapeHtml(c.email)}</div>` : ""}</td>
<td>${c.phones.map((p) => escapeHtml(p)).join("<br>") || `<span class="muted">sans téléphone</span>`}</td>
<td><form class="inline" method="post" action="/admin/crm/link" onsubmit="return confirm('Ajouter le numéro WhatsApp +${escapeHtml(r.wa_phone)} à la fiche « ${escapeHtml(c.name).replaceAll("'", "\\'")} » ?')">
<input type="hidden" name="request" value="${escapeHtml(r.id)}">
<input type="hidden" name="contact" value="${escapeHtml(c.id)}">
<button class="act">Lier cette fiche</button>
</form></td>
</tr>`;
              })
              .join("");
            return `<div class="card warn">
<b>${escapeHtml(r.client_name ?? "?")}</b> — +${escapeHtml(r.wa_phone)}
${claimedEmail ? ` · email déclaré : <b>${escapeHtml(claimedEmail)}</b>` : ""}
<div class="muted">${escapeHtml(r.detail ?? "")} — demandé le ${fmtDate(r.created_at)}</div>
${
  candidates.length
    ? `<table><tr><th>Fiche candidate</th><th>Numéro(s)</th><th></th></tr>${candRows}</table>`
    : `<p class="muted">Aucune fiche candidate trouvée (ni par email ni par nom) — chercher manuellement dans Wix → Contacts, ajouter le numéro WhatsApp à la bonne fiche, puis ignorer cette demande.</p>`
}
<form class="inline" method="post" action="/admin/crm/link-dismiss" style="margin-top:.5rem" onsubmit="return confirm('Ignorer cette demande de liaison ?')">
<input type="hidden" name="request" value="${escapeHtml(r.id)}">
<button class="act" style="background:#6e7781">Ignorer</button>
</form>
</div>`;
          })
          .join("");
        const linkSection = linkQueue.length
          ? `<h2 id="liaisons">🔗 Liaisons en attente (${linkQueue.length})</h2>
<p class="muted">Ces clients affirment avoir un compte/abonnement mais la vérification par email n'a
pas abouti. Un clic sur « Lier cette fiche » AJOUTE leur numéro WhatsApp à la fiche choisie (sans
toucher à l'ancien numéro) — Awa les reconnaît immédiatement et le client est prévenu sur WhatsApp.</p>
${linkCards}`
          : "";

        const groupInfos = audit.duplicates.map((g) => {
          const ids = g.contacts.map((c) => c.id).join(",");
          const planHolders = new Set(
            g.contacts.filter((c) => plansByContact.has(c.id)).map((c) => c.id),
          );
          // Same rule as the POST enforcement — what you see is what merges.
          const plan = planMerge(g.contacts, planHolders, memberIds);
          const keeper = g.contacts.find((c) => c.id === plan?.targetId);
          const hasPlan = planHolders.size > 0;
          const rows = g.contacts
            .map((c) => {
              const plans = plansByContact.get(c.id) ?? [];
              const badges =
                (memberIds.has(c.id)
                  ? ` <span class="badge" style="background:#0969da">👤 compte membre</span>`
                  : "") +
                (plans.length
                  ? ` <span class="badge" style="background:#8250df">🎫 ${escapeHtml(plans.join(" · "))}</span>`
                  : "");
              const fate = !plan
                ? `<span class="muted">—</span>`
                : c.id === plan.targetId
                  ? `<span class="ok">✓ conservée</span>`
                  : plan.sourceIds.includes(c.id)
                    ? `<span class="muted">fusionnée puis supprimée</span>`
                    : `<span class="muted">reste telle quelle (protégée)</span>`;
              return `<tr>
<td><b>${escapeHtml(c.name)}</b>${badges}${c.email ? `<div class="muted">${escapeHtml(c.email)}</div>` : ""}</td>
<td>${c.phones.map((p) => escapeHtml(p)).join("<br>")}${c.hasE164 ? ` <span class="muted">✓ intl</span>` : ""}</td>
<td class="hide-sm">${c.createdDate ? fmtDate(c.createdDate) : "—"}</td>
<td>${fate}</td>
</tr>`;
            })
            .join("");
          const leftoverNote = plan?.leftoverIds.length
            ? ` <span class="muted">(${plan.leftoverIds.length} fiche(s) protégée(s) — compte membre ou abonnement — resteront : Wix interdit de les fusionner ; à traiter avec la réception si besoin.)</span>`
            : "";
          const signature = q.duplicateGroupSignature(g.contacts.map((c) => c.id));
          const action = plan
            ? `<form class="inline" method="post" action="/admin/crm/merge" onsubmit="return confirm('Fusionner ${plan.sourceIds.length} fiche(s) dans « ${escapeHtml(keeper?.name ?? "?").replaceAll("'", "\\'")} » ?\\n\\nLes fiches fusionnées sont SUPPRIMÉES (irréversible).')">
<input type="hidden" name="group" value="${ids}">
<button class="act">Fusionner ${plan.sourceIds.length} fiche(s)</button>
</form>${leftoverNote}`
            : `<span class="muted">⚠️ Rien à fusionner automatiquement : ces fiches sont des comptes membres (Wix interdit de fusionner deux membres). À traiter dans Wix avec la réception.</span>
<form class="inline" method="post" action="/admin/crm/merge-dismiss" style="margin-left:.4rem" onsubmit="return confirm('Marquer ce groupe comme traité ?\\n\\nIl disparaîtra de la liste (restaurable), et réapparaîtra tout seul si ses fiches changent.')">
<input type="hidden" name="key" value="${escapeHtml(g.key)}">
<input type="hidden" name="group" value="${ids}">
<button class="act" style="background:#6e7781">✅ Traité dans Wix</button>
</form>`;
          const html = `<div class="card ${hasPlan ? "warn" : ""}">
<b>…${escapeHtml(g.key)}</b> — ${g.contacts.length} fiches pour ce numéro${hasPlan ? ` <span class="badge" style="background:#cf222e">abonnée non reconnue</span>` : ""}
<table><tr><th>Fiche</th><th>Numéro(s) enregistré(s)</th><th class="hide-sm">Créée</th><th>Sort</th></tr>${rows}</table>
<div style="margin-top:.5rem">${action}</div>
</div>`;
          return {
            html,
            hasPlan,
            actionable: plan !== null,
            key: g.key,
            signature,
            dismissed: plan === null && dismissedSet.has(`${g.key}|${signature}`),
            names: g.contacts.map((c) => c.name).join(" / "),
          };
        });

        // A duplicate involving an active abonnement is CRITICAL: the client
        // pays a plan Awa cannot see (ambiguous match → no plan found → asked
        // to pay Wave again). Those groups come first, actionable ones next.
        // Groups marked "traité" (member-only, handled in Wix) are folded away.
        const visible = groupInfos.filter((g) => !g.dismissed);
        const treated = groupInfos.filter((g) => g.dismissed);
        const priority = visible.filter((g) => g.hasPlan);
        const rest = visible.filter((g) => !g.hasPlan);
        const byActionable = (a: (typeof groupInfos)[number], b: (typeof groupInfos)[number]) =>
          Number(b.actionable) - Number(a.actionable);
        const prioritySection = priority.length
          ? `<h2>🔴 Prioritaires — une abonnée active n'est pas reconnue (${priority.length})</h2>
<p class="muted">Ces clientes paient un abonnement mais Awa ne peut pas les identifier tant que le
doublon existe : à leur prochain message, Awa leur proposera de payer par Wave. À traiter en premier.</p>
${priority.sort(byActionable).map((g) => g.html).join("")}`
          : "";
        const treatedSection = treated.length
          ? `<div class="card"><details><summary>✅ Groupes marqués traités (${treated.length})</summary>
<table><tr><th>Numéro</th><th>Fiches</th><th></th></tr>${treated
              .map(
                (g) => `<tr><td>…${escapeHtml(g.key)}</td><td>${escapeHtml(g.names)}</td>
<td><form class="inline" method="post" action="/admin/crm/merge-restore">
<input type="hidden" name="key" value="${escapeHtml(g.key)}">
<input type="hidden" name="sig" value="${escapeHtml(g.signature)}">
<button class="act" style="background:#6e7781">Ré-afficher</button>
</form></td></tr>`,
              )
              .join("")}</table></details></div>`
          : "";
        const groupCards =
          prioritySection +
          (rest.length
            ? `<h2>Autres doublons (${rest.length})</h2>
${rest.sort(byActionable).map((g) => g.html).join("")}`
            : "") +
          treatedSection;

        // Active clients first: an upcoming booking, a booking in the last
        // 30 days, or a live plan means Awa will fail on them SOON — the
        // dormant rest can wait.
        const isActive = (id: string) =>
          noPhoneActivity.upcoming.has(id) ||
          noPhoneActivity.recent.has(id) ||
          plansByContact.has(id);
        const noPhoneActive = audit.noPhone
          .filter((c) => isActive(c.id))
          .sort(
            (a, b) =>
              Number(noPhoneActivity.upcoming.has(b.id)) -
              Number(noPhoneActivity.upcoming.has(a.id)),
          );
        const noPhoneDormant = audit.noPhone.filter((c) => !isActive(c.id));
        const noPhoneRow = (c: (typeof audit.noPhone)[number]) => {
          const badges =
            (noPhoneActivity.upcoming.has(c.id)
              ? ` <span class="badge" style="background:#1a7f37">📅 résa à venir</span>`
              : "") +
            (noPhoneActivity.recent.has(c.id)
              ? ` <span class="badge" style="background:#57606a">📅 résa &lt; 30 j</span>`
              : "") +
            ((plansByContact.get(c.id) ?? []).length
              ? ` <span class="badge" style="background:#8250df">🎫 ${escapeHtml((plansByContact.get(c.id) ?? []).join(" · "))}</span>`
              : "");
          return `<tr><td>${escapeHtml(c.name)}${badges}</td><td>${escapeHtml(c.email ?? "—")}</td></tr>`;
        };
        const noPhoneActiveBlock = noPhoneActive.length
          ? `<div class="card warn"><b>🔴 Actives — à compléter en premier (${noPhoneActive.length})</b>
<p class="muted">Elles ont une résa à venir, une résa dans les 30 derniers jours, ou un abonnement en
cours : Awa échouera sur elles à leur prochain message.</p>
<table><tr><th>Nom</th><th>Email</th></tr>${noPhoneActive.map(noPhoneRow).join("")}</table></div>`
          : "";
        const noPhoneRows = noPhoneDormant.map(noPhoneRow).join("");

        const issueLabel: Record<string, string> = {
          contact_missing: "fiche supprimée ou introuvable",
          no_phone: "aucun téléphone sur la fiche",
          phone_unmatchable: "numéro mal formaté (illisible pour Awa)",
        };
        const unreachableRows = unreachable
          .map(
            (u) => `<tr>
<td><b>${escapeHtml(u.contact?.name ?? u.contactId)}</b>${u.contact?.email ? `<div class="muted">${escapeHtml(u.contact.email)}</div>` : ""}</td>
<td>${u.plans.map((p) => `🎫 ${escapeHtml(p.planName)}${p.endDate ? ` <span class="muted">(fin ${fmtDate(p.endDate)})</span>` : ""}`).join("<br>")}</td>
<td>${escapeHtml(issueLabel[u.issue] ?? u.issue)}</td>
<td>${(u.contact?.phones ?? []).map((p) => escapeHtml(p)).join("<br>") || `<span class="muted">—</span>`}</td>
</tr>`,
          )
          .join("");
        const unreachableSection = unreachable.length
          ? `<h2 id="injoignables">🎫 Abonnés injoignables (${unreachable.length})</h2>
<p class="muted">Ces clientes paient un abonnement ACTIF mais Awa ne pourra jamais les reconnaître :
leur fiche n'a pas de numéro utilisable. C'est exactement la population du cas « abonnement
introuvable » — à compléter dans Wix → Contacts avec leur numéro WhatsApp (+221...), en priorité.</p>
<div class="card warn"><table><tr><th>Abonnée</th><th>Abonnement(s)</th><th>Problème</th><th>Numéro(s) enregistré(s)</th></tr>${unreachableRows}</table></div>`
          : "";

        const body = `
${banner}
<nav class="jump-nav" aria-label="Sections CRM">
  <a href="#liaisons">Liaisons${linkQueue.length ? ` (${linkQueue.length})` : ""}</a>
  <a href="#injoignables">Injoignables${unreachable.length ? ` (${unreachable.length})` : ""}</a>
  <a href="#doublons">Doublons${audit.duplicates.length ? ` (${audit.duplicates.length})` : ""}</a>
  <a href="#sans-tel">Sans téléphone${audit.noPhone.length ? ` (${audit.noPhone.length})` : ""}</a>
</nav>
<div class="stat-grid">
<div class="stat"><span class="muted">Fiches contact Wix</span><b>${audit.total}</b></div>
<div class="stat"><span class="muted">Liaisons en attente</span><b>${linkQueue.length}</b></div>
<div class="stat"><span class="muted">Abonnés injoignables</span><b>${unreachable.length}</b></div>
<div class="stat"><span class="muted">Numéros en doublon</span><b>${audit.duplicates.length}</b></div>
<div class="stat"><span class="muted">Fiches sans téléphone</span><b>${audit.noPhone.length}</b></div>
</div>
${linkSection || `<h2 id="liaisons">🔗 Liaisons en attente</h2><div class="card"><span class="ok">✓ Aucune liaison en attente.</span></div>`}
${unreachableSection || `<h2 id="injoignables" class="muted" style="font-size:.9rem">Abonnés injoignables — aucun</h2>`}
<h2 id="doublons">👯 Doublons à fusionner ${audit.duplicates.length ? `(${audit.duplicates.length})` : ""}</h2>
<p class="muted">Awa refuse (prudemment) de choisir quand un numéro correspond à plusieurs fiches :
ces clientes ne sont pas reconnues. Un clic fusionne le groupe — la fiche conservée (✓) est choisie
automatiquement : compte membre 👤 et abonnement 🎫 d'abord (Wix interdit de les fusionner comme
sources), sinon numéro international, sinon la plus ancienne. Les fiches fusionnées sont supprimées
par Wix ; les fiches protégées restent telles quelles.</p>
${groupCards || `<div class="card"><span class="ok">✓ Aucun doublon — rien à nettoyer.</span></div>`}
<h2 id="sans-tel">📵 Fiches sans téléphone ${audit.noPhone.length ? `(${audit.noPhone.length})` : ""}</h2>
<p class="muted">Invisibles pour Awa (elle reconnaît les clientes par leur numéro WhatsApp).
À compléter directement dans Wix → Contacts, avec le numéro WhatsApp de la cliente.</p>
${noPhoneActiveBlock}
<div class="card">
${noPhoneDormant.length ? `<details><summary>Fiches dormantes — sans résa à venir ni abonnement (${noPhoneDormant.length})</summary><table><tr><th>Nom</th><th>Email</th></tr>${noPhoneRows}</table></details>` : audit.noPhone.length === 0 ? `<span class="ok">✓ Toutes les fiches ont un téléphone.</span>` : `<span class="ok">✓ Aucune fiche dormante.</span>`}
</div>`;
        reply.type("text/html").send(await layout("CRM", "/admin/crm", body));
      });

      admin.post("/crm/merge", async (req, reply) => {
        const bodyIn = (req.body ?? {}) as Record<string, string>;
        const group = String(bodyIn.group ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const fail = (msg: string) =>
          reply.redirect(`/admin/crm?err=${encodeURIComponent(msg)}`, 303);

        if (group.length < 2) return fail("groupe invalide");
        // Re-verify server-side — the merge is irreversible, never trust the
        // form alone: the fiches must still exist AND share the same number.
        const contacts = await Promise.all(group.map((id) => getContactById(id)));
        if (contacts.some((c) => !c)) {
          return fail("une fiche du groupe n'existe plus — recharge la page");
        }
        const keys = contacts.map(
          (c) =>
            new Set(
              (c.info?.phones?.items ?? [])
                .map((p: any) => phoneKey(String(p?.e164Phone ?? p?.phone ?? "")))
                .filter(Boolean),
            ),
        );
        const first = keys[0];
        const allShare = keys.every((set) => [...set].some((k) => first.has(k)));
        if (!allShare) {
          return fail("les fiches ne partagent pas le même numéro — fusion refusée");
        }
        // The merge plan is recomputed HERE with the same rule as the page:
        // member accounts and plan holders are never merge sources (Wix 428 /
        // plan-survival risk) — they survive or stay aside.
        const [plansByContact, memberIds] = await Promise.all([
          activePlansByContact().catch(() => null),
          findMemberContactIds(group).catch(() => null),
        ]);
        if (plansByContact === null || memberIds === null) {
          return fail("impossible de vérifier abonnements/comptes membres — réessaie");
        }
        const plan = planMerge(
          contacts.map((c, i) => ({
            id: group[i],
            hasE164: (c.info?.phones?.items ?? []).some(
              (p: any) => typeof p?.e164Phone === "string" && p.e164Phone.length > 5,
            ),
            createdDate: c.createdDate ?? null,
          })),
          new Set(group.filter((id) => plansByContact.has(id))),
          memberIds,
        );
        if (!plan) {
          return fail(
            "rien à fusionner automatiquement dans ce groupe (comptes membres) — à traiter dans Wix",
          );
        }

        try {
          await mergeContacts(plan.targetId, plan.sourceIds);
          req.log.info(
            { target: plan.targetId, sources: plan.sourceIds, by: req.adminUser },
            "CRM duplicate contacts merged from admin dashboard",
          );
          return reply.redirect(`/admin/crm?done=${plan.sourceIds.length}`, 303);
        } catch (e) {
          req.log.error({ err: e, target: plan.targetId, sources: plan.sourceIds }, "CRM merge failed");
          return fail("erreur Wix pendant la fusion — réessaie");
        }
      });

      // ---------- Liaison 1 clic : numéro WhatsApp → fiche Wix choisie ----------
      // Mark a non-mergeable duplicate group (member accounts) as handled in
      // Wix: hides it from the list. Reversible, and the group reappears by
      // itself if its composition changes (signature recomputed server-side).
      admin.post("/crm/merge-dismiss", async (req, reply) => {
        const bodyIn = (req.body ?? {}) as Record<string, string>;
        const key = String(bodyIn.key ?? "").trim();
        const group = String(bodyIn.group ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (!key || group.length < 2) {
          return reply.redirect(`/admin/crm?err=${encodeURIComponent("groupe invalide")}`, 303);
        }
        await q.dismissDuplicateGroup(key, q.duplicateGroupSignature(group), req.adminUser ?? "?");
        req.log.info({ key, group, by: req.adminUser }, "CRM duplicate group marked handled");
        return reply.redirect("/admin/crm?done=traite", 303);
      });

      admin.post("/crm/merge-restore", async (req, reply) => {
        const bodyIn = (req.body ?? {}) as Record<string, string>;
        const key = String(bodyIn.key ?? "").trim();
        const sig = String(bodyIn.sig ?? "").trim();
        if (key && sig) {
          await q.restoreDuplicateGroup(key, sig);
          req.log.info({ key, by: req.adminUser }, "CRM duplicate group restored");
        }
        return reply.redirect("/admin/crm?done=restaure", 303);
      });

      admin.post("/crm/link", async (req, reply) => {
        const bodyIn = (req.body ?? {}) as Record<string, string>;
        const fail = (msg: string) =>
          reply.redirect(`/admin/crm?err=${encodeURIComponent(msg)}`, 303);

        // Server-side re-verification, pattern merge: the request must still
        // be open, the fiche must still exist, and the number must not
        // already resolve to another fiche (that would be a MERGE, not a
        // link — the duplicates section handles it).
        const request = await links.getByIdForAdmin(String(bodyIn.request ?? ""));
        if (!request) return fail("demande introuvable — recharge la page");
        if (!["NEEDS_RECEPTION", "AWAITING_EMAIL", "AWAITING_CODE"].includes(request.status)) {
          return fail("cette demande est déjà traitée — recharge la page");
        }
        const contactId = String(bodyIn.contact ?? "");
        const contact = await getContactById(contactId).catch(() => null);
        if (!contact) return fail("cette fiche n'existe plus — recharge la page");
        const wa = `+${request.wa_phone.replace(/^\+/, "")}`;
        const resolved = await findContactIdByPhone(wa, request.client_name ?? undefined).catch(
          () => null,
        );
        if (resolved && resolved !== contactId) {
          return fail(
            "ce numéro WhatsApp est déjà porté par une AUTRE fiche — c'est une fusion, pas une " +
              "liaison : traite-le dans la section Doublons",
          );
        }

        try {
          await addPhoneToContact(contactId, wa);
        } catch (e) {
          req.log.error({ err: e, contactId, request: request.id }, "CRM link failed");
          return fail("erreur Wix pendant l'ajout du numéro — réessaie");
        }
        await links.markLinked(request.id, contactId, req.adminUser ?? "?");
        invalidateMembershipCache(request.client_id);
        req.log.info(
          { contactId, request: request.id, wa, by: req.adminUser },
          "WhatsApp number linked to Wix contact from admin dashboard",
        );
        // Tell the client — best-effort: outside WhatsApp's 24h window Meta
        // rejects free-form sends (131047); the linking itself stays done.
        try {
          await sendText(
            request.wa_phone,
            "✅ C'est bon ! Ton compte Revive est maintenant relié à ce numéro WhatsApp — " +
              "je reconnais ton abonnement et ton historique. Dis-moi si tu veux réserver un cours 🙂",
          );
        } catch {
          return reply.redirect(`/admin/crm?done=link-nowa`, 303);
        }
        return reply.redirect(`/admin/crm?done=link`, 303);
      });

      admin.post("/crm/link-dismiss", async (req, reply) => {
        const bodyIn = (req.body ?? {}) as Record<string, string>;
        const request = await links.getByIdForAdmin(String(bodyIn.request ?? ""));
        if (!request) {
          return reply.redirect(
            `/admin/crm?err=${encodeURIComponent("demande introuvable — recharge la page")}`,
            303,
          );
        }
        await links.dismiss(request.id, req.adminUser ?? "?");
        req.log.info({ request: request.id, by: req.adminUser }, "Link request dismissed");
        return reply.redirect(`/admin/crm?done=dismissed`, 303);
      });

      // ---------- Profil WhatsApp Business (photo, description, adresse, horaires) ----------
      admin.get("/profile", async (req, reply) => {
        const done = (req.query as any)?.done as string | undefined;
        const err = (req.query as any)?.err as string | undefined;

        const local = await q.getLocalWhatsAppProfile().catch(() => null);
        let live: Awaited<ReturnType<typeof getBusinessProfile>> = {};
        try {
          live = await getBusinessProfile();
        } catch (e) {
          req.log.warn({ err: e }, "Failed to fetch live WhatsApp business profile");
        }

        const description = local?.description ?? live.description ?? "";
        const address = local?.address ?? live.address ?? "";
        const hours = local?.hours ?? "";

        const banner = done
          ? `<div class="card" style="border-color:#1a7f37"><span class="ok">✓ ${
              done === "photo-err"
                ? "Description/adresse enregistrées. La photo n'a PAS pu être changée (voir ci-dessous)."
                : "Profil WhatsApp Business mis à jour."
            }</span></div>`
          : err
            ? `<div class="card warn">⚠️ ${escapeHtml(err)}</div>`
            : "";

        const photoSection = config.WA_APP_ID
          ? `<label>URL d'une photo (carrée, JPG/PNG)<input type="url" name="photo_url" placeholder="https://…"></label>
<p class="muted">Laisser vide pour ne pas changer la photo actuelle.</p>`
          : `<p class="muted">⚠️ Édition de la photo désactivée (variable d'env <code>WA_APP_ID</code> non configurée).</p>`;

        reply.type("text/html").send(
          await layout(
            "Profil WhatsApp",
            "/admin/profile",
            `<h2>Profil WhatsApp Business</h2>
${banner}
<div class="card">
${
  live.profile_picture_url
    ? `<img src="${escapeHtml(live.profile_picture_url)}" alt="Photo de profil actuelle" style="width:96px;height:96px;border-radius:50%;object-fit:cover;margin-bottom:.8rem">`
    : ""
}
<form method="post" action="/admin/profile" style="display:flex;flex-direction:column;gap:.8rem">
<label>Description<textarea name="description" rows="5" maxlength="512" style="width:100%;padding:.55rem .8rem;border:1px solid #e4ddd3;border-radius:10px;font:inherit">${escapeHtml(description)}</textarea></label>
<label>Adresse<input type="text" name="address" maxlength="256" value="${escapeHtml(address)}" style="width:100%;padding:.55rem .8rem;border:1px solid #e4ddd3;border-radius:10px;font:inherit"></label>
<label>Horaires <span class="muted">(pas de champ dédié côté WhatsApp — ajoutés automatiquement à la fin de la description)</span><textarea name="hours" rows="4" style="width:100%;padding:.55rem .8rem;border:1px solid #e4ddd3;border-radius:10px;font:inherit">${escapeHtml(hours)}</textarea></label>
${photoSection}
<button class="act" style="align-self:flex-start">Enregistrer</button>
</form>
</div>`,
          ),
        );
      });

      admin.post("/profile", async (req, reply) => {
        const bodyIn = (req.body ?? {}) as Record<string, string>;
        const fail = (msg: string) => reply.redirect(`/admin/profile?err=${encodeURIComponent(msg)}`, 303);

        const description = String(bodyIn.description ?? "").trim();
        const address = String(bodyIn.address ?? "")
          .trim()
          .slice(0, 256);
        const hours = String(bodyIn.hours ?? "").trim();
        const photoUrl = String(bodyIn.photo_url ?? "").trim();

        const composedDescription = composeBusinessDescription(description, hours);

        try {
          await updateBusinessProfile({ description: composedDescription, address });
        } catch (e) {
          req.log.error({ err: e }, "WhatsApp business profile update failed");
          return fail("échec de la mise à jour du profil WhatsApp — réessaie");
        }

        await q.saveLocalWhatsAppProfile({ description, address, hours }, req.adminUser ?? "?");
        req.log.info({ by: req.adminUser }, "WhatsApp business profile updated from admin dashboard");

        if (!photoUrl) {
          return reply.redirect("/admin/profile?done=1", 303);
        }

        try {
          const imgRes = await fetch(photoUrl, { signal: AbortSignal.timeout(15_000) });
          if (!imgRes.ok) throw new Error(`download failed (${imgRes.status})`);
          const mimeType = imgRes.headers.get("content-type") ?? "image/jpeg";
          const bytes = Buffer.from(await imgRes.arrayBuffer());
          const handle = await uploadProfilePictureHandle(bytes, mimeType);
          await updateBusinessProfile({ profile_picture_handle: handle });
        } catch (e) {
          req.log.error({ err: e }, "WhatsApp business profile photo update failed");
          return reply.redirect("/admin/profile?done=photo-err", 303);
        }

        return reply.redirect("/admin/profile?done=1", 303);
      });

      // ---------- Planning du personnel (grille interactive + envoi WhatsApp) ----------
      async function staffPlanningView(scheduleId: string | undefined, banner: string, showNew: boolean, reply: any) {
        const schedules = await staffPlan.listSchedules();
        const current =
          (scheduleId ? await staffPlan.getSchedule(scheduleId) : null) ??
          schedules.find((s) => s.status === "published") ??
          schedules[0] ??
          null;
        const [shifts, staff] = await Promise.all([
          current ? staffPlan.getShifts(current.id) : Promise.resolve([]),
          staffPlan.listPlanningStaff(),
        ]);
        const body = renderStaffPlanning(
          Object.assign({ schedules, current, shifts, staff, banner }, { showNewForm: showNew }),
        );
        reply.type("text/html").send(await layout("Équipe", "/admin/staff", body));
      }

      admin.get("/staff", async (req, reply) => {
        const q = req.query as any;
        return staffPlanningView(q?.s, staffBanner(q?.done, q?.err), q?.new === "1", reply);
      });

      admin.post("/staff", async (req, reply) => {
        const name = String((req.body as any)?.name ?? "").trim();
        if (!name) return reply.redirect("/admin/staff?err=nom obligatoire", 303);
        const s = await staffPlan.createSchedule(name, req.adminUser ?? null);
        return reply.redirect(`/admin/staff?s=${s.id}&done=created`, 303);
      });

      admin.post("/staff/duplicate", async (req, reply) => {
        const b = req.body as any;
        const name = String(b?.name ?? "").trim() || "Copie";
        const dup = await staffPlan.duplicateSchedule(String(b?.source_id ?? ""), name, req.adminUser ?? null);
        if (!dup) return reply.redirect("/admin/staff?err=planning introuvable", 303);
        return reply.redirect(`/admin/staff?s=${dup.id}&done=duplicated`, 303);
      });

      admin.post("/staff/:id/rename", async (req, reply) => {
        const { id } = req.params as { id: string };
        const name = String((req.body as any)?.name ?? "").trim();
        if (name) await staffPlan.renameSchedule(id, name);
        return reply.redirect(`/admin/staff?s=${id}&done=renamed`, 303);
      });

      admin.post("/staff/:id/publish", async (req, reply) => {
        const { id } = req.params as { id: string };
        const ok = await staffPlan.publishSchedule(id);
        req.log.info({ schedule: id, by: req.adminUser }, "Staff schedule published");
        return reply.redirect(ok ? `/admin/staff?s=${id}&done=published` : "/admin/staff?err=planning introuvable", 303);
      });

      admin.post("/staff/:id/delete", async (req, reply) => {
        const { id } = req.params as { id: string };
        const ok = await staffPlan.deleteSchedule(id);
        return reply.redirect(ok ? "/admin/staff?done=deleted" : "/admin/staff?err=seul un brouillon peut être supprimé", 303);
      });

      admin.post("/staff/:id/grid", async (req, reply) => {
        const { id } = req.params as { id: string };
        const schedule = await staffPlan.getSchedule(id);
        if (!schedule) return reply.redirect("/admin/staff?err=planning introuvable", 303);
        const staff = await staffPlan.listPlanningStaff();
        const known = new Set(staff.map((s) => s.id));
        const parsed = validateGridPayload(String((req.body as any)?.grid ?? ""), known);
        if ("error" in parsed) return reply.redirect(`/admin/staff?s=${id}&err=${encodeURIComponent(parsed.error)}`, 303);
        await staffPlan.replaceShifts(id, parsed.shifts);
        req.log.info({ schedule: id, shifts: parsed.shifts.length, by: req.adminUser }, "Staff grid saved");
        return reply.redirect(`/admin/staff?s=${id}&done=saved`, 303);
      });

      admin.get("/staff/:id/print", async (req, reply) => {
        const { id } = req.params as { id: string };
        const schedule = await staffPlan.getSchedule(id);
        if (!schedule) return reply.code(404).type("text/plain").send("Planning introuvable");
        const [shifts, staff] = await Promise.all([staffPlan.getShifts(id), staffPlan.listPlanningStaff()]);
        reply.type("text/html").send(renderStaffPrint(schedule, shifts, staff));
      });

      // Send one employee her own schedule on WhatsApp (staff = out of the 24h
      // window → template-first, like every other staff ping).
      async function sendStaffPlanning(
        schedule: staffPlan.StaffSchedule,
        staffMember: staffPlan.PlanningStaff,
        allShifts: staffPlan.StaffShift[],
        log: any,
      ): Promise<"sent" | "no_phone" | "no_shift" | "failed"> {
        if (!staffMember.phone) return "no_phone";
        const mine = allShifts.filter((s) => s.staff_id === staffMember.id);
        if (mine.length === 0) return "no_shift";
        const { subject, body } = buildEmployeeScheduleMessage(schedule.name, staffMember.name, mine);
        try {
          const path = await sendWhatsAppNotification(staffMember.phone, subject, body, { preferTemplate: true });
          await nrepo.recordStaffPlanningLog(staffMember.phone, `[planning ${schedule.name}] ${staffMember.name}`, path, null);
          return "sent";
        } catch (e) {
          await nrepo.recordStaffPlanningLog(staffMember.phone, `[planning ${schedule.name}] ${staffMember.name}`, "failed", String(e).slice(0, 300));
          log.error({ err: e, staff: staffMember.id }, "Staff planning send failed");
          return "failed";
        }
      }

      admin.post("/staff/:id/send/:staffId", async (req, reply) => {
        const { id, staffId } = req.params as { id: string; staffId: string };
        const schedule = await staffPlan.getSchedule(id);
        if (!schedule) return reply.redirect("/admin/staff?err=planning introuvable", 303);
        const [shifts, staff] = await Promise.all([staffPlan.getShifts(id), staffPlan.listPlanningStaff()]);
        const member = staff.find((s) => s.id === staffId);
        if (!member) return reply.redirect(`/admin/staff?s=${id}&err=employée introuvable`, 303);
        const r = await sendStaffPlanning(schedule, member, shifts, req.log);
        if (r === "no_phone") return reply.redirect(`/admin/staff?s=${id}&err=no-phone`, 303);
        if (r === "no_shift") return reply.redirect(`/admin/staff?s=${id}&err=${encodeURIComponent(member.name + " n'a aucun horaire")}`, 303);
        if (r === "failed") return reply.redirect(`/admin/staff?s=${id}&err=${encodeURIComponent("échec de l'envoi WhatsApp")}`, 303);
        return reply.redirect(`/admin/staff?s=${id}&done=${encodeURIComponent("sent:" + member.name)}`, 303);
      });

      admin.post("/staff/:id/send-all", async (req, reply) => {
        const { id } = req.params as { id: string };
        const schedule = await staffPlan.getSchedule(id);
        if (!schedule) return reply.redirect("/admin/staff?err=planning introuvable", 303);
        const [shifts, staff] = await Promise.all([staffPlan.getShifts(id), staffPlan.listPlanningStaff()]);
        let sent = 0, noPhone = 0, noShift = 0;
        for (const member of staff) {
          const r = await sendStaffPlanning(schedule, member, shifts, req.log);
          if (r === "sent") sent++;
          else if (r === "no_phone") noPhone++;
          else if (r === "no_shift") noShift++;
        }
        req.log.info({ schedule: id, sent, noPhone, noShift, by: req.adminUser }, "Staff planning sent to all");
        return reply.redirect(`/admin/staff?s=${id}&done=sent-all:${sent}:${noPhone}:${noShift}`, 303);
      });

      // ---------- Notifications automatiques (rappels staff, journal) ----------
      const NOTIF_BANNERS: Record<string, string> = {
        created: "Règle créée.",
        updated: "Règle mise à jour.",
        deleted: "Règle supprimée.",
        toggled: "Règle mise en pause / réactivée.",
        tested: "Message de test envoyé (voir le journal).",
        "test-failed": "Envoi de test échoué — voir le journal.",
        "contact-added": "Contact ajouté.",
        "contact-deleted": "Contact supprimé.",
        "contact-muted": "Contact muté / réactivé.",
      };

      function banner(done?: string, err?: string): string {
        if (done && NOTIF_BANNERS[done]) {
          return `<div class="card" style="border-color:#1a7f37"><span class="ok">✓ ${escapeHtml(NOTIF_BANNERS[done])}</span></div>`;
        }
        if (err) return `<div class="card warn">⚠️ ${escapeHtml(err)}</div>`;
        return "";
      }

      /** Build a RuleInput from a posted form, normalizing per-kind fields. */
      function parseRuleInput(b: Record<string, string>): nrepo.RuleInput | { error: string } {
        const label = String(b.label ?? "").trim();
        const kind = b.kind === "fixed_schedule" ? "fixed_schedule" : "class_reminder";
        const message = String(b.message_template ?? "").trim();
        if (!label) return { error: "le nom de la règle est obligatoire" };
        if (!message) return { error: "le message est obligatoire" };
        const intOrNull = (v: unknown) => {
          const n = parseInt(String(v ?? "").trim(), 10);
          return Number.isFinite(n) ? n : null;
        };
        const recipientKind = b.recipient_kind === "coach" ? "coach" : "phone";
        const phone = String(b.recipient_phone ?? "").trim() || null;

        if (kind === "class_reminder") {
          if (intOrNull(b.lead_minutes) === null)
            return { error: "les minutes avant le cours sont obligatoires" };
          if (recipientKind === "phone" && !phone)
            return { error: "un numéro destinataire est requis (ou choisir « coach »)" };
          return {
            label,
            kind,
            class_pattern: String(b.class_pattern ?? "").trim() || null,
            exclude_pattern: String(b.exclude_pattern ?? "").trim() || null,
            lead_minutes: intOrNull(b.lead_minutes),
            suppress_gap_minutes: intOrNull(b.suppress_gap_minutes),
            recipient_kind: recipientKind,
            recipient_phone: recipientKind === "coach" ? null : phone,
            days_of_week: null,
            send_time: null,
            message_template: message,
            group_only: b.group_only === "1",
          };
        }
        // fixed_schedule
        const days = String(b.days_of_week ?? "").trim();
        const time = String(b.send_time ?? "").trim();
        if (!days) return { error: "les jours sont obligatoires (ex : 6 pour samedi)" };
        if (!/^\d{1,2}:\d{2}$/.test(time)) return { error: "heure invalide (format HH:MM)" };
        if (!phone) return { error: "un numéro destinataire est requis" };
        return {
          label,
          kind,
          class_pattern: null,
          exclude_pattern: null,
          lead_minutes: null,
          suppress_gap_minutes: null,
          recipient_kind: "phone",
          recipient_phone: phone,
          days_of_week: days,
          send_time: time,
          message_template: message,
          group_only: false,
        };
      }

      admin.get("/notifications", async (req, reply) => {
        const editId = (req.query as any)?.edit as string | undefined;
        const done = (req.query as any)?.done as string | undefined;
        const err = (req.query as any)?.err as string | undefined;
        const [rules, contacts, log, lastByRule] = await Promise.all([
          q.listNotificationRules(),
          q.listStaffContacts(),
          q.listNotificationLog(100),
          q.lastLogPerRule(),
        ]);
        const editRule = editId ? (rules.find((r) => r.id === editId) ?? null) : null;
        const body = renderNotificationsPage({
          rules,
          contacts,
          log,
          lastByRule,
          coachHints: cachedCoachNames(),
          editRule,
          banner: banner(done, err),
          testPhone: config.NOTIF_TEST_PHONE,
        });
        reply.type("text/html").send(await layout("Notifications", "/admin/notifications", body));
      });

      admin.post("/notifications/rules", async (req, reply) => {
        const parsed = parseRuleInput((req.body ?? {}) as Record<string, string>);
        if ("error" in parsed) {
          return reply.redirect(`/admin/notifications?err=${encodeURIComponent(parsed.error)}`, 303);
        }
        await nrepo.createRule(parsed);
        req.log.info({ by: req.adminUser, label: parsed.label }, "Notification rule created");
        return reply.redirect("/admin/notifications?done=created", 303);
      });

      admin.post("/notifications/rules/:id/update", async (req, reply) => {
        const { id } = req.params as { id: string };
        const parsed = parseRuleInput((req.body ?? {}) as Record<string, string>);
        if ("error" in parsed) {
          return reply.redirect(`/admin/notifications?edit=${id}&err=${encodeURIComponent(parsed.error)}`, 303);
        }
        await nrepo.updateRule(id, parsed);
        req.log.info({ by: req.adminUser, ruleId: id }, "Notification rule updated");
        return reply.redirect("/admin/notifications?done=updated", 303);
      });

      admin.post("/notifications/rules/:id/toggle", async (req, reply) => {
        const { id } = req.params as { id: string };
        const rule = await nrepo.getRule(id);
        if (rule) await nrepo.setRuleEnabled(id, !rule.enabled);
        return reply.redirect("/admin/notifications?done=toggled", 303);
      });

      admin.post("/notifications/rules/:id/delete", async (req, reply) => {
        const { id } = req.params as { id: string };
        await nrepo.deleteRule(id);
        req.log.info({ by: req.adminUser, ruleId: id }, "Notification rule deleted");
        return reply.redirect("/admin/notifications?done=deleted", 303);
      });

      // Send the rule's message NOW with sample values (logged source='test',
      // its own dedup key so it never blocks a real occurrence).
      admin.post("/notifications/rules/:id/test", async (req, reply) => {
        const rule = await nrepo.getRule((req.params as { id: string }).id);
        if (!rule) return reply.redirect("/admin/notifications?err=règle introuvable", 303);
        // Tests always go to the admin test number (never the real guardian/coach).
        const phone = config.NOTIF_TEST_PHONE;
        if (!phone) {
          return reply.redirect(
            `/admin/notifications?err=${encodeURIComponent("aucun numéro de test configuré (NOTIF_TEST_PHONE)")}`,
            303,
          );
        }
        const body = `${renderMessage(rule.message_template, TEST_VARS)}\n\n${STAFF_FOOTER}`;
        try {
          // Test goes to a staff number (out-of-window) → template-first, like the real send.
          const path = await sendWhatsAppNotification(phone, `[TEST] ${rule.label}`, body, {
            preferTemplate: true,
          });
          await nrepo.recordTestLog(phone, body, path, null);
          return reply.redirect("/admin/notifications?done=tested", 303);
        } catch (e) {
          await nrepo.recordTestLog(phone, body, "failed", String(e).slice(0, 300));
          req.log.error({ err: e, ruleId: rule.id }, "Notification test send failed");
          return reply.redirect("/admin/notifications?done=test-failed", 303);
        }
      });

      admin.post("/notifications/contacts", async (req, reply) => {
        const b = (req.body ?? {}) as Record<string, string>;
        const res = await nrepo.createContact({
          name: String(b.name ?? "").trim(),
          phone: String(b.phone ?? "").trim(),
          role: String(b.role ?? "").trim() || "staff",
          muted: b.muted === "1",
        });
        if (!res.ok) return reply.redirect(`/admin/notifications?err=${encodeURIComponent(res.error ?? "erreur")}`, 303);
        req.log.info({ by: req.adminUser, name: b.name }, "Staff contact added");
        return reply.redirect("/admin/notifications?done=contact-added", 303);
      });

      admin.post("/notifications/contacts/:id/mute", async (req, reply) => {
        const { id } = req.params as { id: string };
        const contacts = await nrepo.listStaffContacts();
        const c = contacts.find((x) => x.id === id);
        if (c) await nrepo.setContactMuted(id, !c.muted);
        return reply.redirect("/admin/notifications?done=contact-muted", 303);
      });

      admin.post("/notifications/contacts/:id/delete", async (req, reply) => {
        const { id } = req.params as { id: string };
        await nrepo.deleteContact(id);
        return reply.redirect("/admin/notifications?done=contact-deleted", 303);
      });

      // ---------- Actions de pointage (aucune action monétaire) ----------
      admin.post("/bookings/:id/refund-done", async (req, reply) => {
        const { id } = req.params as { id: string };
        const updated = await transition(pool, id, "REFUNDED");
        if (updated) {
          req.log.info(
            { bookingId: id, by: req.adminUser },
            "Refund marked done from admin dashboard",
          );
        } else {
          req.log.warn(
            { bookingId: id, by: req.adminUser },
            "Refund-done rejected (booking not in REFUND_NEEDED)",
          );
        }
        reply.redirect("/admin", 303);
      });

      admin.post("/plan-orders/:id/activated", async (req, reply) => {
        const { id } = req.params as { id: string };
        const updated = await repo.markPlanOrderActivated(id, `manual-${req.adminUser ?? "?"}`);
        if (updated) {
          req.log.info(
            { planOrderId: id, by: req.adminUser },
            "Plan order marked activated from admin dashboard",
          );
        } else {
          req.log.warn(
            { planOrderId: id, by: req.adminUser },
            "Plan-activated rejected (order not in PAID)",
          );
        }
        reply.redirect("/admin", 303);
      });
    },
    { prefix: "/admin" },
  );
}
