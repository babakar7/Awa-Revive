import { describe, expect, it } from "vitest";
import {
  lintOutboundReply,
  canToolResultApprovePaymentUrl,
  correctiveLintInstruction,
  extractUrls,
  isPaymentUrl,
  normalizeUrl,
} from "../src/agent/outboundLint.js";

const WAVE = "https://pay.wave.com/c/cos-26b60x0eg149a?a=12000&c=XOF";
const OM = "https://sugu.orange-sonatel.com/mp/dmeqhrdd3D_ojFf3zu4T";
const FAKE = "https://pay.wave.com/c/cos-xxbebe1";
const MAPS = "https://maps.app.goo.gl/jJS8rS3sV5j41SGc9";

describe("payment-link tool allowlist", () => {
  it("trusts refreshed plan links and add-spots links", () => {
    expect(canToolResultApprovePaymentUrl("refresh_expired_plan_payment_link")).toBe(true);
    expect(canToolResultApprovePaymentUrl("add_spots_to_booking")).toBe(true);
  });

  it("keeps unrelated and lookalike tools outside the trust boundary", () => {
    expect(canToolResultApprovePaymentUrl("list_plans")).toBe(false);
    expect(canToolResultApprovePaymentUrl("refresh_expired_payment_link")).toBe(false);
  });
});

describe("lintOutboundReply", () => {
  it("passes a reply with a server-issued Wave link", () => {
    const r = `Voici ton lien 👇\n${WAVE}\nValable 20 minutes`;
    expect(lintOutboundReply(r, [WAVE]).ok).toBe(true);
  });

  it("passes when the link is an active DB record re-mentioned", () => {
    expect(lintOutboundReply(`Ton lien plus haut : ${OM}`, [OM]).ok).toBe(true);
  });

  it("blocks a fabricated Wave link not in the allowlist", () => {
    const res = lintOutboundReply(`Voici ton lien Wave 👇\n${FAKE}`, [WAVE]);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("unapproved_payment_url");
  });

  it("blocks a payment link when the allowlist is empty", () => {
    const res = lintOutboundReply(`Ton lien : ${FAKE}`, []);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("unapproved_payment_url");
  });

  it("blocks an active-link claim when no live server order exists", () => {
    const res = lintOutboundReply("Ton lien de paiement est encore valide.", []);
    expect(res).toMatchObject({ ok: false, reason: "unbacked_active_link_claim" });
  });

  it("blocks an Orange Money link not issued this turn", () => {
    expect(lintOutboundReply(`Paie ici ${OM}`, [WAVE]).ok).toBe(false);
  });

  it("blocks imitated tool-call trace syntax with a fabricated link", () => {
    const r = `[outil] create_payment_link({}) -> {"payment_link":"${FAKE}"}\n\nVoici ton lien 👇`;
    const res = lintOutboundReply(r, [FAKE]);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("tool_syntax");
  });

  it("blocks the internal ⟦trace⟧ marker if copied into a reply", () => {
    expect(lintOutboundReply("⟦trace⟧ list_classes({}) -> [...]", []).ok).toBe(false);
  });

  it("blocks a bare tool call written as prose", () => {
    expect(lintOutboundReply("Je fais create_plan_payment_link(plan) pour toi", []).ok).toBe(false);
  });

  it("ignores non-payment URLs like the maps link", () => {
    expect(lintOutboundReply(`On est ici : ${MAPS}`, []).ok).toBe(true);
  });

  it("passes a valid link even when a fabricated one is absent (only real link present)", () => {
    expect(lintOutboundReply(`Ton lien : ${WAVE}`, [WAVE, OM]).ok).toBe(true);
  });

  it("tolerates trailing punctuation on the URL", () => {
    expect(lintOutboundReply(`Paie ici : ${WAVE}.`, [WAVE]).ok).toBe(true);
  });
});

describe("url helpers", () => {
  it("normalizes trailing punctuation", () => {
    expect(normalizeUrl(`${WAVE}.`)).toBe(WAVE);
    expect(normalizeUrl(`${WAVE})`)).toBe(WAVE);
  });
  it("extracts multiple urls", () => {
    expect(extractUrls(`a ${WAVE} b ${MAPS} c`)).toEqual([WAVE, MAPS]);
  });
  it("classifies payment vs non-payment hosts", () => {
    expect(isPaymentUrl(WAVE)).toBe(true);
    expect(isPaymentUrl(OM)).toBe(true);
    expect(isPaymentUrl(MAPS)).toBe(false);
  });
});

describe("leaked NO_REPLY sentinel (last-gate safety net)", () => {
  it("blocks a reply that still carries the raw control token", () => {
    const r = lintOutboundReply("<NO_REPLY>\n\nPour répondre à ta question : oui !", []);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("leaked_sentinel");
  });
  it("passes a normal reply with no sentinel", () => {
    expect(lintOutboundReply("Oui, il y a bien la natation !", []).ok).toBe(true);
  });
});

describe("correctiveLintInstruction", () => {
  it("lists approved urls when present", () => {
    const note = correctiveLintInstruction([WAVE]);
    expect(note).toContain(WAVE);
    expect(note).toContain("server-approved");
  });
  it("forbids claiming a link when none is approved", () => {
    const note = correctiveLintInstruction([]);
    expect(note).toContain("NO server-issued payment link");
    expect(note).not.toContain("http");
  });
});

// --- Slot-time guard (prod 11/08: client accepted 11h15, paid for 10h15) ---

import {
  createSlotTimeGuard,
  absorbSlotTimeFacts,
  findSlotTimeMismatch,
  extractTimeTokens,
  extractDateTokens,
} from "../src/agent/outboundLint.js";

const PAYMENT_LINK_RESULT = JSON.stringify({
  payment_link: OM,
  amount_fcfa: 12000,
  class: "Pilates Reformer (Sculpt)",
  slot_start: "2026-08-15T10:15:00.000Z",
  slot_start_dakar: "samedi 15 août à 10:15",
  note: "…",
});

function guardFrom(toolName: string, result: string) {
  const guard = createSlotTimeGuard();
  absorbSlotTimeFacts(guard, toolName, result);
  return guard;
}

describe("extractTimeTokens", () => {
  it("reads 11h15, 11:15, 11 h 15 and 12-hour clocks", () => {
    expect(extractTimeTokens("à 11h15 ou 12:30, at 1:15 pm, 11 h 15")).toEqual([
      "11:15",
      "12:30",
      "13:15",
      "11:15",
    ]);
  });
  it("ignores durations, amounts and cancellation windows", () => {
    expect(
      extractTimeTokens(
        "12 000 F, valable 20 minutes, annulation jusqu'à 16h avant, 16h00 avant le cours, 24h00 chrono, 12.000 F",
      ),
    ).toEqual([]);
  });
});

describe("extractDateTokens", () => {
  it("reads French and English day-month forms", () => {
    expect(extractDateTokens("samedi 15 août puis August 16 et le 1er août")).toEqual([
      "15-7",
      "16-7",
      "1-7",
    ]);
  });
});

describe("slot-time guard", () => {
  it("activates on a successful create_payment_link and vouches its Dakar slot", () => {
    const guard = guardFrom("create_payment_link", PAYMENT_LINK_RESULT);
    expect(guard.active).toBe(true);
    expect(guard.times.has("10:15")).toBe(true);
    expect(guard.dates.has("15-7")).toBe(true);
    expect(guard.facts).toEqual(["samedi 15 août à 10:15"]);
  });

  it("stays inert on error results and non-locking tools", () => {
    const err = guardFrom(
      "create_payment_link",
      JSON.stringify({ error: "not_enough_spots", alternatives: [{ start_dakar: "lundi 10 août à 12:30" }] }),
    );
    expect(err.active).toBe(false);
    expect(err.times.size).toBe(0);
    const avail = guardFrom(
      "check_availability",
      JSON.stringify({ slots: [{ start_dakar: "samedi 15 août à 11:15" }] }),
    );
    expect(avail.active).toBe(false);
  });

  it("blocks the exact prod incident: reply says 11h15, server booked 10:15", () => {
    const guard = guardFrom("create_payment_link", PAYMENT_LINK_RESULT);
    const reply = `Voici ton lien Max It pour la séance Sculpt du samedi 15 août à 11h15 : 12 000 F 👉 ${OM}`;
    const res = lintOutboundReply(reply, [OM], guard);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("slot_time_mismatch");
    expect(res.detail).toContain("11h15");
  });

  it("passes the same reply when it states the real booked time", () => {
    const guard = guardFrom("create_payment_link", PAYMENT_LINK_RESULT);
    const reply = `Voici ton lien Max It pour la séance Sculpt du samedi 15 août à 10:15 : 12 000 F, valable 20 minutes 👉 ${OM}`;
    expect(lintOutboundReply(reply, [OM], guard).ok).toBe(true);
  });

  it("blocks a wrong date even when the time is right", () => {
    const guard = guardFrom("create_payment_link", PAYMENT_LINK_RESULT);
    const res = lintOutboundReply(`Sculpt dimanche 16 août à 10h15 👉 ${OM}`, [OM], guard);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("slot_time_mismatch");
    expect(res.detail).toBe("date:16-7");
  });

  it("does not flag the 16h cancellation-window rule in a booking confirmation", () => {
    const guard = guardFrom(
      "book_with_membership",
      JSON.stringify({ booked: true, slot_start_dakar: "samedi 15 août à 10:15" }),
    );
    const reply =
      "C'est réservé ! Sculpt samedi 15 août à 10:15 ✅ Annulation gratuite jusqu'à 16h avant le cours.";
    expect(lintOutboundReply(reply, [], guard).ok).toBe(true);
  });

  it("allows both old and new times after a reschedule", () => {
    const guard = guardFrom(
      "reschedule_booking",
      JSON.stringify({
        rescheduled: true,
        old_slot_start_dakar: "lundi 10 août à 10:15",
        new_slot_start_dakar: "mardi 11 août à 12:30",
      }),
    );
    const ok = "C'est déplacé du lundi 10 août 10h15 au mardi 11 août 12h30 ✅";
    expect(lintOutboundReply(ok, [], guard).ok).toBe(true);
    const wrong = "C'est déplacé au mardi 11 août à 18h15 ✅";
    expect(lintOutboundReply(wrong, [], guard).ok).toBe(false);
  });

  it("lets get_my_bookings vouch extra times without activating the guard alone", () => {
    const guard = createSlotTimeGuard();
    absorbSlotTimeFacts(
      guard,
      "get_my_bookings",
      JSON.stringify({ bookings: [{ slot_start_dakar: "jeudi 13 août à 18:15" }] }),
    );
    expect(guard.active).toBe(false);
    expect(findSlotTimeMismatch("Ton cours est jeudi 13 août à 18h15", guard)).toBeNull();
    absorbSlotTimeFacts(guard, "reschedule_booking", JSON.stringify({
      rescheduled: true,
      old_slot_start_dakar: "jeudi 13 août à 18:15",
      new_slot_start_dakar: "vendredi 14 août à 10:15",
    }));
    expect(guard.active).toBe(true);
    expect(
      lintOutboundReply("Déplacé de jeudi 13 août 18h15 à vendredi 14 août 10h15 ✅", [], guard).ok,
    ).toBe(true);
  });

  it("skips the check entirely when no locking tool ran", () => {
    const guard = createSlotTimeGuard();
    expect(lintOutboundReply("On se voit à 11h15 !", [], guard).ok).toBe(true);
  });
});

describe("correctiveLintInstruction with slot facts", () => {
  it("names the exact server-booked slot", () => {
    const guard = guardFrom("create_payment_link", PAYMENT_LINK_RESULT);
    const note = correctiveLintInstruction([OM], guard);
    expect(note).toContain("samedi 15 août à 10:15");
    expect(note).toContain(OM);
  });
  it("omits slot copy when the guard never activated", () => {
    const note = correctiveLintInstruction([], createSlotTimeGuard());
    expect(note).not.toContain("Dakar");
  });
});
