import { describe, expect, it } from "vitest";
import {
  deriveReplyRequirements,
  missingReplyRequirements,
  replyRequirementsInstruction,
} from "../src/agent/replyCoverage.js";
import { executeTool, TOOL_DEFINITIONS } from "../src/agent/tools.js";
import type { Client } from "../src/domain/repo.js";

const INCIDENT =
  "Bonjour, Mme ça va ? Comment réserver? quelles sont vos horaires ? Vous êtes où ? Merciii";

const COMPLETE_FIRST_REPLY =
  "Bonjour ! Moi c'est Awa, je suis une assistante automatisée de Revive 😊\n\n" +
  "Vous pouvez réserver directement ici avec moi ou sur www.revive.sn. " +
  "Voici aussi le planning à jour : www.revive.sn/planning.\n\n" +
  "Revive se trouve aux Almadies, Dakar : https://maps.app.goo.gl/jJS8rS3sV5j41SGc9";

describe("reply coverage requirements", () => {
  it("derives every requirement from the exact 03/08 production incident", () => {
    expect(deriveReplyRequirements(INCIDENT, true)).toEqual([
      "first_contact_greeting",
      "automated_identity",
      "booking_method",
      "schedule_overview",
      "location",
      "no_unsolicited_question",
    ]);
  });

  it("accepts one complete first-contact schedule caption", () => {
    const requirements = deriveReplyRequirements(INCIDENT, true);
    expect(
      missingReplyRequirements(COMPLETE_FIRST_REPLY, requirements, {
        scheduleAttached: true,
      }),
    ).toEqual([]);
  });

  it("blocks the incomplete and pushy reply shape that reached production", () => {
    const requirements = deriveReplyRequirements(INCIDENT, true);
    const bad =
      "Je viens de vous envoyer le planning complet 📅. Vous pouvez aussi le retrouver sur www.revive.sn/planning. Quel cours vous intéresse ?";

    expect(
      missingReplyRequirements(bad, requirements, { scheduleAttached: true }),
    ).toEqual([
      "first_contact_greeting",
      "automated_identity",
      "booking_method",
      "location",
      "no_unsolicited_question",
    ]);
  });

  it("does not require another greeting or introduction mid-conversation", () => {
    const requirements = deriveReplyRequirements("Vous pouvez m'envoyer le planning ?", false);
    expect(requirements).toEqual(["schedule_overview", "no_unsolicited_question"]);
    expect(
      missingReplyRequirements(
        "Bien sûr, voici le planning à jour 📅 Il reste aussi disponible sur www.revive.sn/planning.",
        requirements,
        { scheduleAttached: true },
      ),
    ).toEqual([]);
  });

  it("allows one next-step question when the client explicitly wants to book", () => {
    const requirements = deriveReplyRequirements(
      "Je veux réserver, quels sont vos horaires et où êtes-vous ?",
      false,
    );
    expect(requirements).not.toContain("no_unsolicited_question");
    expect(
      deriveReplyRequirements("Pouvez-vous me réserver un cours ? Vos horaires ?", false),
    ).not.toContain("no_unsolicited_question");
  });

  it("does not confuse a plan programme or a missing link with studio logistics", () => {
    expect(deriveReplyRequirements("Quel est le programme de L'Invitée ?", false)).not.toContain(
      "schedule_overview",
    );
    expect(deriveReplyRequirements("Où se trouve mon lien de paiement ?", false)).not.toContain(
      "location",
    );
  });

  it("requires a real attached or relayed schedule, not just its web link", () => {
    expect(
      missingReplyRequirements(
        "Le planning est sur www.revive.sn/planning.",
        ["schedule_overview"],
      ),
    ).toEqual(["schedule_overview"]);
  });

  it("injects the server-enforced contract into the volatile prompt", () => {
    const instruction = replyRequirementsInstruction(
      deriveReplyRequirements(INCIDENT, true),
    );
    expect(instruction).toContain("CURRENT-TURN REQUIRED COVERAGE");
    expect(instruction).toContain("Google Maps link");
    expect(instruction).toContain("without a booking question");
  });
});

describe("get_class_schedule tool contract", () => {
  it("requires the complete client-facing caption", () => {
    const tool = TOOL_DEFINITIONS.find((candidate) => candidate.name === "get_class_schedule");
    expect(tool).toBeDefined();
    expect(tool?.input_schema).toMatchObject({ required: ["message"] });
    expect(tool?.description).toContain("caption");
    expect(tool?.description).toContain("CURRENT-TURN REQUIRED COVERAGE");
    expect(tool?.description).toContain("<NO_REPLY>");
  });

  it("rejects an incomplete caption before any Wix or WhatsApp side effect", async () => {
    const requirements = deriveReplyRequirements(INCIDENT, true);
    const result = JSON.parse(
      await executeTool(
        { id: "client-1", wa_phone: "221781038893" } as Client,
        "get_class_schedule",
        { message: "Voici le planning : www.revive.sn/planning" },
        { replyRequirements: requirements },
      ),
    );

    expect(result).toMatchObject({
      error: "reply_requirements_missing",
      missing: [
        "first_contact_greeting",
        "automated_identity",
        "booking_method",
        "location",
      ],
    });
    expect(result.message).toContain("Nothing was sent");
  });
});
