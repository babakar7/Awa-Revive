import { describe, expect, it } from "vitest";
import {
  lintOutboundReply,
  canToolResultApprovePaymentUrl,
  correctiveLintInstruction,
  extractUrls,
  isPaymentUrl,
  normalizeUrl,
} from "../src/agent/outboundLint.js";

const WAVE = "https://pay.wave.com/c/cos-26b60x0eg149a?a=12000&c=XOF";
const OM = "https://sugu.orange-sonatel.com/mp/dmeqhrdd3D_ojFf3zu4T";
const FAKE = "https://pay.wave.com/c/cos-xxbebe1";
const MAPS = "https://maps.app.goo.gl/jJS8rS3sV5j41SGc9";

describe("payment-link tool allowlist", () => {
  it("trusts refreshed plan links and add-spots links", () => {
    expect(canToolResultApprovePaymentUrl("refresh_expired_plan_payment_link")).toBe(true);
    expect(canToolResultApprovePaymentUrl("add_spots_to_booking")).toBe(true);
  });

  it("keeps unrelated and lookalike tools outside the trust boundary", () => {
    expect(canToolResultApprovePaymentUrl("list_plans")).toBe(false);
    expect(canToolResultApprovePaymentUrl("refresh_expired_payment_link")).toBe(false);
  });
});

describe("lintOutboundReply", () => {
  it("passes a reply with a server-issued Wave link", () => {
    const r = `Voici ton lien 👇\n${WAVE}\nValable 20 minutes`;
    expect(lintOutboundReply(r, [WAVE]).ok).toBe(true);
  });

  it("passes when the link is an active DB record re-mentioned", () => {
    expect(lintOutboundReply(`Ton lien plus haut : ${OM}`, [OM]).ok).toBe(true);
  });

  it("blocks a fabricated Wave link not in the allowlist", () => {
    const res = lintOutboundReply(`Voici ton lien Wave 👇\n${FAKE}`, [WAVE]);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("unapproved_payment_url");
  });

  it("blocks a payment link when the allowlist is empty", () => {
    const res = lintOutboundReply(`Ton lien : ${FAKE}`, []);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("unapproved_payment_url");
  });

  it("blocks an active-link claim when no live server order exists", () => {
    const res = lintOutboundReply("Ton lien de paiement est encore valide.", []);
    expect(res).toMatchObject({ ok: false, reason: "unbacked_active_link_claim" });
  });

  it("blocks an Orange Money link not issued this turn", () => {
    expect(lintOutboundReply(`Paie ici ${OM}`, [WAVE]).ok).toBe(false);
  });

  it("blocks imitated tool-call trace syntax with a fabricated link", () => {
    const r = `[outil] create_payment_link({}) -> {"payment_link":"${FAKE}"}\n\nVoici ton lien 👇`;
    const res = lintOutboundReply(r, [FAKE]);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("tool_syntax");
  });

  it("blocks the internal ⟦trace⟧ marker if copied into a reply", () => {
    expect(lintOutboundReply("⟦trace⟧ list_classes({}) -> [...]", []).ok).toBe(false);
  });

  it("blocks a bare tool call written as prose", () => {
    expect(lintOutboundReply("Je fais create_plan_payment_link(plan) pour toi", []).ok).toBe(false);
  });

  it("ignores non-payment URLs like the maps link", () => {
    expect(lintOutboundReply(`On est ici : ${MAPS}`, []).ok).toBe(true);
  });

  it("passes a valid link even when a fabricated one is absent (only real link present)", () => {
    expect(lintOutboundReply(`Ton lien : ${WAVE}`, [WAVE, OM]).ok).toBe(true);
  });

  it("tolerates trailing punctuation on the URL", () => {
    expect(lintOutboundReply(`Paie ici : ${WAVE}.`, [WAVE]).ok).toBe(true);
  });
});

describe("url helpers", () => {
  it("normalizes trailing punctuation", () => {
    expect(normalizeUrl(`${WAVE}.`)).toBe(WAVE);
    expect(normalizeUrl(`${WAVE})`)).toBe(WAVE);
  });
  it("extracts multiple urls", () => {
    expect(extractUrls(`a ${WAVE} b ${MAPS} c`)).toEqual([WAVE, MAPS]);
  });
  it("classifies payment vs non-payment hosts", () => {
    expect(isPaymentUrl(WAVE)).toBe(true);
    expect(isPaymentUrl(OM)).toBe(true);
    expect(isPaymentUrl(MAPS)).toBe(false);
  });
});

describe("correctiveLintInstruction", () => {
  it("lists approved urls when present", () => {
    const note = correctiveLintInstruction([WAVE]);
    expect(note).toContain(WAVE);
    expect(note).toContain("server-approved");
  });
  it("forbids claiming a link when none is approved", () => {
    const note = correctiveLintInstruction([]);
    expect(note).toContain("NO server-issued payment link");
    expect(note).not.toContain("http");
  });
});
