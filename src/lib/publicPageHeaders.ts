import type { FastifyReply } from "fastify";

/**
 * En-têtes durcis des pages publiques sans authentification (livraison, fiche
 * de poste). Ces pages sont ouvertes depuis WhatsApp par des gens pressés, sur
 * des liens qui circulent : rien ne doit être mis en cache, indexé, encadré,
 * ni exécuté.
 *
 * `formAction` est le SEUL paramètre : la page livraison POSTe son départ
 * ('self'), la fiche de poste n'a aucun formulaire ('none'). Tout le reste est
 * identique — d'où le helper partagé, plutôt que deux copies dont une oublie
 * un en-tête (nosniff manquait côté livraison avant ce partage).
 */
export function hardenPublicPage(
  reply: FastifyReply,
  opts: { formAction: "self" | "none" },
): void {
  reply.header("Cache-Control", "no-store");
  reply.header("X-Robots-Tag", "noindex, nofollow");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("X-Frame-Options", "DENY");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'unsafe-inline'; form-action '${opts.formAction}'; base-uri 'none'`,
  );
}
