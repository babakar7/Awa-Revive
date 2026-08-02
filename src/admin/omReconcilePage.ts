import { pool } from "../db/index.js";
import { escapeHtml, fmtFcfa, ago } from "./helpers.js";
import { isOmOutageActive } from "../domain/omOutage.js";

/**
 * Réconciliation manuelle Orange Money / Max It.
 *
 * Contexte (panne du 31/07/2026) : quand le callback Sonatel se perd, un
 * paiement RÉEL laisse l'ordre local en EXPIRED sans que personne ne soit
 * notifié (cas Maryeme 01/08, Marie 02/08). La réception retrouve la
 * transaction dans le portail marchand, colle son ID ici, et le serveur
 * rejoue EXACTEMENT le pipeline du webhook : vérification authentifiée
 * auprès de Sonatel (statut SUCCESS, montant, code marchand) puis
 * fulfillment automatique. Payment-first intact : rien n'est réservé sur
 * la seule parole de l'admin — Sonatel doit confirmer la transaction.
 */

export interface OmReconcileCandidate {
  id: string;
  kind: "Cours" | "Abonnement" | "Bar" | "Livraison";
  label: string;
  client_name: string | null;
  wa_phone: string;
  amount_xof: number;
  payment_method: string;
  status: string;
  created_at: Date;
}

interface OmVerificationRow {
  transaction_id: string;
  order_id: string;
  status: string;
  amount_xof: number;
  last_error: string | null;
  updated_at: Date;
}

/** Format Sonatel observé : MP260801.2046.A59064 — reste volontairement laxiste. */
export function looksLikeOmTransactionId(raw: string): boolean {
  const s = raw.trim();
  return /^[A-Za-z0-9][A-Za-z0-9.\-_]{5,49}$/.test(s);
}

/**
 * Ordres OM/Max It récents (7 jours) encore réconciliables : non payés
 * (EXPIRED / AWAITING_PAYMENT — un paiement tardif vérifié flippe EXPIRED→PAID)
 * dans les quatre familles d'ordres que le webhook sait fulfiller.
 */
export async function omReconcileCandidates(): Promise<OmReconcileCandidate[]> {
  const res = await pool.query(
    `select * from (
       select b.id, 'Cours' as kind, b.service_name as label, c.name as client_name,
              c.wa_phone, b.amount_xof, b.payment_method, b.status, b.created_at
         from pending_bookings b join clients c on c.id = b.client_id
        where b.payment_method in ('orange_money','maxit')
          and b.status in ('EXPIRED','AWAITING_PAYMENT')
          and b.created_at > now() - interval '7 days'
       union all
       select p.id, 'Abonnement', p.plan_name, c.name, c.wa_phone,
              p.amount_xof, p.payment_method, p.status, p.created_at
         from pending_plan_orders p join clients c on c.id = p.client_id
        where p.payment_method in ('orange_money','maxit')
          and p.status in ('EXPIRED','AWAITING_PAYMENT')
          and p.created_at > now() - interval '7 days'
       union all
       select o.id, 'Bar', coalesce(o.service_name,'Commande bar'), c.name, c.wa_phone,
              o.amount_xof, o.payment_method, o.status, o.created_at
         from pending_cafe_orders o join clients c on c.id = o.client_id
        where o.payment_method in ('orange_money','maxit')
          and o.status in ('EXPIRED','AWAITING_PAYMENT')
          and o.created_at > now() - interval '7 days'
       union all
       select a.id, 'Livraison', 'Livraison', c.name, c.wa_phone,
              a.amount_xof, a.method, a.status, a.created_at
         from delivery_payment_attempts a join clients c on c.id = a.client_id
        where a.method in ('orange_money','maxit')
          and a.status in ('EXPIRED','AWAITING_PAYMENT')
          and a.created_at > now() - interval '7 days'
     ) t
     order by created_at desc
     limit 40`,
  );
  return res.rows;
}

async function recentVerifications(): Promise<OmVerificationRow[]> {
  const res = await pool.query(
    `select transaction_id, order_id, status, amount_xof, last_error, updated_at
       from orange_money_verifications
      order by updated_at desc limit 10`,
  );
  return res.rows;
}

const METHOD_LABEL: Record<string, string> = {
  orange_money: "Orange Money",
  maxit: "Max It",
};

function statusBadge(status: string): string {
  const cls =
    status === "SUCCEEDED" || status === "PAID"
      ? "badge--green"
      : status === "FAILED"
        ? "badge--red"
        : "badge--amber";
  return `<span class="badge ${cls}">${escapeHtml(status)}</span>`;
}

export async function renderOmReconcilePage(query: {
  done?: string;
  err?: string;
}): Promise<string> {
  const [candidates, verifications, outage] = await Promise.all([
    omReconcileCandidates(),
    recentVerifications(),
    isOmOutageActive(),
  ]);

  const outageCard = outage
    ? `<div class="card" style="border-left:4px solid #c62828;margin-bottom:1rem">
<b>🚧 Mode panne OM/Max It : ACTIF</b>
<p class="muted" style="margin:.4rem 0 .8rem;max-width:44rem">Awa ne dit jamais qu'un paiement Orange Money / Max It
« n'a pas été reçu » : elle rassure le client (vérification manuelle temporaire), alerte l'équipe, et la
confirmation part automatiquement après réconciliation ici. Désactive ce mode dès que les callbacks Sonatel refonctionnent.</p>
<form method="post" action="/admin/paiements-om/outage" class="inline" onsubmit="return confirm('Désactiver le mode panne OM ? Awa reprendra son discours normal sur les paiements OM/Max It.')">
<input type="hidden" name="mode" value="off"><button class="btn">Désactiver le mode panne</button></form>
</div>`
    : `<div class="card" style="border-left:4px solid #2e7d32;margin-bottom:1rem">
<b>Mode panne OM/Max It : inactif</b>
<p class="muted" style="margin:.4rem 0 .8rem;max-width:44rem">À activer si les callbacks Sonatel se perdent à nouveau :
Awa arrêtera de dire qu'un paiement OM/Max It « n'a pas été reçu », préviendra le client d'un délai de confirmation,
et alertera l'équipe pour réconciliation manuelle ici.</p>
<form method="post" action="/admin/paiements-om/outage" class="inline" onsubmit="return confirm('Activer le mode panne OM ? Awa préviendra les clients que les confirmations OM/Max It passent en vérification manuelle.')">
<input type="hidden" name="mode" value="on"><button class="btn">🚧 Activer le mode panne</button></form>
</div>`;

  const banner = query.done
    ? `<div class="card" style="border-left:4px solid #2e7d32;margin-bottom:1rem">✅ ${escapeHtml(query.done)}</div>`
    : query.err
      ? `<div class="card" style="border-left:4px solid #c62828;margin-bottom:1rem">⚠️ ${escapeHtml(query.err)}</div>`
      : "";

  const rows = candidates
    .map((c) => {
      const who = `${escapeHtml(c.client_name ?? "(sans nom)")} <span class="muted">+${escapeHtml(c.wa_phone)}</span>`;
      return `<tr>
<td><input type="radio" name="order" value="${c.id}" required aria-label="Choisir ${escapeHtml(c.label)}"></td>
<td>${escapeHtml(c.kind)}</td>
<td>${escapeHtml(c.label)}<br><span class="muted">${who}</span></td>
<td>${fmtFcfa(c.amount_xof)}</td>
<td>${escapeHtml(METHOD_LABEL[c.payment_method] ?? c.payment_method)}</td>
<td>${statusBadge(c.status)}</td>
<td class="muted">${escapeHtml(ago(c.created_at))}</td>
</tr>`;
    })
    .join("");

  const candidatesTable = candidates.length
    ? `<div style="overflow-x:auto"><table>
<thead><tr><th></th><th>Type</th><th>Commande</th><th>Montant</th><th>Moyen</th><th>Statut</th><th>Créée</th></tr></thead>
<tbody>${rows}</tbody></table></div>`
    : `<p class="muted">Aucun ordre Orange Money / Max It non payé sur les 7 derniers jours 🎉</p>`;

  const verifRows = verifications
    .map(
      (v) => `<tr>
<td><code>${escapeHtml(v.transaction_id)}</code></td>
<td>${fmtFcfa(v.amount_xof)}</td>
<td>${statusBadge(v.status)}</td>
<td class="muted">${escapeHtml(v.last_error ?? "")}</td>
<td class="muted">${escapeHtml(ago(v.updated_at))}</td>
</tr>`,
    )
    .join("");

  const verifTable = verifications.length
    ? `<h3 style="margin-top:2rem">Dernières vérifications</h3>
<div style="overflow-x:auto"><table>
<thead><tr><th>Transaction</th><th>Montant</th><th>Résultat</th><th>Erreur</th><th>Maj</th></tr></thead>
<tbody>${verifRows}</tbody></table></div>`
    : "";

  return `${banner}${outageCard}<div class="card">
<h2 style="margin-top:0">Retrouver un paiement Orange Money / Max It</h2>
<p class="muted" style="max-width:46rem">Quand un client dit avoir payé mais que rien ne s'est confirmé
(callback Sonatel perdu) : retrouve la transaction dans le portail marchand OM
(montant + heure), colle son <b>ID de transaction</b> (ex. <code>MP260801.2046.A59064</code>),
choisis la commande correspondante ci-dessous et valide. Le serveur vérifie la transaction
auprès de Sonatel (montant, statut, marchand) et, si tout correspond, finalise
automatiquement la commande + la confirmation WhatsApp du client. Rien n'est validé sans
la confirmation Sonatel.</p>
<form method="post" action="/admin/paiements-om">
<p><label for="tx"><b>ID de transaction OM</b></label><br>
<input id="tx" name="transaction_id" required placeholder="MP260801.2046.A59064" style="min-width:20rem" autocomplete="off"></p>
${candidatesTable}
${candidates.length ? `<p style="margin-top:1rem"><button class="btn" onclick="return confirm('Vérifier cette transaction auprès de Sonatel et finaliser la commande sélectionnée ?')">Vérifier &amp; finaliser</button></p>` : ""}
</form>
${verifTable}
</div>`;
}
