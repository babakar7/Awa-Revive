import type { FastifyBaseLogger } from "fastify";
import { config } from "../config.js";
import { pool } from "../db/index.js";
import {
  listServices,
  listStaffResources,
  queryAvailabilityMulti,
  type WixService,
  type WixSlot,
  type WixStaffResource,
} from "../lib/wix.js";
import { sendImage, sendText } from "../lib/whatsapp.js";
import { renderStoryImage, type StoryClass, type StoryData, type StorySlot } from "../lib/storyImage.js";

/**
 * Story Instagram quotidienne — orchestration.
 *
 * Chaque soir (STORY_HOUR, heure de Dakar), Awa récupère les cours du lendemain
 * depuis Wix, génère l'image (src/lib/storyImage.ts) et l'envoie sur WhatsApp au
 * numéro du gérant (STORY_PHONE) qui la poste manuellement en story. Aucune
 * publication Instagram automatique (hors périmètre).
 *
 * Pipeline 100% déterministe : le modèle n'intervient jamais. Dakar == UTC toute
 * l'année, donc le calcul de "demain" et des heures se fait en UTC.
 */

const STORY_STATE_KEY = "last_story_date";
const STORY_CUTOFF_HOUR = 22; // au-delà, on n'envoie plus (une panne ne doit pas partir près de minuit)

const WEEKDAYS_FR_UPPER = [
  "DIMANCHE",
  "LUNDI",
  "MARDI",
  "MERCREDI",
  "JEUDI",
  "VENDREDI",
  "SAMEDI",
] as const;

const MONTHS_FR = [
  "janvier",
  "février",
  "mars",
  "avril",
  "mai",
  "juin",
  "juillet",
  "août",
  "septembre",
  "octobre",
  "novembre",
  "décembre",
] as const;

export interface TomorrowWindow {
  dateISO: string; // "2026-07-21"
  fromISO: string; // début de journée (UTC == Dakar)
  toISO: string; // fin de journée
}

/** Fenêtre de demain (bornes UTC de la journée). Pur. Dakar == UTC. */
export function tomorrowWindow(now: Date): TomorrowWindow {
  const t = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const dateISO = t.toISOString().slice(0, 10);
  return {
    dateISO,
    fromISO: `${dateISO}T00:00:00.000Z`,
    toISO: `${dateISO}T23:59:59.999Z`,
  };
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** "MARDI" — jour de la semaine en majuscules pour un YYYY-MM-DD (UTC). */
export function dayLabelFor(dateISO: string): string {
  return WEEKDAYS_FR_UPPER[new Date(`${dateISO}T12:00:00.000Z`).getUTCDay()];
}

/** "21 juillet" — pour l'en-tête de l'image. */
export function dateLabelFor(dateISO: string): string {
  const d = new Date(`${dateISO}T12:00:00.000Z`);
  return `${d.getUTCDate()} ${MONTHS_FR[d.getUTCMonth()]}`;
}

/** Légende WhatsApp courte : "Story de demain — mardi 21/07". */
export function storyCaption(dateISO: string): string {
  const d = new Date(`${dateISO}T12:00:00.000Z`);
  const weekday = WEEKDAYS_FR_UPPER[d.getUTCDay()].toLowerCase();
  return `Story de demain — ${weekday} ${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}`;
}

/** Fenêtre d'envoi ouverte : startHour ≤ heure < 22h (Dakar == UTC). Pur. */
export function storyWindowOpen(now: Date, startHour = 18, cutoffHour = STORY_CUTOFF_HOUR): boolean {
  const h = now.getUTCHours();
  return h >= startHour && h < cutoffHour;
}

/** Coach majoritaire d'un cours (égalité → premier vu). null si aucun. */
function pickCoach(votes: Map<string, number>): string | null {
  let best: string | null = null;
  let bestN = 0;
  for (const [name, n] of votes) {
    if (n > bestN) {
      best = name;
      bestN = n;
    }
  }
  return best;
}

/**
 * Projette les créneaux Wix de demain en `StoryData` (regroupés par cours). Pur
 * et testable. Filtre les services APPOINTMENT (garde les types inconnus, comme
 * la sweep de notifications) ; résout le coach par `slot.coach` sinon par
 * `coachId` via l'annuaire staff. Jamais de nom de cours en dur.
 */
export function buildStoryData(
  slots: WixSlot[],
  services: WixService[],
  staff: WixStaffResource[],
  now: Date,
): StoryData {
  const win = tomorrowWindow(now);
  const svcById = new Map(services.map((s) => [s.id, s]));
  const staffById = new Map(staff.map((r) => [r.id, r.name]));

  interface Group {
    name: string;
    coachVotes: Map<string, number>;
    slots: Array<StorySlot & { ms: number }>;
    earliest: number;
  }
  const groups = new Map<string, Group>();

  for (const slot of slots) {
    const svc = svcById.get(slot.serviceId);
    if (!svc) continue;
    // Seul un APPOINTMENT explicite est exclu ; un type inconnu reste un cours
    // de groupe (pour ne pas tout masquer sur un changement de schéma Wix).
    if (svc.type === "APPOINTMENT") continue;
    const d = new Date(slot.startDate);
    if (Number.isNaN(d.getTime())) continue;

    let g = groups.get(slot.serviceId);
    if (!g) {
      g = { name: svc.name, coachVotes: new Map(), slots: [], earliest: Infinity };
      groups.set(slot.serviceId, g);
    }
    g.slots.push({
      time: `${pad(d.getUTCHours())}H${pad(d.getUTCMinutes())}`,
      openSpots: slot.openSpots,
      totalSpots: slot.totalSpots,
      ms: d.getTime(),
    });
    g.earliest = Math.min(g.earliest, d.getTime());

    const coachName = slot.coach ?? (slot.coachId ? staffById.get(slot.coachId) ?? null : null);
    if (coachName) g.coachVotes.set(coachName, (g.coachVotes.get(coachName) ?? 0) + 1);
  }

  const classes: StoryClass[] = [...groups.values()]
    .sort((a, b) => a.earliest - b.earliest)
    .map((g) => ({
      name: g.name,
      coach: pickCoach(g.coachVotes),
      slots: g.slots
        .sort((a, b) => a.ms - b.ms)
        .map(({ ms: _ms, ...s }) => s),
    }));

  return { dayLabel: dayLabelFor(win.dateISO), dateLabel: dateLabelFor(win.dateISO), classes };
}

/** Récupère + met en forme les cours de demain (I/O Wix). */
export async function fetchTomorrowStory(now: Date = new Date()): Promise<StoryData> {
  const win = tomorrowWindow(now);
  const [services, staff] = await Promise.all([listServices(), listStaffResources()]);
  const classIds = services.filter((s) => s.type !== "APPOINTMENT").map((s) => s.id);
  const slots = await queryAvailabilityMulti(classIds, win.fromISO, win.toISO);
  return buildStoryData(slots, services, staff, now);
}

// ---------- garde app_state (une story par jour, atomique) ----------

/**
 * Réserve l'envoi du jour de façon atomique et renvoie la valeur précédente pour
 * pouvoir annuler la réservation en cas d'échec d'envoi (permettant un retry au
 * prochain passage). `claimed=false` → déjà envoyée aujourd'hui.
 */
async function claimDailyStory(today: string): Promise<{ claimed: boolean; previous: string | null }> {
  const before = await pool.query<{ value: string }>(
    `select value from app_state where key = $1`,
    [STORY_STATE_KEY],
  );
  const previous = before.rows[0]?.value ?? null;
  const res = await pool.query(
    `insert into app_state (key, value) values ($1, $2)
     on conflict (key) do update set value = $2, updated_at = now()
       where app_state.value <> $2`,
    [STORY_STATE_KEY, today],
  );
  return { claimed: (res.rowCount ?? 0) > 0, previous };
}

/** Annule la réservation du jour (retour à la valeur précédente, ou suppression). */
async function rollbackDailyStory(today: string, previous: string | null): Promise<void> {
  if (previous === null) {
    await pool.query(`delete from app_state where key = $1 and value = $2`, [STORY_STATE_KEY, today]);
  } else {
    await pool.query(
      `update app_state set value = $1, updated_at = now() where key = $2 and value = $3`,
      [previous, STORY_STATE_KEY, today],
    );
  }
}

/** Marque la story du jour comme envoyée (inconditionnel — envoi manuel admin). */
export async function markStorySent(today: string): Promise<void> {
  await pool.query(
    `insert into app_state (key, value) values ($1, $2)
     on conflict (key) do update set value = $2, updated_at = now()`,
    [STORY_STATE_KEY, today],
  );
}

/** Date (YYYY-MM-DD) de la dernière story envoyée, ou null. */
export async function getLastStoryDate(): Promise<string | null> {
  const r = await pool.query<{ value: string }>(`select value from app_state where key = $1`, [
    STORY_STATE_KEY,
  ]);
  return r.rows[0]?.value ?? null;
}

// ---------- orchestration ----------

/**
 * Appelée à chaque passage du sweeper 5 min. Envoie la story une fois par jour
 * dans la fenêtre du soir. En cas d'échec après réservation, annule la
 * réservation et relance l'erreur → le prochain passage réessaie (jusqu'à 22h).
 */
export async function maybeSendDailyStory(log: FastifyBaseLogger): Promise<boolean> {
  const now = new Date();
  if (!storyWindowOpen(now, config.STORY_HOUR)) return false;
  if (!config.STORY_PHONE) return false;

  const today = now.toISOString().slice(0, 10);
  const { claimed, previous } = await claimDailyStory(today);
  if (!claimed) return false;

  try {
    const data = await fetchTomorrowStory(now);
    const { dateISO } = tomorrowWindow(now);
    if (data.classes.length === 0) {
      // Le gérant doit savoir que le job a tourné (silence = indistinguable d'une
      // panne) ; il peut poster une story "repos" à la main s'il le souhaite.
      await sendText(
        config.STORY_PHONE,
        `Pas de cours demain (${storyCaption(dateISO).replace("Story de demain — ", "")}) — pas de story générée.`,
      );
      log.info("Daily story: no classes tomorrow, sent text notice");
      return true;
    }
    const png = renderStoryImage(data);
    await sendImage(config.STORY_PHONE, png, storyCaption(dateISO));
    return true;
  } catch (err) {
    await rollbackDailyStory(today, previous).catch((rbErr) =>
      log.error({ err: rbErr }, "Daily story: claim rollback failed"),
    );
    throw err;
  }
}
