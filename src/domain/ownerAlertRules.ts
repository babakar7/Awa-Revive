/**
 * Qui doit réveiller le propriétaire ?
 *
 * Toutes les alertes internes passent par notifyReception(subject, body). Une
 * partie d'entre elles sont de simples informations (une commande de plus, le
 * récap du soir) ; les autres demandent qu'un HUMAIN fasse quelque chose —
 * rembourser, activer un abonnement, reprendre une conversation plantée. Ces
 * dernières doivent TOUJOURS arriver au propriétaire sur WhatsApp, template en
 * premier (son numéro n'écrit jamais à Awa : sa fenêtre 24 h est fermée en
 * permanence, et un envoi free-text hors fenêtre est accepté 200 puis jeté par
 * Meta — la panne silencieuse qu'on refuse ici).
 *
 * La décision se prend sur le SUJET seul, jamais sur le corps : le corps
 * contient des phrases comme « paiement en attente » qui n'engagent personne.
 *
 * Trois règles, dans cet ordre :
 *  1. une commande de TEST ne réveille jamais personne ;
 *  2. la liste informative ci-dessous ne réveille jamais personne ;
 *  3. un marqueur d'intervention (emoji d'alerte ou verbe d'action) réveille.
 *
 * Un sujet inconnu ne réveille PAS : une alerte inutile répétée finit toujours
 * par être ignorée, et c'est ainsi qu'on rate la vraie. Le filet est le test
 * qui balaie les appels à notifyReception du dépôt et échoue tant qu'un sujet
 * n'est pas classé d'un côté ou de l'autre — un nouvel appel doit donc choisir,
 * soit en portant un marqueur, soit en passant ownerAlert explicitement.
 */

/** Une commande/alerte de test : exclue des stats, exclue du téléphone du gérant. */
const TEST_SUBJECT = /🧪\s*TEST/u;

/**
 * Sujets purement informatifs : la réception les traite dans son flux normal,
 * personne n'a d'action à ouvrir. Ils ne partent JAMAIS chez le propriétaire.
 */
const INFORMATIONAL_SUBJECT_PATTERNS: RegExp[] = [
  /nouvelle commande livraison/i,
  /nouvelle livraison programmée/i,
  /départ autorisé/i,
  /espèces choisies/i,
  /récap du jour/i,
  // Le relais humain a déjà déclenché son alerte au moment du handoff ; les
  // messages suivants du client relanceraient le gérant à chaque phrase.
  /relais humain/i,
];

/**
 * Marqueurs d'intervention. Les emojis sont ceux déjà utilisés comme préfixe
 * de sujet dans le code (⚠ anomalie, 💸 remboursement, 🔴 cas grave,
 * 🙋🏾 handoff, 🛡 garantie, 🔀 fusion de fiches, 🔗 liaison). Ils sont écrits
 * SANS sélecteur de variante (U+FE0F) et sans teinte de peau : « ⚠️ » comme
 * « ⚠ » et « 🙋🏾 » comme « 🙋 » contiennent tous le caractère de base.
 */
const INTERVENTION_MARKERS = ["⚠", "💸", "🔴", "🚨", "🙋", "🛡", "🔀", "🔗"];

/** Verbes/états qui décrivent une action restée à faire côté humain. */
const INTERVENTION_PHRASES =
  /à faire|à vérifier|à confirmer|à traiter|à relier|à réparer|à activer|à terminer|à finir|à synchroniser|à aligner|à reprendre|à re-créditer|manuelle|manuellement|remboursement|handoff|crash|planté|mise en pause|échec|introuvable|non notifiée?|non créée?|absente|en retard|en attente|requise?|à décider/i;

export interface OwnerAlertVerdict {
  /** Faut-il réveiller le propriétaire sur WhatsApp ? */
  alert: boolean;
  /** Pourquoi — repris tel quel dans les logs et les tests. */
  reason:
    | "forced"
    | "opted_out"
    | "test"
    | "informational"
    | "marker"
    | "phrase"
    | "unclassified";
}

/**
 * Décide si un sujet de notification réception mérite une copie propriétaire.
 * `override` est le choix explicite d'un appelant (opts.ownerAlert) et gagne
 * toujours : un sujet à formulation inédite peut ainsi forcer l'alerte sans
 * attendre que le vocabulaire ci-dessus s'enrichisse.
 */
export function ownerAlertVerdict(subject: string, override?: boolean): OwnerAlertVerdict {
  if (override === true) return { alert: true, reason: "forced" };
  if (override === false) return { alert: false, reason: "opted_out" };
  if (TEST_SUBJECT.test(subject)) return { alert: false, reason: "test" };
  if (INFORMATIONAL_SUBJECT_PATTERNS.some((pattern) => pattern.test(subject))) {
    return { alert: false, reason: "informational" };
  }
  if (INTERVENTION_MARKERS.some((marker) => subject.includes(marker))) {
    return { alert: true, reason: "marker" };
  }
  if (INTERVENTION_PHRASES.test(subject)) return { alert: true, reason: "phrase" };
  return { alert: false, reason: "unclassified" };
}

/** Raccourci booléen — même règle, pour les appelants qui n'ont pas besoin du motif. */
export function shouldAlertOwner(subject: string, override?: boolean): boolean {
  return ownerAlertVerdict(subject, override).alert;
}

/**
 * Le sujet est-il explicitement rangé du côté « information » ? Utilisé par le
 * test de couverture qui balaie le dépôt : il exige que chaque sujet réel soit
 * soit une intervention, soit informatif — jamais « unclassified » par oubli.
 */
export function isKnownInformationalSubject(subject: string): boolean {
  const verdict = ownerAlertVerdict(subject);
  return !verdict.alert && (verdict.reason === "test" || verdict.reason === "informational");
}

/**
 * Message envoyé au propriétaire. Le corps reste celui de la réception (mêmes
 * liens, mêmes montants) ; seul le sujet est préfixé, pour qu'une notification
 * WhatsApp tronquée dise d'emblée qu'une action est attendue.
 */
export function formatOwnerAlert(
  subject: string,
  body: string,
): { subject: string; body: string } {
  return { subject: `🚨 INTERVENTION — ${subject}`, body };
}
