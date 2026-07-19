import type { Invoice, InvoiceCandidate } from "../domain/invoiceRepo.js";
import { invoiceLines } from "../domain/invoiceRepo.js";
import type { InvoiceLine } from "../domain/invoiceRules.js";

/**
 * Body HTML for /admin/factures — server-rendered, self-contained escaping so
 * it doesn't import from routes.ts (which imports this). routes.ts wraps list/
 * form/view in layout(); the print page is a standalone document (no chrome).
 */

function esc(s: unknown): string {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fcfa(n: number): string {
  return `${Number(n).toLocaleString("fr-FR").replace(/ /g, " ")} FCFA`;
}

function fmtDay(d: Date | string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("fr-FR", {
    timeZone: "Africa/Dakar",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function fmtLongDay(d: Date | string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("fr-FR", {
    timeZone: "Africa/Dakar",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

const BANNERS: Record<string, string> = {
  created: "Facture créée.",
  sent: "Facture envoyée au client sur WhatsApp.",
};

export function facturesBanner(done?: string, err?: string): string {
  if (done && BANNERS[done])
    return `<div class="card success"><span class="ok">✓ ${esc(BANNERS[done])}</span></div>`;
  if (err) return `<div class="card warn">⚠️ ${esc(err)}</div>`;
  return "";
}

function sentCell(inv: Invoice): string {
  if (inv.sent_status === "sent") return `<span class="ok">✓ envoyée</span>`;
  if (inv.sent_status === "window_closed")
    return `<span style="color:var(--warn)">fenêtre fermée</span>`;
  if (inv.sent_status === "failed") return `<span class="muted" style="color:var(--danger)">✗ échec</span>`;
  return `<span class="muted">—</span>`;
}

export function renderFacturesList(rows: Invoice[], banner: string): string {
  const table = rows.length
    ? `<table><thead><tr><th>N°</th><th>Date</th><th>Client</th><th>Total</th><th class="hide-sm">Envoi</th><th>Actions</th></tr></thead><tbody>${rows
        .map(
          (inv) => `<tr>
<td style="white-space:nowrap"><b>${esc(inv.number)}</b></td>
<td class="hide-sm">${fmtDay(inv.created_at)}</td>
<td>${esc(inv.client_name)}${inv.client_phone ? `<br><span class="muted">+${esc(inv.client_phone)}</span>` : ""}</td>
<td style="white-space:nowrap">${fcfa(inv.total_xof)}</td>
<td class="hide-sm">${sentCell(inv)}</td>
<td><a class="act act--sm act--ghost" href="/admin/factures/${esc(inv.id)}">Voir</a></td>
</tr>`,
        )
        .join("")}</tbody></table>`
    : `<p class="muted">Aucune facture pour l'instant.</p>`;
  return `${banner}
<div class="row between">
  <h2 style="margin:.4rem 0">Factures 🧾</h2>
  <a href="/admin/factures/new" class="act">➕ Nouvelle facture</a>
</div>
<div class="card">${table}</div>`;
}

// ---------- create form ----------

export function renderFactureForm(candidates: InvoiceCandidate[], banner: string): string {
  // Candidate data for the prefill picker — embedded once, script-injection guarded.
  const candData = candidates.map((c) => ({
    kind: c.kind,
    id: c.id,
    clientName: c.clientName,
    clientPhone: c.clientPhone ?? "",
    lines: c.lines.map((l) => ({ label: l.label, qty: l.qty, unit: l.unit_xof })),
    paidVia: c.paidVia,
    paymentRef: c.paymentRef ?? "",
    paidAt: c.paidAt.toISOString(),
  }));
  const candJson = JSON.stringify(candData).replace(/</g, "\\u003c");
  const options = candidates
    .map(
      (c, i) =>
        `<option value="${i}">${esc(c.clientName)} — ${esc(c.lines.map((l) => `${l.qty}× ${l.label}`).join(", ").slice(0, 60))} · ${fcfa(c.totalXof)} (${fmtDay(c.paidAt)})</option>`,
    )
    .join("");

  return `${banner}
<h2 style="margin:.4rem 0">➕ Nouvelle facture</h2>
<form method="post" action="/admin/factures" style="display:flex;flex-direction:column;gap:.7rem">
  ${
    candidates.length
      ? `<div class="card">
    <label>Partir d'un paiement récent <span class="muted">(optionnel — préremplit la facture)</span>
      <select id="cand">
        <option value="">— saisie manuelle —</option>
        ${options}
      </select>
    </label>
  </div>`
      : ""
  }
  <div class="card col">
    <label>Nom du client / entreprise<input name="client_name" id="client_name" required></label>
    <label>Téléphone WhatsApp <span class="muted">(optionnel — requis pour l'envoi)</span><input name="client_phone" id="client_phone" placeholder="77 123 45 67 ou +221…"></label>
    <label>Référence / à l'attention de <span class="muted">(optionnel)</span><input name="client_ref" id="client_ref" placeholder="Société Teranga Conseil SARL"></label>
  </div>

  <h2 style="margin:.2rem 0">Lignes</h2>
  <div class="card">
    <div id="lines"></div>
    <button type="button" class="act act--sm act--ghost" id="addline" style="margin-top:.4rem">+ Ajouter une ligne</button>
  </div>

  <div class="card col">
    <label>Note <span class="muted">(optionnel — bas de facture)</span><input name="note" id="note"></label>
  </div>

  <input type="hidden" name="source_kind" id="source_kind" value="manual">
  <input type="hidden" name="source_id" id="source_id" value="">
  <input type="hidden" name="payment_method" id="payment_method" value="">
  <input type="hidden" name="payment_ref" id="payment_ref" value="">
  <input type="hidden" name="paid_at" id="paid_at" value="">

  <div class="actionbar">
    <b>Total : <span id="factotal">0</span> F</b>
    <button class="act" type="submit" >Créer la facture</button>
    <a href="/admin/factures">Annuler</a>
  </div>
</form>
<script>
(function(){
  var CAND = JSON.parse("${candJson.replace(/"/g, '\\"')}");
  var lines = document.getElementById('lines');
  var i = 0;
  function row(label, qty, unit){
    var d = document.createElement('div');
    d.style.cssText = 'display:flex;gap:.4rem;margin-bottom:.4rem;align-items:center';
    d.innerHTML =
      '<input name="line_label_'+i+'" placeholder="Désignation" value="'+(label||'').replace(/"/g,'&quot;')+'" style="flex:1">'+
      '<input name="line_qty_'+i+'" type="number" min="1" max="99" value="'+(qty||1)+'" title="Qté" style="width:4rem" oninput="factotal()">'+
      '<input name="line_unit_'+i+'" type="number" min="0" value="'+(unit==null?'':unit)+'" placeholder="PU" title="Prix unitaire" style="width:6rem" oninput="factotal()">'+
      '<button type="button" title="Retirer" style="border:none;background:transparent;cursor:pointer;font-size:1.1rem">✕</button>';
    d.querySelector('button').onclick = function(){ d.remove(); factotal(); };
    lines.appendChild(d); i++;
  }
  window.factotal = function(){
    var t = 0;
    lines.querySelectorAll('div').forEach(function(d){
      var q = parseInt(d.querySelector('[name^=line_qty_]').value,10);
      var u = parseInt(d.querySelector('[name^=line_unit_]').value,10);
      if(q>0 && u>=0) t += q*u;
    });
    document.getElementById('factotal').textContent = t.toLocaleString('fr-FR');
  };
  document.getElementById('addline').onclick = function(){ row('',1,''); };
  var sel = document.getElementById('cand');
  if(sel) sel.onchange = function(){
    lines.innerHTML=''; i=0;
    var v = sel.value;
    if(v===''){ document.getElementById('source_kind').value='manual'; row('',1,''); factotal(); return; }
    var c = CAND[parseInt(v,10)];
    document.getElementById('client_name').value = c.clientName;
    document.getElementById('client_phone').value = c.clientPhone;
    document.getElementById('source_kind').value = c.kind;
    document.getElementById('source_id').value = c.id;
    document.getElementById('payment_method').value = c.paidVia;
    document.getElementById('payment_ref').value = c.paymentRef;
    document.getElementById('paid_at').value = c.paidAt;
    c.lines.forEach(function(l){ row(l.label, l.qty, l.unit); });
    factotal();
  };
  row('',1,''); factotal();
})();
</script>`;
}

// ---------- view ----------

function linesTable(lines: InvoiceLine[]): string {
  return `<table><thead><tr><th>Désignation</th><th class="right">Qté</th><th class="right">PU</th><th class="right">Total</th></tr></thead><tbody>${lines
    .map(
      (l) => `<tr><td>${esc(l.label)}</td><td class="right">${l.qty}</td><td class="right">${fcfa(l.unit_xof)}</td><td class="right"><b>${fcfa(l.total_xof)}</b></td></tr>`,
    )
    .join("")}</tbody></table>`;
}

export function renderFactureView(inv: Invoice, banner: string): string {
  const lines = invoiceLines(inv);
  const sendBtn = inv.client_phone
    ? `<form method="post" action="/admin/factures/${esc(inv.id)}/send" style="display:inline"${inv.sent_at ? ` onsubmit="return confirm('Déjà envoyée — renvoyer au client ?')"` : ""}>
         <button class="act" type="submit">📲 ${inv.sent_at ? "Renvoyer" : "Envoyer"} sur WhatsApp</button>
       </form>`
    : `<span class="muted">Pas de numéro — envoi WhatsApp impossible</span>`;
  return `${banner}
<div class="row between">
  <h2 style="margin:.4rem 0">Facture ${esc(inv.number)}</h2>
  <div class="row">
    <a class="act act--ghost" href="/admin/factures/${esc(inv.id)}/print" target="_blank">🖨 Imprimer</a>
    ${sendBtn}
  </div>
</div>
<div class="card">
  <div class="muted">Émise le ${fmtLongDay(inv.created_at)}${inv.created_by ? ` · par ${esc(inv.created_by)}` : ""}</div>
  <div style="margin:.5rem 0"><b>${esc(inv.client_name)}</b>${inv.client_ref ? `<br><span class="muted">${esc(inv.client_ref)}</span>` : ""}${inv.client_phone ? `<br><span class="muted">+${esc(inv.client_phone)}</span>` : ""}</div>
  ${linesTable(lines)}
  <div style="text-align:right;margin-top:.6rem;font-size:1.1rem"><b>Total : ${fcfa(inv.total_xof)}</b></div>
  ${inv.paid_at ? `<div class="muted" style="margin-top:.4rem">✓ Payée via ${esc(inv.payment_method ?? "—")}${inv.payment_ref ? ` — réf. ${esc(inv.payment_ref)}` : ""} · le ${fmtLongDay(inv.paid_at)}</div>` : ""}
  ${inv.note ? `<div class="muted" style="margin-top:.4rem">Note : ${esc(inv.note)}</div>` : ""}
  <div class="muted" style="margin-top:.4rem">Envoi WhatsApp : ${sentCell(inv)}${inv.sent_at ? ` (${fmtLongDay(inv.sent_at)})` : ""}</div>
</div>`;
}

// ---------- printable standalone page ----------

export function renderFacturePrint(inv: Invoice): string {
  const lines = invoiceLines(inv);
  const rows = lines
    .map(
      (l) => `<tr><td>${esc(l.label)}</td><td class="num">${l.qty}</td><td class="num">${fcfa(l.unit_xof)}</td><td class="num"><b>${fcfa(l.total_xof)}</b></td></tr>`,
    )
    .join("");
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>Facture ${esc(inv.number)} — Revive</title>
<style>
  *{box-sizing:border-box}
  body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#1f2126;background:#fff;margin:0;padding:2rem}
  .paper{max-width:720px;margin:0 auto}
  .head{display:flex;justify-content:space-between;align-items:flex-start;gap:1rem}
  .logo{font-size:2rem;font-weight:800;letter-spacing:-.02em}
  .doc{text-align:right}
  .doc b{font-size:1.05rem}
  .doc div{font-size:.82rem;color:#6b7075;margin-top:.2rem}
  .seller{margin-top:1.4rem;font-size:.85rem;color:#6b7075;line-height:1.45}
  .seller b{color:#1f2126}
  hr{border:none;border-top:1px solid #e3e5e8;margin:1.2rem 0}
  .parties{display:flex;gap:2rem;flex-wrap:wrap;font-size:.85rem;line-height:1.45}
  .parties .lab{color:#6b7075}
  .parties .nom{font-weight:700}
  .parties .muted{color:#6b7075}
  table{width:100%;border-collapse:collapse;font-size:.92rem;margin-top:1.6rem}
  thead th{background:#cfdcf3;color:#1f2126;text-align:left;font-size:.8rem;padding:.55rem .7rem}
  thead th.num,td.num{text-align:right}
  td{padding:.65rem .7rem;font-variant-numeric:tabular-nums}
  tbody{border-bottom:2px solid #1f2126}
  .totals{margin:1.2rem 0 0 auto;max-width:340px;font-size:.9rem}
  .totals .row{display:flex;justify-content:space-between;padding:.22rem 0}
  .totals .strong{font-weight:700;font-size:1rem;border-top:1px solid #e3e5e8;margin-top:.3rem;padding-top:.5rem}
  .paid,.note{color:#6b7075;font-size:.85rem;margin-top:1.1rem}
  .no-print{margin:0 auto 1.2rem;max-width:720px}
  .no-print button{background:#1f2126;color:#fff;border:none;border-radius:8px;padding:.55rem 1.1rem;font-size:.95rem;cursor:pointer}
  @media print{ .no-print{display:none} body{padding:0} }
</style></head><body>
<div class="no-print"><button onclick="window.print()">🖨 Imprimer / Enregistrer en PDF</button></div>
<div class="paper">
  <div class="head">
    <div class="logo">revive</div>
    <div class="doc"><b>Facture n° ${esc(inv.number)}</b><div>Date d'émission : ${fmtLongDay(inv.created_at)}</div></div>
  </div>
  <div class="seller"><b>Revive</b><br>Dakar, Dakar<br>Sénégal<br>support@revive.sn<br>Téléphone : 78 464 43 29</div>
  <hr>
  <div class="parties">
    <div><div class="lab">Facturer à :</div><div class="nom">${esc(inv.client_name)}</div>${inv.client_ref ? `<div class="muted">${esc(inv.client_ref)}</div>` : ""}<div class="muted">Sénégal</div></div>
    ${inv.client_phone ? `<div><div class="lab">Infos client supplémentaires :</div><div class="muted">Téléphone : +${esc(inv.client_phone)}</div></div>` : ""}
  </div>
  <table><thead><tr><th>Article ou service</th><th class="num">Quantité</th><th class="num">Prix</th><th class="num">Total</th></tr></thead><tbody>${rows}</tbody></table>
  <div class="totals">
    <div class="row strong"><span>Total de la facture</span><span>${fcfa(inv.total_xof)}</span></div>
  </div>
  ${inv.paid_at ? `<div class="paid">✓ Payée via ${esc(inv.payment_method ?? "—")}${inv.payment_ref ? ` — réf. ${esc(inv.payment_ref)}` : ""} · le ${fmtLongDay(inv.paid_at)}</div>` : ""}
  ${inv.note ? `<div class="note">${esc(inv.note)}</div>` : ""}
</div>
</body></html>`;
}
