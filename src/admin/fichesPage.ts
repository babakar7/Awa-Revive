import { escapeHtml as esc, fmtDate } from "./helpers.js";
import type { JobFiche } from "../domain/ficheRepo.js";
import type { FicheSendEntry } from "../domain/ficheRepo.js";
import type { FicheRecipients } from "../domain/ficheRules.js";
import { MAX_FICHE_BODY, MAX_ROLE_LABEL, hasUnpublishedChanges } from "../domain/ficheRules.js";
import type { StaffContact } from "../domain/notificationRepo.js";
import { phoneDigits } from "../domain/notificationRepo.js";

/**
 * /admin/fiches — le gérant écrit les responsabilités d'un rôle et les pousse
 * sur WhatsApp à toute l'équipe concernée. Fonctions PURES (aucun accès DB),
 * comme faqPage/menuPage : la route charge, la page rend.
 *
 * Deux partis pris visibles dans l'UI :
 *  - on n'affirme JAMAIS qu'une fiche a été « reçue » ni « lue ». Le webhook
 *    Meta ne traite que `failed` (webhooks/whatsapp.ts) : delivered/read sont
 *    jetés. Le plus fort qu'on sache dire est « accepté par Meta ».
 *  - les destinataires sont comptés sur les clés PUBLIÉES, pas sur le
 *    brouillon : c'est ce que l'envoi utilisera réellement.
 */

const BANNERS: Record<string, string> = {
  created: "Fiche créée.",
  saved: "Brouillon enregistré.",
  published: "Fiche publiée — le lien est actif pour l’équipe.",
  unpublished: "Fiche dépubliée — le lien répond désormais « introuvable ».",
  deleted: "Fiche supprimée.",
  "link-rotated": "Nouveau lien généré — l’ancien ne fonctionne plus.",
};

export function fichesBanner(done?: string, err?: string): string {
  if (done && BANNERS[done])
    return `<div class="card success"><span class="ok">✓ ${esc(BANNERS[done])}</span></div>`;
  if (done && done.startsWith("sent:"))
    return `<div class="card success"><span class="ok">✓ Fiche envoyée à ${esc(done.slice(5))} (acceptée par Meta).</span></div>`;
  if (done && done.startsWith("sent-all:")) {
    const [, ok, noPhone, muted, failed] = done.split(":");
    const bits = [`${ok} envoi(s) accepté(s) par Meta`];
    if (Number(failed) > 0) bits.push(`${failed} en échec`);
    if (Number(noPhone) > 0) bits.push(`${noPhone} sans numéro`);
    if (Number(muted) > 0) bits.push(`${muted} en sourdine (non envoyé)`);
    const cls = Number(failed) > 0 ? "warn" : "success";
    return `<div class="card ${cls}">${cls === "success" ? "✓ " : "⚠️ "}${esc(bits.join(" · "))}.</div>`;
  }
  if (err) return `<div class="card warn">⚠️ ${esc(err)}</div>`;
  return "";
}

export interface FicheCardData {
  fiche: JobFiche;
  recipients: FicheRecipients;
  lastSends: Map<string, FicheSendEntry>;
  url: string;
}

export interface FichesPageData {
  cards: FicheCardData[];
  knownRoles: string[];
  rolesWithoutFiche: string[];
  templateConfigured: boolean;
  banner: string;
}

const badge = (cls: string, text: string) => `<span class="badge badge--${cls}">${esc(text)}</span>`;

function statusCell(entry: FicheSendEntry | undefined): string {
  if (!entry) return `<span class="muted">jamais envoyée</span>`;
  const when = fmtDate(entry.created_at);
  if (entry.status === "failed")
    return `${badge("red", "échec signalé")}<br><span class="muted">${esc(when)}${entry.error ? ` — ${esc(entry.error.slice(0, 80))}` : ""}</span>`;
  if (entry.status === "sent" || entry.status === "sent_template")
    return `${badge("green", "accepté par Meta")}<br><span class="muted">${esc(when)}</span>`;
  return `${badge("gray", entry.status)}<br><span class="muted">${esc(when)}</span>`;
}

function recipientRows(d: FicheCardData): string {
  const { fiche, recipients, lastSends } = d;
  const row = (c: StaffContact, kind: "target" | "muted" | "nophone") => {
    const entry = lastSends.get(phoneDigits(c.phone ?? ""));
    const action =
      kind === "nophone"
        ? `<a class="act act--sm act--ghost" href="/admin/notifications#contacts">Ajouter un numéro</a>`
        : `<form method="post" action="/admin/fiches/${esc(fiche.id)}/send/${esc(c.id)}" class="inline" data-confirm="Envoyer la fiche « ${esc(fiche.published_role_label ?? fiche.role_label)} » à ${esc(c.name)} ?"><button class="act act--sm${kind === "muted" ? " act--ghost" : ""}" type="submit">${entry ? "Renvoyer" : "Envoyer"}</button></form>`;
    return `<tr>
<td data-label="Employée"><b>${esc(c.name)}</b>${kind === "muted" ? ` ${badge("amber", "sourdine")}` : ""}${kind === "nophone" ? ` ${badge("gray", "sans numéro")}` : ""}</td>
<td data-label="Rôle"><span class="muted">${esc(c.role)}</span></td>
<td data-label="Dernier envoi WhatsApp">${statusCell(entry)}</td>
<td data-label="Action" class="right">${action}</td>
</tr>`;
  };
  const rows = [
    ...recipients.targets.map((c) => row(c, "target")),
    ...recipients.muted.map((c) => row(c, "muted")),
    ...recipients.noPhone.map((c) => row(c, "nophone")),
  ];
  if (!rows.length)
    return `<tr><td colspan="4" class="muted">Aucun membre du répertoire ne porte ce rôle.</td></tr>`;
  return rows.join("");
}

function ficheCard(d: FichesPageData, card: FicheCardData): string {
  const { fiche, recipients, url } = card;
  const published = fiche.published_body !== null;
  const dirty = hasUnpublishedChanges(fiche);
  const sendable = published && recipients.targets.length > 0;
  const staleSend =
    published && fiche.last_sent_at && fiche.published_at && fiche.published_at > fiche.last_sent_at;

  const badges = [
    published ? badge("green", "publiée") : badge("amber", "brouillon"),
    dirty ? badge("amber", "modifications non publiées") : "",
    staleSend ? badge("violet", "modifiée depuis le dernier envoi") : "",
  ]
    .filter(Boolean)
    .join(" ");

  const linkBlock = published
    ? `<p class="muted" style="margin:.2rem 0 .5rem;word-break:break-all">Lien de l’équipe : <a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a></p>`
    : `<p class="muted" style="margin:.2rem 0 .5rem">Pas encore publiée : le lien répond « introuvable » tant que tu n’as pas publié.</p>`;

  const zeroWarn =
    published && recipients.targets.length === 0
      ? `<div class="card warn" style="margin:.6rem 0">⚠️ <b>Aucun membre joignable pour ce rôle.</b> Ajoute un numéro dans le <a href="/admin/notifications#contacts">répertoire staff</a> — sinon cette fiche ne part à personne.</div>`
      : "";

  const dirtyWarn = dirty
    ? `<div class="card warn" style="margin:.6rem 0">⚠️ Le brouillon diffère de la version publiée. L’équipe lit toujours l’ancienne, et l’envoi utilise les rôles publiés. <b>Publie</b> pour rendre tes modifications visibles.</div>`
    : "";

  return `<section class="card" style="margin-bottom:1.1rem">
  <div class="section-header"><div><span class="eyebrow">Fiche de poste</span><h2>${esc(fiche.role_label)} ${badges}</h2></div>
  <span class="muted">${recipients.targets.length} destinataire(s)${recipients.muted.length ? ` · ${recipients.muted.length} en sourdine` : ""}${recipients.noPhone.length ? ` · ${recipients.noPhone.length} sans numéro` : ""}</span></div>
  ${linkBlock}${zeroWarn}${dirtyWarn}

  <form method="post" action="/admin/fiches/${esc(fiche.id)}" class="stack">
    <label>Rôle concerné
      <input name="role_label" value="${esc(fiche.role_label)}" required maxlength="${MAX_ROLE_LABEL}" list="fiche-roles" style="width:100%">
    </label>
    <span class="muted">Sépare par « / » pour couvrir plusieurs libellés du répertoire (ex. « Cuisine / Bar »). Les destinataires sont ceux dont le rôle correspond.</span>
    <label>Responsabilités
      <textarea name="body" rows="12" maxlength="${MAX_FICHE_BODY}" placeholder="- Ouvrir le studio à 6h45&#10;- Vérifier la propreté des vestiaires&#10;- Accueillir chaque cliente par son prénom">${esc(fiche.body)}</textarea>
    </label>
    <span class="muted">Une ligne par responsabilité. « - » ou « 1. » en début de ligne devient une liste sur la page de l’équipe.</span>
    <div class="row">
      <button class="act" name="op" value="save" type="submit">Enregistrer le brouillon</button>
      <button class="act act--ok" name="op" value="publish" type="submit">${published ? "Publier les modifications" : "Publier"}</button>
      ${published ? `<button class="act act--ghost" name="op" value="unpublish" type="submit" formnovalidate>Dépublier</button>` : ""}
    </div>
  </form>

  <div class="table-wrap" style="margin-top:1rem">
    <table class="responsive-table"><thead><tr><th>Employée</th><th>Rôle</th><th>Dernier envoi WhatsApp</th><th class="right">Action</th></tr></thead>
    <tbody>${recipientRows(card)}</tbody></table>
  </div>
  <p class="muted" style="margin:.5rem 0 0">« Accepté par Meta » ne prouve pas la lecture : WhatsApp ne nous remonte que les échecs.</p>

  <div class="row" style="margin-top:.9rem;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem">
    <div class="row" style="gap:.4rem">
      <form method="post" action="/admin/fiches/${esc(fiche.id)}/send" class="inline" data-confirm="Envoyer la fiche « ${esc(fiche.published_role_label ?? fiche.role_label)} » à ${recipients.targets.length} personne(s) ?">
        <button class="act" type="submit"${sendable ? "" : " disabled"}>Envoyer à tous (${recipients.targets.length})</button>
      </form>
      <a class="act act--sm act--ghost" href="/admin/fiches/${esc(fiche.id)}/print" target="_blank">Imprimer</a>
    </div>
    <div class="row" style="gap:.4rem">
      <form method="post" action="/admin/fiches/${esc(fiche.id)}/regenerate-link" class="inline" data-confirm="Générer un nouveau lien ? L’ancien cessera immédiatement de fonctionner pour tout le monde.">
        <button class="act act--sm act--ghost" type="submit">Régénérer le lien</button>
      </form>
      ${
        fiche.last_sent_at
          ? `<span class="muted">Déjà envoyée — dépublie plutôt que supprimer.</span>`
          : `<form method="post" action="/admin/fiches/${esc(fiche.id)}/delete" class="inline" data-confirm="Supprimer définitivement la fiche « ${esc(fiche.role_label)} » ?"><button class="act act--sm act--danger" type="submit">Supprimer</button></form>`
      }
    </div>
  </div>
  ${fiche.updated_at ? `<p class="muted" style="margin:.5rem 0 0">Modifiée ${esc(fmtDate(fiche.updated_at))}${fiche.updated_by ? ` par ${esc(fiche.updated_by)}` : ""}${fiche.published_at ? ` · publiée ${esc(fmtDate(fiche.published_at))}` : ""}${fiche.last_sent_at ? ` · dernier lot ${esc(fmtDate(fiche.last_sent_at))} (${fiche.last_sent_count} accepté(s))` : ""}</p>` : ""}
</section>`;
}

export function renderFichesPage(d: FichesPageData): string {
  const datalist = `<datalist id="fiche-roles">${d.knownRoles.map((r) => `<option value="${esc(r)}"></option>`).join("")}</datalist>`;

  const missing = d.rolesWithoutFiche.length
    ? `<div class="card" style="margin-bottom:1rem"><span class="eyebrow">À couvrir</span>
<p class="muted" style="margin:.25rem 0 .5rem">Ces rôles existent dans le répertoire staff mais aucune fiche ne les couvre — personne ne recevra de responsabilités pour eux.</p>
<div class="row" style="flex-wrap:wrap;gap:.4rem">${d.rolesWithoutFiche
        .map(
          (r) =>
            `<form method="post" action="/admin/fiches" class="inline"><input type="hidden" name="role_label" value="${esc(r)}"><input type="hidden" name="body" value=""><button class="act act--sm act--ghost" type="submit">+ ${esc(r)}</button></form>`,
        )
        .join("")}</div></div>`
    : "";

  const templateWarn = d.templateConfigured
    ? ""
    : `<div class="card warn" style="margin-bottom:1rem">⚠️ <b>Aucun template WhatsApp configuré</b> (<code>WA_RECEPTION_TEMPLATE</code>). Hors fenêtre de 24 h, Meta accepte le message puis le jette sans rien signaler : l’équipe ne recevra rien. À régler avant de compter sur ces envois.</div>`;

  const cards = d.cards.length
    ? d.cards.map((c) => ficheCard(d, c)).join("")
    : `<div class="card"><div class="empty"><b>Aucune fiche de poste</b><p>Crée la première pour un rôle de ton équipe.</p></div></div>`;

  return `${d.banner}${datalist}
<header class="page-header"><div class="page-header-copy"><span class="eyebrow">Studio</span><h2>Fiches de poste</h2>
<p>Écris les responsabilités d’un rôle, publie-les, et envoie-les sur WhatsApp à toute l’équipe concernée. Le message porte un lien : la fiche entière ne tient pas dans un WhatsApp.</p></div></header>
${templateWarn}${missing}${cards}

<section class="card form-card">
  <span class="eyebrow">Nouvelle fiche</span>
  <form method="post" action="/admin/fiches" class="stack">
    <label>Rôle concerné
      <input name="role_label" required maxlength="${MAX_ROLE_LABEL}" list="fiche-roles" placeholder="Accueil" style="width:100%">
    </label>
    <label>Responsabilités <span class="muted">(tu peux publier plus tard)</span>
      <textarea name="body" rows="6" maxlength="${MAX_FICHE_BODY}" placeholder="- Ouvrir le studio à 6h45"></textarea>
    </label>
    <button class="act" type="submit">Créer la fiche</button>
  </form>
</section>`;
}

/** Version imprimable, côté admin : c'est ici que vit le bouton d'impression —
 *  la page publique n'a aucun script (window.print() imposerait un script-src). */
export function renderFichePrint(fiche: JobFiche, bodyHtml: string): string {
  const label = fiche.published_role_label ?? fiche.role_label;
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>Fiche de poste — ${esc(label)}</title>
<style>
  @page { size: A4 portrait; margin: 1.6cm }
  *{box-sizing:border-box}
  body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#211921;background:#fff;margin:0;padding:1.6rem;line-height:1.6}
  .brand{color:#6c5a6d;font-size:.72rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase;margin:0 0 .2rem}
  h1{font-size:1.5rem;margin:0 0 .15rem}
  .sub{color:#6c5a6d;font-size:.85rem;margin:0 0 1.2rem}
  ul,ol{padding-left:1.4rem}li{margin:.32rem 0}p{margin:.55rem 0}
  .no-print{margin:0 0 1.2rem}
  .no-print button{background:#7c547d;color:#fff;border:none;border-radius:8px;padding:.5rem 1rem;font-size:.95rem;cursor:pointer}
  @media print{ .no-print{display:none} body{padding:0} }
</style></head><body>
<div class="no-print"><button onclick="window.print()">🖨 Imprimer / Enregistrer en PDF</button></div>
<p class="brand">Studio Revive</p>
<h1>${esc(label)}</h1>
<p class="sub">${fiche.published_at ? `Version publiée du ${esc(fmtDate(fiche.published_at))}` : "Brouillon — non publié, l’équipe ne voit pas encore ce texte"}</p>
${bodyHtml}
</body></html>`;
}
