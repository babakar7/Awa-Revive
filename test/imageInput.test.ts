import { describe, expect, it } from "vitest";
import { imageTurnText } from "../src/lib/imageInput.js";

describe("imageTurnText", () => {
  it("prefixes the description with [image reçue]", () => {
    expect(imageTurnText("Capture d'écran d'un paiement Wave de 10 000 FCFA.")).toBe(
      "[image reçue] Capture d'écran d'un paiement Wave de 10 000 FCFA.",
    );
  });

  it("appends the client's caption on its own line when present", () => {
    const turn = imageTurnText("Capture d'écran d'un paiement Wave.", "j'ai payé, regarde");
    expect(turn).toBe(
      "[image reçue] Capture d'écran d'un paiement Wave.\n[légende du client] j'ai payé, regarde",
    );
  });

  it("ignores an empty or whitespace-only caption", () => {
    expect(imageTurnText("Une photo du studio.", "   ")).toBe("[image reçue] Une photo du studio.");
    expect(imageTurnText("Une photo du studio.", undefined)).toBe("[image reçue] Une photo du studio.");
  });
});
