/**
 * PROBE §2 du plan AUTO-CANCEL-EMPTY-CLASSES-PLAN.md — annulation d'occurrence
 * via Calendar V3, sur le cours JETABLE créé par Babakar (Pilates Fusion,
 * samedi ~1:30). Go explicite de Babakar le 17/08/2026.
 *
 * Usage :
 *   npx tsx scripts/probe-cancel-event.ts            # phase A : lecture seule
 *   npx tsx scripts/probe-cancel-event.ts --cancel <eventId>   # phase B : mutation
 *
 * Garde-fous phase B : refuse si recurrenceType=MASTER, si participants > 0,
 * si le start ne tombe pas samedi, ou si l'eventId ne vient pas de la phase A.
 */
import "dotenv/config";

const WIX_API = "https://www.wixapis.com";

function headers(): Record<string, string> {
  const key = process.env.WIX_API_KEY;
  const site = process.env.WIX_SITE_ID;
  if (!key || !site) throw new Error("WIX_API_KEY / WIX_SITE_ID manquants dans .env");
  return {
    Authorization: key,
    "wix-site-id": site,
    "Content-Type": "application/json",
    // UA explicite : le UA undici par défaut est bloqué par Cloudflare (cf. wix.ts).
    "User-Agent": "resabot/1.0",
  };
}

async function wixPost(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${WIX_API}${path}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${text.slice(0, 800)}`);
  return text ? JSON.parse(text) : {};
}

async function wixGet(path: string): Promise<any> {
  const res = await fetch(`${WIX_API}${path}`, {
    method: "GET",
    headers: headers(),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${text.slice(0, 800)}`);
  return text ? JSON.parse(text) : {};
}

interface FoundSlot {
  serviceId: string;
  serviceName: string;
  sessionId: string;
  eventId: string | null;
  start: string;
  end: string;
  openSpots: number;
  totalSpots: number;
  coach: string | null;
  /** Slot brut Wix — requis par Create Booking (bookedEntity.slot). */
  raw: unknown;
}

async function findThrowawaySlots(): Promise<FoundSlot[]> {
  // Services actifs dont le nom évoque le cours jetable.
  const data = await wixPost("/bookings/v2/services/query", {
    query: { paging: { limit: 100 } },
  });
  const services: any[] = data?.services ?? [];
  const candidates = services.filter((s) =>
    String(s?.name ?? "").toLowerCase().includes("fusion"),
  );
  console.log(
    "Services trouvés :",
    services.map((s) => `${s.name} [${s.id}] hidden=${s.hidden ?? "?"}`).join(" | "),
  );
  console.log(
    "Candidats 'fusion' :",
    candidates.map((s) => `${s.name} [${s.id}]`).join(" | ") || "AUCUN",
  );
  if (candidates.length === 0) return [];

  // Samedi 22/08/2026, journée entière (Dakar = UTC).
  const from = "2026-08-22T00:00:00Z";
  const to = "2026-08-23T00:00:00Z";
  const avail = await wixPost("/availability-calendar/v1/availability/query", {
    query: {
      filter: { serviceId: candidates.map((s) => s.id), startDate: from, endDate: to },
    },
  });
  const entries: any[] = avail?.availabilityEntries ?? [];
  return entries
    .filter((e) => e?.slot?.sessionId)
    .map((e) => ({
      serviceId: String(e.slot.serviceId ?? ""),
      serviceName:
        candidates.find((s) => s.id === e.slot.serviceId)?.name ?? "(service ?)",
      sessionId: String(e.slot.sessionId),
      eventId:
        typeof e.slot.eventId === "string" && e.slot.eventId.trim()
          ? e.slot.eventId.trim()
          : null,
      start: String(e.slot.startDate ?? ""),
      end: String(e.slot.endDate ?? ""),
      openSpots: Number(e.openSpots ?? 0),
      totalSpots: Number(e.totalSpots ?? e.slot?.totalSpots ?? e.slot?.capacity ?? 0),
      coach: typeof e.slot.resource?.name === "string" ? e.slot.resource.name : null,
      raw: e.slot,
    }));
}

async function getEvent(eventId: string): Promise<any> {
  const data = await wixGet(
    `/calendar/v3/events/${encodeURIComponent(eventId)}?timeZone=Africa%2FDakar`,
  );
  return data?.event ?? data;
}

function describeEvent(ev: any): void {
  console.log("  event.id            =", ev?.id);
  console.log("  status              =", ev?.status);
  console.log("  recurrenceType      =", ev?.recurrenceType);
  console.log("  recurringEventId    =", ev?.recurringEventId ?? "(aucun)");
  console.log("  title               =", ev?.title);
  console.log("  start               =", JSON.stringify(ev?.start));
  console.log("  totalCapacity       =", ev?.totalCapacity);
  console.log("  remainingCapacity   =", ev?.remainingCapacity);
  console.log("  participants        =", JSON.stringify(ev?.totalNumberOfParticipants ?? ev?.participants ?? null));
}

async function main(): Promise<void> {
  const cancelIdx = process.argv.indexOf("--cancel");
  const targetEventId = cancelIdx >= 0 ? process.argv[cancelIdx + 1] : null;

  const slots = await findThrowawaySlots();
  if (slots.length === 0) {
    console.log("Aucun créneau 'fusion' trouvé samedi 22/08 — vérifier le nom/la date du cours jetable.");
    return;
  }
  for (const s of slots) {
    console.log("\n--- Créneau disponibilité ---");
    console.log("  service     =", s.serviceName, `[${s.serviceId}]`);
    console.log("  start→end   =", s.start, "→", s.end);
    console.log("  openSpots   =", s.openSpots, "/ totalSpots =", s.totalSpots);
    console.log("  coach       =", s.coach ?? "(aucun)");
    console.log("  sessionId   =", s.sessionId.length, "chars :", s.sessionId.slice(0, 60) + "…");
    console.log("  slot.eventId=", s.eventId ?? "ABSENT");
    if (s.eventId) {
      console.log("  → événement Calendar V3 :");
      try {
        describeEvent(await getEvent(s.eventId));
      } catch (err) {
        console.log("  GET event ÉCHEC :", (err as Error).message);
      }
    }
  }

  if (!targetEventId) {
    console.log("\nPhase A (lecture seule) terminée. Pour annuler : --cancel <eventId>");
    return;
  }

  // ---------- Phase B : mutation, garde-fous d'abord ----------
  const slot = slots.find((s) => s.eventId === targetEventId);
  if (!slot) throw new Error(`--cancel ${targetEventId} ne correspond à aucun créneau listé en phase A — refus.`);
  const ev = await getEvent(targetEventId);
  if (ev?.recurrenceType === "MASTER") throw new Error("recurrenceType=MASTER — refus (jamais la série).");
  if (ev?.status !== "CONFIRMED") throw new Error(`status=${ev?.status} — refus (attendu CONFIRMED).`);
  const cap = Number(ev?.totalCapacity ?? NaN);
  const rem = Number(ev?.remainingCapacity ?? NaN);
  if (!Number.isInteger(cap) || !Number.isInteger(rem)) throw new Error("capacité invalide — refus (fail-closed).");
  if (cap - rem !== 0) throw new Error(`${cap - rem} participant(s) — refus.`);
  const day = new Date(slot.start).getUTCDay();
  if (day !== 6) throw new Error(`start ${slot.start} n'est pas un samedi — refus.`);

  console.log("\n=== PHASE B : annulation de", targetEventId, "===");
  const res = await wixPost(
    `/calendar/v3/events/${encodeURIComponent(targetEventId)}/cancel`,
    { participantNotification: { notifyParticipants: false } },
  );
  console.log("Réponse cancel :", JSON.stringify(res).slice(0, 500));

  console.log("\n→ Re-fetch de l'événement :");
  describeEvent(await getEvent(targetEventId));

  console.log("\n→ Re-query disponibilité du même samedi :");
  const after = await findThrowawaySlots();
  const still = after.find((s) => s.eventId === targetEventId || s.sessionId === slot.sessionId);
  console.log(still ? "  ENCORE PRÉSENT dans la disponibilité (!)" : "  Disparu de la disponibilité ✓");

  // Point 3 du probe : une création de réservation sur le slot annulé (le slot
  // brut capturé AVANT l'annulation, comme dans la course résiduelle §9 du
  // plan) doit être refusée par Wix. Si elle passe malgré tout, on la decline
  // aussitôt (statut CREATED — pas encore visible au calendrier).
  console.log("\n→ Tentative Create Booking sur le slot annulé (échec attendu) :");
  try {
    const data = await wixPost("/bookings/v2/bookings", {
      booking: {
        bookedEntity: { slot: slot.raw },
        contactDetails: { firstName: "TEST", lastName: "PROBE — ignorer", phone: "+221789536676" },
        selectedPaymentOption: "OFFLINE",
        numberOfParticipants: 1,
      },
    });
    const bookingId = data?.booking?.id;
    console.log("  ⚠️ RÉSERVATION ACCEPTÉE malgré l'annulation — booking", bookingId);
    if (bookingId) {
      await wixPost(`/_api/bookings-service/v2/bookings/${bookingId}/decline`, { revision: "1" });
      console.log("  → booking decliné (rollback) ✓");
    }
  } catch (err) {
    console.log("  Refusée par Wix ✓ —", (err as Error).message.slice(0, 300));
  }
}

main().catch((err) => {
  console.error("PROBE ÉCHEC :", err instanceof Error ? err.message : err);
  process.exit(1);
});
