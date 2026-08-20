import { describe, expect, it } from "vitest";
import { contactPlanForBooking, usableContactName } from "../src/domain/bookingContact.js";
import type { PhoneContactResolution } from "../src/lib/wix.js";

const one: PhoneContactResolution = {
  kind: "one",
  contact: { id: "c-1", fullName: "Penda Sow" },
};

/**
 * Le cœur du garde-fou : « aucun contact » et « plusieurs contacts ambigus »
 * ne doivent PAS mener à la même décision. C'est leur confusion qui a laissé
 * partir 12 réservations sans fiche entre juillet et août 2026 (cas Penda).
 */
describe("fiche contact avant réservation payée", () => {
  it("rattache la fiche quand elle est unique", () => {
    expect(contactPlanForBooking(one, "Penda")).toEqual({ action: "attach", contact: one.contact });
  });

  it("crée la fiche quand aucun contact ne porte le numéro", () => {
    expect(contactPlanForBooking({ kind: "none" }, "Penda")).toEqual({
      action: "create",
      name: "Penda",
    });
  });

  it("ne crée JAMAIS de fiche sur une ambiguïté — ce serait un doublon", () => {
    expect(contactPlanForBooking({ kind: "ambiguous", count: 3 }, "Penda")).toEqual({
      action: "skip",
      gap: "ambiguous",
    });
  });

  it("refuse de créer une fiche avec un nom de profil inexploitable", () => {
    for (const name of ["A", "L", " ", "", null, undefined, "🌸", "7"]) {
      expect(contactPlanForBooking({ kind: "none" }, name)).toEqual({
        action: "skip",
        gap: "bad_name",
      });
    }
  });

  it("accepte les prénoms d'ici, accents et particules compris", () => {
    for (const name of ["Penda", "Marème", "N'Diaye", "Anne-Marie", "Aïda"]) {
      expect(contactPlanForBooking({ kind: "none" }, name)).toEqual({ action: "create", name });
    }
  });

  it("nettoie les espaces autour du nom avant de créer", () => {
    expect(contactPlanForBooking({ kind: "none" }, "  Fall Marème  ")).toEqual({
      action: "create",
      name: "Fall Marème",
    });
  });

  it("une ambiguïté prime sur la qualité du nom", () => {
    // Nom pourri ET ambigu : on signale l'ambiguïté, la vraie cause du blocage.
    expect(contactPlanForBooking({ kind: "ambiguous", count: 2 }, "A")).toEqual({
      action: "skip",
      gap: "ambiguous",
    });
  });

  it("usableContactName exige deux lettres", () => {
    expect(usableContactName("Al")).toBe(true);
    expect(usableContactName("A")).toBe(false);
    expect(usableContactName("A.")).toBe(false);
    expect(usableContactName("é")).toBe(false);
    expect(usableContactName("Éo")).toBe(true);
  });
});
