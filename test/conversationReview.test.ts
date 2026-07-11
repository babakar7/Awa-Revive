import { describe, expect, it } from "vitest";
import {
  ACTIONABLE_OUTCOMES,
  buildDigestBody,
  buildTranscript,
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
