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

  <footer class="key-memo-footer">
    <strong>Un doute ?</strong>
    <span>Ne créez rien en double dans Wix. Vérifiez le registre et laissez Awa transmettre la demande.</span>
  </footer>
</article>`;
}
