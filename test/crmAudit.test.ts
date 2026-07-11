import { describe, expect, it } from "vitest";
import { auditContacts, phoneKey, planMerge } from "../src/lib/crmAudit.js";

const contact = (id: string, first: string, phones: any[], email?: string) => ({
  id,
  createdDate: "2026-01-01T00:00:00Z",
  info: {
    name: { first, last: "Test" },
    phones: { items: phones },
    emails: email ? { items: [{ email }] } : undefined,
  },
});

describe("phoneKey", () => {
  it("normalizes any spelling of a senegalese number to its last 9 digits", () => {
    expect(phoneKey("+221774446666")).toBe("774446666");
    expect(phoneKey("774446666")).toBe("774446666");
    expect(phoneKey("77 444 66 66")).toBe("774446666");
    expect(phoneKey("00221774446666")).toBe("774446666");
  });

  it("rejects strings that are not phone numbers", () => {
    expect(phoneKey("abc")).toBeNull();
    expect(phoneKey("12")).toBeNull();
  });
});

describe("auditContacts", () => {
  it("classifies no-phone contacts and groups duplicates across spellings", () => {
    const audit = auditContacts([
      contact("a", "SansTel", [], "a@x.com"),
      contact("b", "Marie", [{ e164Phone: "+221774446666", phone: "77 444 66 66" }]),
      contact("c", "Marie2", [{ phone: "774446666" }]), // same number, raw spelling
      contact("d", "Solo", [{ e164Phone: "+221700000009" }]),
    ]);
    expect(audit.total).toBe(4);
    expect(audit.noPhone.map((c) => c.id)).toEqual(["a"]);
    expect(audit.duplicates).toHaveLength(1);
    expect(audit.duplicates[0].key).toBe("774446666");
    expect(audit.duplicates[0].contacts.map((c) => c.id).sort()).toEqual(["b", "c"]);
    expect(audit.duplicates[0].contacts.find((c) => c.id === "b")?.hasE164).toBe(true);
    expect(audit.duplicates[0].contacts.find((c) => c.id === "c")?.hasE164).toBe(false);
  });

  it("does not flag a contact twice for two spellings of its own number", () => {
    const audit = auditContacts([
      contact("a", "Double", [{ e164Phone: "+221774446666" }, { phone: "77 444 66 66" }]),
    ]);
    expect(audit.duplicates).toHaveLength(0);
  });
});

describe("planMerge", () => {
  const c = (id: string, hasE164: boolean, createdDate: string | null) => ({
    id,
    hasE164,
    createdDate,
  });
  const none = new Set<string>();

  it("plan holder survives; plain fiches are sources", () => {
    const plan = planMerge(
      [c("old-e164", true, "2024-01-01"), c("young-plan", false, "2026-01-01")],
      new Set(["young-plan"]),
      none,
    );
    expect(plan).toEqual({ targetId: "young-plan", sourceIds: ["old-e164"], leftoverIds: [] });
  });

  it("member beats plan holder as target; the plan holder is protected, not merged", () => {
    const plan = planMerge(
      [c("member", false, "2026-01-01"), c("plan", false, "2024-01-01"), c("plain", true, "2025-01-01")],
      new Set(["plan"]),
      new Set(["member"]),
    );
    expect(plan).toEqual({ targetId: "member", sourceIds: ["plain"], leftoverIds: ["plan"] });
  });

  it("Dieynaba case: two members + one plain fiche → plain merges into a member, other member stays", () => {
    const plan = planMerge(
      [c("member-a", false, "2024-01-01"), c("plain", false, "2025-01-01"), c("member-b", false, "2026-01-01")],
      none,
      new Set(["member-a", "member-b"]),
    );
    expect(plan?.targetId).toBe("member-a"); // oldest member
    expect(plan?.sourceIds).toEqual(["plain"]);
    expect(plan?.leftoverIds).toEqual(["member-b"]);
  });

  it("all fiches are members → nothing mergeable (null)", () => {
    const plan = planMerge(
      [c("a", true, "2024-01-01"), c("b", true, "2025-01-01")],
      none,
      new Set(["a", "b"]),
    );
    expect(plan).toBeNull();
  });

  it("without plans/members, keeps the oldest e164 fiche", () => {
    const plan = planMerge(
      [c("raw-old", false, "2024-01-01"), c("e164-new", true, "2026-01-01"), c("e164-old", true, "2025-01-01")],
      none,
      none,
    );
    expect(plan?.targetId).toBe("e164-old");
    expect(plan?.sourceIds?.sort()).toEqual(["e164-new", "raw-old"]);
  });

  it("member holding the plan wins over a plain member", () => {
    const plan = planMerge(
      [c("member-plain", false, "2024-01-01"), c("member-plan", false, "2026-01-01"), c("plain", false, "2025-01-01")],
      new Set(["member-plan"]),
      new Set(["member-plain", "member-plan"]),
    );
    expect(plan?.targetId).toBe("member-plan");
    expect(plan?.sourceIds).toEqual(["plain"]);
    expect(plan?.leftoverIds).toEqual(["member-plain"]);
  });
});
