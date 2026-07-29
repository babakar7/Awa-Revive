import { describe, expect, it } from "vitest";
import { wixDeliveryClientFromContact } from "../src/lib/wix.js";
import { deriveDeliveryPresentation } from "../src/domain/deliveryPresentation.js";

describe("wixDeliveryClientFromContact — international phone", () => {
  it("prefers the canonical e164 phone over the display value that drops the country code", () => {
    // A US contact: Wix's display phone omits the +1; only e164Phone carries it.
    const contact = {
      id: "c1",
      info: {
        name: { first: "Rebecca", last: "Sharp" },
        phones: { items: [{ primary: true, phone: "301 825 3162", e164Phone: "+13018253162" }] },
      },
      primaryInfo: { phone: "301 825 3162" },
    };
    const client = wixDeliveryClientFromContact(contact);
    expect(client?.phone).toBe("+13018253162"); // NOT "301 825 3162" → "+3018253162"
  });

  it("still resolves a Senegalese contact to its full international number", () => {
    const contact = {
      id: "c2",
      info: {
        name: { first: "Awa", last: "Diop" },
        phones: { items: [{ primary: true, phone: "77 123 45 67", e164Phone: "+221771234567" }] },
      },
      primaryInfo: { phone: "77 123 45 67" },
    };
    expect(wixDeliveryClientFromContact(contact)?.phone).toBe("+221771234567");
  });

  it("falls back to the display phone when no e164 is present", () => {
    const contact = {
      id: "c3",
      info: { name: { first: "X" }, phones: { items: [{ primary: true, phone: "+221770000000" }] } },
      primaryInfo: { phone: "+221770000000" },
    };
    expect(wixDeliveryClientFromContact(contact)?.phone).toBe("+221770000000");
  });
});

describe("delivery client-notify intervention wording", () => {
  const baseOrder: any = {
    id: "00000000-0000-4000-8000-000000000000",
    status: "IN_KITCHEN",
    client_name: "Rebecca",
    client_phone: "13018253162",
    amount_xof: 6000,
    payment_status: "PAID",
    activated_at: new Date(),
    kitchen_notify_status: "sent",
    created_notify_status: "failed",
    route_notify_status: "sent",
    recipient_route_notify_status: "sent",
    reschedule_notify_status: "sent",
    activation_notify_status: "sent",
    kitchen_ticket_status: "NEW",
    scheduled_for: null,
    recipient_phone: null,
  };

  it("explains the failure and points to 'Cliente prévenue'", () => {
    const p = deriveDeliveryPresentation(baseOrder, new Date());
    expect(p.blockingReason).toContain("Awa n'a pas pu confirmer");
    expect(p.blockingReason).toContain("+13018253162");
    expect(p.blockingReason).toContain("Cliente prévenue");
  });

  it("no intervention once the client-notify is marked handled ('manual')", () => {
    const p = deriveDeliveryPresentation({ ...baseOrder, created_notify_status: "manual" }, new Date());
    expect(p.blockingReason).toBeNull();
  });
});
