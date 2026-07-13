import { describe, expect, it } from "vitest";
import { refundMessage } from "../src/webhooks/wave.js";

describe("refundMessage", () => {
  it("class_started: says the payment arrived after class start (fr)", () => {
    const msg = refundMessage("fr", undefined, "class_started");
    expect(msg).toContain("après le début du cours");
    expect(msg).toContain("remboursé(e) sous 24h");
  });

  it("class_started: says the payment arrived after class start (en)", () => {
    const msg = refundMessage("en", undefined, "class_started");
    expect(msg).toContain("after the class had already started");
    expect(msg).toContain("refunded within 24h");
  });

  it("class_started: has a Wolof variant", () => {
    const msg = refundMessage("wo", undefined, "class_started");
    expect(msg).toContain("cours bi tàmbalee");
    expect(msg).toContain("24 waxtu");
  });

  it("technical: keeps the generic technical-issue message (fr)", () => {
    const msg = refundMessage("fr", undefined, "technical", "Aminata");
    expect(msg).toContain("souci technique");
    expect(msg).toContain("https://wa.me/221784644329?text=");
    expect(decodeURIComponent(msg)).toContain("je suis Aminata");
    expect(msg).not.toContain("+221784644329");
  });

  it("slot_taken stays the default reason", () => {
    expect(refundMessage("fr")).toContain("vient d'être prise");
  });

  it("group shortage takes precedence over the reason", () => {
    const msg = refundMessage("fr", { requested: 3, remaining: 1 }, "class_started");
    expect(msg).toContain("il ne restait que 1 place(s)");
  });
});
