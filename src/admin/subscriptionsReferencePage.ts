/**
 * Référence des abonnements (Clés de la Maison, Abonnement Aquabike, plan sur
 * mesure) — mémo opérationnel réception.
 *
 * Cette page est volontairement statique : elle doit rester disponible même
 * si Wix ou Postgres sont momentanément indisponibles. Elle complète le
 * registre dynamique /admin/abonnements sans déclencher aucune action métier.
 */
export function renderSubscriptionsReference(): string {
  return `
<article class="key-memo">
  <header class="page-header key-memo-header">
    <div class="page-header-copy">
      <span class="eyebrow">Clés de la Maison</span>
      <h2>Mémo réception</h2>
      <p>Les règles à vérifier au comptoir pour les Clés, cours bonus, invitations, prolongations et garanties.</p>
    </div>
    <div class="page-header-actions key-memo-actions">
      <a class="act act--ghost" href="/admin/abonnements">Voir le registre</a>
      <button class="act" type="button" onclick="window.print()">Imprimer le mémo</button>
    </div>
  </header>

  <section class="key-memo-principle" aria-labelledby="key-principle-title">
    <span class="key-memo-principle-icon" aria-hidden="true">✦</span>
    <div>
      <span class="eyebrow">Principe général</span>
      <h2 id="key-principle-title">Awa reçoit et transmet. La réception vérifie, valide et tient le registre.</h2>
      <p>En cas de doute, ne rien créer en double dans Wix.</p>
    </div>
  </section>

  <div class="key-memo-grid">
    <section class="key-rule-card" aria-labelledby="key-rule-sale">
      <div class="key-rule-heading">
        <span class="key-rule-number" aria-hidden="true">1</span>
        <div>
          <span class="eyebrow">Au comptoir</span>
          <h2 id="key-rule-sale">Vente d’une Clé</h2>
        </div>
      </div>
      <p>Activez <strong>uniquement la Clé payante</strong> sur le compte Wix de la cliente.</p>
      <div class="key-callout key-callout--success">
        <strong>Automatique</strong>
        <span>Le cours bonus est ajouté automatiquement.</span>
      </div>
      <div class="key-callout key-callout--danger">
        <strong>Ne pas faire</strong>
        <span>Ne créez pas de formule bonus manuellement, sauf si une alerte vous le demande.</span>
      </div>
    </section>

    <section class="key-rule-card" aria-labelledby="key-rule-bonus">
      <div class="key-rule-heading">
        <span class="key-rule-number" aria-hidden="true">2</span>
        <div>
          <span class="eyebrow">Avantage</span>
          <h2 id="key-rule-bonus">Cours bonus</h2>
        </div>
      </div>
      <dl class="key-facts">
        <div><dt>Cours</dt><dd>Aquabike, Yoga, Mat ou Step</dd></div>
        <div><dt>Jours</dt><dd>Du lundi au vendredi</dd></div>
        <div><dt>Quantité</dt><dd>1 pour L’Invitée et L’Habituée · 2 pour La Résidente</dd></div>
      </dl>
      <p class="key-final-rule"><strong>Après réservation :</strong> aucun changement, aucune annulation et aucun recrédit, sauf si Revive annule le cours.</p>
    </section>

    <section class="key-rule-card key-rule-card--wide" aria-labelledby="key-rule-invitation">
      <div class="key-rule-heading">
        <span class="key-rule-number" aria-hidden="true">3</span>
        <div>
          <span class="eyebrow">Passage obligatoire par Awa</span>
          <h2 id="key-rule-invitation">Invitations</h2>
        </div>
      </div>
      <div class="key-callout key-callout--danger">
        <strong>Jamais directement dans Wix</strong>
        <span>Toute invitation passe par Awa/Resabot, même si la demande est faite à l’accueil. Ne créez jamais directement une formule Invitation.</span>
      </div>
      <div class="key-check-grid" aria-label="Conditions de l’invitation">
        <p><span aria-hidden="true">✓</span> Amie n’ayant jamais fait de Reformer chez Revive — ses autres venues ne bloquent pas</p>
        <p><span aria-hidden="true">✓</span> Reformer à 12h30, du lundi au vendredi</p>
        <p><span aria-hidden="true">✓</span> Réservation sous le compte de la détentrice</p>
        <p><span aria-hidden="true">✓</span> Prénom et téléphone de l’amie dans la réservation</p>
      </div>
      <p class="key-final-rule"><strong>Après réservation :</strong> aucun changement, aucune annulation et aucun recrédit, sauf si Revive annule le cours.</p>
    </section>

    <section class="key-rule-card" aria-labelledby="key-rule-extension">
      <div class="key-rule-heading">
        <span class="key-rule-number" aria-hidden="true">4</span>
        <div>
          <span class="eyebrow">L’Habituée et La Résidente seulement</span>
          <h2 id="key-rule-extension">Prolongation de 7 jours</h2>
        </div>
      </div>
      <ul class="key-checklist">
        <li>Clé encore active</li>
        <li>Demande faite avant l’expiration</li>
        <li>Au moins une séance Reformer restante</li>
        <li>Prolongation jamais utilisée</li>
      </ul>
      <p class="key-owner-note"><strong>Awa transmet la demande.</strong> Seule la réception la valide et l’enregistre.</p>
    </section>

    <section class="key-rule-card" aria-labelledby="key-rule-guarantee">
      <div class="key-rule-heading">
        <span class="key-rule-number" aria-hidden="true">5</span>
        <div>
          <span class="eyebrow">Décision humaine</span>
          <h2 id="key-rule-guarantee">Garantie L’Invitée</h2>
        </div>
      </div>
      <p class="key-deadline"><strong>Délai :</strong> avant la fin de la journée de la première séance.</p>
      <ul class="key-checklist">
        <li>Présence effective à la première séance</li>
        <li>Aucune deuxième séance Reformer utilisée</li>
        <li>Aucun cours bonus réservé ou utilisé</li>
      </ul>
      <p class="key-owner-note"><strong>Awa transmet le dossier.</strong> La réception décide et effectue le remboursement.</p>
    </section>

    <section class="key-rule-card key-rule-card--wide" aria-labelledby="key-rule-founders">
      <div class="key-rule-heading">
        <span class="key-rule-number" aria-hidden="true">6</span>
        <div>
          <span class="eyebrow">Continuité des anciennes abonnées</span>
          <h2 id="key-rule-founders">Membres Fondatrices</h2>
        </div>
      </div>
      <div class="key-founders-layout">
        <div>
          <h3>Elles conservent jusqu’à leur échéance</h3>
          <ul class="key-checklist key-checklist--kept">
            <li>Leur abonnement actuel</li>
            <li>La piscine les jours de Reformer</li>
            <li>La bibliothèque</li>
            <li>Le tarif membre massage</li>
          </ul>
        </div>
        <div>
          <h3>Leur ancien abonnement ne donne pas</h3>
          <ul class="key-checklist key-checklist--excluded">
            <li>De cours bonus</li>
            <li>D’invitation</li>
            <li>De prolongation</li>
          </ul>
        </div>
      </div>
      <p class="key-final-rule"><strong>Relances commerciales :</strong> les programmes gratuits Ambassadrice et Invitation ne sont pas concernés.</p>
    </section>
  </div>

  <section class="key-catalogue" aria-labelledby="key-catalogue-title">
    <div class="key-catalogue-head">
      <span class="eyebrow">Catalogue</span>
      <h2 id="key-catalogue-title">Tous les abonnements et leurs avantages</h2>
      <p>Les prix et disponibilités font foi dans Wix. Les avantages ci-dessous sont gérés par Awa/Resabot.</p>
    </div>
    <div class="key-catalogue-grid">
      <article class="key-cat-card">
        <header><h3>L’Invitée — Clé 3 séances</h3><span class="key-cat-price">30 000 F · 3 séances · 21 j</span></header>
        <ul>
          <li>Nouvelles clientes Revive uniquement, une seule fois</li>
          <li>Piscine le jour de chaque séance (serviette comprise)</li>
          <li>1 cours en plus (Aquabike, Yoga, Mat ou Step, lun–ven)</li>
          <li>Une boisson découverte offerte</li>
          <li>Garantie intégrale après la 1re séance (demande le jour même)</li>
        </ul>
      </article>
      <article class="key-cat-card">
        <header><h3>L’Habituée — Clé 6 séances</h3><span class="key-cat-price">72 000 F · 6 séances · 30 j</span></header>
        <ul>
          <li>Piscine les jours de séance (serviette comprise)</li>
          <li>1 cours en plus (Aquabike, Yoga, Mat ou Step, lun–ven)</li>
          <li>Bibliothèque · massage membre 25 000 F au lieu de 35 000 F</li>
          <li>7 jours de plus, une fois, sur demande avant expiration</li>
        </ul>
      </article>
      <article class="key-cat-card">
        <header><h3>La Résidente — Clé 12 séances</h3><span class="key-cat-price">144 000 F · 12 séances · 60 j</span></header>
        <ul>
          <li>Piscine pendant toute la validité</li>
          <li>2 cours en plus (Aquabike, Yoga, Mat ou Step, lun–ven)</li>
          <li>1 invitation Reformer (12h30, lun–ven) pour une amie qui n’a jamais fait de Reformer chez Revive</li>
          <li>Bibliothèque · massage membre · 7 jours de plus, une fois</li>
        </ul>
      </article>
      <article class="key-cat-card key-cat-card--accent">
        <header><h3>L’Abonnement Aquabike</h3><span class="key-cat-price">70 000 F · 8 séances · 30 j</span></header>
        <ul>
          <li>8 séances au prix de 7 — la huitième est offerte</li>
          <li><strong>1 séance Reformer offerte</strong>, sur créneau calme (12h30, lun–ven) — passe par Awa (cours bonus)</li>
          <li><strong>1 invitation Aquabike</strong> pour une amie qui n’a jamais fait d’Aquabike chez Revive — cours Aquabike, lun–ven, à toute heure — passe par Awa</li>
          <li>7 jours de plus sur demande avant expiration</li>
        </ul>
        <p class="key-cat-note">Règles différentes des Clés : l’invitation est un cours <em>Aquabike</em> (pas Reformer 12h30), et le bonus est une séance <em>Reformer</em> au créneau calme.</p>
      </article>
      <article class="key-cat-card key-cat-card--accent">
        <header><h3>1x Reformer · 1x Mat · 1x Step (par semaine)</h3><span class="key-cat-price">100 000 F · 12 séances · 30 j</span></header>
        <ul>
          <li>12 séances au choix : Reformer (Foundation/Sculpt/Intense), Pilates Mat, Step</li>
          <li>Piscine les jours de séance (serviette comprise) · bibliothèque · massage membre 25 000 F</li>
          <li>1 invitation Reformer (12h30, lun–ven) pour une amie qui n’a jamais fait de Reformer chez Revive</li>
          <li>7 jours de plus sur demande avant expiration · pas de cours en plus (Mat/Step déjà couverts)</li>
        </ul>
        <p class="key-cat-note">Plan dédié à une cliente précise : Awa ne le propose jamais spontanément.</p>
      </article>
      <article class="key-cat-card key-cat-card--accent">
        <header><h3>2x Reformer · 1x Yoga · 1x Step (par semaine)</h3><span class="key-cat-price">148 000 F · 16 séances · 30 j</span></header>
        <ul>
          <li>16 séances au choix : Reformer (Foundation/Sculpt/Intense), Power Yoga, Step</li>
          <li>Accès piscine pendant toute la durée de la formule (serviette comprise) · bibliothèque · massage membre 25 000 F</li>
          <li>1 invitation Reformer (12h30, lun–ven) pour une amie qui n’a jamais fait de Reformer chez Revive</li>
          <li>7 jours de plus sur demande avant expiration · pas de cours en plus (Yoga/Step déjà couverts)</li>
        </ul>
        <p class="key-cat-note">Plan dédié à une cliente précise : Awa ne le propose jamais spontanément. Piscine plus large que l’autre plan sur mesure : toute la durée, pas seulement les jours de séance.</p>
      </article>
      <article class="key-cat-card key-cat-card--plain">
        <header><h3>Carnet natation (sans avantages annexes)</h3><span class="key-cat-price">10 séances à utiliser librement</span></header>
        <ul>
          <li>Carnet de 10 Bébé nageur et Natation — 70 000 F</li>
        </ul>
      </article>
    </div>
  </section>

  <footer class="key-memo-footer">
    <strong>Un doute ?</strong>
    <span>Ne créez rien en double dans Wix. Vérifiez le registre et laissez Awa transmettre la demande.</span>
  </footer>
</article>`;
}
