import Fastify from "fastify";
import { registerWhatsAppWebhook } from "./webhooks/whatsapp.js";
import { registerWaveWebhook } from "./webhooks/wave.js";
import { registerOrangeMoneyWebhook } from "./webhooks/orangeMoney.js";
import { registerAdmin } from "./admin/routes.js";
import { pool } from "./db/index.js";

const HEALTHCHECK_TIMEOUT_MS = 2_000;

/** Readiness check: the process is useful only while Postgres answers. */
export async function checkDatabaseHealth(timeoutMs = HEALTHCHECK_TIMEOUT_MS): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("database healthcheck timed out")), timeoutMs);
    });
    await Promise.race([
      pool.query("select 1"),
      timeout,
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function buildServer() {
  const app = Fastify({ logger: true, trustProxy: true });

  // Keep the raw body — both webhook signatures are HMACs over the raw bytes.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (req, body: Buffer, done) => {
      (req as any).rawBody = body;
      try {
        done(null, body.length ? JSON.parse(body.toString("utf8")) : {});
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // Admin dashboard forms (webhooks never use this content type).
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body: string, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body)));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.get("/healthz", async (_req, reply) => {
    const ok = await checkDatabaseHealth();
    return reply.code(ok ? 200 : 503).send({ ok });
  });

  registerWhatsAppWebhook(app);
  registerWaveWebhook(app);
  registerOrangeMoneyWebhook(app);
  registerAdmin(app);

  // Minimal "return to WhatsApp" pages for Wave success/error redirects (SPEC §4.3).
  // wa.me link is bare (no ?text= prefill): Awa never confirms a booking from
  // a client claim — only the Wave webhook does (payment-first invariant).
  const AWA_WA_ME = "https://wa.me/221789536676";
  const returnPage = (title: string, emoji: string, note: string) => `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f6f3ee;color:#222;text-align:center}main{padding:2rem;max-width:22rem}h1{font-size:3rem;margin:0}a.wa{display:inline-block;margin-top:1.25rem;padding:.85rem 1.4rem;background:#25D366;color:#fff;text-decoration:none;border-radius:999px;font-weight:600;font-size:1.05rem}</style>
</head><body><main><h1>${emoji}</h1><p><strong>${title}</strong></p><p>${note}</p><a class="wa" href="${AWA_WA_ME}">Retourner sur WhatsApp 📲</a></main></body></html>`;

  app.get("/payment/success", async (_req, reply) =>
    reply
      .type("text/html")
      .send(
        returnPage(
          "Paiement effectué",
          "✅",
          "Votre confirmation arrive automatiquement sur WhatsApp dans un instant.",
        ),
      ),
  );
  app.get("/payment/error", async (_req, reply) =>
    reply
      .type("text/html")
      .send(
        returnPage(
          "Paiement non abouti",
          "😕",
          "Le paiement n'a pas abouti. Réessayez depuis le lien sur WhatsApp.",
        ),
      ),
  );

  return app;
}
