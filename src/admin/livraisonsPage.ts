import { config } from "../config.js";
import { type CafeMenuItem, formatExtrasMultiline, formatExtrasOneLine } from "../lib/cafeMenu.js";
import {
  orderItems,
  type ClosedDeliveryOrder,
  type DeliveryOrder,
  type DeliveryStats,
  type RecentDeliveryClient,
} from "../domain/deliveryRepo.js";
import { formatDakarDateTime } from "../domain/deliveryRules.js";

/**
 * Body HTML for /admin/livraisons — server-rendered, self-contained escaping so
 * it doesn't import from routes.ts (which imports this). routes.ts wraps it in
 * layout() (board with a 60s auto-refresh; the create form on its own page with
 * no refresh so a half-typed order is never wiped) and owns the POST handlers.
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

function minutesSince(d: Date | string): number {
  return Math.floor((Date.now() - new Date(d).getTime()) / 60000);
}

function isWaitingForActivation(o: DeliveryOrder): boolean {
  return !!o.scheduled_for && !o.activated_at;
}

function dakarInputValue(value: Date | string): string {
  const d = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function arrivalCountdown(value: Date | string): string {
  const mins = Math.ceil((new Date(value).getTime() - Date.now()) / 60000);
  if (mins <= 0) return "activation imminente";
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const rest = mins % 60;
  if (days > 0) return `dans ${days} j ${hours} h`;
  if (hours > 0) return `dans ${hours} h ${rest} min`;
  return `dans ${rest} min`;
}

/** Colored SLA badge: green <10 min, amber <SLA, red ≥SLA; distinct once departed. */
function slaBadge(o: DeliveryOrder): string {
  if (o.status === "OUT_FOR_DELIVERY") {
    const since = o.out_for_delivery_at ? minutesSince(o.out_for_delivery_at) : 0;
    return `<span class="badge badge--green">en route (${since} min)</span>`;
  }
  const elapsed = minutesSince(o.kitchen_notify_at ?? o.created_at);
  const remaining = o.sla_minutes - elapsed;
  let cls: string;
  let label: string;
  if (remaining <= 0) {
    cls = "badge--red";
    label = `+${-remaining} min`;
  } else if (elapsed < 10) {
    cls = "badge--green";
    label = `reste ${remaining} min`;
  } else {
    cls = "badge--amber";
    label = `reste ${remaining} min`;
  }
  return `<span class="badge ${cls}">${label}</span>`;
}

function kitchenStatusCell(o: DeliveryOrder): string {
  const s = o.kitchen_notify_status;
  if (s === "sent" || s === "sent_template") return `<span class="ok">✓ cuisine</span>`;
  if (s === "partial") return `<span class="warn-text">Partiel</span>`;
  if (s === "fallback_reception")
    return `<span class="warn-text">Réception prévenue</span>`;
  if (s === "pending" || s === "claimed") return `<span class="muted">envoi en cours…</span>`;
  return `<span class="danger-text">Cuisine non notifiée</span>`;
}

function inlineForm(action: string, label: string, confirm?: string, variant = ""): string {
  const confirmation = confirm ? ` data-confirm="${esc(confirm)}"` : "";
  const cls = variant ? ` act--${variant}` : "";
  return `<form method="post" action="${esc(action)}" class="inline"${confirmation}><button class="act act--sm${cls}" type="submit">${esc(label)}</button></form>`;
}

function actionsCell(o: DeliveryOrder): string {
  const base = `/admin/livraisons/${o.id}`;
  const parts: string[] = [];
  const kitchenBad = ["failed", "partial", "fallback_reception"].includes(o.kitchen_notify_status);
  if (o.status === "IN_KITCHEN") {
    if (!o.activated_at) return "";
    if (o.payment_status === "CASH_DUE" || o.payment_status === "PAID") {
      parts.push(inlineForm(`${base}/depart`, "🛵 Partie", undefined, "ok"));
      parts.push(inlineForm(`${base}/delivered`, "✓ Livrée", undefined, "ghost"));
    } else if (o.payment_status !== "REFUND_NEEDED") {
      parts.push(`<span class="badge badge--amber">Départ bloqué</span>`);
      parts.push(inlineForm(`${base}/cash`, "💵 Espèces", "Confirmer le paiement en espèces à la livraison ?", "ghost"));
    }
    if (kitchenBad) parts.push(inlineForm(`${base}/renotify-kitchen`, "🔁 Renvoyer", undefined, "ghost"));
    parts.push(inlineForm(`${base}/cancel`, "✖ Annuler", "Annuler cette commande ?", "danger"));
  } else if (o.status === "OUT_FOR_DELIVERY") {
    parts.push(inlineForm(`${base}/delivered`, "✓ Livrée", undefined, "ok"));
    parts.push(
      inlineForm(`${base}/cancel`, "✖ Annuler", "La commande est en route — annuler quand même ?", "danger"),
    );
  }
  return parts.join(" ");
}

function scheduledActionsCell(o: DeliveryOrder): string {
  const base = `/admin/livraisons/${o.id}`;
  const arrival = o.scheduled_for ? dakarInputValue(o.scheduled_for) : "";
  const lead =
    o.scheduled_for && o.kitchen_notify_at
      ? Math.round(
          (new Date(o.scheduled_for).getTime() - new Date(o.kitchen_notify_at).getTime()) /
            60000,
        )
      : 60;
  return `<details class="inline">
<summary class="act act--sm act--ghost">Reprogrammer</summary>
<form method="post" action="${esc(base)}/reschedule" class="card col" style="margin-top:.5rem;min-width:17rem">
  <label>Nouvelle arrivée (Dakar)<input name="scheduled_for" type="datetime-local" required value="${esc(arrival)}"></label>
  <label>Alerter la cuisine
    <select name="kitchen_lead_minutes">
      ${[30, 60, 90].map((n) => `<option value="${n}"${lead === n ? " selected" : ""}>${n} min avant</option>`).join("")}
    </select>
  </label>
  <button class="act act--sm" type="submit">Enregistrer</button>
</form>
</details> ${inlineForm(`${base}/cancel`, "✖ Annuler", "Annuler cette commande programmée ?", "danger")}`;
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
      return `<span class="ok">✓ Payé</span><br><span class="muted">${esc(method)}</span>`;
    case "CASH_DUE":
      return `<b>${esc(o.amount_xof)} F</b><br><span class="warn-text">espèces à encaisser</span>`;
    case "AWAITING_PAYMENT":
      return `<b>${esc(o.amount_xof)} F</b><br><span class="muted">lien envoyé</span>`;
    case "REFUND_NEEDED":
      return `<span class="danger-text">Remboursement à traiter</span>`;
    default:
      return `<b>${esc(o.amount_xof)} F</b><br><span class="muted">choix en attente</span>`;
  }
}

/**
 * Client-ping flag for the status-relevant ping: the confirmation (IN_KITCHEN)
 * or the en-route ping (OUT_FOR_DELIVERY). A failed confirmation is a soft
 * warning (nothing is blocked yet); a failed route ping is the red "call the
 * client" the runner must act on.
 */
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
    return `<div class="muted" style="margin-top:.35rem">Remise à la cliente</div>`;
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
  return `<div style="margin-top:.35rem"><b>Remise à ${esc(o.recipient_name)}</b><br><a href="https://wa.me/${esc(o.recipient_phone)}" target="_blank" rel="noreferrer" class="muted">+${esc(o.recipient_phone)}</a>${notify}</div>`;
}

function recipientEditor(o: DeliveryOrder): string {
  return `<details style="margin-top:.4rem">
<summary class="muted" style="cursor:pointer">Modifier le contact de remise</summary>
<form method="post" action="/admin/livraisons/${esc(o.id)}/recipient" class="card col" style="margin-top:.45rem;min-width:16rem">
  <label>Nom<input name="recipient_name" maxlength="120" value="${esc(o.recipient_name ?? "")}" placeholder="Ex. Fatou, assistante"></label>
  <label>Téléphone<input name="recipient_phone" type="tel" inputmode="tel" value="${esc(o.recipient_phone ?? "")}" placeholder="77 123 45 67 ou +221…"></label>
  <span class="muted">Videz les deux champs pour supprimer ce contact.</span>
  <button class="act act--sm" type="submit">Enregistrer</button>
</form>
</details>`;
}

function clientCell(o: DeliveryOrder): string {
  return `${o.is_test ? `<span class="badge badge--violet">🧪 Test</span><br>` : ""}<b>${esc(o.client_name)}</b><br><a href="https://wa.me/${esc(o.client_phone)}" target="_blank" rel="noreferrer" class="muted">+${esc(o.client_phone)}</a>${clientFlag(o)}${recipientBlock(o)}${recipientEditor(o)}`;
}

function openRow(o: DeliveryOrder): string {
  const items = orderItems(o);
  return `<tr>
<td data-label="Délai">${slaBadge(o)}</td>
<td data-label="Client">${clientCell(o)}</td>
<td data-label="Commande">${esc(formatExtrasOneLine(items))}<details><summary class="muted">Voir le détail</summary><div style="white-space:pre-wrap">${esc(formatExtrasMultiline(items))}</div></details></td>
<td data-label="Adresse" class="hide-sm">${esc(o.address)}</td>
<td data-label="Paiement" class="nowrap">${paymentCell(o)}</td>
<td data-label="Cuisine" class="hide-sm">${kitchenStatusCell(o)}</td>
<td data-label="Actions">${actionsCell(o)}</td>
</tr>`;
}

function scheduledRow(o: DeliveryOrder): string {
  const arrival = o.scheduled_for
    ? formatDakarDateTime(o.scheduled_for, "fr")
    : "—";
  const kitchenAt = o.kitchen_notify_at
    ? formatDakarDateTime(o.kitchen_notify_at, "fr")
    : "—";
  return `<tr>
<td data-label="Arrivée"><b>${esc(arrival)}</b><br><span class="badge badge--violet">${esc(o.scheduled_for ? arrivalCountdown(o.scheduled_for) : "")}</span></td>
<td data-label="Client">${clientCell(o)}</td>
<td data-label="Commande">${esc(formatExtrasOneLine(orderItems(o)))}</td>
<td data-label="Paiement" class="nowrap">${paymentCell(o)}</td>
<td data-label="Cuisine" class="hide-sm"><span class="muted">${esc(kitchenAt)}</span></td>
<td data-label="Actions">${scheduledActionsCell(o)}</td>
</tr>`;
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
  open: DeliveryOrder[];
  recent: ClosedDeliveryOrder[];
  stats: DeliveryStats;
  banner: string;
}

export function renderLivraisonsBoard(data: BoardData): string {
  const { open, recent, stats } = data;
  const scheduled = open.filter(isWaitingForActivation);
  const active = open.filter((o) => !isWaitingForActivation(o));
  const avg = stats.avgPrepMinutes === null ? "—" : `${Math.round(stats.avgPrepMinutes)} min`;
  const scheduledTable = scheduled.length
    ? `<div class="table-wrap"><table class="responsive-table"><thead><tr><th>Arrivée promise</th><th>Client</th><th>Commande</th><th>Paiement</th><th class="hide-sm">Alerte cuisine</th><th>Actions</th></tr></thead><tbody>${scheduled.map(scheduledRow).join("")}</tbody></table></div>`
    : `<div class="empty"><b>Aucune livraison programmée</b></div>`;
  const openTable = active.length
    ? `<div class="table-wrap"><table class="responsive-table"><thead><tr><th>Délai</th><th>Client</th><th>Commande</th><th class="hide-sm">Adresse</th><th>Paiement</th><th class="hide-sm">Cuisine</th><th>Actions</th></tr></thead><tbody>${active.map(openRow).join("")}</tbody></table></div>`
    : `<div class="empty"><b>Aucune commande en cours</b><p>Les nouvelles livraisons apparaîtront ici avec leur délai.</p></div>`;
  const recentTable = recent.length
    ? `<div class="table-wrap"><table class="responsive-table"><thead><tr><th>État</th><th>Client</th><th>Commande</th><th class="hide-sm">Paiement</th><th>Durées</th></tr></thead><tbody>${recent.map(closedRow).join("")}</tbody></table></div>`
    : `<div class="empty"><b>Aucun historique récent</b></div>`;
  return `${data.banner}
<header class="page-header"><div class="page-header-copy"><span class="eyebrow">Bar</span><h2>Livraisons</h2><p>Suivez le délai cuisine, le choix de paiement et le départ de chaque commande.</p></div><div class="page-header-actions"><a href="/admin/livraisons/new" class="act">Nouvelle commande</a></div></header>
<div class="stat-grid">
  <div class="stat"><span class="muted">Ouvertes</span><b>${stats.openCount}</b></div>
  <div class="stat"><span class="muted">Départ moyen (30 j)</span><b>${avg}</b></div>
  <div class="stat"><span class="muted">En retard aujourd'hui</span><b>${stats.lateToday}</b></div>
</div>
<div class="section-header"><h2>Programmées</h2><span class="badge ${scheduled.length ? "badge--violet" : "badge--green"}">${scheduled.length}</span></div>
<div class="card">${scheduledTable}</div>
<div class="section-header"><h2>En cours</h2><span class="badge ${active.length ? "badge--amber" : "badge--green"}">${active.length}</span></div>
<div class="card">${openTable}</div>
<div class="section-header"><h2>Historique récent</h2></div>
<div class="card">${recentTable}</div>`;
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
}

export function renderLivraisonForm(
  items: Map<string, CafeMenuItem>,
  banner: string,
  recents: RecentDeliveryClient[] = [],
  prefill: LivraisonPrefill = {},
): string {
  const qty = prefill.qty ?? {};
  const choicePick = prefill.choice ?? {};
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
  const recentSelect = recents.length
    ? `<label>Client récent <span class="muted">(remplir en un tap)</span>
    <select id="liv-recent"><option value="">— choisir un client déjà livré —</option>${recents
      .map(
        (r) =>
          `<option value="${esc(r.client_phone)}" data-name="${esc(r.client_name)}" data-phone="${esc(r.client_phone)}" data-address="${esc(r.address)}">${esc(r.client_name)} — ${esc(r.client_phone)}</option>`,
      )
      .join("")}</select></label>`
    : "";
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
  return `${banner}
<style>
.liv-item.on{background:var(--brand-soft);border-radius:8px}.liv-item.on>span:first-child{font-weight:650}
.liv-wix-results{display:grid;gap:.35rem;max-height:18rem;overflow:auto;margin-top:.45rem;padding:.45rem}
.liv-wix-result{display:block;width:100%;text-align:left;white-space:normal}
.liv-wix-result small{display:block;margin-top:.15rem;font-weight:400}
.liv-optional-fields[hidden]{display:none}
</style>
<header class="page-header"><div class="page-header-copy"><span class="eyebrow">Livraisons</span><h2>Nouvelle commande</h2><p>Le client choisira Wave, Orange Money, Max It ou espèces avec Awa. Le montant est calculé automatiquement depuis le menu actif.</p></div></header>
<form method="post" action="/admin/livraisons" class="col">
  <div class="card col">
    <div>
      <label for="liv-wix-search">Client Wix <span class="muted">(nom, téléphone ou e-mail)</span></label>
      <input id="liv-wix-search" type="search" autocomplete="off" placeholder="Commencer à saisir…" aria-controls="liv-wix-results" aria-autocomplete="list">
      <input id="liv-wix-id" name="wix_contact_id" type="hidden" value="${esc(prefill.wix_contact_id ?? "")}">
      <div id="liv-wix-results" class="card liv-wix-results" role="listbox" hidden></div>
      <div style="display:flex;align-items:center;gap:.5rem;margin-top:.35rem">
        <span id="liv-wix-status" class="muted" aria-live="polite">${hasWixClient ? `✓ Fiche Wix liée à ${esc(prefill.client_name ?? "ce client")}` : "La saisie manuelle reste disponible."}</span>
        <button id="liv-wix-clear" type="button" class="act act--ghost act--sm"${hasWixClient ? "" : " hidden"}>Retirer le lien Wix</button>
      </div>
    </div>
    ${recentSelect}
    <label>Nom du client<input name="client_name" required value="${esc(prefill.client_name ?? "")}"></label>
    <label>Téléphone (WhatsApp)<input name="client_phone" type="tel" inputmode="tel" required placeholder="77 123 45 67 ou +221…" value="${esc(prefill.client_phone ?? "")}"></label>
    <label>Adresse de livraison<input name="address" required value="${esc(prefill.address ?? "")}"></label>
    <fieldset class="card col" style="margin:0">
      <legend><b>Remise de la livraison</b></legend>
      <label style="display:flex;align-items:flex-start;gap:.75rem">
        <input id="liv-recipient-toggle" type="checkbox"${hasRecipient ? " checked" : ""} aria-controls="liv-recipient-fields" aria-expanded="${hasRecipient ? "true" : "false"}" style="width:auto;margin-top:.2rem">
        <span><b>Une autre personne récupère la livraison</b><br><span class="muted">Le livreur devra appeler ce contact à la place de la cliente.</span></span>
      </label>
      <div id="liv-recipient-fields" class="col liv-optional-fields"${hasRecipient ? "" : " hidden"}>
        <label>Nom du contact<input name="recipient_name" maxlength="120" placeholder="Ex. Fatou, assistante" value="${esc(prefill.recipient_name ?? "")}"${hasRecipient ? " required" : ""}></label>
        <label>Téléphone du contact<input name="recipient_phone" type="tel" inputmode="tel" placeholder="77 123 45 67 ou +221…" value="${esc(prefill.recipient_phone ?? "")}"${hasRecipient ? " required" : ""}></label>
        <span class="muted">Cette personne recevra uniquement l’alerte quand la commande partira.</span>
      </div>
    </fieldset>
    <label>Note <span class="muted">(optionnel)</span><input name="note" value="${esc(prefill.note ?? "")}"></label>
    <fieldset class="card col" style="margin:0">
      <legend><b>Moment de la livraison</b></legend>
      <label style="display:flex;align-items:center;gap:.55rem"><input name="delivery_mode" type="radio" value="now"${deliveryMode === "now" ? " checked" : ""} style="width:auto"> Maintenant</label>
      <label style="display:flex;align-items:center;gap:.55rem"><input name="delivery_mode" type="radio" value="scheduled"${deliveryMode === "scheduled" ? " checked" : ""} style="width:auto"> Programmer</label>
      <div id="liv-schedule-fields" class="col"${deliveryMode === "scheduled" ? "" : " hidden"}>
        <label>Arrivée promise au client (heure de Dakar)
          <input name="scheduled_for" type="datetime-local" min="${esc(scheduleMin)}" value="${esc(prefill.scheduled_for ?? "")}"${deliveryMode === "scheduled" ? " required" : ""}>
        </label>
        <label>Alerter la cuisine
          <select name="kitchen_lead_minutes">
            ${[30, 60, 90].map((n) => `<option value="${n}"${kitchenLead === n ? " selected" : ""}>${n} minutes avant l'arrivée</option>`).join("")}
          </select>
        </label>
        <span class="muted">Si ce délai est déjà atteint, la commande sera activée immédiatement.</span>
      </div>
    </fieldset>
    <label>Alerte si pas partie après (min)<input name="sla_minutes" type="number" min="5" max="180" value="${esc(sla)}" style="width:6rem"></label>
    <label class="card" style="display:flex;align-items:flex-start;gap:.75rem;margin:0;background:var(--brand-soft)">
      <input name="is_test" type="checkbox" value="1"${prefill.is_test === "1" ? " checked" : ""} style="width:auto;margin-top:.2rem">
      <span><b>🧪 Commande de test</b><br><span class="muted">Envoie les alertes normalement, mais reste exclue des statistiques, des clients récents et des factures.</span></span>
    </label>
  </div>
  <h2 style="margin:.2rem 0">Articles</h2>
  ${menuUnavailable}
  ${searchBox}
  <p id="liv-noresult" class="muted" style="display:none">Aucun article ne correspond.</p>
  ${sections}
  <div class="actionbar">
    <b><span id="livcount">0</span> article(s) — Total estimé : <span id="livtotal">0</span> F</b>
    <button class="act" type="submit">Créer la commande</button>
    <a href="/admin/livraisons">Annuler</a>
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
  var clientName=form&&form.querySelector('[name="client_name"]');
  var clientPhone=form&&form.querySelector('[name="client_phone"]');
  var clientAddress=form&&form.querySelector('[name="address"]');
  var recipientToggle=document.getElementById('liv-recipient-toggle');
  var recipientFields=document.getElementById('liv-recipient-fields');
  var recipientName=form&&form.querySelector('[name="recipient_name"]');
  var recipientPhone=form&&form.querySelector('[name="recipient_phone"]');
  var scheduleFields=document.getElementById('liv-schedule-fields');
  var scheduleInput=form&&form.querySelector('[name="scheduled_for"]');
  var wixTimer=null,wixRequest=null;
  function hideWixResults(){wixResults.hidden=true;wixResults.replaceChildren();}
  function pickWixClient(client){
    wixId.value=client.id||'';
    if(clientName)clientName.value=client.name||'';
    if(clientPhone)clientPhone.value=client.phone||'';
    if(clientAddress)clientAddress.value=client.address||'';
    wixSearch.value=client.name||'';
    wixStatus.textContent='✓ Client Wix sélectionné'+(client.address?' — adresse préremplie':' — adresse à compléter');
    wixClear.hidden=false;
    hideWixResults();
  }
  function showWixClients(clients){
    wixResults.replaceChildren();
    if(!clients.length){wixStatus.textContent='Aucun client Wix trouvé. Vous pouvez continuer manuellement.';wixResults.hidden=true;return;}
    clients.forEach(function(client){
      var button=document.createElement('button');
      button.type='button';button.className='act act--ghost liv-wix-result';button.setAttribute('role','option');
      var title=document.createElement('b');title.textContent=client.name||'Client Wix';button.appendChild(title);
      var details=[client.phone,client.email,client.address].filter(Boolean);
      if(details.length){var small=document.createElement('small');small.className='muted';small.textContent=details.join(' · ');button.appendChild(small);}
      button.addEventListener('click',function(){pickWixClient(client);});
      wixResults.appendChild(button);
    });
    wixStatus.textContent=clients.length+' résultat(s) — choisissez une fiche.';
    wixResults.hidden=false;
  }
  if(wixSearch)wixSearch.addEventListener('input',function(){
    var q=this.value.trim();
    wixId.value='';wixClear.hidden=true;
    clearTimeout(wixTimer);if(wixRequest)wixRequest.abort();
    if(q.length<2){hideWixResults();wixStatus.textContent=q?'Saisissez au moins 2 caractères.':'La saisie manuelle reste disponible.';return;}
    wixStatus.textContent='Recherche dans Wix…';
    wixTimer=setTimeout(function(){
      wixRequest=new AbortController();
      fetch('/admin/livraisons/clients?q='+encodeURIComponent(q),{headers:{Accept:'application/json'},signal:wixRequest.signal})
        .then(function(response){if(!response.ok)throw new Error('Wix indisponible');return response.json();})
        .then(function(data){if(wixSearch.value.trim()===q)showWixClients(Array.isArray(data.clients)?data.clients:[]);})
        .catch(function(error){if(error.name!=='AbortError'){hideWixResults();wixStatus.textContent='Recherche Wix indisponible — utilisez la saisie manuelle.';}});
    },250);
  });
  if(wixClear)wixClear.addEventListener('click',function(){
    wixId.value='';wixSearch.value='';wixClear.hidden=true;hideWixResults();
    wixStatus.textContent='Lien Wix retiré. Les coordonnées saisies sont conservées.';
    wixSearch.focus();
  });
  function syncDeliveryMode(){
    var mode=form&&form.querySelector('[name="delivery_mode"]:checked');
    var scheduled=!!mode&&mode.value==='scheduled';
    if(scheduleFields)scheduleFields.hidden=!scheduled;
    if(scheduleInput)scheduleInput.required=scheduled;
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
  }
  if(recipientToggle)recipientToggle.addEventListener('change',function(){syncRecipient(true);});
  function recompute(){
    var t=0,c=0;
    document.querySelectorAll('input[name^="qty_"]').forEach(function(i){
      var q=parseInt(i.value,10)||0;
      if(q>0){t+=q*(parseInt(i.dataset.price,10)||0);c+=q;}
      var row=i.closest('.liv-item');
      if(row){
        row.classList.toggle('on',q>0);
        var sel=row.querySelector('.liv-choice');
        if(sel)sel.style.display=q>0?'':'none';
      }
    });
    document.getElementById('livtotal').textContent=t.toLocaleString('fr-FR');
    document.getElementById('livcount').textContent=c;
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
    document.getElementById('liv-noresult').style.display=(q&&!any)?'':'none';
  });
  var recent=document.getElementById('liv-recent');
  if(recent)recent.addEventListener('change',function(){
    var o=this.options[this.selectedIndex];if(!o||!o.value)return;
    var f=this.closest('form');
    f.client_name.value=o.dataset.name||'';
    f.client_phone.value=o.dataset.phone||'';
    f.address.value=o.dataset.address||'';
    wixId.value='';wixSearch.value='';wixClear.hidden=true;hideWixResults();
    wixStatus.textContent='Client récent sélectionné — aucune fiche Wix liée.';
  });
  syncRecipient(false);
  syncDeliveryMode();
  recompute();
})();
</script>`;
}
