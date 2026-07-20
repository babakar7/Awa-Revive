import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { escapeHtml } from "./helpers.js";
import { layout } from "./layout.js";
import { sendImage, sendText } from "../lib/whatsapp.js";
import { renderStoryImage } from "../lib/storyImage.js";
import {
  dayLabelFor,
  fetchTomorrowStory,
  getLastStoryDate,
  markStorySent,
  storyCaption,
  tomorrowWindow,
} from "../domain/dailyStory.js";

/**
 * Page admin « Story Instagram » : prévisualiser la story de demain (rendue à la
 * volée avec les vraies données Wix) et la renvoyer manuellement sur WhatsApp au
 * gérant. L'envoi automatique du soir reste géré par le sweeper 5 min.
 */
export function registerStoryRoutes(admin: FastifyInstance): void {
  admin.get("/story", async (req, reply) => {
    const done = (req.query as { done?: string })?.done;
    const err = (req.query as { err?: string })?.err;
    const now = new Date();
    const { dateISO } = tomorrowWindow(now);
    const today = now.toISOString().slice(0, 10);
    const last = await getLastStoryDate().catch(() => null);
    const sentToday = last === today;

    const banner = done
      ? `<div class="card success"><span class="ok">✓ ${escapeHtml(done)}</span></div>`
      : err
        ? `<div class="card warn">⚠️ ${escapeHtml(err)}</div>`
        : "";

    const statusHtml = sentToday
      ? `<span class="badge badge--green">Envoyée aujourd'hui</span>`
      : `<span class="badge badge--gray">Pas encore envoyée — départ auto à ${config.STORY_HOUR}h</span>`;

    const phone = config.STORY_PHONE
      ? escapeHtml(config.STORY_PHONE)
      : `<span class="badge badge--gray">STORY_PHONE non configuré</span>`;

    const body = `${banner}
<header class="page-header"><div class="page-header-copy"><span class="eyebrow">Configuration</span><h2>Story Instagram</h2><p>Aperçu de la story des cours de <b>demain</b> (${escapeHtml(dayLabelFor(dateISO).toLowerCase())}), générée à partir des données Wix en direct. Envoyée automatiquement chaque soir à ${config.STORY_HOUR}h sur WhatsApp.</p></div></header>
<div class="card" style="display:flex;gap:2rem;flex-wrap:wrap;align-items:flex-start">
  <div style="flex:0 0 auto">
    <img src="/admin/story/png?inline=1&amp;t=${Date.now()}" alt="Aperçu story de demain" style="width:270px;max-width:100%;border-radius:14px;box-shadow:0 6px 24px rgba(0,0,0,.18)" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'muted',textContent:'Pas de cours demain — aucune story à générer.'}))">
  </div>
  <div style="flex:1 1 260px;min-width:240px">
    <p style="margin:.2rem 0 1rem">Statut : ${statusHtml}</p>
    <p class="muted" style="margin:.2rem 0 1.2rem">Destinataire : ${phone}</p>
    <form method="post" action="/admin/story/send" onsubmit="return confirm('Envoyer la story de demain sur WhatsApp maintenant ?')">
      <button class="act" type="submit"${config.STORY_PHONE ? "" : " disabled"}>Renvoyer maintenant</button>
      <a class="act act--ghost" href="/admin/story/png" style="margin-left:.5rem">Télécharger le PNG</a>
    </form>
  </div>
</div>`;

    reply.type("text/html").send(await layout("Story Instagram", "/admin/story", body, { contentWidth: "standard" }));
  });

  admin.get("/story/png", async (req, reply) => {
    const data = await fetchTomorrowStory();
    if (data.classes.length === 0) {
      return reply.code(404).type("text/plain").send("Pas de cours demain");
    }
    const png = renderStoryImage(data);
    const inline = (req.query as { inline?: string })?.inline === "1";
    reply.type("image/png");
    if (!inline) {
      const { dateISO } = tomorrowWindow(new Date());
      reply.header("content-disposition", `attachment; filename="story-${dateISO}.png"`);
    }
    return reply.send(png);
  });

  admin.post("/story/send", async (_req, reply) => {
    if (!config.STORY_PHONE) {
      return reply.redirect(`/admin/story?err=${encodeURIComponent("STORY_PHONE non configuré")}`, 303);
    }
    try {
      const now = new Date();
      const { dateISO } = tomorrowWindow(now);
      const data = await fetchTomorrowStory(now);
      if (data.classes.length === 0) {
        await sendText(
          config.STORY_PHONE,
          `Pas de cours demain (${storyCaption(dateISO).replace("Story de demain — ", "")}) — pas de story générée.`,
        );
      } else {
        const png = renderStoryImage(data);
        await sendImage(config.STORY_PHONE, png, storyCaption(dateISO));
      }
      // Marque envoyée pour que le job auto du soir ne double pas.
      await markStorySent(now.toISOString().slice(0, 10));
      return reply.redirect("/admin/story?done=Story%20envoy%C3%A9e%20sur%20WhatsApp", 303);
    } catch (err) {
      return reply.redirect(`/admin/story?err=${encodeURIComponent(String((err as Error)?.message ?? err).slice(0, 200))}`, 303);
    }
  });
}
