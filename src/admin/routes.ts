import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { pool } from "../db/index.js";
import { transition } from "../domain/stateMachine.js";
import * as repo from "../domain/repo.js";
import { extrasFromJson } from "../lib/cafeMenu.js";
import { adminAuthHook } from "./auth.js";
import * as q from "./queries.js";
import { runCrmAudit, phoneKey, planMerge } from "../lib/crmAudit.js";
import {
  mergeContacts,
  getContactById,
  listAllActiveOrders,
  findMemberContactIds,
} from "../lib/wix.js";

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
        const [audit, plansByContact] = await Promise.all([
          runCrmAudit(),
          activePlansByContact().catch(() => new Map<string, string[]>()),
        ]);
        const allDupIds = audit.duplicates.flatMap((g) => g.contacts.map((c) => c.id));
        const memberIds = await findMemberContactIds(allDupIds).catch(() => new Set<string>());

        const banner = done
          ? `<div class="card" style="border-color:#1a7f37"><span class="ok">✓ Fusion effectuée (${escapeHtml(done)} fiche(s) absorbée(s)).</span></div>`
          : err
            ? `<div class="card warn">⚠️ Fusion refusée : ${escapeHtml(err)}</div>`
            : "";

        const groupCards = audit.duplicates
          .map((g) => {
            const ids = g.contacts.map((c) => c.id).join(",");
            const planHolders = new Set(
              g.contacts.filter((c) => plansByContact.has(c.id)).map((c) => c.id),
            );
            // Same rule as the POST enforcement — what you see is what merges.
            const plan = planMerge(g.contacts, planHolders, memberIds);
            const keeper = g.contacts.find((c) => c.id === plan?.targetId);
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
            const action = plan
              ? `<form class="inline" method="post" action="/admin/crm/merge" onsubmit="return confirm('Fusionner ${plan.sourceIds.length} fiche(s) dans « ${escapeHtml(keeper?.name ?? "?").replaceAll("'", "\\'")} » ?\\n\\nLes fiches fusionnées sont SUPPRIMÉES (irréversible).')">
<input type="hidden" name="group" value="${ids}">
<button class="act">Fusionner ${plan.sourceIds.length} fiche(s)</button>
</form>${leftoverNote}`
              : `<span class="muted">⚠️ Rien à fusionner automatiquement : ces fiches sont des comptes membres (Wix interdit de fusionner deux membres). À traiter dans Wix avec la réception.</span>`;
            return `<div class="card">
<b>…${escapeHtml(g.key)}</b> — ${g.contacts.length} fiches pour ce numéro
<table><tr><th>Fiche</th><th>Numéro(s) enregistré(s)</th><th class="hide-sm">Créée</th><th>Sort</th></tr>${rows}</table>
<div style="margin-top:.5rem">${action}</div>
</div>`;
          })
          .join("");

        const noPhoneRows = audit.noPhone
          .map(
            (c) =>
              `<tr><td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.email ?? "—")}</td></tr>`,
          )
          .join("");

        const body = `
${banner}
<div class="stat-grid">
<div class="stat"><span class="muted">Fiches contact Wix</span><b>${audit.total}</b></div>
<div class="stat"><span class="muted">Numéros en doublon</span><b>${audit.duplicates.length}</b></div>
<div class="stat"><span class="muted">Fiches sans téléphone</span><b>${audit.noPhone.length}</b></div>
</div>
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
<div class="card">
${audit.noPhone.length ? `<details><summary>Voir la liste (${audit.noPhone.length})</summary><table><tr><th>Nom</th><th>Email</th></tr>${noPhoneRows}</table></details>` : `<span class="ok">✓ Toutes les fiches ont un téléphone.</span>`}
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
