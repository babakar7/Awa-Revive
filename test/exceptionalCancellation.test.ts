import { beforeEach, describe, expect, it, vi } from "vitest";

// The handoff_to_human branch only touches repo.recordHandoff + the notify
// module, so we mock those and exercise the real executeTool switch.
const notifyOwner = vi.fn();
const notifyReception = vi.fn();
vi.mock("../src/lib/notify.js", () => ({
  notifyOwner: (...a: unknown[]) => notifyOwner(...a),
  notifyReception: (...a: unknown[]) => notifyReception(...a),
  sendVerificationCodeEmail: vi.fn(),
}));
vi.mock("../src/domain/repo.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/domain/repo.js")>();
  return { ...actual, recordHandoff: vi.fn().mockResolvedValue(undefined) };
});

import { config } from "../src/config.js";
import { executeTool } from "../src/agent/tools.js";
import type { Client } from "../src/domain/repo.js";

const client = {
  id: "client-1",
  wa_phone: "+221771708584",
  name: "Arame",
  language: "fr",
} as unknown as Client;

describe("exceptional <16h cancellation routes to the gérant", () => {
  beforeEach(() => {
    notifyOwner.mockClear();
    notifyReception.mockClear();
  });

  it("alerts the gérant (not reception) and returns gerant_phone", async () => {
    const raw = await executeTool(client, "handoff_to_human", {
      reason: "Je dois annuler mon cours de ce soir à titre exceptionnel.",
      exceptional_cancellation: true,
    });
    const res = JSON.parse(raw);

    expect(res.owner_notified).toBe(true);
    expect(res.gerant_phone).toBe(config.OWNER_PHONE);
    expect(res.note).toMatch(/call the gérant/i);
    expect(res.reception_notified).toBeUndefined();

    expect(notifyOwner).toHaveBeenCalledTimes(1);
    expect(notifyReception).not.toHaveBeenCalled();
  });

  it("still routes an ordinary handoff to reception", async () => {
    const raw = await executeTool(client, "handoff_to_human", {
      reason: "Je souhaite parler à quelqu'un de l'équipe.",
    });
    const res = JSON.parse(raw);

    expect(res.reception_notified).toBe(true);
    expect(res.reception_whatsapp).toBe(config.RECEPTION_PHONE);
    expect(res.gerant_phone).toBeUndefined();

    expect(notifyReception).toHaveBeenCalledTimes(1);
    expect(notifyOwner).not.toHaveBeenCalled();
  });
});
