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
  created: "Commande créée — cuisine notifiée.",
  "created-kitchen-failed": "Commande créée, mais l'envoi à la cuisine a échoué — utilisez « 🔁 Renvoyer ».",
  ready: "Commande marquée prête — le client est prévenu.",
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

/** Colored SLA badge: green <10 min, amber <SLA, red ≥SLA; distinct once READY. */
function slaBadge(o: DeliveryOrder): string {
  if (o.status === "READY") {
    const since = o.ready_at ? minutesSince(o.ready_at) : 0;
    return `<span class="badge badge--green">prête (${since} min)</span>`;
  }
  const elapsed = minutesSince(o.created_at);
  const remaining = o.sla_minutes - elapsed;
  let color: string;
  let label: string;
  if (remaining <= 0) {
    color = "#cf222e";
    label = `+${-remaining} min`;
  } else if (elapsed < 10) {
    color = "#1a7f37";
    label = `reste ${remaining} min`;
  } else {
    color = "#9a6700";
    label = `reste ${remaining} min`;
  }
  return `<span class="badge" style="background:${color}">${label}</span>`;
}

function kitchenStatusCell(o: DeliveryOrder): string {
  const s = o.kitchen_notify_status;
  if (s === "sent" || s === "sent_template") return `<span class="ok">✓ cuisine</span>`;
  if (s === "partial") return `<span style="color:#9a6700;font-weight:600">⚠️ partiel</span>`;
  if (s === "fallback_reception")
    return `<span style="color:#9a6700;font-weight:600">→ réception (pas de contact cuisine)</span>`;
  if (s === "pending" || s === "claimed") return `<span class="muted">envoi en cours…</span>`;
  return `<span style="color:#cf222e;font-weight:600">✗ cuisine NON notifiée</span>`;
}

function inlineForm(action: string, label: string, confirm?: string, variant = ""): string {
  const onsubmit = confirm ? ` onsubmit="return confirm('${esc(confirm)}')"` : "";
  const cls = variant ? ` act--${variant}` : "";
  return `<form method="post" action="${esc(action)}" class="inline"${onsubmit}><button class="act act--sm${cls}" type="submit">${esc(label)}</button></form>`;
}

function actionsCell(o: DeliveryOrder): string {
  const base = `/admin/livraisons/${o.id}`;
  const parts: string[] = [];
  const kitchenBad = ["failed", "partial", "fallback_reception"].includes(o.kitchen_notify_status);
  if (o.status === "IN_KITCHEN") {
    parts.push(inlineForm(`${base}/ready`, "✅ Prête", undefined, "ok"));
    if (kitchenBad) parts.push(inlineForm(`${base}/renotify-kitchen`, "🔁 Renvoyer", undefined, "ghost"));
    parts.push(inlineForm(`${base}/cancel`, "✖ Annuler", "Annuler cette commande ?", "danger"));
  } else if (o.status === "READY") {
    parts.push(inlineForm(`${base}/delivered`, "🛵 Livrée", undefined, "ok"));
    parts.push(
      inlineForm(`${base}/cancel`, "✖ Annuler", "Le client a peut-être été prévenu « en route » — annuler quand même ?", "danger"),
    );
  }
  return parts.join(" ");
}

/** Red "call the client" flag when a READY order's ready-ping didn't land. */
function clientFlag(o: DeliveryOrder): string {
  if (o.status !== "READY") return "";
  if (o.client_notify_status === "sent" || o.client_notify_status === "sent_template")
    return `<div class="ok" style="font-size:.8rem">✓ client prévenu</div>`;
  if (o.client_notify_status === "pending" || o.client_notify_status === "claimed")
    return `<div class="muted" style="font-size:.8rem">notification en cours…</div>`;
  return `<div style="color:#cf222e;font-weight:700;font-size:.85rem">📞 Appeler le client : +${esc(o.client_phone)}</div>`;
}

function openRow(o: DeliveryOrder): string {
  const items = orderItems(o);
  return `<tr>
<td>${slaBadge(o)}</td>
<td><b>${esc(o.client_name)}</b><br><a href="tel:+${esc(o.client_phone)}" class="muted">+${esc(o.client_phone)}</a>${clientFlag(o)}</td>
<td>${esc(formatExtrasOneLine(items))}<details><summary class="muted">détail</summary><div style="white-space:pre-wrap">${esc(formatExtrasMultiline(items))}</div></details></td>
<td class="hide-sm">${esc(o.address)}</td>
<td style="white-space:nowrap">${esc(o.amount_xof)} F<br><span class="muted" style="font-size:.72rem">à encaisser</span></td>
<td class="hide-sm">${kitchenStatusCell(o)}</td>
<td>${actionsCell(o)}</td>
</tr>`;
}

function closedRow(o: DeliveryOrder): string {
  const prep = o.ready_at ? `${minutesSince(o.created_at) - minutesSince(o.ready_at)} min` : "—";
  const state = o.status === "DELIVERED" ? "🛵 livrée" : "✖ annulée";
  return `<tr>
<td>${esc(state)}</td>
<td>${esc(o.client_name)}</td>
<td>${esc(formatExtrasOneLine(orderItems(o)))}</td>
<td class="hide-sm">${esc(o.amount_xof)} F</td>
<td class="hide-sm">${o.status === "DELIVERED" ? esc(prep) : "—"}</td>
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
    ? `<table><thead><tr><th>Délai</th><th>Client</th><th>Commande</th><th class="hide-sm">Adresse</th><th>Montant</th><th class="hide-sm">Cuisine</th><th>Actions</th></tr></thead><tbody>${open.map(openRow).join("")}</tbody></table>`
    : `<p class="muted">Aucune commande en cours.</p>`;
  const recentTable = recent.length
    ? `<table><thead><tr><th>État</th><th>Client</th><th>Commande</th><th class="hide-sm">Montant</th><th class="hide-sm">Prépa</th></tr></thead><tbody>${recent.map(closedRow).join("")}</tbody></table>`
    : `<p class="muted">Aucune commande récente.</p>`;
  return `${data.banner}
<div class="row between">
  <h2 style="margin:.4rem 0">Livraisons 🛵</h2>
  <a href="/admin/livraisons/new" class="act">➕ Nouvelle commande</a>
</div>
<div class="stat-grid">
  <div class="stat"><span class="muted">En cours</span><b>${stats.openCount}</b></div>
  <div class="stat"><span class="muted">Prépa moyenne (30 j)</span><b>${avg}</b></div>
  <div class="stat"><span class="muted">En retard aujourd'hui</span><b>${stats.lateToday}</b></div>
</div>
<h2>En cours</h2>
<div class="card">${openTable}</div>
<h2>Historique récent</h2>
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
        .map(
          (it) => `<label class="row" style="padding:.3rem 0;border-top:1px solid var(--border-subtle)">
<span style="flex:1">${esc(it.name)} <span class="muted">— ${esc(it.priceXof)} F</span></span>
<input type="number" name="qty_${esc(it.id)}" min="0" max="10" value="0" data-price="${esc(it.priceXof)}" style="width:4.5rem" oninput="livTotal()"></label>`,
        )
        .join("");
      return `<details class="card"><summary style="font-weight:600;cursor:pointer">${esc(cat || "Autres")} <span class="muted">(${list.length})</span></summary>${rows}</details>`;
    })
    .join("");
  const menuUnavailable = items.size === 0 ? `<div class="card warn">⚠️ cafe-menu.md introuvable — aucun article disponible.</div>` : "";
  return `${banner}
<h2 style="margin:.4rem 0">➕ Nouvelle commande livraison</h2>
<p class="muted">Paiement à la livraison — le montant est calculé automatiquement depuis le menu.</p>
<form method="post" action="/admin/livraisons" class="col">
  <div class="card col">
    <label>Nom du client<input name="client_name" required></label>
    <label>Téléphone (WhatsApp)<input name="client_phone" required placeholder="77 123 45 67 ou +221…"></label>
    <label>Adresse de livraison<input name="address" required></label>
    <label>Note <span class="muted">(optionnel)</span><input name="note"></label>
    <label>Alerte cuisine après (min)<input name="sla_minutes" type="number" min="5" max="180" value="${esc(config.DELIVERY_SLA_MINUTES)}" style="width:6rem"></label>
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
