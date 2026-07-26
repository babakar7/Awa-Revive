import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeWixPublicKey,
  verifyAndNormalizeWixWebhook,
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
