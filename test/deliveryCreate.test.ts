import { describe, expect, it } from "vitest";
import { prepareDeliveryCreateInput } from "../src/domain/deliveryCreate.js";
import type { CafeMenuItem } from "../src/lib/cafeMenu.js";

const menu = new Map<string, CafeMenuItem>([
  ["tea", { id: "tea", name: "Thé", priceXof: 1500, category: "Boissons" }],
]);

const valid = {
  client_name: "Fatou Sarr",
  client_phone: "77 123 45 67",
  address: "Almadies",
  items: [{ item_id: "tea", qty: 2, price_xof: 1 }],
};

describe("prepareDeliveryCreateInput", () => {
  it("validates staff fields before any persistence", () => {
    const result = prepareDeliveryCreateInput({ ...valid, client_name: "" }, menu, new Date("2026-08-20T10:00:00Z"));
    expect(result).toEqual({ ok: false, field: "client_name", message: "Le nom du client est obligatoire." });
  });

  it("always prices lines from the server menu", () => {
    const result = prepareDeliveryCreateInput(valid, menu, new Date("2026-08-20T10:00:00Z"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.prepared.amount_xof).toBe(3000);
  });

  it("rejects a scheduled arrival in the past against injected time", () => {
    const result = prepareDeliveryCreateInput(
      { ...valid, delivery_mode: "scheduled", scheduled_for: "2026-08-20T09:00", kitchen_lead_minutes: 120 },
      menu,
      new Date("2026-08-20T10:00:00Z"),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe("scheduled_for");
  });
});
