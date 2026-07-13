import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { pool } from "../db/index.js";
import { notifyReception } from "../lib/notify.js";

/**
 * Boucle de résultat (PROGRESS §4.31) : personne ne savait si un client
 * avait obtenu ce qu'il voulait — une conversation se terminait, point. Ce
 * module relit chaque conversation retombée au silence (>45 min) avec un
 * appel LLM et la classe :
 *
 *  - resolved            → le besoin exprimé a été satisfait
 *  - handed_off          → transmis à la réception via handoff_to_human (tracé ailleurs)
 *  - dropoff             → parti APRÈS une réponse correcte : choix libre du client,
 *                          AUCUNE action (décision produit Babakar) — statistiques seulement
 *  - deadend             → parti parce qu'Awa a mal répondu / tourné en rond / refusé
 *  - technical_failure   → le client a reçu le message d'erreur
 *
 * deadend + technical_failure alimentent la file « À reprendre » du dashboard
 * (la réception recontacte — pas de relance automatique par Awa). Les cas
 * severe (frustration explicite, abonnée bloquée, plainte) notifient la
 * réception immédiatement ; le reste part dans le digest quotidien de 19h.
 */

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

/** Une conversation est « terminée » après ce silence. */
export const REVIEW_AFTER_MINUTES = 45;
/** Ne jamais classifier plus vieux que ça (backfill au premier déploiement). */
export const REVIEW_MAX_AGE_HOURS = 24;
/** Bornage du batch par sweep — le volume studio en reste très loin. */
const MAX_REVIEWS_PER_SWEEP = 20;

export const OUTCOMES = [
  "resolved",
  "handed_off",
  "dropoff",
  "deadend",
  "technical_failure",
] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const NEED_CATEGORIES = [
  "booking",
  "membership",
  "cancel_reschedule",
  "cafe",
  "info",
  "payment",
  "account_linking",
  "other",
] as const;

/** Les issues qui représentent un client reparti les mains vides par NOTRE faute. */
export const ACTIONABLE_OUTCOMES: Outcome[] = ["deadend", "technical_failure"];

export interface ReviewVerdict {
  outcome: Outcome;
  need_category: (typeof NEED_CATEGORIES)[number];
  severity: "normal" | "severe";
  summary: string;
  suggested_action: string;
}

export interface ReviewTurn {
  role: string; // user | assistant | tool
  content: string;
  created_at: Date;
}

// ---------- classificateur ----------

const REVIEW_TOOL: Anthropic.Tool = {
  name: "report_outcome",
  description: "Report the outcome classification of this WhatsApp conversation.",
  input_schema: {
    type: "object",
    properties: {
      outcome: { type: "string", enum: [...OUTCOMES] },
      need_category: { type: "string", enum: [...NEED_CATEGORIES] },
      severity: { type: "string", enum: ["normal", "severe"] },
      summary: {
        type: "string",
        description: "1-2 sentences, in French: what the client wanted and how it ended",
      },
      suggested_action: {
        type: "string",
        description:
          "One concrete step for the reception, in French (empty string when outcome is resolved/handed_off/dropoff)",
      },
    },
    required: ["outcome", "need_category", "severity", "summary", "suggested_action"],
    additionalProperties: false,
  },
};

const REVIEW_SYSTEM = `You review ended WhatsApp conversations between clients and Awa, the booking
assistant of the Revive studio (Dakar). Awa books classes (paid via Wave or a membership), sells
memberships, takes bar orders, cancels/reschedules, answers studio questions, links accounts by
email code, and hands off to human reception when she can't help.

The conversation went silent: classify HOW it ended for the client, from the transcript alone.
Turns prefixed "tool:" are Awa's tool calls with their results — trust them over wording (e.g. a
booked:true result means the booking really happened).

- resolved: the client's expressed need was satisfied (booking confirmed, question answered,
  cancellation done, order paid...). A client who got their answer and simply didn't reply
  "merci" is still resolved.
- handed_off: Awa called handoff_to_human and gave the reception contact — the need now belongs
  to a human (whatever happens next).
- dropoff: Awa answered correctly and usefully (slots offered, price given, link sent) and the
  client chose not to continue. Their free choice — NOT a failure. An unpaid payment link alone
  is a dropoff, not a deadend.
- deadend: the client left BECAUSE the exchange failed them: Awa couldn't do what they asked and
  no handoff happened, went in circles, misunderstood repeatedly, or the last client message is
  an unanswered question or unmet request.
- technical_failure: the client received the technical-error message ("souci technique") or a
  tool visibly crashed and blocked their request.

severity=severe when: explicit frustration or complaint, a client with a membership/paid booking
blocked from using it, repeated technical failures, or anything reception should see TODAY.
Otherwise normal. When unsure between two outcomes, pick the one that gets a human to look
(deadend over dropoff) only if there are real signs the client wanted more; otherwise dropoff.`;

/** Rend le transcript compact envoyé au classificateur (pur, testé). */
export function buildTranscript(turns: ReviewTurn[], maxChars = 6000): string {
  const lines = turns.map((t) => `${t.role}: ${t.content}`.slice(0, 500));
  let out = lines.join("\n");
  if (out.length > maxChars) out = out.slice(-maxChars);
  return out;
}

/** Valide/normalise la sortie du tool (pur, testé) — jamais de valeur inventée. */
export function parseVerdict(input: unknown): ReviewVerdict | null {
  const v = input as Record<string, unknown>;
  const outcome = String(v?.outcome ?? "");
  const category = String(v?.need_category ?? "");
  if (!(OUTCOMES as readonly string[]).includes(outcome)) return null;
  return {
    outcome: outcome as Outcome,
    need_category: (NEED_CATEGORIES as readonly string[]).includes(category)
      ? (category as ReviewVerdict["need_category"])
      : "other",
    severity: v?.severity === "severe" ? "severe" : "normal",
    summary: String(v?.summary ?? "").slice(0, 500),
    suggested_action: String(v?.suggested_action ?? "").slice(0, 500),
  };
}

export async function classifyConversation(turns: ReviewTurn[]): Promise<ReviewVerdict | null> {
  const response = await anthropic.messages.create({
    model: config.CLAUDE_MODEL,
    max_tokens: 500,
    output_config: { effort: "low" },
    system: REVIEW_SYSTEM,
    tools: [REVIEW_TOOL],
    tool_choice: { type: "tool", name: "report_outcome" },
    messages: [{ role: "user", content: buildTranscript(turns) }],
  });
  const call = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "report_outcome",
  );
  return call ? parseVerdict(call.input) : null;
}

// ---------- sélection & stockage ----------

export interface PendingReview {
  client_id: string;
  client_name: string | null;
  wa_phone: string;
  /** ::text pour garder les microsecondes — un Date JS tronque à la ms, et la
   *  review stockée « plus vieille » que le dernier message serait re-classée
   *  à chaque sweep, pour toujours (bug attrapé par l'E2E du 12/07). */
  last_message_at: string;
}

/**
 * Conversations à classifier : le dernier tour date de 45 min à 24 h, et il
 * est plus récent que la dernière review du client (une review par point de
 * conversation — si le client re-écrit après, un nouveau point se créera).
 */
export async function conversationsToReview(): Promise<PendingReview[]> {
  const res = await pool.query(
    `select c.id as client_id, c.name as client_name, c.wa_phone,
            max(conv.created_at)::text as last_message_at
       from clients c
       join conversations conv on conv.client_id = c.id
      group by c.id, c.name, c.wa_phone
     having max(conv.created_at) < now() - ($1 || ' minutes')::interval
        and max(conv.created_at) > now() - ($2 || ' hours')::interval
        and max(conv.created_at) > coalesce(
              (select max(r.last_message_at) from conversation_reviews r
                where r.client_id = c.id),
              'epoch'::timestamptz)
      order by max(conv.created_at) asc
      limit $3`,
    [String(REVIEW_AFTER_MINUTES), String(REVIEW_MAX_AGE_HOURS), MAX_REVIEWS_PER_SWEEP],
  );
  return res.rows;
}

/** Tours de la conversation, tool inclus (l'issue se lit dans les résultats). */
export async function reviewTurns(clientId: string, n = 30): Promise<ReviewTurn[]> {
  const res = await pool.query(
    `select role, content, created_at
       from (select role, content, created_at
               from conversations
              where client_id = $1
              order by created_at desc
              limit $2) t
      order by created_at asc`,
    [clientId, n],
  );
  return res.rows;
}

export async function saveReview(
  pending: PendingReview,
  verdict: ReviewVerdict,
): Promise<string | null> {
  // dropoff = choix libre du client → DONE d'office : jamais dans la file,
  // jamais notifié, statistiques seulement. Idem pour les issues saines.
  const actionable = ACTIONABLE_OUTCOMES.includes(verdict.outcome);
  const res = await pool.query(
    `insert into conversation_reviews
       (client_id, last_message_at, outcome, need_category, severity, summary,
        suggested_action, status, done_by)
     values ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8, $9)
     on conflict (client_id, last_message_at) do nothing
     returning id`,
    [
      pending.client_id,
      pending.last_message_at,
      verdict.outcome,
      verdict.need_category,
      verdict.severity,
      verdict.summary,
      verdict.suggested_action,
      actionable ? "OPEN" : "DONE",
      actionable ? null : "auto",
    ],
  );
  return res.rows[0]?.id ?? null;
}

// ---------- sweep ----------

/**
 * Tourne dans le sweeper 5 min (index.ts). Classifie chaque conversation
 * éligible ; cas grave non résolu → notification réception immédiate. Un
 * échec de classification laisse la conversation pour le prochain passage.
 */
export async function runReviewSweep(): Promise<number> {
  const pendings = await conversationsToReview();
  let reviewed = 0;
  for (const pending of pendings) {
    try {
      const turns = await reviewTurns(pending.client_id);
      if (turns.length === 0) continue;
      const verdict = await classifyConversation(turns);
      if (!verdict) continue;
      const id = await saveReview(pending, verdict);
      reviewed++;
      if (id && verdict.severity === "severe" && ACTIONABLE_OUTCOMES.includes(verdict.outcome)) {
        await pool.query(
          `update conversation_reviews set reception_notified_at = now() where id = $1`,
          [id],
        );
        notifyReception(
          "🔴 Conversation à reprendre — cas grave",
          `${pending.client_name ?? "?"} (+${pending.wa_phone.replace(/^\+/, "")}) est reparti(e) ` +
            `sans obtenir ce qu'il/elle voulait :\n  ${verdict.summary}\n\n` +
            `Action suggérée : ${verdict.suggested_action || "recontacter le client"}\n` +
            `Conversation : ${config.BASE_URL}/admin/conversations/${pending.client_id}\n` +
            `File complète : ${config.BASE_URL}/admin/reviews`,
        );
      }
    } catch (err) {
      console.error(`Review failed for client ${pending.client_id} (will retry):`, err);
    }
  }
  return reviewed;
}

// ---------- vues & actions du dashboard ----------

export interface AdminReview {
  id: string;
  client_id: string;
  client_name: string | null;
  wa_phone: string;
  outcome: Outcome;
  need_category: string;
  severity: string;
  summary: string | null;
  suggested_action: string | null;
  status: string;
  done_by: string | null;
  created_at: Date;
}

/** File « À reprendre » : impasses/échecs ouverts, cas graves en tête. */
export async function openReviews(): Promise<AdminReview[]> {
  const res = await pool.query(
    `select r.*, c.name as client_name, c.wa_phone
       from conversation_reviews r join clients c on c.id = r.client_id
      where r.status = 'OPEN'
      order by (r.severity = 'severe') desc, r.created_at asc`,
  );
  return res.rows;
}

/** Dernières classifications, toutes issues (transparence/contrôle qualité). */
export async function recentReviews(limit = 30): Promise<AdminReview[]> {
  const res = await pool.query(
    `select r.*, c.name as client_name, c.wa_phone
       from conversation_reviews r join clients c on c.id = r.client_id
      order by r.created_at desc limit $1`,
    [limit],
  );
  return res.rows;
}

/** Bouton « Traité » / « Ignorer » — renvoie false si déjà fermé. */
export async function closeReview(
  id: string,
  adminUser: string,
  ignored: boolean,
): Promise<boolean> {
  const res = await pool.query(
    `update conversation_reviews
        set status = 'DONE', done_by = $2, done_at = now()
      where id = $1 and status = 'OPEN'`,
    [id, ignored ? `ignored:${adminUser}` : adminUser],
  );
  return (res.rowCount ?? 0) > 0;
}

export interface ReviewStats {
  total: number;
  byOutcome: { outcome: string; n: number }[];
  topUnserved: { need_category: string; n: number }[];
}

/** Agrégats sur `days` jours — le taux de résolution et les besoins non servis. */
export async function reviewStats(days: number): Promise<ReviewStats> {
  const [byOutcome, topUnserved] = await Promise.all([
    pool
      .query(
        `select outcome, count(*)::int as n from conversation_reviews
          where created_at > now() - ($1 || ' days')::interval
          group by outcome order by n desc`,
        [String(days)],
      )
      .then((r) => r.rows),
    pool
      .query(
        `select need_category, count(*)::int as n from conversation_reviews
          where created_at > now() - ($1 || ' days')::interval
            and outcome in ('deadend','technical_failure')
          group by need_category order by n desc limit 5`,
        [String(days)],
      )
      .then((r) => r.rows),
  ]);
  return {
    total: byOutcome.reduce((n: number, o: any) => n + o.n, 0),
    byOutcome,
    topUnserved,
  };
}

/**
 * Part des conversations où le client n'est PAS reparti par notre faute
 * (resolved + handed_off + dropoff). null quand rien n'a été classé (pur, testé).
 */
export function satisfactionRate(byOutcome: { outcome: string; n: number }[]): number | null {
  const total = byOutcome.reduce((n, o) => n + o.n, 0);
  if (total === 0) return null;
  const good = byOutcome
    .filter((o) => ["resolved", "handed_off", "dropoff"].includes(o.outcome))
    .reduce((n, o) => n + o.n, 0);
  return Math.round((good / total) * 100);
}

// ---------- digest quotidien ----------

export const DIGEST_HOUR_DAKAR = 19;

/** true si le digest du jour n'est pas encore parti (garde en DB, atomique). */
export async function claimDailyDigest(today: string): Promise<boolean> {
  const res = await pool.query(
    `insert into app_state (key, value) values ('last_digest_date', $1)
     on conflict (key) do update set value = $1, updated_at = now()
       where app_state.value <> $1`,
    [today],
  );
  return (res.rowCount ?? 0) > 0;
}

export interface DigestData {
  openReviews: {
    client_name: string | null;
    wa_phone: string;
    client_id: string;
    outcome: string;
    severity: string;
    summary: string | null;
    suggested_action: string | null;
  }[];
  openHandoffs: { client_name: string | null; wa_phone: string; reason: string | null }[];
  today: { outcome: string; n: number }[];
  topUnserved7d: { need_category: string; n: number }[];
}

export async function collectDigestData(): Promise<DigestData> {
  const [openReviews, openHandoffs, today, topUnserved7d] = await Promise.all([
    pool
      .query(
        `select r.client_id, r.outcome, r.severity, r.summary, r.suggested_action,
                c.name as client_name, c.wa_phone
           from conversation_reviews r join clients c on c.id = r.client_id
          where r.status = 'OPEN'
          order by (r.severity = 'severe') desc, r.created_at asc
          limit 30`,
      )
      .then((r) => r.rows),
    pool
      .query(
        `select h.reason, c.name as client_name, c.wa_phone
           from handoffs h join clients c on c.id = h.client_id
          where h.status = 'OPEN'
          order by h.created_at asc limit 30`,
      )
      .then((r) => r.rows),
    pool
      .query(
        `select outcome, count(*)::int as n from conversation_reviews
          where created_at >= current_date group by outcome`,
      )
      .then((r) => r.rows),
    pool
      .query(
        `select need_category, count(*)::int as n from conversation_reviews
          where created_at > now() - interval '7 days'
            and outcome in ('deadend','technical_failure')
          group by need_category order by n desc limit 3`,
      )
      .then((r) => r.rows),
  ]);
  return { openReviews, openHandoffs, today, topUnserved7d };
}

const OUTCOME_LABELS: Record<string, string> = {
  resolved: "résolues",
  handed_off: "transmises à la réception",
  dropoff: "abandons libres",
  deadend: "impasses",
  technical_failure: "échecs techniques",
};

/** Corps texte du digest (pur, testé). */
export function buildDigestBody(data: DigestData): string {
  const lines: string[] = [];
  const total = data.today.reduce((n, o) => n + o.n, 0);
  const good = data.today
    .filter((o) => ["resolved", "handed_off", "dropoff"].includes(o.outcome))
    .reduce((n, o) => n + o.n, 0);

  lines.push(`Conversations du jour : ${total} classées.`);
  for (const o of data.today) {
    lines.push(`  - ${o.n} ${OUTCOME_LABELS[o.outcome] ?? o.outcome}`);
  }
  if (total > 0) {
    lines.push(
      `Taux « le client n'est pas reparti par notre faute » : ${Math.round((good / total) * 100)} %.`,
    );
  }

  lines.push("", `À REPRENDRE (${data.openReviews.length}) — clients repartis les mains vides :`);
  if (data.openReviews.length === 0) lines.push("  ✓ rien à reprendre.");
  for (const r of data.openReviews) {
    lines.push(
      `  ${r.severity === "severe" ? "🔴 " : "- "}${r.client_name ?? "?"} (+${r.wa_phone}) : ${r.summary ?? r.outcome}` +
        (r.suggested_action ? `\n    → ${r.suggested_action}` : ""),
    );
  }

  lines.push("", `HANDOFFS OUVERTS (${data.openHandoffs.length}) :`);
  if (data.openHandoffs.length === 0) lines.push("  ✓ tous traités.");
  for (const h of data.openHandoffs) {
    lines.push(`  - ${h.client_name ?? "?"} (+${h.wa_phone}) : ${h.reason ?? "?"}`);
  }

  if (data.topUnserved7d.length > 0) {
    lines.push("", "TOP BESOINS NON SERVIS (7 jours) — matière à améliorer Awa :");
    for (const t of data.topUnserved7d) {
      lines.push(`  - ${t.need_category} : ${t.n} conversation(s) perdue(s)`);
    }
  }

  lines.push("", `Tout marquer traité au fil de l'eau : ${config.BASE_URL}/admin/reviews`);
  return lines.join("\n");
}

/**
 * Envoie le digest une fois par jour après DIGEST_HOUR_DAKAR (Dakar = UTC).
 * Appelé à chaque passage du sweeper 5 min — la garde app_state rend l'envoi
 * unique même à travers les restarts.
 */
export async function maybeSendDailyDigest(): Promise<boolean> {
  const now = new Date();
  if (now.getUTCHours() < DIGEST_HOUR_DAKAR) return false;
  const today = now.toISOString().slice(0, 10);
  if (!(await claimDailyDigest(today))) return false;
  const data = await collectDigestData();
  notifyReception("📋 Récap du jour — conversations & suivis", buildDigestBody(data));
  return true;
}
