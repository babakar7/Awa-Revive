import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeWixPublicKey,
  normalizeWixWebhookEvent,
  verifyAndNormalizeWixWebhook,
  verifyWixSharedSecret,
} from "../src/lib/wixWebhook.js";

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();

function sign(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .sign("RSA-SHA256", Buffer.from(`${header}.${body}`), privateKey)
    .toString("base64url");
  return `${header}.${body}.${signature}`;
}

const event = {
  id: "event-1",
  entityFqdn: "wix.pricing_plans.v2.order",
  entityId: "order-1",
  slug: "purchased",
  actionEvent: { body: { order: { planId: "plan-1" } } },
};

describe("Wix webhook JWT", () => {
  it("normalizes the nested stringified Wix payload", () => {
    const token = sign({ data: JSON.stringify({ data: JSON.stringify(event) }) });
    expect(verifyAndNormalizeWixWebhook(token, publicPem)).toMatchObject(event);
  });

  it("accepts PEM escaped newlines and base64", () => {
    expect(decodeWixPublicKey(publicPem.replace(/\n/g, "\\n")).trim()).toBe(publicPem.trim());
    expect(
      decodeWixPublicKey(Buffer.from(publicPem).toString("base64")),
    ).toBe(publicPem);
  });

  it("rejects a bad signature", () => {
    const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const otherPem = other.publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(() => verifyAndNormalizeWixWebhook(sign({ data: event }), otherPem)).toThrow(
      "invalid Wix webhook signature",
    );
  });
});

describe("Wix in-site webhook forwarder", () => {
  it("compares the shared secret without accepting missing or partial values", () => {
    const secret = "5f5226ff9613f6ed43cce1cedd7bd40a6406aca52aac841169e65ae116921f29";
    expect(verifyWixSharedSecret(secret, secret)).toBe(true);
    expect(verifyWixSharedSecret("", secret)).toBe(false);
    expect(verifyWixSharedSecret(secret.slice(0, -1), secret)).toBe(false);
    expect(verifyWixSharedSecret(`${secret.slice(0, -1)}0`, secret)).toBe(false);
  });

  it("normalizes the structured payload sent by the Wix backend event handler", () => {
    const structured = {
      ...event,
      eventTime: "2026-07-27T13:00:00.000Z",
      actionEvent: {
        body: {
          order: {
            _id: "order-1",
            planId: "plan-1",
            buyer: { memberId: "member-1", contactId: "contact-1" },
          },
        },
      },
    };
    expect(normalizeWixWebhookEvent(structured)).toEqual(structured);
  });
});
