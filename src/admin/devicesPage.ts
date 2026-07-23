import { escapeHtml as esc, fmtDate } from "./helpers.js";
import type { OpsDevice } from "../domain/opsDeviceRepo.js";

/**
 * Admin supervision for the ops PWAs (Phase 1: the cuisine iPad). Generate a
 * one-time pairing code, see each device's connection state (paired / last seen
 * / revoked), revoke a device durably, and send a test event to confirm the iPad
 * receives realtime pushes. The pairing code is shown ONCE, right after
 * generation — it is stored only hashed.
 */

const ROLE_LABEL: Record<string, string> = {
  cuisine: "iPad Cuisine",
  accueil: "Téléphone Accueil",
  owner: "Propriétaire",
};

function connectionCell(d: OpsDevice): string {
  if (d.revoked_at) return `<span class="pill pill--muted">Révoqué</span>`;
  if (!d.paired_at) return `<span class="pill pill--warn">En attente d'appairage</span>`;
  const seen = d.last_seen_at ? new Date(d.last_seen_at).getTime() : 0;
  const online = seen > 0 && Date.now() - seen < 90_000; // seen in the last 90s
  return online
    ? `<span class="pill pill--ok">● En ligne</span>`
    : `<span class="pill pill--muted">Hors ligne</span>`;
}

export interface DevicesPageData {
  devices: OpsDevice[];
  latestEventAt: Date | null;
  /** Freshly generated code to show once (label + code), or null. */
  fresh?: { label: string; role: string; code: string } | null;
  notice?: string | null;
  error?: string | null;
}

export function renderDevicesPage(d: DevicesPageData): string {
  const freshBlock = d.fresh
    ? `<div class="card card--accent"><h3>Code d'appairage — ${esc(d.fresh.label)} (${esc(ROLE_LABEL[d.fresh.role] ?? d.fresh.role)})</h3>
<p class="code-big">${esc(d.fresh.code)}</p>
<p class="muted">Ouvrez <b>cuisine.revive.sn</b> sur l'appareil et entrez ce code. Il expire dans 10 minutes et ne s'affiche qu'une fois.</p></div>`
    : "";

  const rows = d.devices.length
    ? d.devices
        .map(
          (v) => `<tr>
<td><b>${esc(v.label)}</b></td>
<td>${esc(ROLE_LABEL[v.role] ?? v.role)}</td>
<td>${connectionCell(v)}</td>
<td class="muted">${v.paired_at ? esc(fmtDate(v.paired_at)) : "—"}</td>
<td class="muted">${v.last_seen_at ? esc(fmtDate(v.last_seen_at)) : "—"}</td>
<td class="row-actions">
${v.revoked_at
  ? `<form method="post" action="/admin/appareils/${esc(v.id)}/delete" onsubmit="return confirm('Supprimer définitivement cet appareil ?')"><button class="act act--ghost" type="submit">Supprimer</button></form>`
  : `<form method="post" action="/admin/appareils/${esc(v.id)}/revoke" onsubmit="return confirm('Révoquer cet appareil ? Sa session sera coupée immédiatement.')"><button class="act act--danger" type="submit">Révoquer</button></form>`}
</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="6" class="muted">Aucun appareil enregistré.</td></tr>`;

  return `<style>
.code-big{font-size:2.4rem;font-weight:800;letter-spacing:.4em;text-align:center;margin:.4rem 0 .6rem;color:#7c547d}
.card--accent{border:1px solid #d9c2da;background:#faf5fb}
.pill{display:inline-block;font-size:.75rem;font-weight:700;padding:.15rem .55rem;border-radius:999px}
.pill--ok{background:#e6f6ec;color:#1a7f37}.pill--warn{background:#fdf1dc;color:#8a5a00}.pill--muted{background:#eee;color:#666}
.row-actions form{display:inline}
.banner--ok{border-left:4px solid #1a7f37}.banner--err{border-left:4px solid #b42318}
</style>
${d.notice ? `<div class="banner banner--ok">${esc(d.notice)}</div>` : ""}
${d.error ? `<div class="banner banner--err">${esc(d.error)}</div>` : ""}
${freshBlock}
<div class="card"><h3>Appairer un nouvel appareil</h3>
<form method="post" action="/admin/appareils" class="row">
<label>Nom<input name="label" maxlength="40" placeholder="iPad Cuisine" required></label>
<label>Type<select name="role">
<option value="cuisine">iPad Cuisine</option>
<option value="accueil">Téléphone Accueil</option>
<option value="owner">Propriétaire</option>
</select></label>
<button class="act" type="submit">Générer un code</button>
</form>
<p class="muted">Le code s'affiche une seule fois. Sur l'appareil, ouvrez le sous-domaine correspondant et saisissez-le.</p></div>

<div class="card"><div class="section-header"><h3>Appareils</h3>
<form method="post" action="/admin/appareils/test"><button class="act act--ghost" type="submit">Envoyer un test à la cuisine</button></form></div>
<p class="muted">Dernier événement temps réel : ${d.latestEventAt ? esc(fmtDate(d.latestEventAt)) : "aucun"}.</p>
<div class="table-wrap"><table class="responsive-table"><thead><tr>
<th>Nom</th><th>Type</th><th>État</th><th>Appairé</th><th>Vu</th><th></th>
</tr></thead><tbody>${rows}</tbody></table></div></div>`;
}
