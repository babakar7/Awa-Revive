import { describe, expect, it } from "vitest";
import {
  ACTIONABLE_OUTCOMES,
  buildDigestBody,
  buildTranscript,
  normalizeVerdictForTranscript,
  parseVerdict,
  satisfactionRate,
  type DigestData,
} from "../src/domain/conversationReview.js";

describe("satisfactionRate", () => {
  it("counts resolved + handed_off + dropoff as served, rounds to a percent", () => {
    expect(
      satisfactionRate([
        { outcome: "resolved", n: 6 },
        { outcome: "dropoff", n: 2 },
        { outcome: "handed_off", n: 1 },
        { outcome: "deadend", n: 1 },
      ]),
    ).toBe(90);
  });

  it("null when nothing was classified (never fake a 100%)", () => {
    expect(satisfactionRate([])).toBeNull();
  });
});

describe("buildTranscript", () => {
  const turn = (role: string, content: string) => ({ role, content, created_at: new Date() });

  it("renders role-prefixed lines, tool turns included", () => {
    const out = buildTranscript([
      turn("user", "je veux réserver"),
      turn("tool", 'check_availability({}) -> {"slots":[]}'),
      turn("assistant", "voici les créneaux"),
    ]);
    expect(out).toBe(
      'user: je veux réserver\ntool: check_availability({}) -> {"slots":[]}\nassistant: voici les créneaux',
    );
  });

  it("labels team replies separately from Awa", () => {
    const out = buildTranscript([
      { role: "assistant", source: "admin", content: "Je prends le relais", created_at: new Date() },
    ]);
    expect(out).toBe("human_team: Je prends le relais");
  });

  it("caps each line and keeps the END of long conversations (the outcome lives there)", () => {
    const turns = [
      turn("user", "x".repeat(2000)),
      ...Array.from({ length: 50 }, (_, i) => turn("user", `message ${i}`)),
      turn("assistant", "LA FIN"),
    ];
    const out = buildTranscript(turns, 1000);
    expect(out.length).toBeLessThanOrEqual(1000);
    expect(out).toContain("LA FIN");
    expect(out).not.toContain("x".repeat(600)); // first line truncated to 500 then sliced away
  });

  it("never splits an emoji surrogate pair while truncating", () => {
    const out = buildTranscript([turn("user", "x".repeat(498) + "😊")], 500);
    expect(() => JSON.stringify(out)).not.toThrow();
    expect(out).not.toMatch(/[\uD800-\uDBFF]$/);
  });
});

describe("normalizeVerdictForTranscript", () => {
  it("keeps a client silence after Awa's question out of the follow-up queue", () => {
    const turn = (role: string, content: string) => ({ role, content, created_at: new Date() });
    const verdict = normalizeVerdictForTranscript(
      { outcome: "deadend", need_category: "booking", severity: "normal", summary: "x", suggested_action: "relancer" },
      [turn("user", "Je veux réserver"), turn("assistant", "Quel jour te conviendrait ?")],
    );
    expect(verdict).toMatchObject({ outcome: "dropoff", suggested_action: "" });
  });

  it("treats silence after an imperative prompt with no '?' as a dropoff (Bery case 07/08)", () => {
    const turn = (role: string, content: string) => ({ role, content, created_at: new Date() });
    const verdict = normalizeVerdictForTranscript(
      { outcome: "deadend", need_category: "booking", severity: "normal", summary: "x", suggested_action: "relancer" },
      [
        turn("user", "Je veux réserver la Clé Invité"),
        turn("assistant", "Tu es bien éligible 😊 Dis-moi quel jour ou moment te conviendrait le mieux !"),
      ],
    );
    expect(verdict).toMatchObject({ outcome: "dropoff", suggested_action: "" });
  });

  it("ignores a WhatsApp reaction after Awa's qualification question (Assane case 11/08)", () => {
    const turn = (role: string, content: string) => ({ role, content, created_at: new Date() });
    const verdict = normalizeVerdictForTranscript(
      {
        outcome: "deadend",
        need_category: "membership",
        severity: "normal",
        summary: "La cliente a seulement réagi avec un émoji.",
        suggested_action: "La recontacter.",
      },
      [
        turn("user", "Je suis intéressée par la Clé 3 séances"),
        turn("assistant", "As-tu déjà pratiqué le Pilates Reformer chez Revive ?"),
        turn("user", "[réaction 😢]"),
      ],
    );
    expect(verdict).toMatchObject({ outcome: "dropoff", suggested_action: "" });
  });

  it("never creates a follow-up after a successful sexual-content disengagement (mba826094)", () => {
    const turn = (role: string, content: string) => ({ role, content, created_at: new Date() });
    const verdict = normalizeVerdictForTranscript(
      {
        outcome: "deadend",
        need_category: "booking",
        severity: "severe",
        summary: "La réservation n'a pas été finalisée.",
        suggested_action: "Recontacter le client.",
      },
      [
        turn("assistant", "Quel jour te conviendrait pour ta première séance ?"),
        turn("user", "[sticker reçu : contenu à caractère intime/sexuel]"),
        turn(
          "tool",
          'disengage_conversation({"category":"sexual"}) -> {"disengaged":true,"note":"stop"}',
        ),
        turn("assistant", "Je reste uniquement sur le studio et les réservations. Belle journée."),
        turn("user", "[sticker reçu : Main rose faisant le signe cœur]"),
      ],
    );
    expect(verdict).toMatchObject({
      outcome: "dropoff",
      severity: "normal",
      suggested_action: "",
    });
  });

  it("reviews a real new request normally after an older disengagement", () => {
    const turn = (role: string, content: string) => ({ role, content, created_at: new Date() });
    const original = {
      outcome: "deadend" as const,
      need_category: "booking" as const,
      severity: "normal" as const,
      summary: "Le nouveau message est resté sans réponse.",
      suggested_action: "Répondre au client.",
    };
    const verdict = normalizeVerdictForTranscript(original, [
      turn(
        "tool",
        'disengage_conversation({"category":"sexual"}) -> {"disengaged":true}',
      ),
      turn("assistant", "Je reste uniquement sur les réservations."),
      turn("user", "Bonjour, est-ce qu'il reste une place samedi ?"),
    ]);
    expect(verdict).toEqual(original);
  });

  it("keeps a real unanswered client question actionable", () => {
    const turn = (role: string, content: string) => ({ role, content, created_at: new Date() });
    const original = {
      outcome: "deadend" as const,
      need_category: "booking" as const,
      severity: "normal" as const,
      summary: "La cliente a demandé une place samedi sans recevoir de réponse.",
      suggested_action: "Répondre à sa demande de créneau.",
    };
    const verdict = normalizeVerdictForTranscript(original, [
      turn("assistant", "Voici le tarif de la séance."),
      turn("user", "Est-ce qu'il reste une place samedi ?"),
    ]);
    expect(verdict).toEqual(original);
  });

  it("still surfaces a SEVERE deadend even when Awa spoke last (member blocked)", () => {
    const turn = (role: string, content: string) => ({ role, content, created_at: new Date() });
    const original = {
      outcome: "deadend" as const,
      need_category: "membership" as const,
      severity: "severe" as const,
      summary: "Abonnée bloquée, repartie sans réserver.",
      suggested_action: "La rappeler pour relier son compte.",
    };
    const verdict = normalizeVerdictForTranscript(original, [
      turn("user", "Je n'arrive pas à utiliser mon abonnement"),
      turn("assistant", "Désolée, je ne peux pas relier ton compte."),
    ]);
    expect(verdict).toEqual(original);
  });

  it("does not blame list_plans when it succeeded before an output-filter rejection", () => {
    const turn = (role: string, content: string) => ({ role, content, created_at: new Date() });
    const verdict = normalizeVerdictForTranscript(
      {
        outcome: "technical_failure",
        need_category: "membership",
        severity: "severe",
        summary: "L'outil de récupération des plans a échoué et bloqué la demande.",
        suggested_action: "Recontacter la cliente.",
      },
      [
        turn("tool", 'list_plans({}) -> [{"id":"invitee","name":"L’Invitée"}]'),
        turn("tool", 'outbound_filter({}) -> {"error":"output_filter","detail":"outbound_coverage_failed:first_contact_greeting,automated_identity"}'),
      ],
    );
    expect(verdict.summary).toContain("outils métier ont réussi");
    expect(verdict.summary).toContain("filtre de sortie");
    expect(verdict.summary).not.toMatch(/plans? a échoué/i);
  });

  it("ignores an output-filter rejection from a PREVIOUS exchange (stale trace in the 30-turn window)", () => {
    // Bitty 06/08 : le filtre avait bloqué une réponse le 04/08 (déjà reviewé) ;
    // deux jours après, sa réservation confirmée était re-signalée à tort.
    const turn = (role: string, content: string) => ({ role, content, created_at: new Date() });
    const original = {
      outcome: "resolved" as const,
      need_category: "booking" as const,
      severity: "normal" as const,
      summary: "Réservation confirmée via son abonnement.",
      suggested_action: "",
    };
    expect(normalizeVerdictForTranscript(original, [
      turn("user", "Ok pour le paiement"),
      turn("tool", 'create_plan_payment_link({}) -> {"payment_link":"https://pay.wave.com/c/x"}'),
      turn("tool", 'outbound_filter({}) -> {"error":"output_filter","detail":"outbound_coverage_failed:no_unsolicited_question"}'),
      turn("assistant", "Désolée, un problème technique m'empêche de terminer."),
      turn("user", "Peux-tu me réserver mardi 12h30 ?"),
      turn("tool", 'book_with_membership({}) -> {"booked":true,"remaining_sessions":1}'),
      turn("assistant", "C'est confirmé ✅ mardi 11 août à 12h30."),
    ])).toEqual(original);
  });

  it("still forces technical_failure when the filter blocked the reply to the LAST client message", () => {
    const turn = (role: string, content: string) => ({ role, content, created_at: new Date() });
    const verdict = normalizeVerdictForTranscript(
      {
        outcome: "resolved",
        need_category: "membership",
        severity: "normal",
        summary: "Lien de paiement envoyé.",
        suggested_action: "",
      },
      [
        turn("user", "Ok pour le paiement"),
        turn("tool", 'create_plan_payment_link({}) -> {"payment_link":"https://pay.wave.com/c/x"}'),
        turn("tool", 'outbound_filter({}) -> {"error":"output_filter","detail":"outbound_coverage_failed:no_unsolicited_question"}'),
        turn("assistant", "Désolée, un problème technique m'empêche de terminer."),
      ],
    );
    expect(verdict.outcome).toBe("technical_failure");
    expect(verdict.summary).toContain("filtre de sortie");
  });

  it("keeps a real tool failure when its trace contains an error", () => {
    const turn = (role: string, content: string) => ({ role, content, created_at: new Date() });
    const original = {
      outcome: "technical_failure" as const,
      need_category: "membership" as const,
      severity: "normal" as const,
      summary: "L'outil list_plans a échoué.",
      suggested_action: "Réessayer.",
    };
    expect(normalizeVerdictForTranscript(original, [
      turn("tool", 'list_plans({}) -> {"error":"wix_unavailable"}'),
    ])).toEqual(original);
  });
});

describe("parseVerdict", () => {
  it("accepts a valid verdict verbatim", () => {
    expect(
      parseVerdict({
        outcome: "deadend",
        need_category: "cancel_reschedule",
        severity: "severe",
        summary: "Voulait déplacer son cours, refusé par la règle des 16h.",
        suggested_action: "La rappeler pour proposer une solution.",
      }),
    ).toEqual({
      outcome: "deadend",
      need_category: "cancel_reschedule",
      severity: "severe",
      summary: "Voulait déplacer son cours, refusé par la règle des 16h.",
      suggested_action: "La rappeler pour proposer une solution.",
    });
  });

  it("rejects an unknown outcome (never invent a value)", () => {
    expect(parseVerdict({ outcome: "banana", need_category: "info" })).toBeNull();
  });

  it("falls back to other/normal on unknown category or severity", () => {
    const v = parseVerdict({ outcome: "resolved", need_category: "yoga", severity: "extreme" });
    expect(v?.need_category).toBe("other");
    expect(v?.severity).toBe("normal");
  });

  it("dropoff is never actionable — stats only (product decision)", () => {
    expect(ACTIONABLE_OUTCOMES).not.toContain("dropoff");
    expect(ACTIONABLE_OUTCOMES).toEqual(["deadend", "technical_failure"]);
  });
});

describe("buildDigestBody", () => {
  const data: DigestData = {
    openReviews: [
      {
        client_id: "c1",
        client_name: "Rokhaya",
        wa_phone: "221776383088",
        outcome: "deadend",
        severity: "severe",
        summary: "Voulait utiliser son abonnement, repartie sans réserver.",
        suggested_action: "La recontacter pour relier son compte.",
      },
    ],
    openHandoffs: [{ client_name: "Awa T.", wa_phone: "221770001122", reason: "facture" }],
    today: [
      { outcome: "resolved", n: 8 },
      { outcome: "dropoff", n: 2 },
      { outcome: "deadend", n: 1 },
    ],
    topUnserved7d: [{ need_category: "cancel_reschedule", n: 4 }],
  };

  it("contains the day's tally, the queue, handoffs and top unmet needs", () => {
    const body = buildDigestBody(data);
    expect(body).toContain("11 classées");
    expect(body).toContain("8 résolues");
    expect(body).toContain("2 abandons libres");
    expect(body).toContain("🔴 Rokhaya (+221776383088)");
    expect(body).toContain("→ La recontacter pour relier son compte.");
    expect(body).toContain("Awa T. (+221770001122) : facture");
    expect(body).toContain("cancel_reschedule : 4");
    // 8 resolved + 2 dropoff (choix libre) sur 11 → 91 %
    expect(body).toContain("91 %");
  });

  it("empty day renders the all-clear lines", () => {
    const body = buildDigestBody({ openReviews: [], openHandoffs: [], today: [], topUnserved7d: [] });
    expect(body).toContain("0 classées");
    expect(body).toContain("✓ rien à reprendre");
    expect(body).toContain("✓ tous traités");
    expect(body).not.toContain("TOP BESOINS");
  });
});
