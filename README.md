# Revive Bookings — WhatsApp Booking Agent (Phase 1)

An AI agent on WhatsApp that books clients into classes at **Revive** (studio) via Wix Bookings, taking payment first via **Wave** (Senegal mobile money). Conversation is handled by Claude; all state lives in Postgres.

> **Payment-first invariant:** a booking is NEVER created in Wix until a Wave payment webhook is verified. The Wix booking is created in exactly one place: the Wave webhook handler ([src/webhooks/wave.ts](src/webhooks/wave.ts)).

## Architecture

```
Client (WhatsApp)
   │  inbound msg
   ▼
Meta WhatsApp Cloud API ──webhook──► This service ◄──webhook── Wave (payment events)
                                        │
                         ┌──────────────┼──────────────┐
                         ▼              ▼              ▼
                   Claude API      Wix Bookings     Postgres
                  (conversation)  (availability,   (state, logs)
                                   create booking)
```

Single deployable Fastify service. No frontend — everything happens in WhatsApp, plus two tiny "return to WhatsApp" pages for Wave redirects.

## Setup

Requirements: **Node 20+**, **Postgres** (any managed instance).

```bash
npm install
cp .env.example .env      # then fill it in (see below)
npm run migrate           # creates tables (idempotent; also runs at boot)
npm run dev               # start with hot reload
```

### Environment variables

| Variable | What / where to get it |
|---|---|
| `WA_PHONE_NUMBER_ID` | Meta app → WhatsApp → API Setup (test number in Phase 1) |
| `WA_ACCESS_TOKEN` | Permanent system-user token (Meta Business settings) |
| `WA_APP_SECRET` | Meta app dashboard → App settings → Basic → App secret |
| `WA_VERIFY_TOKEN` | Any string; must match what you type in the Meta webhook config |
| `WA_APP_ID` | Optional — Meta app ID (not the phone-number id), only needed to change the WhatsApp Business profile photo from `/admin/profile` (resumable upload API is app-scoped) |
| `WA_RENEWAL_TEMPLATE` / `WA_RENEWAL_TEMPLATE_LANG` | Optional — approved Meta template for the pre-expiry renewal nudge (3 vars: name, plan, end date). Empty = renewal push disabled (the in-conversation renewal offer still works). Lang defaults to `fr` |
| `RENEWAL_NUDGE_DAYS` | Optional — days before a plan's end date to send the renewal nudge (default 3) |
| `WIX_API_KEY` / `WIX_SITE_ID` | Wix account → API keys ([docs](https://dev.wix.com/docs/rest/business-solutions/bookings)) |
| `WAVE_API_KEY` | Wave business portal — `wave_sn_prod_...` ([docs](https://docs.wave.com/checkout)) |
| `WAVE_WEBHOOK_SECRET` | `wave_sn_WHS_...` — shown **once** when you register the webhook endpoint in the Wave portal (Developer → Webhooks). Not the `wave_sn_AKS_` request-signing secret. |
| `ANTHROPIC_API_KEY` | console.anthropic.com |
| `CLAUDE_MODEL` | defaults to `claude-sonnet-5` |
| `DATABASE_URL` | Postgres connection string |
| `BASE_URL` | Public HTTPS URL of this service (tunnel URL in local dev) |
| `RECEPTION_PHONE` | Human handoff destination (existing reception WhatsApp) |
| `PAYMENT_LINK_TTL_MINUTES` | Wave link validity (default 20) |
| `STUDIO_ADDRESS` | Shown in booking confirmations |

The service refuses to boot with missing vars and lists them all at once.

### Local development with webhooks

Webhooks need a public HTTPS URL. Use a tunnel:

```bash
ngrok http 3000            # or: cloudflared tunnel --url http://localhost:3000
```

Set `BASE_URL` to the tunnel URL, then:

1. **Meta**: App dashboard → WhatsApp → Configuration → Webhook:
   - Callback URL: `{BASE_URL}/webhooks/whatsapp`
   - Verify token: your `WA_VERIFY_TOKEN`
   - Subscribe to the `messages` field.
2. **Wave**: register `{BASE_URL}/webhooks/wave` in the Wave portal and copy the webhook secret into `WAVE_WEBHOOK_SECRET`.

Phase 1 runs on Meta's **free test number** (up to 5 pre-verified recipients — add them in API Setup). Moving to a production number later only changes `WA_PHONE_NUMBER_ID` and `WA_ACCESS_TOKEN`.

## Simulating Wave payments

Until Wave API access is granted (or to test without paying), simulate the payment webhook:

```bash
# 1. Chat with the bot on WhatsApp until it sends you a payment link.
# 2. Grab the pending booking id (= Wave client_reference):
psql $DATABASE_URL -c "select id, service_name, status from pending_bookings order by created_at desc limit 3;"

# 3. Fire a signed checkout.session.completed event:
npm run simulate:wave -- <pending_booking_id>

# Useful variants:
npm run simulate:wave -- <id> --bad-signature        # must be rejected with 401, no state change
npm run simulate:wave -- <id> --event-id EV_dup      # run twice → second is a no-op (idempotency)
npm run simulate:wave -- <id> --url https://<staging>/webhooks/wave
```

For real-money testing, Wave supports small amounts (e.g. 100 XOF) — configure a cheap test class in Wix.

## Booking flow / state machine

```
DRAFT ──payment link created──► AWAITING_PAYMENT
AWAITING_PAYMENT ──TTL passed──────────────► EXPIRED
AWAITING_PAYMENT ──valid Wave webhook──────► PAID
EXPIRED ──late Wave webhook────────────────► PAID   (money taken; honored)
PAID ──slot still free, Wix booking OK─────► BOOKED
PAID ──slot gone or Wix error──────────────► REFUND_NEEDED
```

- Transitions are single atomic conditional `UPDATE`s ([src/domain/stateMachine.ts](src/domain/stateMachine.ts)) — duplicate webhooks and two-clients-racing-for-the-last-spot resolve safely (first webhook wins; loser → `REFUND_NEEDED`).
- `REFUND_NEEDED` has **no automated refund** in Phase 1: the client is told they'll be refunded within 24h, and the case shows up in `npm run summary` for manual processing in the Wave portal.
- One active payment link per client — creating a new one expires the previous.
- `event_id`s coming from the model are validated against a server-side cache of slots actually shown to that client (prompt-injection stance, SPEC §9). Prices always come from the Wix catalog, never from model output.

## Bar orders

Awa can bundle a bar order (smoothies, matcha, food) into a class booking: one Wave link covers class + bar, the client confirmation lists the items, and reception is notified (email + WhatsApp) to prepare the order — by default ready after the class.

- **Menu source of truth: [cafe-menu.md](cafe-menu.md)** — owner-editable, parsed by the server at boot (restart/redeploy to apply). Item lines are `- ID | Name | price | description`; never change an existing ID (prices are always resolved server-side from this file, the model only passes ids — same anti-injection stance as slots). A broken file (duplicate id, bad price) fails the boot loudly; a missing file just disables bar ordering.
- v1 limitations: no bundling with membership bookings (no payment link) and no bar-only orders — both are counter-only, Awa says so.

## Operations

```bash
npm run summary     # daily plain-text summary: bookings, REFUNDS NEEDED, handoffs, expired links
npm test            # unit tests: signature verifiers, state machine, bar menu, messages
npm run test:integration   # payment-path integration tests — needs Docker running
                           # (throwaway Postgres container; Wix/Wave/Meta mocked, no real API touched)
npm run build && npm start   # production
```

### Admin dashboard (`/admin`)

Server-rendered, zero-dependency dashboard (`src/admin/`) protected by HTTP
Basic Auth. Set `ADMIN_USERS="babakar:pass1,reception:pass2"` (one account per
human — action logs record who clicked); unset → built-in fallback login
`revive` / `revive` (never open, never 503). Pages:
overview ("à traiter": pending refunds with a *remboursement effectué* button,
paid plan orders awaiting manual Wix activation, recent handoffs, day/7-day
stats), conversations (search + full thread incl. collapsed tool calls),
bookings & plan orders (status filters), handoffs. The two buttons only
RECORD manual actions — no money ever moves from the dashboard; refunds are
done by a human in the Wave portal (`npm run refund:done` remains as CLI
fallback).

**Profile page (`/admin/profile`)**: edit the WhatsApp Business profile
(description, address, photo) via the Cloud API's `whatsapp_business_profile`
endpoint. Meta has **no "hours" field** on that endpoint — hours are entered
in their own textarea and folded into the description text as a trailing
block (`composeBusinessDescription` in [src/lib/whatsapp.ts](src/lib/whatsapp.ts)),
truncated to stay under Meta's 512-char description limit. The last-saved
values are kept in the `whatsapp_profile` table so the form round-trips even
though hours have nowhere to live on Meta's side. Photo editing needs an
additional `WA_APP_ID` env var (Meta's resumable upload API is app-scoped,
not phone-number-scoped) — without it the photo field is hidden and
description/address/hours still work.

Deploy target: Railway / Render / Fly.io — anything that runs Node and exposes HTTPS. Set all env vars, point `DATABASE_URL` at managed Postgres; migrations run automatically at boot. The service is stateless apart from Postgres, so restarts mid-flow lose nothing (acceptance #8) — the in-memory rate limiter and Wix catalog cache rebuild themselves.

## Notes & known unknowns

- **Wix API shapes**: paths follow the current Wix REST docs (Services V2, Availability Calendar V1, Bookings V2). Per the spec, verify request/response shapes against [the Wix docs](https://dev.wix.com/docs/rest/business-solutions/bookings) once real credentials are available — [src/lib/wix.ts](src/lib/wix.ts) is the only file to adjust.
- **Wave webhook signature**: `HMAC-SHA256(secret, timestamp + body)` with the `Wave-Signature: t=...,v1=...` header — confirmed against [Wave's webhook docs](https://docs.wave.com/webhook). Make sure the secret in `WAVE_WEBHOOK_SECRET` is the **webhook** secret (`wave_sn_WHS_...`, shown once at endpoint registration), not the API request-signing secret (`wave_sn_AKS_...`).
- **Model**: the spec says `claude-sonnet-latest`; the current alias is `claude-sonnet-5` (set via `CLAUDE_MODEL`).
- The `specs` file in this repo contains a live WhatsApp access token in its env block — it is gitignored until that block is scrubbed. **Consider that token exposed and rotate it in the Meta dashboard.**

## Acceptance checklist (SPEC §10)

1. Happy path FR: greet → list classes → pick slot → pay (simulated webhook) → Wix booking exists → WhatsApp confirmation.
2. Same in EN and Wolof (language mirrored; confirmation templates exist in all three).
3. Expired link → no booking; client can request a fresh link (TTL sweep + lazy expiry).
4. Forged Wave webhook → 401, no state change (`--bad-signature`).
5. Duplicate Wave webhook → exactly one Wix booking (`processed_webhooks` + atomic PAID transition).
6. Slot-taken race → `REFUND_NEEDED` recorded, client notified, no Wix booking.
7. "I want to cancel my class" → handoff row + reception number in reply.
8. Restart mid-flow → no lost state (everything in Postgres).
9. Unit tests: both signature verifiers, state machine transitions (`npm test`).
