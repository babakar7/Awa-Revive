import { describe, expect, it } from "vitest";
import { planBookingContactRepairs } from "../src/domain/bookingContactBackfill.js";
import type { BookingContactSnapshot } from "../src/lib/wix.js";

const CONTACT = "509d0a3d-76ea-4152-95d4-b058ef7827ed";

function snap(over: Partial<BookingContactSnapshot>): BookingContactSnapshot {
  return {
    bookingId: "b1",
    revision: "2",
    contactId: CONTACT,
    firstName: "Amy",
    lastName: "Ndiaye",
    ...over,
  };
}

describe("planBookingContactRepairs", () => {
  it("rattache une résa orpheline créée sous le nom de profil WhatsApp (cas « A »)", () => {
    const repairs = planBookingContactRepairs(
      [snap({ contactId: null, firstName: "A", lastName: null })],
      CONTACT,
      "Amy Ndiaye",
    );
    expect(repairs).toEqual([
      { bookingId: "b1", revision: "2", firstName: "Amy", lastName: "Ndiaye" },
    ]);
  });

  it("renomme une résa déjà rattachée mais au libellé tronqué (cas « L »/Habott Lina)", () => {
    const repairs = planBookingContactRepairs(
      [snap({ firstName: "L", lastName: null })],
      CONTACT,
      "Habott Lina",
    );
    expect(repairs).toEqual([
      { bookingId: "b1", revision: "2", firstName: "Habott", lastName: "Lina" },
    ]);
  });

  it("ne touche pas une résa déjà correcte", () => {
    expect(planBookingContactRepairs([snap({})], CONTACT, "Amy Ndiaye")).toEqual([]);
  });

  it("gère un nom canonique sans nom de famille", () => {
    const repairs = planBookingContactRepairs(
      [snap({ contactId: null, firstName: "Awa", lastName: "X" })],
      CONTACT,
      "Awa",
    );
    expect(repairs).toEqual([{ bookingId: "b1", revision: "2", firstName: "Awa" }]);
    // Et une résa déjà alignée sur ce prénom seul reste intacte.
    expect(
      planBookingContactRepairs([snap({ firstName: "Awa", lastName: null })], CONTACT, "Awa"),
    ).toEqual([]);
  });

  it("répare plusieurs résas en un passage et garde la revision de chacune", () => {
    const repairs = planBookingContactRepairs(
      [
        snap({ bookingId: "b1", revision: "2", contactId: null, firstName: "A", lastName: null }),
        snap({ bookingId: "b2", revision: "7", contactId: null, firstName: "A", lastName: null }),
        snap({ bookingId: "b3" }),
      ],
      CONTACT,
      "Amy Ndiaye",
    );
    expect(repairs.map((r) => [r.bookingId, r.revision])).toEqual([
      ["b1", "2"],
      ["b2", "7"],
    ]);
  });
});
