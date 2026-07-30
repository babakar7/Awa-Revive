import { describe, expect, it } from "vitest";
import {
  isAffirmativeReaction,
  shouldRouteReactionAsReply,
} from "../src/agent/reactionIntent.js";

const QUESTION = { content: "As-tu déjà pratiqué le Reformer chez Revive ?", wa_message_id: "wamid.Q" };
const STATEMENT = { content: "Parfait, à bientôt !", wa_message_id: "wamid.S" };

describe("isAffirmativeReaction", () => {
  it("accepts thumbs-up across skin tones and OK marks", () => {
    for (const e of ["👍", "👍🏾", "👍🏿", "👌", "✅", "🆗"]) {
      expect(isAffirmativeReaction(e)).toBe(true);
    }
  });
  it("rejects acknowledgements and empty (removed) reactions", () => {
    for (const e of ["❤️", "🙏", "🙏🏾", "😂", "😍", "", null, undefined]) {
      expect(isAffirmativeReaction(e)).toBe(false);
    }
  });
});

describe("shouldRouteReactionAsReply", () => {
  it("routes 👍 on Awa's latest question", () => {
    expect(shouldRouteReactionAsReply("👍", "wamid.Q", QUESTION)).toBe(true);
  });
  it("routes 👍🏾 (skin tone) on the latest question", () => {
    expect(shouldRouteReactionAsReply("👍🏾", "wamid.Q", QUESTION)).toBe(true);
  });
  it("does NOT route when the target is a stale/older message", () => {
    expect(shouldRouteReactionAsReply("👍", "wamid.OLD", QUESTION)).toBe(false);
  });
  it("does NOT route when the latest assistant turn is not a question", () => {
    expect(shouldRouteReactionAsReply("👍", "wamid.S", STATEMENT)).toBe(false);
  });
  it("does NOT route a heart/pray reaction", () => {
    expect(shouldRouteReactionAsReply("❤️", "wamid.Q", QUESTION)).toBe(false);
  });
  it("does NOT route a removed reaction (empty emoji)", () => {
    expect(shouldRouteReactionAsReply("", "wamid.Q", QUESTION)).toBe(false);
  });
  it("does NOT route when there is no prior assistant turn", () => {
    expect(shouldRouteReactionAsReply("👍", "wamid.Q", null)).toBe(false);
  });
});
