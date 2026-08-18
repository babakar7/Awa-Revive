import { describe, expect, it } from "vitest";
import { isMidnightTomorrowAmbiguous } from "../src/agent/relativeDateAmbiguity.js";
import { dynamicContext } from "../src/agent/systemPrompt.js";
import { executeTool } from "../src/agent/tools.js";
import type { Client } from "../src/domain/repo.js";

const client = { id: "client-midnight" } as Client;
const baseContext = {
  clientName: "Penda",
  clientLanguage: "fr",
  activeBooking: null,
  activePlanOrder: null,
  activeCafeOrder: null,
  memberships: [],
  recentRefunds: [],
} as const;

describe("post-midnight relative-date ambiguity", () => {
  it("flags Penda's bare 'demain' just after midnight", () => {
    expect(isMidnightTomorrowAmbiguous("Demain", new Date("2026-08-18T00:02:00Z"))).toBe(true);
    expect(
      isMidnightTomorrowAmbiguous(
        "Je voudrais faire l'Aquabike demain matin",
        new Date("2026-08-18T03:59:00Z"),
      ),
    ).toBe(true);
  });

  it("does not interfere later in the day or when the date is explicit", () => {
    expect(isMidnightTomorrowAmbiguous("demain", new Date("2026-08-18T04:00:00Z"))).toBe(false);
    expect(
      isMidnightTomorrowAmbiguous("demain mercredi", new Date("2026-08-18T00:02:00Z")),
    ).toBe(false);
    expect(
      isMidnightTomorrowAmbiguous("demain 19/08", new Date("2026-08-18T00:02:00Z")),
    ).toBe(false);
  });

  it("injects a current-turn instruction to clarify before searching", () => {
    const context = dynamicContext({ ...baseContext, midnightTomorrowAmbiguity: true });
    expect(context).toContain("MIDNIGHT DATE AMBIGUITY");
    expect(context).toContain("Do NOT assume a calendar day");
    expect(context).toContain("ce matin");
    expect(context).toContain("demain");
  });

  it("blocks availability I/O if the model still tries to guess", async () => {
    const result = JSON.parse(
      await executeTool(
        client,
        "check_availability",
        {
          service_id: "03200531-2229-4f36-bb26-b320d795a77a",
          date_from: "2026-08-19T00:00:00Z",
          date_to: "2026-08-19T23:59:59Z",
        },
        { midnightTomorrowAmbiguity: true },
      ),
    );
    expect(result).toMatchObject({ error: "ambiguous_relative_date" });
  });
});
