import { beforeEach, describe, expect, it, vi } from "vitest";

const hasRecentBookingActivity = vi.fn();
const setAwaDisengaged = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/domain/repo.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/domain/repo.js")>();
  return {
    ...actual,
    hasRecentBookingActivity: (...a: unknown[]) => hasRecentBookingActivity(...a),
    setAwaDisengaged: (...a: unknown[]) => setAwaDisengaged(...a),
  };
});

import { TOOL_DEFINITIONS, executeTool } from "../src/agent/tools.js";
import type { Client } from "../src/domain/repo.js";

const client = { id: "client-1", wa_phone: "+221775048261", name: "Codette" } as unknown as Client;

describe("disengage_conversation tool", () => {
  beforeEach(() => {
    hasRecentBookingActivity.mockReset();
    setAwaDisengaged.mockClear();
  });

  it("is registered with a required free-text reason", () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === "disengage_conversation");
    expect(tool).toBeDefined();
    const schema = tool!.input_schema as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.properties.reason).toBeDefined();
    expect(schema.required).toEqual(["reason"]);
  });

  it("refuses to disengage a client with recent booking activity (prod 05/08)", async () => {
    hasRecentBookingActivity.mockResolvedValue(true);
    const res = JSON.parse(
      await executeTool(client, "disengage_conversation", { reason: "Conversation répétitive sans intention Revive" }),
    );
    expect(res.error).toBe("client_engaged_in_booking");
    expect(res.message).toMatch(/Do NOT disengage/);
    expect(setAwaDisengaged).not.toHaveBeenCalled();
  });

  it("still disengages a contact with no booking activity", async () => {
    hasRecentBookingActivity.mockResolvedValue(false);
    const res = JSON.parse(
      await executeTool(client, "disengage_conversation", { reason: "Avances répétées envers Awa" }),
    );
    expect(res.disengaged).toBe(true);
    expect(setAwaDisengaged).toHaveBeenCalledWith("client-1", "Avances répétées envers Awa", 24, "nonserious");
  });
});
