import { sendInteractive } from "./whatsapp.js";
import { cafeFavouriteOptions } from "./cafeMenu.js";
import * as repo from "../domain/repo.js";

/**
 * Book-first / menu-after: right after a class booking is confirmed, show the
 * café menu as a SEPARATE order (never bundled into the class payment). Shows
 * the studio "incontournables" DIRECTLY (one present_options-style list) rather
 * than a vague yes/no — a tapped item comes back into the agent, which builds
 * the order and creates a café-only link (create_cafe_payment_link). Used by
 * BOTH flows so the client experience is identical: the Wave webhook (after the
 * payment confirmation) and the agent loop (after book_with_membership).
 * Non-blocking and best-effort by design: a failure here must never break a
 * confirmed booking.
 */
export async function sendCafeMenuOffer(args: {
  waPhone: string;
  clientId: string;
  lang: string;
  log?: { error: (obj: unknown, msg: string) => void };
}): Promise<void> {
  try {
    const options = cafeFavouriteOptions();
    if (options.length === 0) return; // menu unavailable — show nothing
    const { body, button } = cafeMenuOfferCopy(args.lang);
    const kind = await sendInteractive(args.waPhone, body, button, options);
    // Log what the client saw so the rebuilt history stays coherent (same
    // format the present_options tool uses).
    await repo.addTurn(
      args.clientId,
      "assistant",
      `${body}\n[message interactif ${kind} — options : ${options.map((o) => o.title).join(" · ")}]`,
    );
  } catch (err) {
    if (args.log) args.log.error({ err, clientId: args.clientId }, "Café menu offer failed (non-blocking)");
    else console.error(`Café menu offer failed for client ${args.clientId} (non-blocking):`, err);
  }
}

function cafeMenuOfferCopy(lang: string): { body: string; button: string } {
  switch (lang) {
    case "en":
      return {
        body:
          "Fancy something with your session? 🥤 Here are our studio favourites 👇 (scroll to see them all)",
        button: "See the menu",
      };
    case "wo":
      return {
        body:
          "Ndax dangaa bëgg lu mu ànd sa séance? 🥤 Ñii ñooy sunu incontournables 👇 (scroll ngir gis lépp)",
        button: "Xool menu bi",
      };
    default:
      return {
        body:
          "Envie d'accompagner ta séance ? 🥤 Voici nos incontournables 👇 (scrolle pour voir le reste)",
        button: "Voir le menu",
      };
  }
}
