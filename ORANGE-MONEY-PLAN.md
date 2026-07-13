# Plan — Orange Money / Max It payments in Awa

## Context

Awa today takes class / plan / bar payments **only via Wave**. The site already uses **Orange Money** (prod app live). We verified:

| Check | Result |
|---|---|
| Prod OAuth `POST https://api.orange-sonatel.com/oauth/token` | **200**, bearer ~5 min |
| QR create `POST /api/eWallet/v4/qrcode` + merchant `553651` | **200** |
| Response | `deepLink`, `deepLinks.OM` + `deepLinks.MAXIT` (same URL), `qrCode` PNG, `qrId`, `validFor` |
| Sandbox OAuth | also works |
| Status GET by `qrId` (several path guesses) | **404** — no known poll API yet |
| App code for OM | **none** (env only) |

**Goal:** clients can pay Awa with **Wave**, **Orange Money**, or **Max It** (parity with the website, where OM and Max It are **separate choices**), without breaking the **payment-first** invariant (Wix booking only after verified payment).

### API reality vs website UX

One Sonatel QR create call returns:

- `deepLinks.OM` — open in **Orange Money**
- `deepLinks.MAXIT` — open in **Max It**
- (In our prod probe those URLs were identical; still treat them as **two product choices** like the site, and always prefer the matching `deepLinks.*` key so if they diverge later Awa stays correct.)

Backend: **one QR session** (`qrId`) for both; **which link we send** depends on the client’s choice.

---

## Product UX (align with website)

### When to choose a method

1. Client already names a method → use it and create payment immediately:
   - Wave / “wave”
   - Orange Money / OM / “orange”
   - Max It / Maxit / “max it”
2. Otherwise (after slot + name known) → `present_options` **three buttons** (same idea as the site):
   - `Payer Wave` (`id: pay_wave`)
   - `Payer Orange Money` (`id: pay_om`)
   - `Payer Max It` (`id: pay_maxit`)
3. Then create the payment for the chosen rail.

Same pattern for **plan** and **bar** payment links.

### What the client receives

| Choice | Link sent | Copy |
|---|---|---|
| Wave | `wave_launch_url` | existing Wave wording |
| Orange Money | `deepLinks.OM` (fallback `deepLink`) | amount + expiry + “ouvre dans **Orange Money**” |
| Max It | `deepLinks.MAXIT` (fallback `deepLink`) | amount + expiry + “ouvre dans **Max It**” |

- WhatsApp: one HTTPS deep link (no QR PNG required in v1).
- Spot confirmed **only** after payment is verified (same as Wave).

### Copy / business-info

Update `business-info.md` § Paiement: Awa accepts **Wave, Orange Money et Max It** (not “Wave only”). Handoff if none work.

---

## Architecture (mirror Wave)

```
Client chooses Wave | Orange Money | Max It
    → createDraft*
    → Wave: createCheckoutSession  OR  OM API: createQrPayment (one qrId)
    → AWAITING_PAYMENT
         payment_method = wave | orange_money | maxit
         payment_link   = wave URL | deepLinks.OM | deepLinks.MAXIT
         session id     = wave session id | qrId
    → client pays in the chosen app
    → webhook (or verified completion)
    → PAID atomic → fulfillPaidBooking / plan activate / bar PAID
    → WhatsApp confirmation (existing)
```

**Invariant:** only the **payment confirmation path** creates Wix bookings — same as Wave. OM/Max It call the **same** `fulfillPaidBooking` / plan / bar handlers after `PAID`.

### Recommended module split

| Piece | Role |
|---|---|
| `src/lib/orangeMoney.ts` | OAuth token cache, `createQrPayment`, pick OM vs Max It link from `deepLinks`, webhook verify (once known) |
| `src/webhooks/orangeMoney.ts` | `POST /webhooks/orange-money` → shared processPayment (covers both OM and Max It pays) |
| Shared fulfill | Extract or call existing fulfillment with provider-agnostic `clientReference` |
| `config.ts` | optional OM env: if unset, only Wave is offered |

### Data model

Keep existing tables:

| Column (existing) | Wave | Orange Money | Max It |
|---|---|---|---|
| `payment_method` | `wave` | `orange_money` | `maxit` |
| `wave_session_id` | Wave session id | **`qrId`** (same for both OM rails) | same `qrId` |
| `payment_link` | `wave_launch_url` | `deepLinks.OM` | `deepLinks.MAXIT` |
| `link_expires_at` | TTL | min(our TTL, `validFor.endDateTime`) | same |

No new tables for v1. Idempotency: `processed_webhooks` with `om:{eventOrQrId}` (one payment event for either app).

### Config (env)

Already in `.env`:

- `OM_CLIENT_ID`, `OM_CLIENT_SECRET`, `OM_MERCHANT_CODE=553651`
- optional `OM_SANDBOX_*` for later

Add to `config.ts` as **optional** (empty = feature off):

- `OM_CLIENT_ID`, `OM_CLIENT_SECRET`, `OM_MERCHANT_CODE`
- `OM_API_BASE` default `https://api.orange-sonatel.com`
- `OM_WEBHOOK_SECRET` if portal provides one (TBD)
- `OM_TOKEN` cache in-memory (refresh before `expires_in`)

Railway: set the three prod vars when shipping.

---

## Payment confirmation (critical design choice)

Wave has a solid signed webhook. OM is less clear in open docs.

### Primary (must have)

**Webhook** `POST /webhooks/orange-money` registered in Sonatel portal (NOTIFICATION product already on the app per PROGRESS).

Implementation approach:

1. Accept POST, log **raw body + headers** (first days), return 200 quickly.
2. Once payload shape is known (or from website code if available): extract **paid status**, **amount**, **order/metadata** (`metadata.order` = our pending id — we already send this on QR create).
3. Verify authenticity (shared secret / signature / IP allowlist — whatever portal documents).
4. Same state machine: `AWAITING_PAYMENT|EXPIRED → PAID` → fulfill.

**Ops:** register  
`https://resabot-production.up.railway.app/webhooks/orange-money`  
(or custom domain later) on the **same** OM app as the website if one callback URL is shared — then route by `metadata.order` prefix (`awa:…` vs web). Prefer metadata:

```json
"metadata": { "order": "<pending_booking_uuid>", "channel": "awa" }
```

### Secondary (hardening)

| Mechanism | Use |
|---|---|
| Success URL | `${BASE_URL}/payment/success?ref=<id>&provider=om` — page still says “confirmation on WhatsApp”; optionally enqueue a “check this ref” job if a status API appears |
| Client “j’ai payé” | **Never** mark paid (same as Wave screenshots) |
| Polling | Status GET by `qrId` not found yet — skip until portal docs/website code reveal endpoint |

### Risk if webhook is delayed

If website already relies on a known notification payload, **reuse that format** (best source of truth — ask for a sample or the website handler). Plan assumes we align with the live site.

---

## Tooling / agent changes

### `create_payment_link` / `create_plan_payment_link` / `create_cafe_payment_link`

Add `payment_method: "wave" | "orange_money" | "maxit"`.

**Server decision (recommended):**

- When OM env is configured, `payment_method` is **required** (or model must have just used present_options); missing/invalid → error: offer the three buttons.
- When OM env missing → only `wave` accepted; reject `orange_money` / `maxit`.
- `orange_money` and `maxit` both call the **same** `createQrPayment`; server selects `deepLinks.OM` vs `deepLinks.MAXIT` for `payment_link`.

```ts
if (method === "wave") {
  session = await wave.createCheckoutSession(...)
  link = session.wave_launch_url
  sessionId = session.id
} else {
  // method === "orange_money" | "maxit"
  const qr = await om.createQrPayment({ amountXof, clientReference: draft.id, ... })
  link = method === "maxit"
    ? (qr.deepLinks.MAXIT ?? qr.deepLink)
    : (qr.deepLinks.OM ?? qr.deepLink)
  sessionId = qr.qrId
}
await repo.setAwaitingPayment(draft.id, sessionId, link, expiresAt, { payment_method: method })
```

### Prompt

- Three methods when OM enabled (match website): Wave, Orange Money, Max It.
- Flow: present_options if unclear → create_* with that method → relay **the** link for that app; never invent paid.
- Screenshots still not proof.

### Admin / summary

- Show `payment_method` on bookings (admin already shows it in places).
- Receipts: “payé via Wave” vs “payé via Orange Money”.

---

## Implementation order

1. **`orangeMoney.ts`**: token cache + `createQrPayment` (unit-testable pure parts; integration optional).
2. **Config + schema/repo**: optional OM env; `setAwaitingPayment(..., payment_method)`.
3. **Tools**: method param on three create_* link tools; present_options for choice.
4. **Webhook stub**: `/webhooks/orange-money` — verify if possible, parse metadata.order, call shared processPayment; **log unknown payloads**.
5. **Prompt + business-info**.
6. **Tests**: token mock, QR create mock, webhook happy path → BOOKED (reuse wave integration patterns), method choice validation.
7. **Ops**: Railway env + portal webhook URL; smoke test 100 XOF sandbox or prod small amount.

---

## Out of scope (v1)

- Auto-refund via OM API (same as Wave: manual / reception).
- Separate merchant apps for web vs Awa (shared app OK; distinguish via metadata).
- Sending QR PNG (deep link is enough).
- Replacing Wave (Wave stays default/alternate).

---

## Critical files

| File | Change |
|---|---|
| `src/lib/orangeMoney.ts` | **new** — API client |
| `src/webhooks/orangeMoney.ts` | **new** — webhook |
| `src/server.ts` | register webhook |
| `src/config.ts` | OM env |
| `src/agent/tools.ts` | method on create_* links |
| `src/agent/systemPrompt.ts` | UX rules |
| `src/domain/repo.ts` | payment_method on await payment |
| `src/webhooks/wave.ts` | extract shared `processPayment` or import from `domain/payments.ts` |
| `business-info.md` | Wave + OM |
| `.env.example` / Railway | vars |
| `test/*` | unit + integration |

---

## Verification

1. `npm run build && npm test` (+ integration).
2. OM disabled (no env) → Wave-only unchanged.
3. Unit: QR request body has merchant code, metadata.order = booking id, validity.
4. Integration mock: OM webhook paid → BOOKED + WhatsApp confirm path.
5. E2E: WhatsApp → choose OM → open Max It/OM link → pay 100 XOF → confirm within ~1 min.
6. Wave path regression: still works.

---

## Open dependency (ops, not code)

- **Notification webhook payload** from Sonatel (or copy from website). Until known: implement create + stub webhook + log; complete parser after first real callback.
- If website repo is available, reuse its OM success handling — fastest path to correct fulfillment.

---

## Summary

Match the **website**: three explicit choices — **Wave**, **Orange Money**, **Max It**. One Sonatel QR session; send `deepLinks.OM` or `deepLinks.MAXIT` accordingly (`payment_method` = `wave` | `orange_money` | `maxit`). Confirm only via verified webhook (same fulfill pipeline as Wave). Prod credentials + merchant `553651` already create QRs successfully.
