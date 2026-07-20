import type { FastifyReply, FastifyRequest } from "fastify";
import { ADMIN_AUTH_CSS } from "./adminStyles.js";

function wantsHtml(req: FastifyRequest): boolean {
  const accept = String(req.headers.accept ?? "");
  return req.method === "GET" && (accept.includes("text/html") || !accept || accept === "*/*");
}

function accessDeniedPage(username: string): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>Accès propriétaire — Revive admin</title><style>${ADMIN_AUTH_CSS}</style></head>
<body><main class="auth-card">
  <div class="auth-brand"><span class="auth-mark" aria-hidden="true">r</span><span><b>revive</b><small>Espace propriétaire</small></span></div>
  <h1>Accès propriétaire requis</h1>
  <p>Le compte <b>${escapeHtml(username)}</b> est un compte équipe. Les paiements des coachs sont réservés au compte propriétaire.</p>
  <form method="post" action="/admin/logout"><button type="submit">Changer de compte</button></form>
  <p class="muted"><a href="/admin">Retour à l’administration</a></p>
</main></body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Role guard for every coach-payment page, PDF and mutation. */
export async function ownerPaymentsAuthHook(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  reply.header("Cache-Control", "no-store");
  if (req.adminRole === "owner") return;

  if (wantsHtml(req)) {
    return reply
      .code(403)
      .type("text/html")
      .send(accessDeniedPage(req.adminUser ?? "équipe"));
  }
  return reply.code(403).type("text/plain").send("Accès propriétaire requis.");
}
