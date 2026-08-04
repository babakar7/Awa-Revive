import { config } from "../config.js";
import { pool } from "../db/index.js";
import { notifyReception } from "../lib/notify.js";
import type { OmPaymentMethod } from "../lib/orangeMoney.js";

/**
 * Alerte propriétaire à CHAQUE tentative de paiement Orange Money / Max It,
 * c'est-à-dire dès qu'un lien/QR est créé pour un client.
 *
 * Contexte (panne Sonatel du 31/07/2026) : quand le callback se perd, un
 * paiement RÉEL reste invisible localement et personne n'est prévenu. En
 * alertant dès la tentative, le gérant sait qu'une transaction peut arriver
 * dans le portail marchand et la réconcilie via /admin/paiements-om si la
 * confirmation automatique n'arrive pas. Wave n'est pas concerné (callbacks
 * fiables). Une commande d'un numéro Équipe/test est journalisée mais ne
 * réveille pas le gérant (préfixe 🧪 TEST — cf. ownerAlertRules).
 */

const METHOD_LABEL: Record<OmPaymentMethod, string> = {
  orange_money: "Orange Money",
  maxit: "Max It",
};

export interface OmAttemptOrderInfo {
  kind: string;
  label: string | null;
  client_name: string | null;
  wa_phone: string | null;
  is_test: boolean;
}

/** Retrouve la ligne d'ordre (déjà créée avant la session) + la cliente. */
async function findAttemptOrder(orderId: string): Promise<OmAttemptOrderInfo | null> {
  const res = await pool.query<OmAttemptOrderInfo>(
    `select * from (
       select 'Cours' as kind, b.service_name as label, c.name as client_name,
              c.wa_phone, c.is_test
         from pending_bookings b join clients c on c.id = b.client_id
        where b.id::text = $1
       union all
       select 'Abonnement', p.plan_name, c.name, c.wa_phone, c.is_test
         from pending_plan_orders p join clients c on c.id = p.client_id
        where p.id::text = $1
       union all
       select 'Bar', coalesce(o.service_name, 'Commande bar'), c.name, c.wa_phone, c.is_test
         from pending_cafe_orders o join clients c on c.id = o.client_id
        where o.id::text = $1
       union all
       select 'Livraison', 'Livraison', c.name, c.wa_phone, c.is_test
         from delivery_payment_attempts a join clients c on c.id = a.client_id
        where a.id::text = $1
     ) t limit 1`,
    [orderId],
  );
  return res.rows[0] ?? null;
}

/** Pur (unit-testé) : sujet + corps de l'alerte de tentative OM/Max It. */
export function formatOmAttemptAlert(args: {
  method: OmPaymentMethod;
  amountXof: number;
  fallbackLabel?: string | null;
  order: OmAttemptOrderInfo | null;
}): { subject: string; body: string } {
  const method = METHOD_LABEL[args.method];
  const amount = `${Math.round(args.amountXof).toLocaleString("fr-FR")} FCFA`;
  const who = args.order?.client_name?.trim() || "Client";
  const phone = args.order?.wa_phone ? ` (+${args.order.wa_phone.replace(/^\+/, "")})` : "";
  const what = args.order
    ? `${args.order.kind} : ${args.order.label ?? "?"}`
    : args.fallbackLabel || "commande inconnue";
  const reconcileUrl = `${config.BASE_URL.replace(/\/+$/, "")}/admin/paiements-om`;
  const testPrefix = args.order?.is_test ? "🧪 TEST — " : "";
  return {
    subject: `${testPrefix}⚠️ Paiement ${method} à réconcilier manuellement`,
    body:
      `${who}${phone} vient de recevoir un lien ${method} de ${amount} — ${what}.\n` +
      `Les confirmations Sonatel étant peu fiables, retrouve la transaction dans le portail ` +
      `marchand si le paiement n'est pas confirmé automatiquement, puis réconcilie ici : ${reconcileUrl}`,
  };
}

/**
 * Fire-and-forget : jamais awaité par le flux de paiement, n'échoue jamais
 * vers l'appelant. La ligne d'ordre existe déjà (créée avant la session) ;
 * si la recherche échoue quand même, l'alerte part avec le libellé de secours.
 */
export function notifyOmPaymentAttempt(args: {
  orderId: string;
  method: OmPaymentMethod;
  amountXof: number;
  fallbackLabel?: string | null;
}): void {
  void (async () => {
    const order = await findAttemptOrder(args.orderId).catch((err) => {
      console.error("[om] attempt alert order lookup failed:", err);
      return null;
    });
    const { subject, body } = formatOmAttemptAlert({
      method: args.method,
      amountXof: args.amountXof,
      fallbackLabel: args.fallbackLabel,
      order,
    });
    notifyReception(subject, body);
  })().catch((err) => console.error("[om] attempt owner alert failed:", err));
}
