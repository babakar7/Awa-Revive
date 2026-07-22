import { config } from "../config.js";
import { type CafeMenuItem, formatExtrasMultiline, formatExtrasOneLine } from "../lib/cafeMenu.js";
import { orderItems, type DeliveryOrder, type DeliveryStats } from "../domain/deliveryRepo.js";

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
  "created-kitchen-failed": "Commande créée, mais l'envoi à la cuisine a échoué — utilisez « 🔁 Renvoyer ».",
  departed: "Commande partie en livraison — le client est prévenu.",
  delivered: "Commande marquée livrée.",
  cancelled: "Commande annulée.",
  renotified: "Cuisine renotifiée.",
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

/** Colored SLA badge: green <10 min, amber <SLA, red ≥SLA; distinct once departed. */
function slaBadge(o: DeliveryOrder): string {
  if (o.status === "OUT_FOR_DELIVERY") {
    const since = o.out_for_delivery_at ? minutesSince(o.out_for_delivery_at) : 0;
    return `<span class="badge badge--green">en route (${since} min)</span>`;
  }
  const elapsed = minutesSince(o.created_at);
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
    parts.push(inlineForm(`${base}/depart`, "🛵 Partie", undefined, "ok"));
    if (kitchenBad) parts.push(inlineForm(`${base}/renotify-kitchen`, "🔁 Renvoyer", undefined, "ghost"));
    // Direct close for an order whose departure was never tapped (no route ping).
    parts.push(inlineForm(`${base}/delivered`, "✓ Livrée", undefined, "ghost"));
    parts.push(inlineForm(`${base}/cancel`, "✖ Annuler", "Annuler cette commande ?", "danger"));
  } else if (o.status === "OUT_FOR_DELIVERY") {
    parts.push(inlineForm(`${base}/delivered`, "✓ Livrée", undefined, "ok"));
    parts.push(
      inlineForm(`${base}/cancel`, "✖ Annuler", "La commande est en route — annuler quand même ?", "danger"),
    );
  }
  return parts.join(" ");
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

function openRow(o: DeliveryOrder): string {
  const items = orderItems(o);
  return `<tr>
<td data-label="Délai">${slaBadge(o)}</td>
<td data-label="Client"><b>${esc(o.client_name)}</b><br><a href="https://wa.me/${esc(o.client_phone)}" target="_blank" rel="noreferrer" class="muted">+${esc(o.client_phone)}</a>${clientFlag(o)}</td>
<td data-label="Commande">${esc(formatExtrasOneLine(items))}<details><summary class="muted">Voir le détail</summary><div style="white-space:pre-wrap">${esc(formatExtrasMultiline(items))}</div></details></td>
<td data-label="Adresse" class="hide-sm">${esc(o.address)}</td>
<td data-label="Montant" class="nowrap"><b>${esc(o.amount_xof)} F</b><br><span class="muted">à encaisser</span></td>
<td data-label="Cuisine" class="hide-sm">${kitchenStatusCell(o)}</td>
<td data-label="Actions">${actionsCell(o)}</td>
</tr>`;
}

function closedRow(o: DeliveryOrder): string {
  const prep = o.out_for_delivery_at
    ? `${minutesSince(o.created_at) - minutesSince(o.out_for_delivery_at)} min`
    : "—";
  const state = o.status === "DELIVERED" ? "🛵 livrée" : "✖ annulée";
  return `<tr>
<td data-label="État">${esc(state)}</td>
<td data-label="Client">${esc(o.client_name)}</td>
<td data-label="Commande">${esc(formatExtrasOneLine(orderItems(o)))}</td>
<td data-label="Montant" class="hide-sm">${esc(o.amount_xof)} F</td>
<td data-label="Départ" class="hide-sm">${o.status === "DELIVERED" ? esc(prep) : "—"}</td>
</tr>`;
}

export interface BoardData {
  open: DeliveryOrder[];
  recent: DeliveryOrder[];
  stats: DeliveryStats;
  banner: string;
}

export function renderLivraisonsBoard(data: BoardData): string {
  const { open, recent, stats } = data;
  const avg = stats.avgPrepMinutes === null ? "—" : `${Math.round(stats.avgPrepMinutes)} min`;
  const openTable = open.length
    ? `<div class="table-wrap"><table class="responsive-table"><thead><tr><th>Délai</th><th>Client</th><th>Commande</th><th class="hide-sm">Adresse</th><th>Montant</th><th class="hide-sm">Cuisine</th><th>Actions</th></tr></thead><tbody>${open.map(openRow).join("")}</tbody></table></div>`
    : `<div class="empty"><b>Aucune commande en cours</b><p>Les nouvelles livraisons apparaîtront ici avec leur délai.</p></div>`;
  const recentTable = recent.length
    ? `<div class="table-wrap"><table class="responsive-table"><thead><tr><th>État</th><th>Client</th><th>Commande</th><th class="hide-sm">Montant</th><th class="hide-sm">Départ</th></tr></thead><tbody>${recent.map(closedRow).join("")}</tbody></table></div>`
    : `<div class="empty"><b>Aucun historique récent</b></div>`;
  return `${data.banner}
<header class="page-header"><div class="page-header-copy"><span class="eyebrow">Bar</span><h2>Livraisons</h2><p>Suivez le délai cuisine, la notification client et l’encaissement à la livraison.</p></div><div class="page-header-actions"><a href="/admin/livraisons/new" class="act">Nouvelle commande</a></div></header>
<div class="stat-grid">
  <div class="stat"><span class="muted">En cours</span><b>${stats.openCount}</b></div>
  <div class="stat"><span class="muted">Départ moyen (30 j)</span><b>${avg}</b></div>
  <div class="stat"><span class="muted">En retard aujourd'hui</span><b>${stats.lateToday}</b></div>
</div>
<div class="section-header"><h2>En cours</h2><span class="badge ${open.length ? "badge--amber" : "badge--green"}">${open.length}</span></div>
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

export function renderLivraisonForm(items: Map<string, CafeMenuItem>, banner: string): string {
  const groups = menuByCategory(items);
  const sections = [...groups.entries()]
    .map(([cat, list]) => {
      const rows = list
        .map((it) => {
          const choices = it.optionChoices ?? [];
          const optionSelect = choices.length
            ? `<select name="choice_${esc(it.id)}" style="margin-top:.3rem;width:100%"><option value="">— ${esc(it.optionLabel || "Choix")} (à préciser) —</option>${choices
                .map((c) => `<option value="${esc(c)}">${esc(c)}</option>`)
                .join("")}</select>`
            : "";
          return `<div class="row" style="flex-wrap:wrap;padding:.3rem 0;border-top:1px solid var(--border-subtle)">
<span style="flex:1">${esc(it.name)} <span class="muted">— ${esc(it.priceXof)} F</span></span>
<input type="number" name="qty_${esc(it.id)}" min="0" max="10" value="0" data-price="${esc(it.priceXof)}" style="width:4.5rem" oninput="livTotal()">
${optionSelect}</div>`;
        })
        .join("");
      return `<details class="card"><summary style="font-weight:600;cursor:pointer">${esc(cat || "Autres")} <span class="muted">(${list.length})</span></summary>${rows}</details>`;
    })
    .join("");
  const menuUnavailable = items.size === 0 ? `<div class="card warn">⚠️ cafe-menu.md introuvable — aucun article disponible.</div>` : "";
  return `${banner}
<header class="page-header"><div class="page-header-copy"><span class="eyebrow">Livraisons</span><h2>Nouvelle commande</h2><p>Paiement à la livraison. Le montant est calculé automatiquement depuis le menu actif.</p></div></header>
<form method="post" action="/admin/livraisons" class="col">
  <div class="card col">
    <label>Nom du client<input name="client_name" required></label>
    <label>Téléphone (WhatsApp)<input name="client_phone" required placeholder="77 123 45 67 ou +221…"></label>
    <label>Adresse de livraison<input name="address" required></label>
    <label>Note <span class="muted">(optionnel)</span><input name="note"></label>
    <label>Alerte si pas partie après (min)<input name="sla_minutes" type="number" min="5" max="180" value="${esc(config.DELIVERY_SLA_MINUTES)}" style="width:6rem"></label>
  </div>
  <h2 style="margin:.2rem 0">Articles</h2>
  ${menuUnavailable}
  ${sections}
  <div class="actionbar">
    <b>Total estimé : <span id="livtotal">0</span> F</b>
    <button class="act" type="submit">Créer la commande</button>
    <a href="/admin/livraisons">Annuler</a>
  </div>
</form>
<script>
function livTotal(){var t=0;document.querySelectorAll('input[name^="qty_"]').forEach(function(i){var q=parseInt(i.value,10);if(q>0)t+=q*parseInt(i.dataset.price,10);});document.getElementById('livtotal').textContent=t.toLocaleString('fr-FR');}
livTotal();
</script>`;
}
