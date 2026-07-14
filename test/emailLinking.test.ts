import { describe, expect, it } from "vitest";
import { appendPhoneItems, resolveEmailCandidate } from "../src/lib/wix.js";
import { decideNoneCandidateAction } from "../src/agent/tools.js";

function contact(id: string, phones: string[] = []) {
  return {
    id,
    info: { phones: { items: phones.map((phone) => ({ tag: "MOBILE", phone })) } },
  };
}

describe("resolveEmailCandidate", () => {
  const waPhone = "221776383088";

  it("no contact for this email → none", () => {
    expect(resolveEmailCandidate([], new Set(), waPhone)).toEqual({ kind: "none" });
  });

  it("one fiche → one", () => {
    const c = contact("a", ["78 638 30 88"]);
    expect(resolveEmailCandidate([c], new Set(), waPhone)).toEqual({ kind: "one", contact: c });
  });

  it("a fiche already carrying the WhatsApp number → already_linked (any spelling)", () => {
    const c = contact("a", ["77 638 30 88"]); // raw spelling of the same number
    expect(resolveEmailCandidate([c], new Set(), waPhone)).toEqual({
      kind: "already_linked",
      contactId: "a",
    });
  });

  it("several fiches, exactly one plan holder → that one", () => {
    const holder = contact("b");
    const r = resolveEmailCandidate([contact("a"), holder], new Set(["b"]), waPhone);
    expect(r).toEqual({ kind: "one", contact: holder });
  });

  it("several fiches, zero or several plan holders → ambiguous", () => {
    const cs = [contact("a"), contact("b")];
    expect(resolveEmailCandidate(cs, new Set(), waPhone)).toEqual({ kind: "ambiguous", count: 2 });
    expect(resolveEmailCandidate(cs, new Set(["a", "b"]), waPhone)).toEqual({
      kind: "ambiguous",
      count: 2,
    });
  });
});

describe("decideNoneCandidateAction (email matches no fiche)", () => {
  it("name known → send the code straight away (one round-trip, prod 14/07 Rama)", () => {
    // Client sent name+email together in reply to the creation invitation: the
    // model passes client_name on the FIRST call, no 'do you confirm?' detour.
    expect(decideNoneCandidateAction(false, "Rama Thiam Ndiaye")).toBe("send_code");
    expect(decideNoneCandidateAction(true, "Rama Thiam Ndiaye")).toBe("send_code");
  });

  it("no name, no create intent → offer to create the account", () => {
    expect(decideNoneCandidateAction(false, "")).toBe("offer_creation");
  });

  it("wants to create but forgot the name → ask for it", () => {
    expect(decideNoneCandidateAction(true, "")).toBe("name_required");
  });
});

describe("appendPhoneItems", () => {
  it("senegalese number is added as countryCode SN + local digits (Wix computes e164)", () => {
    const existing = [{ tag: "MOBILE", phone: "78 638 30 88", primary: true }];
    const items = appendPhoneItems(existing, "221776383088");
    expect(items).toEqual([
      { tag: "MOBILE", phone: "78 638 30 88", primary: true },
      { tag: "MOBILE", countryCode: "SN", phone: "776383088" },
    ]);
  });

  it("keeps existing items but strips Wix-computed fields", () => {
    const existing = [
      {
        tag: "MOBILE",
        phone: "78 000 11 22",
        e164Phone: "+221780001122",
        formattedPhone: "+221 78 000 11 22",
        countryCode: "SN",
        primary: true,
      },
    ];
    const items = appendPhoneItems(existing, "+221771234567")!;
    expect(items[0]).toEqual({
      tag: "MOBILE",
      phone: "78 000 11 22",
      countryCode: "SN",
      primary: true,
    });
  });

  it("number already on the fiche (any spelling) → null (no-op)", () => {
    const existing = [{ tag: "MOBILE", phone: "77 638 30 88" }];
    expect(appendPhoneItems(existing, "221776383088")).toBeNull();
    expect(appendPhoneItems(existing, "+221776383088")).toBeNull();
  });

  it("non-senegalese number is added verbatim in e164", () => {
    const items = appendPhoneItems([], "+33767182228");
    expect(items).toEqual([{ tag: "MOBILE", phone: "+33767182228" }]);
  });
});
