import { describe, expect, it } from "vitest";
import { planVerifiedMerge } from "../src/lib/crmAudit.js";

const PROVEN = "proven";

describe("planVerifiedMerge — target is FORCED to the proven fiche", () => {
  it("returns null when there are no other fiches (index lag / already unique)", () => {
    expect(planVerifiedMerge(PROVEN, [], new Set(), new Set())).toBeNull();
  });

  it("absorbs a plain duplicate fiche into the proven one", () => {
    const plan = planVerifiedMerge(PROVEN, ["dupe"], new Set(), new Set());
    expect(plan).toEqual({ targetId: PROVEN, sourceIds: ["dupe"], leftoverIds: [] });
  });

  it("never keeps a member/plan-holder as source — it becomes a leftover", () => {
    const plan = planVerifiedMerge(
      PROVEN,
      ["dupe", "memberFiche", "planFiche"],
      new Set(["planFiche"]),
      new Set(["memberFiche"]),
    );
    expect(plan).toEqual({
      targetId: PROVEN,
      sourceIds: ["dupe"],
      leftoverIds: expect.arrayContaining(["memberFiche", "planFiche"]),
    });
    expect(plan!.leftoverIds).toHaveLength(2);
  });

  it("returns null when EVERY other fiche is protected (nothing safe to merge)", () => {
    expect(
      planVerifiedMerge(PROVEN, ["memberFiche"], new Set(), new Set(["memberFiche"])),
    ).toBeNull();
    expect(
      planVerifiedMerge(PROVEN, ["planFiche"], new Set(["planFiche"]), new Set()),
    ).toBeNull();
  });

  it("keeps the proven fiche as target even if another fiche holds the plan (client proved this one)", () => {
    // The proven fiche is the one the client controls; a plan on another fiche
    // must NOT hijack the target — that other fiche stays a protected leftover.
    const plan = planVerifiedMerge(PROVEN, ["planFiche"], new Set(["planFiche"]), new Set());
    expect(plan).toBeNull(); // planFiche protected, nothing else to merge
  });
});
