import { config } from "../config.js";
import { type CafeMenuItem, formatExtrasMultiline, formatExtrasOneLine } from "../lib/cafeMenu.js";
import {
  orderItems,
  type ClosedDeliveryOrder,
  type DeliveryOrder,
  type OpenDeliveryOrder,
  type RecentDeliveryClient,
} from "../domain/deliveryRepo.js";
import { formatDakarDateTime } from "../domain/deliveryRules.js";
import {
  DELIVERY_GROUP_ORDER,
  groupDeliveryOrders,
  type DeliveryGroup,
  type DeliveryPresentation,
} from "../domain/deliveryPresentation.js";

/**
 * Body HTML for /admin/livraisons — server-rendered, self-contained escaping so
 * it doesn't import from routes.ts (which imports this). routes.ts wraps it in
 * layout() and owns the POST handlers. The board progressively replaces only
 * its fragment every 30s; the create form is never refreshed.
 */

function esc(s: unknown): string {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const BANNERS: Record<string, string> = {
  created: "Commande créée — cuisine notifiée, confirmation envoyée au client.",
  scheduled: "Commande programmée — client et réception prévenus. La cuisine sera alertée à l'heure prévue.",
  "created-kitchen-failed": "Commande créée, mais l'envoi à la cuisine a échoué — utilisez « 🔁 Renvoyer ».",
  departed: "Commande partie en livraison — le client est prévenu.",
  delivered: "Commande marquée livrée.",
  cancelled: "Commande annulée.",
  renotified: "Cuisine renotifiée.",
  reprogrammed: "Livraison reprogrammée — le nouvel horaire est enregistré.",
  cash: "Paiement en espèces enregistré — le départ est autorisé.",
  recipient: "Contact de remise mis à jour.",
  "recipient-removed": "Contact de remise supprimé — la cliente redevient le contact à appeler.",
};

export function livraisonsBanner(done?: string, err?: string): string {
  if (done && BANNERS[done])
    return `<div class="card success"><span class="ok">✓ ${esc(BANNERS[done])}</span></div>`;
  if (err) return `<div class="card warn">⚠️ ${esc(err)}</div>`;
  return "";
}

function isWaitingForActivation(o: DeliveryOrder): boolean {
  return !!o.scheduled_for && !o.activated_at;
}

function dakarInputValue(value: Date | string): string {
  const d = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function arrivalCountdown(value: Date | string, now = new Date()): string {
  const mins = Math.ceil((new Date(value).getTime() - now.getTime()) / 60000);
  if (mins <= 0) return "activation imminente";
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const rest = mins % 60;
  if (days > 0) return `dans ${days} j ${hours} h`;
  if (hours > 0) return `dans ${hours} h ${rest} min`;
  return `dans ${rest} min`;
}

function kitchenStatus(o: OpenDeliveryOrder): string {
  if (o.kitchen_ticket_status === "READY") return `<span class="ok">✓ Cuisine prête</span>`;
  if (o.kitchen_ticket_status === "PREPARING") return `<span class="badge badge--blue">En préparation</span>`;
  if (o.kitchen_ticket_status === "NEW") return `<span class="badge badge--gray">À démarrer</span>`;
  if (o.kitchen_ticket_status === "COMPLETED") return `<span class="ok">✓ Sortie cuisine</span>`;
  if (o.kitchen_ticket_status === "CANCELLED") return `<span class="muted">Ticket annulé</span>`;
  const s = o.kitchen_notify_status;
  if (s === "sent" || s === "sent_template") return `<span class="muted">Ticket envoyé</span>`;
  if (s === "partial") return `<span class="warn-text">Ticket reçu partiellement</span>`;
  if (s === "fallback_reception")
    return `<span class="warn-text">Réception prévenue à la place du bar</span>`;
  if (s === "pending" || s === "claimed") return `<span class="muted">Ticket en cours d’envoi…</span>`;
  return `<span class="danger-text">Ticket cuisine non reçu</span>`;
}

function inlineForm(action: string, label: string, confirm?: string, variant = ""): string {
  const confirmation = confirm ? ` data-confirm="${esc(confirm)}"` : "";
  const cls = variant ? ` act--${variant}` : "";
  return `<form method="post" action="${esc(action)}" class="inline"${confirmation}><button class="act act--sm${cls}" type="submit">${esc(label)}</button></form>`;
}

function scheduledEditor(o: DeliveryOrder): string {
  const base = `/admin/livraisons/${o.id}`;
  const arrival = o.scheduled_for ? dakarInputValue(o.scheduled_for) : "";
  const lead =
    o.scheduled_for && o.kitchen_notify_at
      ? Math.round(
          (new Date(o.scheduled_for).getTime() - new Date(o.kitchen_notify_at).getTime()) /
            60000,
        )
      : 60;
  return `<form method="post" action="${esc(base)}/reschedule" class="delivery-secondary-form">
  <b>Reprogrammer</b>
  <label>Nouvelle arrivée (Dakar)<input name="scheduled_for" type="datetime-local" required value="${esc(arrival)}"></label>
  <label>Alerter la cuisine
    <select name="kitchen_lead_minutes">
      ${[30, 60, 90].map((n) => `<option value="${n}"${lead === n ? " selected" : ""}>${n} min avant</option>`).join("")}
    </select>
  </label>
  <button class="act act--sm act--ghost" type="submit">Enregistrer le nouvel horaire</button>
</form>`;
}

function paymentCell(o: DeliveryOrder): string {
  const method =
    o.payment_method === "wave"
      ? "Wave"
      : o.payment_method === "orange_money"
        ? "Orange Money"
        : o.payment_method === "maxit"
          ? "Max It"
          : o.payment_method === "cash"
            ? "Espèces"
            : "mobile money";
  switch (o.payment_status) {
    case "PAID":
      return `<span class="ok">✓ Payé</span> <span class="muted">· ${esc(method)}</span>`;
    case "CASH_DUE":
      return `<span class="warn-text">Espèces à encaisser</span>`;
    case "AWAITING_PAYMENT":
      return `<span class="warn-text">Paiement mobile en attente</span>`;
    case "REFUND_NEEDED":
      return `<span class="danger-text">Remboursement à traiter</span>`;
    default:
      return `<span class="warn-text">Moyen de paiement à choisir</span>`;
  }
}

function clientFlag(o: DeliveryOrder): string {
  const ok = (label: string) => `<div class="ok">✓ ${label}</div>`;
  const pending = `<div class="muted">notification en cours…</div>`;
  const sent = (s: string) => s === "sent" || s === "sent_template";
  const inFlight = (s: string) => s === "pending" || s === "claimed";
  if (isWaitingForActivation(o) && !sent(o.reschedule_notify_status)) {
    if (inFlight(o.reschedule_notify_status)) return `<div class="muted">mise à jour client en cours…</div>`;
    return `<div class="warn-text">Nouvel horaire non envoyé</div>`;
  }
  if (o.status === "IN_KITCHEN") {
    if (sent(o.created_notify_status)) return ok("confirmation envoyée");
    if (inFlight(o.created_notify_status)) return pending;
    return `<div class="warn-text">Confirmation non envoyée</div>`;
  }
  if (o.status === "OUT_FOR_DELIVERY") {
    if (sent(o.route_notify_status)) return ok("client prévenu (en route)");
    if (inFlight(o.route_notify_status)) return pending;
    return `<div class="danger-text">Appeler le client : +${esc(o.client_phone)}</div>`;
  }
  return "";
}

function recipientBlock(o: DeliveryOrder): string {
  if (!o.recipient_name || !o.recipient_phone) {
    return `<div class="delivery-contact-line"><span class="muted">Contact livreur</span><b>${esc(o.client_name)}</b> <a href="tel:+${esc(o.client_phone)}">+${esc(o.client_phone)}</a></div>`;
  }
  let notify = "";
  if (o.status === "OUT_FOR_DELIVERY") {
    const s = o.recipient_route_notify_status;
    notify =
      s === "sent" || s === "sent_template"
        ? `<div class="ok">✓ contact prévenu</div>`
        : s === "pending" || s === "claimed"
          ? `<div class="muted">alerte contact en cours…</div>`
          : `<div class="danger-text">Alerte contact échouée</div>`;
  }
  return `<div class="delivery-contact-line"><span class="muted">Contact livreur</span><b>Remise à ${esc(o.recipient_name)}</b> <a href="tel:+${esc(o.recipient_phone)}">+${esc(o.recipient_phone)}</a>${notify}</div>`;
}

function recipientEditor(o: DeliveryOrder): string {
  return `<form method="post" action="/admin/livraisons/${esc(o.id)}/recipient" class="delivery-secondary-form">
  <b>Modifier le contact de remise</b>
  <label>Nom<input name="recipient_name" maxlength="120" value="${esc(o.recipient_name ?? "")}" placeholder="Ex. Fatou, assistante"></label>
  <label>Téléphone<input name="recipient_phone" type="tel" inputmode="tel" value="${esc(o.recipient_phone ?? "")}" placeholder="77 123 45 67 ou +221…"></label>
  <span class="muted">Videz les deux champs pour supprimer ce contact.</span>
  <button class="act act--sm act--ghost" type="submit">Enregistrer le contact</button>
</form>`;
}

function dueBlock(p: DeliveryPresentation, now: Date): string {
  const o = p.order;
  if (o.status === "OUT_FOR_DELIVERY") {
    const mins = o.out_for_delivery_at
      ? Math.max(0, Math.floor((now.getTime() - new Date(o.out_for_delivery_at).getTime()) / 60_000))
      : 0;
    return `<span class="badge badge--blue">En route depuis ${mins} min</span>`;
  }
  if (isWaitingForActivation(o) && o.scheduled_for) {
    return `<b>${esc(formatDakarDateTime(o.scheduled_for, "fr"))}</b><span class="muted">${esc(arrivalCountdown(o.scheduled_for, now))}</span>`;
  }
  if (!p.dueAt) return `<span class="muted">Échéance non définie</span>`;
  const mins = Math.ceil((p.dueAt.getTime() - now.getTime()) / 60_000);
  if (p.urgency === "late") {
    return `<span class="badge badge--red">En retard de ${Math.abs(mins)} min</span>`;
  }
  if (p.urgency === "soon") {
    return `<span class="badge badge--amber">Échéance dans ${Math.max(1, mins)} min</span>`;
  }
  return `<span class="muted">Échéance ${esc(formatDakarDateTime(p.dueAt, "fr"))}</span>`;
}

function primaryAction(p: DeliveryPresentation): string {
  const base = `/admin/livraisons/${p.order.id}`;
  if (p.primaryAction === "resolve_payment") {
    return `<div class="delivery-primary" data-primary-action>${inlineForm(
      `${base}/cash`,
      "Résoudre : choisir espèces",
      "Confirmer le paiement en espèces à la livraison ?",
    )}</div>`;
  }
  if (p.primaryAction === "mark_departed") {
    return `<div class="delivery-primary" data-primary-action>${inlineForm(
      `${base}/depart`,
      "🛵 Marquer partie",
      "Confirmer le départ ? La cliente et, le cas échéant, le contact de remise seront prévenus.",
      "ok",
    )}</div>`;
  }
  if (p.primaryAction === "mark_delivered") {
    return `<div class="delivery-primary" data-primary-action>${inlineForm(
      `${base}/delivered`,
      "✓ Marquer livrée",
      "Confirmer que cette commande a bien été livrée ?",
      "ok",
    )}</div>`;
  }
  return "";
}

function secondaryActions(p: DeliveryPresentation): string {
  const o = p.order;
  const base = `/admin/livraisons/${o.id}`;
  const kitchenBad =
    ["failed", "partial", "fallback_reception"].includes(o.kitchen_notify_status) ||
    (o.status === "IN_KITCHEN" &&
      !!o.activated_at &&
      !["NEW", "PREPARING", "READY"].includes(o.kitchen_ticket_status ?? ""));
  const parts: string[] = [recipientEditor(o)];
  if (isWaitingForActivation(o)) parts.push(scheduledEditor(o));
  if (kitchenBad && o.status === "IN_KITCHEN" && o.activated_at) {
    parts.push(
      inlineForm(
        `${base}/renotify-kitchen`,
        "🔁 Renvoyer à la cuisine",
        "Renvoyer le ticket cuisine maintenant ?",
        "ghost",
      ),
    );
  }
  parts.push(
    inlineForm(
      `${base}/cancel`,
      "✖ Annuler la commande",
      o.status === "OUT_FOR_DELIVERY"
        ? "La commande est en route — annuler quand même ?"
        : "Annuler cette commande ?",
      "danger",
    ),
  );
  return `<details class="delivery-secondary" data-refresh-pause>
<summary>Actions secondaires</summary>
<div class="delivery-secondary-body">${parts.join("")}</div>
</details>`;
}

function orderDetails(o: OpenDeliveryOrder): string {
  const items = orderItems(o);
  return `<details class="delivery-order-details" data-refresh-pause>
<summary>Voir la commande · ${esc(formatExtrasOneLine(items))}</summary>
<div class="delivery-order-detail">
  <div style="white-space:pre-wrap">${esc(formatExtrasMultiline(items))}</div>
  ${o.note ? `<p><span class="muted">Note</span><br>${esc(o.note)}</p>` : ""}
  <p>${kitchenStatus(o)}</p>
  <div class="muted">${clientFlag(o)}</div>
</div>
</details>`;
}

function orderCard(p: DeliveryPresentation, now: Date): string {
  const o = p.order;
  const urgencyClass =
    p.urgency === "late" ? " is-late" : p.urgency === "soon" ? " is-soon" : "";
  return `<article class="delivery-card${urgencyClass}" data-delivery-card data-order-id="${esc(o.id)}">
<header class="delivery-card-head">
  <div>${o.is_test ? `<span class="badge badge--violet">🧪 Test</span>` : ""}<h3>${esc(o.client_name)}</h3><a href="tel:+${esc(o.client_phone)}">+${esc(o.client_phone)}</a></div>
  <div class="delivery-due">${dueBlock(p, now)}</div>
</header>
<div class="delivery-facts">
  <div><span>Paiement</span>${paymentCell(o)}</div>
  <div><span>Total</span><b>${esc(o.amount_xof.toLocaleString("fr-FR"))} F</b></div>
  <div><span>Cuisine</span>${kitchenStatus(o)}</div>
</div>
<div class="delivery-destination">
  <div><span class="muted">Adresse</span><b>${esc(o.address)}</b></div>
  ${recipientBlock(o)}
</div>
${p.blockingReason ? `<div class="delivery-block" role="alert"><b>Intervention requise</b><span>${esc(p.blockingReason)}</span></div>` : ""}
${orderDetails(o)}
<footer class="delivery-card-actions">
  ${primaryAction(p)}
  ${secondaryActions(p)}
</footer>
</article>`;
}

/** Whole minutes between two instants, or null if either is missing. */
function minutesBetween(from: Date | string | null, to: Date | string | null): number | null {
  if (!from || !to) return null;
  return Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60000));
}

/** Per-order duration breakdown for a delivered order: preparation
 *  (start → kitchen READY), transit (departure → delivered) and total. Each
 *  segment is shown only when its timestamps exist (older orders have no
 *  kitchen ticket / never tapped a departure). */
function durationsCell(o: ClosedDeliveryOrder): string {
  if (o.status !== "DELIVERED") return `<span class="muted">—</span>`;
  const start = o.kitchen_notify_at ?? o.activated_at ?? o.created_at;
  const prep = minutesBetween(start, o.kitchen_ready_at);
  const transit = minutesBetween(o.out_for_delivery_at, o.delivered_at);
  const total = minutesBetween(start, o.delivered_at);
  const parts: string[] = [];
  if (prep !== null) parts.push(`<span class="muted">Prépa</span> ${prep} min`);
  if (transit !== null) parts.push(`<span class="muted">Transit</span> ${transit} min`);
  if (total !== null) parts.push(`<b>Total ${total} min</b>`);
  return parts.length ? parts.join(" · ") : `<span class="muted">—</span>`;
}

function closedRow(o: ClosedDeliveryOrder): string {
  const state = o.status === "DELIVERED" ? "🛵 livrée" : "✖ annulée";
  return `<tr>
<td data-label="État">${o.is_test ? `<span class="badge badge--violet">🧪 Test</span><br>` : ""}${esc(state)}</td>
<td data-label="Client">${esc(o.client_name)}${o.recipient_name && o.recipient_phone ? `<br><span class="muted">Remise à ${esc(o.recipient_name)} (+${esc(o.recipient_phone)})</span>` : ""}</td>
<td data-label="Commande">${esc(formatExtrasOneLine(orderItems(o)))}</td>
<td data-label="Paiement" class="hide-sm">${paymentCell(o)}</td>
<td data-label="Durées">${durationsCell(o)}</td>
</tr>`;
}

export interface BoardData {
  open: OpenDeliveryOrder[];
  recent: ClosedDeliveryOrder[];
  banner: string;
}

const GROUP_META: Record<DeliveryGroup, { title: string; copy: string }> = {
  intervention: {
    title: "Intervention requise",
    copy: "Paiement, notification, ticket cuisine ou remboursement à résoudre.",
  },
  preparing: {
    title: "En préparation",
    copy: "Commandes activées qui ne sont pas encore prêtes.",
  },
  ready: {
    title: "Prêtes à partir",
    copy: "Cuisine prête et paiement autorisé.",
  },
  en_route: {
    title: "En route",
    copy: "Commandes à confirmer comme livrées.",
  },
  scheduled: {
    title: "Programmées",
    copy: "Livraisons futures classées par arrivée promise.",
  },
};

function renderGroup(
  group: DeliveryGroup,
  items: DeliveryPresentation[],
  now: Date,
): string {
  const meta = GROUP_META[group];
  return `<section class="delivery-group" id="delivery-${group}" aria-labelledby="delivery-${group}-title">
<div class="section-header delivery-group-head">
  <div><h2 id="delivery-${group}-title">${meta.title}</h2><p>${meta.copy}</p></div>
  <span class="badge ${group === "intervention" && items.length ? "badge--red" : items.length ? "badge--violet" : "badge--gray"}">${items.length}</span>
</div>
${
  items.length
    ? `<div class="delivery-card-grid">${items.map((item) => orderCard(item, now)).join("")}</div>`
    : `<div class="delivery-group-empty">Aucune commande dans ce groupe.</div>`
}
</section>`;
}

function refreshedAt(now: Date): string {
  return new Intl.DateTimeFormat("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "Africa/Dakar",
  }).format(now);
}

export function renderLivraisonsBoardFragment(
  data: Pick<BoardData, "open" | "recent">,
  now: Date = new Date(),
): string {
  const groups = groupDeliveryOrders(data.open, now);
  const recentTable = data.recent.length
    ? `<div class="table-wrap"><table class="responsive-table"><thead><tr><th>État</th><th>Client</th><th>Commande</th><th class="hide-sm">Paiement</th><th>Durées</th></tr></thead><tbody>${data.recent.map(closedRow).join("")}</tbody></table></div>`
    : `<div class="empty"><b>Aucun historique récent</b></div>`;
  const counters = DELIVERY_GROUP_ORDER.map((group) => {
    const count = groups[group].length;
    return `<a class="delivery-counter${group === "intervention" && count ? " is-alert" : ""}" href="#delivery-${group}"><span>${GROUP_META[group].title}</span><b>${count}</b></a>`;
  }).join("");
  return `<div id="delivery-board-fragment" data-refreshed-at="${esc(now.toISOString())}">
<nav class="delivery-counters" aria-label="Compteurs opérationnels">${counters}</nav>
${DELIVERY_GROUP_ORDER.map((group) => renderGroup(group, groups[group], now)).join("")}
<details class="delivery-history" data-refresh-pause>
  <summary><span>Historique récent</span><span class="badge badge--gray">${data.recent.length}</span></summary>
  <div class="card">${recentTable}</div>
</details>
</div>`;
}

export function renderLivraisonsBoard(
  data: BoardData,
  now: Date = new Date(),
): string {
  return `${data.banner}
<style>
.delivery-refresh{display:flex;align-items:center;justify-content:space-between;gap:.75rem;flex-wrap:wrap;margin:-.25rem 0 1rem}.delivery-refresh p{margin:0}.delivery-refresh .act{min-height:44px!important}
.delivery-counters{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:.65rem;margin-bottom:1.2rem}.delivery-counter{display:flex;align-items:center;justify-content:space-between;gap:.5rem;min-height:68px;padding:.75rem .85rem;border:1px solid var(--border);border-radius:12px;background:var(--surface-raised);color:var(--ink-700)!important;text-decoration:none!important}.delivery-counter span{font-size:.78rem;font-weight:700;line-height:1.25}.delivery-counter b{font-size:1.5rem}.delivery-counter.is-alert{border-color:var(--danger-border);background:var(--danger-bg);color:var(--danger)!important}
.delivery-group{scroll-margin-top:calc(var(--topbar-h) + 1rem);margin-bottom:1.4rem}.delivery-group-head{align-items:flex-end}.delivery-group-head p{margin:.2rem 0 0;color:var(--ink-500);font-size:.86rem}.delivery-card-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:.8rem}.delivery-group-empty{padding:1rem;border:1px dashed var(--border);border-radius:12px;color:var(--ink-500);font-size:.88rem}
.delivery-card{display:flex;flex-direction:column;gap:.8rem;min-width:0;padding:1rem;border:1px solid var(--border);border-left:4px solid var(--plum-300);border-radius:14px;background:var(--surface-raised);box-shadow:var(--shadow-1)}.delivery-card.is-late{border-left-color:var(--danger)}.delivery-card.is-soon{border-left-color:var(--warn)}
.delivery-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:.8rem}.delivery-card-head h3{display:inline;margin:.1rem .35rem .12rem 0;font-size:1.08rem}.delivery-card-head a{display:block;font-size:.86rem}.delivery-due{display:grid;justify-items:end;text-align:right;gap:.2rem}
.delivery-facts{display:grid;grid-template-columns:1.15fr .7fr 1fr;gap:.55rem;padding:.7rem;border-radius:10px;background:var(--cream-25)}.delivery-facts>div{display:flex;flex-direction:column;gap:.12rem;min-width:0}.delivery-facts>div>span:first-child{color:var(--ink-500);font-size:.7rem;font-weight:750;text-transform:uppercase;letter-spacing:.04em}
.delivery-destination{display:grid;gap:.45rem}.delivery-destination>div{display:flex;align-items:baseline;gap:.35rem;flex-wrap:wrap}.delivery-destination>div>span:first-child{flex-basis:100%}.delivery-contact-line .ok,.delivery-contact-line .muted,.delivery-contact-line .danger-text{flex-basis:100%}
.delivery-block{display:grid;gap:.16rem;padding:.65rem .72rem;border:1px solid var(--danger-border);border-radius:10px;background:var(--danger-bg);color:var(--danger)}.delivery-block span{font-size:.86rem;line-height:1.45}
.delivery-order-details>summary,.delivery-secondary>summary,.delivery-history>summary{min-height:44px;display:flex;align-items:center;cursor:pointer;color:var(--brand);font-size:.88rem;font-weight:650}.delivery-order-detail{margin-top:.45rem;padding:.65rem;border-radius:9px;background:var(--cream-25);font-size:.88rem}.delivery-order-detail p{margin:.55rem 0 0}
.delivery-card a[href^="tel:"]{display:inline-flex;align-items:center;min-height:44px}.delivery-card input,.delivery-card select{min-height:44px}.delivery-card-actions{display:flex;align-items:center;justify-content:space-between;gap:.65rem;flex-wrap:wrap;margin-top:auto;padding-top:.7rem;border-top:1px solid var(--border-soft)}.delivery-card .act{min-height:44px!important}.delivery-secondary{position:relative;margin-left:auto}.delivery-secondary-body{position:absolute;right:0;z-index:7;width:min(310px,85vw);display:grid;gap:.8rem;padding:.8rem;border:1px solid var(--border);border-radius:12px;background:var(--surface-raised);box-shadow:var(--shadow-2)}.delivery-secondary-form{display:grid;gap:.5rem;padding-bottom:.7rem;border-bottom:1px solid var(--border-soft)}.delivery-secondary-body>form.inline{display:block}.delivery-secondary-body>form.inline .act{width:100%}
.delivery-history{margin-top:1.2rem}.delivery-history>summary{justify-content:space-between;padding:.8rem 1rem;border:1px solid var(--border);border-radius:12px;background:var(--surface)}.delivery-history[open]>summary{margin-bottom:.65rem}
@media(max-width:900px){.delivery-counters{grid-template-columns:repeat(2,minmax(0,1fr))}.delivery-facts{grid-template-columns:1fr 1fr}.delivery-facts>div:last-child{grid-column:1/-1}.delivery-card-head{align-items:flex-start}.delivery-secondary-body{position:fixed;left:.75rem;right:.75rem;bottom:.75rem;width:auto;max-height:70vh;overflow:auto}}
@media(max-width:430px){.delivery-card{padding:.85rem}.delivery-card-head{display:grid}.delivery-due{justify-items:start;text-align:left}.delivery-card-actions{align-items:stretch}.delivery-primary,.delivery-primary form,.delivery-primary .act{width:100%}.delivery-secondary{margin-left:0}.delivery-counters{gap:.45rem}.delivery-counter{min-height:60px;padding:.65rem}}
</style>
<header class="page-header"><div class="page-header-copy"><span class="eyebrow">Bar</span><h2>Livraisons</h2><p>Suivez le délai cuisine, le choix de paiement et le départ de chaque commande.</p></div><div class="page-header-actions"><a href="/admin/livraisons/new" class="act">Nouvelle commande</a></div></header>
<div class="delivery-refresh">
  <p class="muted" id="delivery-refresh-status" aria-live="polite">Dernière mise à jour : ${esc(refreshedAt(now))}</p>
  <button class="act act--ghost act--sm" id="delivery-refresh-button" type="button">Rafraîchir</button>
</div>
${renderLivraisonsBoardFragment(data, now)}
<script>
(function(){
  var interval=30000;
  var timer=null,loading=false;
  var status=document.getElementById('delivery-refresh-status');
  var button=document.getElementById('delivery-refresh-button');
  function fragment(){return document.getElementById('delivery-board-fragment');}
  function editing(){
    var root=fragment();
    return !!root&&(!!root.querySelector('details[open]')||!!root.querySelector('form:focus-within'));
  }
  function stamp(root){
    var raw=root&&root.getAttribute('data-refreshed-at');
    var date=raw?new Date(raw):new Date();
    status.textContent='Dernière mise à jour : '+date.toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  }
  function schedule(){clearTimeout(timer);timer=setTimeout(refresh,interval);}
  function refresh(){
    if(loading)return;
    clearTimeout(timer);
    if(document.hidden){schedule();return;}
    if(editing()){status.textContent='Mise à jour suspendue pendant votre saisie ou la consultation d’un détail.';schedule();return;}
    loading=true;
    button.disabled=true;button.setAttribute('aria-busy','true');status.textContent='Mise à jour…';
    fetch('/admin/livraisons/fragment',{headers:{Accept:'text/html'},credentials:'same-origin'})
      .then(function(response){if(!response.ok)throw new Error('refresh_failed');return response.text();})
      .then(function(html){
        var current=fragment();
        if(current)current.outerHTML=html;
        stamp(fragment());
      })
      .catch(function(){status.textContent='Actualisation impossible — réessayez manuellement.';})
      .finally(function(){loading=false;button.disabled=false;button.removeAttribute('aria-busy');schedule();});
  }
  button.addEventListener('click',refresh);
  document.addEventListener('visibilitychange',function(){if(!document.hidden)refresh();});
  schedule();
})();
</script>`;
}

// ---------- create form ----------

function menuByCategory(items: Map<string, CafeMenuItem>): Map<string, CafeMenuItem[]> {
  const groups = new Map<string, CafeMenuItem[]>();
  for (const item of items.values()) {
    const list = groups.get(item.category) ?? [];
    list.push(item);
    groups.set(item.category, list);
  }
  return groups;
}

/** Lowercase + strip accents, for the live article search haystack. */
function normalizeSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/** Values to repopulate the form with after a validation error (or empty on GET). */
export interface LivraisonPrefill {
  client_name?: string;
  client_phone?: string;
  recipient_name?: string;
  recipient_phone?: string;
  wix_contact_id?: string;
  address?: string;
  note?: string;
  sla_minutes?: string;
  delivery_mode?: string;
  scheduled_for?: string;
  kitchen_lead_minutes?: string;
  is_test?: string;
  qty?: Record<string, number>;
  choice?: Record<string, string>;
  errors?: Record<string, string>;
}

export function renderLivraisonForm(
  items: Map<string, CafeMenuItem>,
  banner: string,
  recents: RecentDeliveryClient[] = [],
  prefill: LivraisonPrefill = {},
): string {
  const qty = prefill.qty ?? {};
  const choicePick = prefill.choice ?? {};
  const errors = prefill.errors ?? {};
  const errorOrder = [
    "client_name",
    "client_phone",
    "address",
    "recipient_name",
    "recipient_phone",
    "articles",
    "scheduled_for",
  ];
  const firstError = errorOrder.find((name) => errors[name]);
  const fieldError = (name: string) =>
    errors[name]
      ? `<span class="field-error" id="error-${esc(name)}" role="alert">${esc(errors[name])}</span>`
      : "";
  const fieldState = (name: string) =>
    errors[name]
      ? ` aria-invalid="true" aria-describedby="error-${esc(name)}"${firstError === name ? " autofocus" : ""}`
      : "";
  const groups = menuByCategory(items);
  const sections = [...groups.entries()]
    .map(([cat, list]) => {
      let catHasQty = false;
      const rows = list
        .map((it) => {
          const n = Math.max(0, Math.min(10, qty[it.id] ?? 0));
          if (n > 0) catHasQty = true;
          const choices = it.optionChoices ?? [];
          const picked = choicePick[it.id] ?? "";
          const optionSelect = choices.length
            ? `<select name="choice_${esc(it.id)}" class="liv-choice" style="margin-top:.4rem;width:100%${n > 0 ? "" : ";display:none"}"><option value="">— ${esc(it.optionLabel || "Choix")} (à préciser) —</option>${choices
                .map(
                  (c) =>
                    `<option value="${esc(c)}"${c === picked ? " selected" : ""}>${esc(c)}</option>`,
                )
                .join("")}</select>`
            : "";
          const haystack = esc(normalizeSearch(`${it.name} ${cat} ${it.id}`));
          return `<div class="liv-item${n > 0 ? " on" : ""}" data-search="${haystack}" style="display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;padding:.55rem .2rem;border-top:1px solid var(--border-soft)">
<span style="flex:1;min-width:9rem">${esc(it.name)} <span class="muted">— ${esc(it.priceXof)} F</span></span>
<span class="liv-stepper" style="display:inline-flex;align-items:center;gap:.5rem">
<button type="button" class="act act--ghost act--sm liv-dec" data-id="${esc(it.id)}" aria-label="Retirer ${esc(it.name)}" style="min-width:2.6rem">−</button>
<output class="liv-out" style="min-width:1.4rem;text-align:center;font-weight:650;font-variant-numeric:tabular-nums">${n}</output>
<button type="button" class="act act--ghost act--sm liv-inc" data-id="${esc(it.id)}" aria-label="Ajouter ${esc(it.name)}" style="min-width:2.6rem">+</button>
</span>
<input type="hidden" name="qty_${esc(it.id)}" value="${n}" data-price="${esc(it.priceXof)}">
${optionSelect}</div>`;
        })
        .join("");
      return `<details class="card liv-cat"${catHasQty ? " open" : ""}><summary style="font-weight:600;cursor:pointer">${esc(cat || "Autres")} <span class="muted">(${list.length})</span></summary>${rows}</details>`;
    })
    .join("");
  const menuUnavailable = items.size === 0 ? `<div class="card warn">⚠️ aucun article disponible dans le menu actif.</div>` : "";
  const recentResults = recents
    .map(
      (r) =>
        `<button type="button" class="act act--ghost liv-wix-result" role="option" data-source="recent" data-name="${esc(r.client_name)}" data-phone="${esc(r.client_phone)}" data-address="${esc(r.address)}"><b>${esc(r.client_name)}</b><small class="muted">Client récent · +${esc(r.client_phone)} · ${esc(r.address)}</small></button>`,
    )
    .join("");
  const recentClientsJson = JSON.stringify(
    recents.map((r) => ({
      id: "",
      source: "recent",
      name: r.client_name,
      phone: r.client_phone,
      address: r.address,
    })),
  ).replaceAll("<", "\\u003c");
  const searchBox = items.size
    ? `<input id="liv-search" type="search" placeholder="🔍 Rechercher un article…" autocomplete="off" style="width:100%">`
    : "";
  const sla = prefill.sla_minutes ?? String(config.DELIVERY_SLA_MINUTES);
  const deliveryMode = prefill.delivery_mode === "scheduled" ? "scheduled" : "now";
  const kitchenLead = [30, 60, 90].includes(Number(prefill.kitchen_lead_minutes))
    ? Number(prefill.kitchen_lead_minutes)
    : 60;
  const scheduleMin = dakarInputValue(new Date(Date.now() + 60_000));
  const hasWixClient = !!prefill.wix_contact_id;
  const hasRecipient = !!(prefill.recipient_name || prefill.recipient_phone);
  const selectedName = String(prefill.client_name ?? "").trim();
  return `${banner}
<style>
.delivery-create-form{gap:1rem}.delivery-form-panel{position:relative;padding:1.15rem}.delivery-panel-heading{display:flex;align-items:flex-start;gap:.75rem;margin-bottom:1rem}.delivery-panel-heading h2{margin:0;font-size:1.15rem}.delivery-panel-heading p{margin:.18rem 0 0}.delivery-panel-number{width:2rem;height:2rem;flex:0 0 2rem;display:grid;place-items:center;border-radius:50%;background:var(--brand);color:#fff;font-weight:750}
.delivery-client-picker{padding:.8rem;border:1px solid var(--border);border-radius:11px;background:var(--cream-25)}.liv-wix-results{display:grid;gap:.35rem;max-height:18rem;overflow:auto;margin-top:.45rem;padding:.45rem}
.liv-wix-result{display:block;width:100%;text-align:left;white-space:normal}
.liv-wix-result small{display:block;margin-top:.15rem;font-weight:400}
.delivery-selected-client{display:flex;align-items:center;justify-content:space-between;gap:.7rem;margin-top:.65rem;padding:.7rem;border:1px solid var(--brand-border);border-radius:10px;background:var(--brand-soft)}.delivery-selected-client p{margin:0}.delivery-manual{margin-top:.8rem}.delivery-manual>summary{min-height:44px;display:flex;align-items:center;color:var(--brand);font-weight:650}.delivery-manual-grid{display:grid;grid-template-columns:1fr 1fr;gap:.8rem}.delivery-manual-grid .wide{grid-column:1/-1}
.liv-item.on{background:var(--brand-soft);border-radius:8px}.liv-item.on>span:first-child{font-weight:650}.liv-stepper .act{min-width:44px;min-height:44px!important}.liv-choice{flex-basis:100%}.liv-cat>summary{min-height:44px;display:flex;align-items:center}
.liv-optional-fields[hidden]{display:none}.field-error{display:block;margin-top:.3rem;color:var(--danger);font-size:.82rem;font-weight:650}.delivery-article-error{margin:.5rem 0;padding:.6rem .7rem;border-radius:9px;background:var(--danger-bg);color:var(--danger)}
.delivery-mode-options{display:grid;grid-template-columns:1fr 1fr;gap:.65rem}.delivery-radio{display:flex;align-items:center;gap:.55rem;min-height:48px;padding:.65rem;border:1px solid var(--border);border-radius:10px;background:var(--cream-25)}.delivery-radio:has(input:checked){border-color:var(--brand);background:var(--brand-soft)}
.delivery-advanced{margin-top:.8rem}.delivery-advanced>summary{min-height:44px;display:flex;align-items:center;color:var(--brand);font-weight:650}.delivery-advanced-body{display:grid;gap:.8rem;padding-top:.65rem}
.delivery-create-form input:not([type="hidden"]),.delivery-create-form select,.delivery-create-form button{min-height:44px}.delivery-create-form .act{min-height:44px!important}.delivery-create-summary{justify-content:space-between}.delivery-summary-facts{display:flex;align-items:center;gap:.55rem;flex-wrap:wrap}.delivery-summary-facts span{font-size:.82rem}.delivery-summary-actions{display:flex;align-items:center;gap:.65rem}.delivery-summary-actions>a{display:inline-flex;align-items:center;min-height:44px}.delivery-summary-actions .act{min-height:46px}
@media(max-width:650px){.delivery-manual-grid,.delivery-mode-options{grid-template-columns:1fr}.delivery-manual-grid .wide{grid-column:auto}.delivery-create-summary{align-items:stretch}.delivery-summary-facts{display:grid;grid-template-columns:1fr 1fr;flex:1}.delivery-summary-actions{width:100%}.delivery-summary-actions .act{flex:1}.delivery-form-panel{padding:.9rem}}
</style>
<header class="page-header"><div class="page-header-copy"><span class="eyebrow">Livraisons</span><h2>Nouvelle commande</h2><p>Le client choisira Wave, Orange Money, Max It ou espèces avec Awa. Le montant est calculé automatiquement depuis le menu actif.</p></div></header>
<form method="post" action="/admin/livraisons" class="col delivery-create-form">
  <section class="card delivery-form-panel" aria-labelledby="delivery-panel-client">
    <div class="delivery-panel-heading"><span class="delivery-panel-number">1</span><div><h2 id="delivery-panel-client">Client et destination</h2><p class="muted">Retrouvez une fiche récente ou Wix, puis vérifiez les coordonnées de remise.</p></div></div>
    <div class="delivery-client-picker">
      <label for="liv-wix-search">Rechercher un client <span class="muted">(récent ou Wix)</span></label>
      <input id="liv-wix-search" type="search" autocomplete="off" placeholder="Nom, téléphone ou e-mail…" aria-controls="liv-wix-results" aria-autocomplete="list">
      <input id="liv-wix-id" name="wix_contact_id" type="hidden" value="${esc(prefill.wix_contact_id ?? "")}">
      <div id="liv-wix-results" class="liv-wix-results" role="listbox"${recentResults ? "" : " hidden"}>${recentResults}</div>
      <span id="liv-wix-status" class="muted" aria-live="polite">${hasWixClient ? "Fiche Wix sélectionnée." : recentResults ? "Clients récents — recherchez pour interroger aussi Wix." : "Aucun client récent. La saisie manuelle reste disponible."}</span>
      <div id="liv-selected-client" class="delivery-selected-client"${selectedName ? "" : " hidden"}>
        <p><b id="liv-selected-name">${esc(selectedName || "Client")}</b><br><span id="liv-selected-detail" class="muted">${esc(prefill.client_phone ?? "")}${hasWixClient ? " · fiche Wix liée" : ""}</span></p>
        <button id="liv-wix-clear" type="button" class="act act--ghost act--sm">Modifier</button>
      </div>
    </div>
    <details class="delivery-manual" open>
      <summary>Saisie manuelle de secours et vérification</summary>
      <div class="delivery-manual-grid">
        <label>Nom du client<input name="client_name" required value="${esc(prefill.client_name ?? "")}"${fieldState("client_name")}>${fieldError("client_name")}</label>
        <label>Téléphone (WhatsApp)<input name="client_phone" type="tel" inputmode="tel" required placeholder="77 123 45 67 ou +221…" value="${esc(prefill.client_phone ?? "")}"${fieldState("client_phone")}>${fieldError("client_phone")}</label>
        <label class="wide">Adresse de livraison<input name="address" required value="${esc(prefill.address ?? "")}"${fieldState("address")}>${fieldError("address")}</label>
        <label class="wide">Note <span class="muted">(optionnel)</span><input name="note" value="${esc(prefill.note ?? "")}"></label>
      </div>
    </details>
    <fieldset class="col" style="margin-top:1rem">
      <legend><b>Remise de la livraison</b></legend>
      <label class="delivery-radio">
        <input id="liv-recipient-toggle" type="checkbox"${hasRecipient ? " checked" : ""} aria-controls="liv-recipient-fields" aria-expanded="${hasRecipient ? "true" : "false"}" style="width:auto;margin-top:.2rem">
        <span><b>Une autre personne récupère la livraison</b><br><span class="muted">Le livreur devra appeler ce contact à la place de la cliente.</span></span>
      </label>
      <div id="liv-recipient-fields" class="col liv-optional-fields"${hasRecipient ? "" : " hidden"}>
        <label>Nom du contact<input name="recipient_name" maxlength="120" placeholder="Ex. Fatou, assistante" value="${esc(prefill.recipient_name ?? "")}"${hasRecipient ? " required" : ""}${fieldState("recipient_name")}>${fieldError("recipient_name")}</label>
        <label>Téléphone du contact<input name="recipient_phone" type="tel" inputmode="tel" placeholder="77 123 45 67 ou +221…" value="${esc(prefill.recipient_phone ?? "")}"${hasRecipient ? " required" : ""}${fieldState("recipient_phone")}>${fieldError("recipient_phone")}</label>
        <span class="muted">Cette personne recevra uniquement l’alerte quand la commande partira.</span>
      </div>
    </fieldset>
  </section>

  <section class="card delivery-form-panel" aria-labelledby="delivery-panel-items">
    <div class="delivery-panel-heading"><span class="delivery-panel-number">2</span><div><h2 id="delivery-panel-items">Articles</h2><p class="muted">Ajoutez les quantités et précisez chaque option obligatoire.</p></div></div>
    ${menuUnavailable}
    ${searchBox}
    <p id="liv-noresult" class="muted" hidden>Aucun article ne correspond.</p>
    <p id="liv-article-error" class="delivery-article-error"${errors.articles ? "" : " hidden"} role="alert"${firstError === "articles" ? ' data-first-error="true"' : ""}>${esc(errors.articles ?? "")}</p>
    ${sections}
  </section>

  <section class="card delivery-form-panel" aria-labelledby="delivery-panel-confirm">
    <div class="delivery-panel-heading"><span class="delivery-panel-number">3</span><div><h2 id="delivery-panel-confirm">Livraison et confirmation</h2><p class="muted">Vérifiez le moment promis avant de créer la commande.</p></div></div>
    <fieldset class="col">
      <legend><b>Moment de la livraison</b></legend>
      <div class="delivery-mode-options">
        <label class="delivery-radio"><input name="delivery_mode" type="radio" value="now"${deliveryMode === "now" ? " checked" : ""}> Maintenant</label>
        <label class="delivery-radio"><input name="delivery_mode" type="radio" value="scheduled"${deliveryMode === "scheduled" ? " checked" : ""}> Programmer</label>
      </div>
      <div id="liv-schedule-fields" class="col"${deliveryMode === "scheduled" ? "" : " hidden"}>
        <label>Arrivée promise au client (heure de Dakar)
          <input name="scheduled_for" type="datetime-local" min="${esc(scheduleMin)}" value="${esc(prefill.scheduled_for ?? "")}"${deliveryMode === "scheduled" ? " required" : ""}${fieldState("scheduled_for")}>
          ${fieldError("scheduled_for")}
        </label>
        <label>Alerter la cuisine
          <select name="kitchen_lead_minutes">
            ${[30, 60, 90].map((n) => `<option value="${n}"${kitchenLead === n ? " selected" : ""}>${n} minutes avant l'arrivée</option>`).join("")}
          </select>
        </label>
        <span class="muted">Si ce délai est déjà atteint, la commande sera activée immédiatement.</span>
      </div>
    </fieldset>
    <details class="delivery-advanced">
      <summary>Réglages avancés · rarement utilisés</summary>
      <div class="delivery-advanced-body">
        <label>Alerte si pas partie après (min)<input name="sla_minutes" type="number" min="5" max="180" value="${esc(sla)}" style="width:7rem"></label>
        <label class="delivery-radio">
          <input name="is_test" type="checkbox" value="1"${prefill.is_test === "1" ? " checked" : ""}>
          <span><b>🧪 Commande de test</b><br><span class="muted">Alertes réelles, mais commande exclue des statistiques, clients récents et factures.</span></span>
        </label>
      </div>
    </details>
  </section>

  <div class="actionbar delivery-create-summary" aria-label="Récapitulatif de la commande">
    <div class="delivery-summary-facts">
      <span><b id="livcount">0</b> article(s)</span>
      <span><b id="livmissing">0</b> option(s) manquante(s)</span>
      <span>Total <b><span id="livtotal">0</span> F</b></span>
      <span>Livraison <b id="livmoment">maintenant</b></span>
      <span>Destinataire <b id="livrecipient">${esc(selectedName || "à renseigner")}</b></span>
    </div>
    <div class="delivery-summary-actions"><a href="/admin/livraisons">Annuler</a><button class="act" type="submit">Créer la commande</button></div>
  </div>
</form>
<script>
(function(){
  var form=document.querySelector('form[action="/admin/livraisons"]');
  var wixSearch=document.getElementById('liv-wix-search');
  var wixId=document.getElementById('liv-wix-id');
  var wixResults=document.getElementById('liv-wix-results');
  var wixStatus=document.getElementById('liv-wix-status');
  var wixClear=document.getElementById('liv-wix-clear');
  var selectedClient=document.getElementById('liv-selected-client');
  var selectedName=document.getElementById('liv-selected-name');
  var selectedDetail=document.getElementById('liv-selected-detail');
  var clientName=form&&form.querySelector('[name="client_name"]');
  var clientPhone=form&&form.querySelector('[name="client_phone"]');
  var clientAddress=form&&form.querySelector('[name="address"]');
  var recipientToggle=document.getElementById('liv-recipient-toggle');
  var recipientFields=document.getElementById('liv-recipient-fields');
  var recipientName=form&&form.querySelector('[name="recipient_name"]');
  var recipientPhone=form&&form.querySelector('[name="recipient_phone"]');
  var scheduleFields=document.getElementById('liv-schedule-fields');
  var scheduleInput=form&&form.querySelector('[name="scheduled_for"]');
  var articleError=document.getElementById('liv-article-error');
  var recentClients=${recentClientsJson};
  var wixTimer=null,wixRequest=null;
  function hideWixResults(){wixResults.hidden=true;wixResults.replaceChildren();}
  function pickWixClient(client){
    wixId.value=client.id||'';
    if(clientName)clientName.value=client.name||'';
    if(clientPhone)clientPhone.value=client.phone||'';
    if(clientAddress)clientAddress.value=client.address||'';
    wixSearch.value=client.name||'';
    wixStatus.textContent=client.id?'✓ Fiche Wix sélectionnée.':'✓ Client récent sélectionné.';
    selectedName.textContent=client.name||'Client';
    selectedDetail.textContent=[client.phone,client.id?'fiche Wix liée':'client récent'].filter(Boolean).join(' · ');
    selectedClient.hidden=false;
    hideWixResults();
    recompute();
  }
  function showClients(clients,statusText){
    wixResults.replaceChildren();
    if(!clients.length){wixStatus.textContent=statusText||'Aucun client trouvé. Vous pouvez continuer manuellement.';wixResults.hidden=true;return;}
    clients.forEach(function(client){
      var button=document.createElement('button');
      button.type='button';button.className='act act--ghost liv-wix-result';button.setAttribute('role','option');
      button.dataset.id=client.id||'';button.dataset.name=client.name||'';button.dataset.phone=client.phone||'';button.dataset.address=client.address||'';
      var title=document.createElement('b');title.textContent=client.name||'Client Wix';button.appendChild(title);
      var details=[client.source==='recent'?'Client récent':'Wix',client.phone,client.email,client.address].filter(Boolean);
      if(details.length){var small=document.createElement('small');small.className='muted';small.textContent=details.join(' · ');button.appendChild(small);}
      wixResults.appendChild(button);
    });
    wixStatus.textContent=statusText||clients.length+' résultat(s) — choisissez une fiche.';
    wixResults.hidden=false;
  }
  function matchingRecents(q){
    var needle=q.toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'');
    return recentClients.filter(function(client){
      return [client.name,client.phone,client.address].join(' ').toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').indexOf(needle)>=0;
    });
  }
  if(wixSearch)wixSearch.addEventListener('input',function(){
    var q=this.value.trim();
    wixId.value='';
    selectedClient.hidden=true;
    clearTimeout(wixTimer);if(wixRequest)wixRequest.abort();
    if(q.length<2){
      if(!q&&recentClients.length)showClients(recentClients,'Clients récents — saisissez 2 caractères pour chercher aussi dans Wix.');
      else{hideWixResults();wixStatus.textContent=q?'Saisissez au moins 2 caractères.':'La saisie manuelle reste disponible.';}
      return;
    }
    var local=matchingRecents(q);
    showClients(local,local.length?local.length+' client(s) récent(s) · recherche Wix en cours…':'Recherche dans Wix…');
    wixTimer=setTimeout(function(){
      wixRequest=new AbortController();
      fetch('/admin/livraisons/clients?q='+encodeURIComponent(q),{headers:{Accept:'application/json'},signal:wixRequest.signal})
        .then(function(response){if(!response.ok)throw new Error('Wix indisponible');return response.json();})
        .then(function(data){
          if(wixSearch.value.trim()!==q)return;
          var wix=Array.isArray(data.clients)?data.clients.map(function(client){return Object.assign({source:'wix'},client);}):[];
          var phones=new Set(wix.map(function(client){return client.phone||'';}).filter(Boolean));
          var combined=local.filter(function(client){return !phones.has(client.phone);}).concat(wix);
          showClients(combined,combined.length?combined.length+' résultat(s) récents et Wix — choisissez une fiche.':'Aucun client trouvé. Vous pouvez continuer manuellement.');
        })
        .catch(function(error){
          if(error.name!=='AbortError'){
            showClients(local,local.length?'Wix indisponible · résultats récents affichés.':'Recherche Wix indisponible — utilisez la saisie manuelle.');
          }
        });
    },250);
  });
  if(wixResults)wixResults.addEventListener('click',function(event){
    var button=event.target.closest('.liv-wix-result');
    if(!button)return;
    pickWixClient({
      id:button.dataset.id||'',
      name:button.dataset.name||button.querySelector('b')?.textContent||'',
      phone:button.dataset.phone||'',
      address:button.dataset.address||''
    });
  });
  if(wixClear)wixClear.addEventListener('click',function(){
    wixId.value='';wixSearch.value='';selectedClient.hidden=true;
    if(recentClients.length)showClients(recentClients,'Clients récents — ou recherchez une autre fiche dans Wix.');
    else{hideWixResults();wixStatus.textContent='Modifiez les coordonnées ou recherchez une autre fiche.';}
    wixSearch.focus();
  });
  function syncDeliveryMode(){
    var mode=form&&form.querySelector('[name="delivery_mode"]:checked');
    var scheduled=!!mode&&mode.value==='scheduled';
    if(scheduleFields)scheduleFields.hidden=!scheduled;
    if(scheduleInput)scheduleInput.required=scheduled;
    recompute();
  }
  if(form)form.querySelectorAll('[name="delivery_mode"]').forEach(function(input){
    input.addEventListener('change',syncDeliveryMode);
  });
  function syncRecipient(shouldFocus){
    var enabled=!!recipientToggle&&recipientToggle.checked;
    if(recipientFields)recipientFields.hidden=!enabled;
    if(recipientToggle)recipientToggle.setAttribute('aria-expanded',enabled?'true':'false');
    [recipientName,recipientPhone].forEach(function(input){
      if(!input)return;
      input.required=enabled;
      if(!enabled)input.value='';
    });
    if(enabled&&shouldFocus&&recipientName)recipientName.focus();
    recompute();
  }
  if(recipientToggle)recipientToggle.addEventListener('change',function(){syncRecipient(true);});
  function recompute(){
    var t=0,c=0,missing=0;
    document.querySelectorAll('input[name^="qty_"]').forEach(function(i){
      var q=parseInt(i.value,10)||0;
      if(q>0){t+=q*(parseInt(i.dataset.price,10)||0);c+=q;}
      var row=i.closest('.liv-item');
      if(row){
        row.classList.toggle('on',q>0);
        var sel=row.querySelector('.liv-choice');
        if(sel){sel.style.display=q>0?'':'none';sel.required=q>0;if(q>0&&!sel.value)missing++;}
      }
    });
    document.getElementById('livtotal').textContent=t.toLocaleString('fr-FR');
    document.getElementById('livcount').textContent=c;
    document.getElementById('livmissing').textContent=missing;
    var mode=form&&form.querySelector('[name="delivery_mode"]:checked');
    var moment=mode&&mode.value==='scheduled'&&scheduleInput&&scheduleInput.value
      ? scheduleInput.value.replace('T',' à ')
      : mode&&mode.value==='scheduled'?'à programmer':'maintenant';
    document.getElementById('livmoment').textContent=moment;
    var recipient=recipientToggle&&recipientToggle.checked&&recipientName&&recipientName.value.trim()
      ? recipientName.value.trim()
      : clientName&&clientName.value.trim()?clientName.value.trim():'à renseigner';
    document.getElementById('livrecipient').textContent=recipient;
    return {count:c,missing:missing};
  }
  function bump(id,d){
    var inp=document.querySelector('input[name="qty_'+id+'"]');
    if(!inp)return;
    var v=(parseInt(inp.value,10)||0)+d;
    if(v<0)v=0;if(v>10)v=10;
    inp.value=v;
    var out=inp.closest('.liv-item').querySelector('.liv-out');
    if(out)out.textContent=v;
    recompute();
  }
  document.addEventListener('click',function(e){
    var inc=e.target.closest('.liv-inc'),dec=e.target.closest('.liv-dec');
    if(inc)bump(inc.dataset.id,1);
    else if(dec)bump(dec.dataset.id,-1);
  });
  document.querySelectorAll('.liv-choice').forEach(function(select){
    select.addEventListener('change',function(){recompute();if(this.value)this.removeAttribute('aria-invalid');});
  });
  var search=document.getElementById('liv-search');
  if(search)search.addEventListener('input',function(){
    var q=this.value.trim().toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'');
    var any=false;
    document.querySelectorAll('.liv-cat').forEach(function(cat){
      var shown=0;
      cat.querySelectorAll('.liv-item').forEach(function(row){
        var m=!q||row.dataset.search.indexOf(q)>=0;
        row.style.display=m?'':'none';
        if(m)shown++;
      });
      cat.style.display=shown?'':'none';
      if(q)cat.open=shown>0;
      if(shown)any=true;
    });
    document.getElementById('liv-noresult').hidden=!(q&&!any);
  });
  [clientName,clientPhone,clientAddress,recipientName,recipientPhone,scheduleInput].forEach(function(input){
    if(!input)return;
    input.addEventListener('input',function(){
      this.removeAttribute('aria-invalid');
      var described=this.getAttribute('aria-describedby');
      if(described){var error=document.getElementById(described);if(error)error.hidden=true;}
      recompute();
    });
  });
  syncRecipient(false);
  syncDeliveryMode();
  recompute();
  if(articleError&&articleError.dataset.firstError==='true'&&search)search.focus();
  if(form)form.addEventListener('submit',function(event){
    var state=recompute();
    if(state.count===0){
      event.preventDefault();
      articleError.textContent='Ajoutez au moins un article à la commande.';
      articleError.hidden=false;
      var firstAdd=document.querySelector('.liv-inc');
      (search||firstAdd).focus();
      return;
    }
    if(state.missing>0){
      event.preventDefault();
      articleError.textContent='Précisez les options obligatoires avant de continuer.';
      articleError.hidden=false;
      var missing=document.querySelector('.liv-choice:required:invalid');
      if(missing)missing.focus();
      return;
    }
    if(articleError)articleError.hidden=true;
  });
})();
</script>`;
}
