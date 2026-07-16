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
  return `${Number(n).toLocaleString("fr-FR").replace(/ /g, " ")} F`;
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
    return `<div class="card" style="border-color:#1a7f37"><span class="ok">✓ ${esc(BANNERS[done])}</span></div>`;
  if (err) return `<div class="card warn">⚠️ ${esc(err)}</div>`;
  return "";
}

function sentCell(inv: Invoice): string {
  if (inv.sent_status === "sent") return `<span class="ok">✓ envoyée</span>`;
  if (inv.sent_status === "window_closed")
    return `<span style="color:#9a6700">fenêtre fermée</span>`;
  if (inv.sent_status === "failed") return `<span style="color:#cf222e">✗ échec</span>`;
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
<td><a class="act" style="text-decoration:none;padding:.35rem .6rem;font-size:.8rem" href="/admin/factures/${esc(inv.id)}">Voir</a></td>
</tr>`,
        )
        .join("")}</tbody></table>`
    : `<p class="muted">Aucune facture pour l'instant.</p>`;
  return `${banner}
<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem">
  <h2 style="margin:.4rem 0">Factures 🧾</h2>
  <a href="/admin/factures/new" class="act" style="text-decoration:none;padding:.5rem .9rem;border-radius:8px">➕ Nouvelle facture</a>
</div>
<div class="card">${table}</div>`;
}

// ---------- create form ----------

const INPUT = "width:100%;padding:.55rem;border:1px solid #e4ddd3;border-radius:8px";

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
      <select id="cand" style="${INPUT}">
        <option value="">— saisie manuelle —</option>
        ${options}
      </select>
    </label>
  </div>`
      : ""
  }
  <div class="card" style="display:flex;flex-direction:column;gap:.6rem">
    <label>Nom du client / entreprise<input name="client_name" id="client_name" required style="${INPUT}"></label>
    <label>Téléphone WhatsApp <span class="muted">(optionnel — requis pour l'envoi)</span><input name="client_phone" id="client_phone" placeholder="77 123 45 67 ou +221…" style="${INPUT}"></label>
    <label>Référence / à l'attention de <span class="muted">(optionnel)</span><input name="client_ref" id="client_ref" placeholder="Société Teranga Conseil SARL" style="${INPUT}"></label>
  </div>

  <h2 style="margin:.2rem 0">Lignes</h2>
  <div class="card">
    <div id="lines"></div>
    <button type="button" class="act" id="addline" style="background:#39414a;padding:.4rem .8rem;margin-top:.4rem">+ Ajouter une ligne</button>
  </div>

  <div class="card" style="display:flex;flex-direction:column;gap:.6rem">
    <label>Note <span class="muted">(optionnel — bas de facture)</span><input name="note" id="note" style="${INPUT}"></label>
  </div>

  <input type="hidden" name="source_kind" id="source_kind" value="manual">
  <input type="hidden" name="source_id" id="source_id" value="">
  <input type="hidden" name="payment_method" id="payment_method" value="">
  <input type="hidden" name="payment_ref" id="payment_ref" value="">
  <input type="hidden" name="paid_at" id="paid_at" value="">

  <div style="position:sticky;bottom:0;background:#f6f3ee;padding:.6rem 0;display:flex;align-items:center;gap:1rem">
    <b>Total : <span id="factotal">0</span> F</b>
    <button class="act" type="submit" style="padding:.6rem 1.1rem">Créer la facture</button>
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
      '<input name="line_label_'+i+'" placeholder="Désignation" value="'+(label||'').replace(/"/g,'&quot;')+'" style="flex:1;padding:.45rem;border:1px solid #e4ddd3;border-radius:8px">'+
      '<input name="line_qty_'+i+'" type="number" min="1" max="99" value="'+(qty||1)+'" title="Qté" style="width:4rem;padding:.45rem;border:1px solid #e4ddd3;border-radius:8px" oninput="factotal()">'+
      '<input name="line_unit_'+i+'" type="number" min="0" value="'+(unit==null?'':unit)+'" placeholder="PU" title="Prix unitaire" style="width:6rem;padding:.45rem;border:1px solid #e4ddd3;border-radius:8px" oninput="factotal()">'+
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
  return `<table><thead><tr><th>Désignation</th><th style="text-align:right">Qté</th><th style="text-align:right">PU</th><th style="text-align:right">Total</th></tr></thead><tbody>${lines
    .map(
      (l) => `<tr><td>${esc(l.label)}</td><td style="text-align:right">${l.qty}</td><td style="text-align:right">${fcfa(l.unit_xof)}</td><td style="text-align:right"><b>${fcfa(l.total_xof)}</b></td></tr>`,
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
<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem">
  <h2 style="margin:.4rem 0">Facture ${esc(inv.number)}</h2>
  <div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap">
    <a class="act" style="text-decoration:none;padding:.5rem .9rem;background:#39414a" href="/admin/factures/${esc(inv.id)}/print" target="_blank">🖨 Imprimer</a>
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
<title>Facture ${esc(inv.number)} — Revive Ventures</title>
<style>
  *{box-sizing:border-box}
  body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#211921;background:#fff;margin:0;padding:2rem}
  .paper{max-width:720px;margin:0 auto}
  .band{background:#7c547d;color:#fbf6f0;display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:.5rem;padding:1.2rem 1.6rem;border-radius:6px}
  .band .who b{font-size:1.3rem;letter-spacing:.03em}
  .band .who div,.band .doc div{font-size:.8rem;opacity:.9;margin-top:.15rem}
  .band .doc{text-align:right}
  .band .doc b{font-size:1.1rem;letter-spacing:.06em}
  .blk{background:#f3e6ee;border-radius:10px;padding:.8rem 1.1rem;max-width:340px;margin:1.5rem 0}
  .blk .lab{font-size:.68rem;font-weight:700;letter-spacing:.07em;color:#7c547d}
  .blk .nom{font-weight:700;margin-top:.2rem}
  .blk .ref{font-size:.85rem;color:#6c5a6d}
  table{width:100%;border-collapse:collapse;font-size:.92rem}
  thead th{background:#7c547d;color:#fbf6f0;text-align:left;font-size:.72rem;letter-spacing:.05em;padding:.5rem .7rem}
  thead th.num,td.num{text-align:right}
  td{padding:.6rem .7rem;border-bottom:1px solid #e8d9d2;font-variant-numeric:tabular-nums}
  .total{margin:1.3rem 0 0 auto;max-width:340px;background:#3d2b3e;color:#fbf6f0;border-radius:12px;display:flex;justify-content:space-between;align-items:center;padding:.85rem 1.3rem}
  .total span{font-size:.72rem;font-weight:700;letter-spacing:.07em}
  .total b{font-size:1.25rem}
  .paid,.note{color:#6c5a6d;font-size:.88rem;margin-top:1rem}
  .foot{border-top:1px solid #e8d9d2;margin-top:2rem;padding-top:.9rem;text-align:center;color:#a98baa;font-size:.8rem}
  .no-print{margin:0 auto 1.2rem;max-width:720px}
  .no-print button{background:#7c547d;color:#fff;border:none;border-radius:8px;padding:.55rem 1.1rem;font-size:.95rem;cursor:pointer}
  @media print{ .no-print{display:none} body{padding:0} }
</style></head><body>
<div class="no-print"><button onclick="window.print()">🖨 Imprimer / Enregistrer en PDF</button></div>
<div class="paper">
  <div class="band">
    <div class="who"><b>REVIVE VENTURES</b><div>Centre de bien-être — Almadies, Dakar</div><div>revive.sn</div></div>
    <div class="doc"><b>FACTURE</b><div>N° ${esc(inv.number)}</div><div>${fmtLongDay(inv.created_at)}</div></div>
  </div>
  <div class="blk">
    <div class="lab">FACTURÉ À</div>
    <div class="nom">${esc(inv.client_name)}</div>
    ${inv.client_ref ? `<div class="ref">${esc(inv.client_ref)}</div>` : ""}
    ${inv.client_phone ? `<div class="ref">+${esc(inv.client_phone)}</div>` : ""}
  </div>
  <table><thead><tr><th>DÉSIGNATION</th><th class="num">QTÉ</th><th class="num">PU</th><th class="num">TOTAL</th></tr></thead><tbody>${rows}</tbody></table>
  <div class="total"><span>TOTAL À RÉGLER</span><b>${fcfa(inv.total_xof)}</b></div>
  ${inv.paid_at ? `<div class="paid">✓ Payée via ${esc(inv.payment_method ?? "—")}${inv.payment_ref ? ` — réf. ${esc(inv.payment_ref)}` : ""} · le ${fmtLongDay(inv.paid_at)}</div>` : ""}
  ${inv.note ? `<div class="note">${esc(inv.note)}</div>` : ""}
  <div class="foot">Revive Ventures · Centre de bien-être · Almadies, Dakar · revive.sn — Merci de votre confiance</div>
</div>
</body></html>`;
}
