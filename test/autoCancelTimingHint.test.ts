import { describe, expect, it } from "vitest";
import { timingHint } from "../src/admin/autoCancelSection.js";
import {
  DAYTIME_CUTOFF_MS,
  EMPTY_REQUIRED_MS,
  MORNING_ELIGIBILITY_HOUR,
} from "../src/domain/autoCancelRules.js";
import { config } from "../src/config.js";

/**
 * The engine's schedule is global, not per-rule (Babakar looked for a "how long
 * before" field in the rule form on 20/08). The hint under the time buckets is
 * the only place that spells it out, so it must stay true to the constants.
 */
describe("annulation auto — rappel du calendrier sous les plages horaires", () => {
  it("« Toute heure » annonce les deux cutoffs", () => {
    const hint = timingHint("", "");
    expect(hint).toContain(`la veille à ${MORNING_ELIGIBILITY_HOUR}h`);
    expect(hint).toContain("9h15 ou avant");
    expect(hint).toContain(`${DAYTIME_CUTOFF_MS / 3_600_000} h avant le début`);
  });

  it("« Tôt le matin » n'annonce que la veille au soir", () => {
    const hint = timingHint("", "09:15");
    expect(hint).toContain(`Décision : la veille à ${MORNING_ELIGIBILITY_HOUR}h.`);
    expect(hint).not.toContain("avant le début du cours");
  });

  it("une plage strictement après 9h15 n'annonce que le délai de 3 h", () => {
    const hint = timingHint("09:16", "");
    expect(hint).toContain(`Décision : ${DAYTIME_CUTOFF_MS / 3_600_000} h avant le début du cours.`);
    expect(hint).not.toContain("la veille");
  });

  it("un cours pile à 9h15 relève des deux (bornes inclusives comme matchesRule)", () => {
    expect(timingHint("09:15", "")).toContain("la veille");
  });

  it("rappelle toujours le vide continu et le préavis minimum", () => {
    for (const hint of [timingHint("", ""), timingHint("", "09:15"), timingHint("09:16", "")]) {
      expect(hint).toContain(`${EMPTY_REQUIRED_MS / 60_000} min d'affilée`);
      expect(hint).toContain(`${config.AUTO_CANCEL_MIN_NOTICE_MINUTES / 60} h du début`);
    }
  });
});
