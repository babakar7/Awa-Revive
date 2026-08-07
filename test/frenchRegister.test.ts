import { describe, expect, it } from "vitest";
import { applyFrenchRegister, detectFrenchRegister } from "../src/lib/frenchRegister.js";

describe("detectFrenchRegister", () => {
  it("detects explicit formal address", () => {
    expect(detectFrenchRegister("On va vous faire un paiement Wave")).toBe("vous");
    expect(detectFrenchRegister("Pouvez-vous m'aider avec votre planning ?")).toBe("vous");
  });

  it("keeps ambiguous or informal messages unchanged", () => {
    expect(detectFrenchRegister("D'accord")).toBeNull();
    expect(detectFrenchRegister("Tu peux m'aider ?")).toBeNull();
  });

  it("formalizes deterministic client templates", () => {
    expect(applyFrenchRegister("Ta commande est prête après ton cours. Montre ce message.", true))
      .toBe("Votre commande est prête après votre cours. Montrez ce message.");
    expect(applyFrenchRegister("Réessaie puis écris-moi : je t'aide.", true))
      .toBe("Réessayez puis écrivez-moi : je vous aide.");
  });

  it("conjugates negated verbs — never « Vous n'as » (fallback technique, prod 07/08)", () => {
    expect(applyFrenchRegister("Tu n’as rien à faire.", true)).toBe("Vous n’avez rien à faire.");
    expect(applyFrenchRegister("Tu n'as rien à faire.", true)).toBe("Vous n’avez rien à faire.");
    expect(applyFrenchRegister("Tu n’es pas inscrite.", true)).toBe("Vous n’êtes pas inscrite.");
    expect(applyFrenchRegister("Tu n’auras rien à régler.", true)).toBe("Vous n’aurez rien à régler.");
  });
});
