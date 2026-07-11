import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { pool } from "../db/index.js";
import { transition } from "../domain/stateMachine.js";
import * as repo from "../domain/repo.js";
import { extrasFromJson } from "../lib/cafeMenu.js";
import { adminAuthHook } from "./auth.js";
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
import { sendText } from "../lib/whatsapp.js";
import * as links from "../domain/linkRequests.js";

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
 */

/** Escape ANY DB-sourced content before injecting into HTML (client text!). */
export function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fmtDate(d: Date | string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("fr-FR", {
    timeZone: config.TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtFcfa(n: number): string {
  return `${Number(n).toLocaleString("fr-FR")} F`;
}

const STATUS_COLORS: Record<string, string> = {
  BOOKED: "#1a7f37",
  ACTIVATED: "#1a7f37",
  PAID: "#9a6700",
  AWAITING_PAYMENT: "#0969da",
  DRAFT: "#6e7781",
  EXPIRED: "#6e7781",
  CANCELLED: "#6e7781",
  REFUND_NEEDED: "#cf222e",
  REFUNDED: "#8250df",
};

function badge(status: string): string {
  const color = STATUS_COLORS[status] ?? "#6e7781";
  return `<span class="badge" style="background:${color}">${escapeHtml(status)}</span>`;
}

function layout(title: string, active: string, body: string): string {
  const tabs = [
    ["/admin", "Vue d'ensemble"],
    ["/admin/conversations", "Conversations"],
    ["/admin/bookings", "Réservations"],
    ["/admin/orders", "Commandes ☕"],
    ["/admin/handoffs", "Handoffs"],
    ["/admin/crm", "CRM 🗂"],
  ]
    .map(
      ([href, label]) =>
        `<a href="${href}" class="${href === active ? "active" : ""}">${label}</a>`,
    )
    .join("");
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)} — Awa admin</title>
<style>
:root{color-scheme:light}
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;margin:0;background:#f6f3ee;color:#1f2328}
header{background:#1f2328;color:#fff;padding:.7rem 1rem;display:flex;align-items:center;gap:1rem;flex-wrap:wrap}
header h1{font-size:1rem;margin:0;white-space:nowrap}
nav{display:flex;gap:.25rem;flex-wrap:wrap}
nav a{color:#c9d1d9;text-decoration:none;padding:.35rem .7rem;border-radius:6px;font-size:.9rem}
nav a.active,nav a:hover{background:#39414a;color:#fff}
main{max-width:960px;margin:0 auto;padding:1rem}
h2{font-size:1.05rem;margin:1.4rem 0 .6rem}
.card{background:#fff;border:1px solid #e4ddd3;border-radius:10px;padding:.9rem;margin-bottom:.8rem}
table{width:100%;border-collapse:collapse;font-size:.88rem}
th,td{text-align:left;padding:.45rem .5rem;border-top:1px solid #eee;vertical-align:top}
th{border-top:none;color:#6e7781;font-weight:600;font-size:.8rem}
.badge{color:#fff;border-radius:20px;padding:.1rem .55rem;font-size:.72rem;font-weight:600;white-space:nowrap}
.muted{color:#6e7781;font-size:.82rem}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:.6rem}
.stat{background:#fff;border:1px solid #e4ddd3;border-radius:10px;padding:.7rem}
.stat b{display:block;font-size:1.3rem}
.bubble{max-width:78%;padding:.55rem .8rem;border-radius:12px;margin:.25rem 0;white-space:pre-wrap;word-break:break-word;font-size:.92rem}
.user{background:#fff;border:1px solid #e4ddd3;margin-right:auto}
.assistant{background:#d7f5dc;margin-left:auto}
.turnrow{display:flex;flex-direction:column}
details.tool{margin:.15rem 0 .15rem 0;font-size:.78rem;color:#6e7781}
details.tool pre{white-space:pre-wrap;word-break:break-all;background:#f0ede7;padding:.5rem;border-radius:8px;margin:.3rem 0 0}
form.inline{display:inline}
button.act{background:#1a7f37;color:#fff;border:none;border-radius:8px;padding:.45rem .8rem;font-size:.85rem;cursor:pointer}
button.act:hover{background:#166f30}
input[type=search]{width:100%;padding:.55rem .8rem;border:1px solid #e4ddd3;border-radius:10px;font-size:.95rem;margin-bottom:.8rem}
a.rowlink{color:inherit;text-decoration:none;display:block}
a.rowlink:hover{background:#faf8f4}
.ok{color:#1a7f37;font-weight:600}
.warn{background:#fff8f0;border-color:#f0d8b6}
@media(max-width:640px){ td.hide-sm,th.hide-sm{display:none} }
</style></head>
<body>
<header><h1>🤖 Awa — admin</h1><nav>${tabs}</nav></header>
<main>${body}</main>
</body></html>`;
}

/** "il y a Xh" style relative time for lists. */
function ago(d: Date | string | null): string {
  if (!d) return "—";
  const mins = Math.round((Date.now() - new Date(d).getTime()) / 60000);
  if (mins < 1) return "à l'instant";
  if (mins < 60) return `il y a ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `il y a ${hours} h`;
  return `il y a ${Math.round(hours / 24)} j`;
}

export function registerAdmin(app: FastifyInstance): void {
  app.register(
    async (admin) => {
      admin.addHook("onRequest", adminAuthHook);

      // ---------- Vue d'ensemble ----------
      admin.get("/", async (req, reply) => {
        const [actions, s] = await Promise.all([q.pendingActions(), q.stats()]);

        const refundRows = actions.refunds
          .map(
            (b) => `<tr>
<td><a href="/admin/conversations/${b.client_id}">${escapeHtml(b.client_name ?? "?")}</a><div class="muted">+${escapeHtml(b.wa_phone)}</div></td>
<td>${escapeHtml(b.service_name)}<div class="muted">${fmtDate(b.slot_start)} · ${b.participants} place(s)</div></td>
<td><b>${fmtFcfa(b.amount_xof)}</b><div class="muted">Wave : ${escapeHtml(b.wave_session_id ?? "?")}</div></td>
<td><form class="inline" method="post" action="/admin/bookings/${b.id}/refund-done" onsubmit="return confirm('Confirmer : le remboursement de ${fmtFcfa(b.amount_xof)} a bien été fait dans le portail Wave ?')"><button class="act">✅ Remboursement effectué</button></form></td>
</tr>`,
          )
          .join("");

        const planRows = actions.planActivations
          .map(
            (p) => `<tr>
<td><a href="/admin/conversations/${p.client_id}">${escapeHtml(p.client_name ?? "?")}</a><div class="muted">+${escapeHtml(p.wa_phone)}</div></td>
<td>${escapeHtml(p.plan_name)}<div class="muted">payé ${fmtDate(p.updated_at)}</div></td>
<td><b>${fmtFcfa(p.amount_xof)}</b></td>
<td><form class="inline" method="post" action="/admin/plan-orders/${p.id}/activated" onsubmit="return confirm('Confirmer : l\\'abonnement a bien été attribué au client dans le dashboard Wix ?')"><button class="act">✅ Abonnement activé</button></form></td>
</tr>`,
          )
          .join("");

        const handoffRows = actions.recentHandoffs
          .map(
            (h) => `<tr>
<td>${ago(h.created_at)}</td>
<td><a href="/admin/conversations/${h.client_id}">${escapeHtml(h.client_name ?? "?")}</a><div class="muted">+${escapeHtml(h.wa_phone)}</div></td>
<td>${escapeHtml(h.reason ?? "")}</td>
</tr>`,
          )
          .join("");

        const body = `
<h2>💸 Remboursements à traiter ${actions.refunds.length ? `(${actions.refunds.length})` : ""}</h2>
<div class="card ${actions.refunds.length ? "warn" : ""}">
${
  actions.refunds.length
    ? `<p class="muted">1. Rembourser dans le portail Wave Business → 2. cliquer le bouton.</p>
       <table><tr><th>Client</th><th>Cours</th><th>Montant</th><th></th></tr>${refundRows}</table>`
    : `<span class="ok">✓ Aucun remboursement en attente</span>`
}
</div>

<h2>🎫 Abonnements payés à activer dans Wix ${actions.planActivations.length ? `(${actions.planActivations.length})` : ""}</h2>
<div class="card ${actions.planActivations.length ? "warn" : ""}">
${
  actions.planActivations.length
    ? `<p class="muted">1. Attribuer la formule au client dans Wix (Abonnements) → 2. cliquer le bouton.</p>
       <table><tr><th>Client</th><th>Formule</th><th>Montant</th><th></th></tr>${planRows}</table>`
    : `<span class="ok">✓ Aucun abonnement en attente d'activation</span>`
}
</div>

<h2>🙋🏾 Handoffs des 7 derniers jours</h2>
<div class="card">
${actions.recentHandoffs.length ? `<table><tr><th>Quand</th><th>Client</th><th>Motif</th></tr>${handoffRows}</table>` : `<span class="muted">Aucun handoff récent.</span>`}
</div>

<h2>📊 Activité</h2>
<div class="stat-grid">
<div class="stat"><span class="muted">Messages reçus aujourd'hui</span><b>${s.msgToday}</b><span class="muted">${s.msg7d} sur 7 j</span></div>
<div class="stat"><span class="muted">Clients actifs aujourd'hui</span><b>${s.activeClientsToday}</b><span class="muted">${s.activeClients7d} sur 7 j</span></div>
<div class="stat"><span class="muted">Résas confirmées aujourd'hui</span><b>${s.bookingsToday}</b><span class="muted">${s.bookings7d} sur 7 j</span></div>
<div class="stat"><span class="muted">Encaissé aujourd'hui</span><b>${fmtFcfa(s.revenueToday)}</b><span class="muted">${fmtFcfa(s.revenue7d)} sur 7 j</span></div>
</div>
<p class="muted">Connecté : ${escapeHtml(req.adminUser ?? "?")} · ${new Date().toLocaleString("fr-FR", { timeZone: config.TIMEZONE })}</p>`;

        reply.type("text/html").send(layout("Vue d'ensemble", "/admin", body));
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
        reply.type("text/html").send(layout("Conversations", "/admin/conversations", body));
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
          .send(layout(client.name ?? client.wa_phone, "/admin/conversations", body));
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
                ? `<div class="muted">+ café : ${fmtFcfa(b.extras_amount_xof)}</div>`
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
        reply.type("text/html").send(layout("Réservations", "/admin/bookings", body));
      });

      // ---------- Commandes café ----------
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
<div class="stat"><span class="muted">Total café du jour</span><b>${fmtFcfa(cafeTotal)}</b></div>
</div>
${prepList ? `<div class="card" style="margin-top:.8rem">À préparer : ${prepList}</div>` : ""}
<div class="card" style="margin-top:.8rem">
${
  today.length
    ? `<table><tr><th>Cours</th><th>Client</th><th>Commande</th><th>Montant</th></tr>${today.map(orderRow).join("")}</table>`
    : `<span class="muted">Aucune commande café pour aujourd'hui.</span>`
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
        reply.type("text/html").send(layout("Commandes café", "/admin/orders", body));
      });

      // ---------- Handoffs ----------
      admin.get("/handoffs", async (_req, reply) => {
        const handoffs = await q.listHandoffs();
        const rows = handoffs
          .map(
            (h) => `<tr>
<td>${fmtDate(h.created_at)}</td>
<td><a href="/admin/conversations/${h.client_id}">${escapeHtml(h.client_name ?? "?")}</a><div class="muted">+${escapeHtml(h.wa_phone)}</div></td>
<td>${escapeHtml(h.reason ?? "")}</td>
</tr>`,
          )
          .join("");
        const body = `<div class="card"><table><tr><th>Quand</th><th>Client</th><th>Motif</th></tr>${rows || `<tr><td colspan="3" class="muted">Aucun handoff.</td></tr>`}</table></div>`;
        reply.type("text/html").send(layout("Handoffs", "/admin/handoffs", body));
      });

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
          ? `<h2>🔗 Liaisons en attente (${linkQueue.length})</h2>
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
        const noPhoneActive = audit.noPhone.filter((c) => isActive(c.id));
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
          ? `<h2>🎫 Abonnés injoignables (${unreachable.length})</h2>
<p class="muted">Ces clientes paient un abonnement ACTIF mais Awa ne pourra jamais les reconnaître :
leur fiche n'a pas de numéro utilisable. C'est exactement la population du cas « abonnement
introuvable » — à compléter dans Wix → Contacts avec leur numéro WhatsApp (+221...), en priorité.</p>
<div class="card warn"><table><tr><th>Abonnée</th><th>Abonnement(s)</th><th>Problème</th><th>Numéro(s) enregistré(s)</th></tr>${unreachableRows}</table></div>`
          : "";

        const body = `
${banner}
<div class="stat-grid">
<div class="stat"><span class="muted">Fiches contact Wix</span><b>${audit.total}</b></div>
<div class="stat"><span class="muted">Liaisons en attente</span><b>${linkQueue.length}</b></div>
<div class="stat"><span class="muted">Abonnés injoignables</span><b>${unreachable.length}</b></div>
<div class="stat"><span class="muted">Numéros en doublon</span><b>${audit.duplicates.length}</b></div>
<div class="stat"><span class="muted">Fiches sans téléphone</span><b>${audit.noPhone.length}</b></div>
</div>
${linkSection}
${unreachableSection}
<h2>👯 Doublons à fusionner ${audit.duplicates.length ? `(${audit.duplicates.length})` : ""}</h2>
<p class="muted">Awa refuse (prudemment) de choisir quand un numéro correspond à plusieurs fiches :
ces clientes ne sont pas reconnues. Un clic fusionne le groupe — la fiche conservée (✓) est choisie
automatiquement : compte membre 👤 et abonnement 🎫 d'abord (Wix interdit de les fusionner comme
sources), sinon numéro international, sinon la plus ancienne. Les fiches fusionnées sont supprimées
par Wix ; les fiches protégées restent telles quelles.</p>
${groupCards || `<div class="card"><span class="ok">✓ Aucun doublon — rien à nettoyer.</span></div>`}
<h2>📵 Fiches sans téléphone ${audit.noPhone.length ? `(${audit.noPhone.length})` : ""}</h2>
<p class="muted">Invisibles pour Awa (elle reconnaît les clientes par leur numéro WhatsApp).
À compléter directement dans Wix → Contacts, avec le numéro WhatsApp de la cliente.</p>
${noPhoneActiveBlock}
<div class="card">
${noPhoneDormant.length ? `<details><summary>Fiches dormantes — sans résa à venir ni abonnement (${noPhoneDormant.length})</summary><table><tr><th>Nom</th><th>Email</th></tr>${noPhoneRows}</table></details>` : audit.noPhone.length === 0 ? `<span class="ok">✓ Toutes les fiches ont un téléphone.</span>` : `<span class="ok">✓ Aucune fiche dormante.</span>`}
</div>`;
        reply.type("text/html").send(layout("Hygiène CRM", "/admin/crm", body));
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
