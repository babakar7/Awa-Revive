# Implementation plan — selected UX improvements

## Context

Implement **only** these eight items from the UX audit (all others dropped):

| # | Item |
|---|---|
| **6** | Class-aware pre-class tips (tenue / what to bring) |
| **7** | “Mes prochains cours” as a first-class shortcut |
| **9** | Waitlist reliability outside 24h (Meta Utility template — you create it) |
| **12** | Payment return pages → deep link back to WhatsApp |
| **13** | Café menu photos |
| **15** | First-session micro-onboarding (must not clash with account-linking invite) |
| **17** | Custom domain for payment links (DNS on Wix) |
| **18** | Formal receipt / invoice after payment |

Keep invariants: payment-first, server decides prices/slots/16h, no café rebundled into class link, mandatory client messages stay **server-sent** where already established.

---

## 6 — Class-aware pre-class tips

**Goal:** After a booking is confirmed, append one short, deterministic “what to bring” line based on class type.

**Approach:**
- Add a pure helper (e.g. `src/lib/classTips.ts`) that maps service **name** (lowercased) → tip string, fr/en/wo.
- Match categories already in `business-info.md`:
  - Reformer / Pilates / Fusion / Yoga / Inversion → chaussettes antidérapantes (Reformer) / tenue sport
  - Aquabike / Aquagym / Natation / Bébé Nageur → maillot / lycra
  - Cardio Boxe → baskets propres + eau
  - Default → arrive 10 min early (optional, only if no specific tip)
- Call from:
  - `confirmationMessage` in `src/webhooks/wave.ts` (Wave-paid classes)
  - membership success path note / confirmation text after `book_with_membership` (so plan bookings get the tip too)
- Never invent tips in the model; no Wix catalog changes required.

**Tests:** unit tests for name → tip mapping (edge cases: unknown class, mixed case, multi-word).

---

## 7 — “Mes prochains cours” shortcut

**Goal:** Clients with upcoming bookings can open them in one tap (or clear free-text path), without rephrasing.

**Approach:**
- In `dynamicContext` (`systemPrompt.ts`): when client has ≥1 upcoming booking (cheap local query already available via repo patterns used by `get_my_bookings` / agent context — wire a lightweight flag or list), inject a short note: if the client is vague or asks what you can do, offer `present_options` with e.g. `[Mes prochains cours]` / `[Réserver]` / `[Autre]`.
- Prompt rule: on tap “Mes prochains cours” → call `get_my_bookings` immediately and present results (cancel/reschedule still via existing tools).
- Free text “mes cours”, “mes résas”, “c’est quand mon cours” still works unchanged.

**Avoid:** Sending this interactive on every message (spam). Only when intent is open/vague or they explicitly ask for help, and only if they have upcoming bookings.

**Files:** `systemPrompt.ts` (dynamic context + booking flow notes), possibly `agent/index.ts` if we pass upcoming-count into context.

---

## 9 — Waitlist template (outside 24h)

**Goal:** When a waitlisted spot frees up, notify even if the client is outside Meta’s 24h free-text window.

**You create the Meta template.** Suggested shape (align with existing renewal pattern):

| | |
|---|---|
| Name | e.g. `waitlist_spot_open` (exact name → env) |
| Category | **Utility** |
| Language | `fr` (and en/wo later if needed) |
| Body vars | `{{1}}` class name, `{{2}}` date/time label |
| Example body | `Bonne nouvelle — une place s'est libérée pour {{1}} ({{2}}) ! Réponds vite sur WhatsApp pour la réserver — premier arrivé, premier servi.` |

**Code (mirror `renewalNudge.ts`):**
- Config: `WA_WAITLIST_TEMPLATE`, `WA_WAITLIST_TEMPLATE_LANG` (optional; empty = keep free-text only).
- In `sweepWaitlist` (`waitlistSweep.ts`):
  1. Try free-text first **or** prefer template always when configured (recommended: **template when set**, so one path works in and out of 24h).
  2. On send failure without template → `NOTIFY_FAILED` (current).
  3. Log assistant turn with same text as today so Awa knows context when they reply.
- Update join_waitlist tool note / prompt: drop “only if recent chat” honesty once template is live; until template is empty, keep honest copy that notify may fail outside 24h.

**Files:** `config.ts`, `.env.example`, `waitlistSweep.ts`, `whatsapp.ts` (`sendTemplate` already exists), tests for message builders / config gate.

**Ops:** After Meta approval, set env on Railway and redeploy.

---

## 12 — Payment return pages → WhatsApp deep link

**Goal:** After Wave redirect, one tap returns to the Awa chat.

**Approach:**
- Update HTML in `src/server.ts` for `/payment/success` and `/payment/error`.
- Prominent button/link: `https://wa.me/221789536676` (or derive from config if we add `WA_PUBLIC_NUMBER`; hardcoding Awa’s public number matches `business-info.md`).
- Success: prefill optional text e.g. `J'ai payé` via `?text=`.
- Keep short note that confirmation also arrives automatically on WhatsApp.

**Tests:** optional snapshot/string assert on HTML containing `wa.me`.

---

## 13 — Café menu photos

**Goal:** When the client asks for “le menu” / catalogue, Awa can send visual menu board(s), not only the 10-row interactive list.

**Approach:**
- Store static image(s) under `assets/cafe/` (e.g. `menu-1.png`, `menu-2.png`) — owner-replaceable; document in README / cafe-menu.md header.
- Helper `sendCafeMenuImages(waPhone)` using existing `sendImage` (same upload path as schedule).
- Integration options (pick simpler):
  - **A (recommended):** New small tool or extend menu presentation path: when presenting the full menu / “voir le menu”, server or tool sends image(s) **then** interactive favourites list (photos don’t replace ordering ids).
  - **B:** Only on explicit “envoie le menu en photo”.
- Prefer **A + light prompt rule**: photo(s) then incontournables list; free-text order still accepted.
- If assets missing → skip images silently, keep list (no broken UX).

**Constraints:** Prices still only from `cafe-menu.md` / `computeExtras`. Images are marketing, not priced.

**Tests:** “no assets → no throw”; with fixtures → `sendImage` called (mock).

---

## 15 — First-session micro-onboarding (anti-clash with linking)

**Goal:** Vague first messages get a clear capability menu without fighting the **account-linking** invite.

### Clash analysis (current behaviour)

In `agent/index.ts`, after Awa’s reply:

1. If `shouldOfferLinking` → server sends `emailAskMessage` (link or create account) and sets `email_prompted_at`.
2. Separately, café offer may fire after membership book.

Stacking **greeting + interactive onboarding list + emailAskMessage** on the first turn is too much and competes for attention (email linking is higher stakes: wrong Wave charge).

### Anti-clash rules (product)

| Situation | Behaviour |
|---|---|
| `shouldOfferLinking === true` | **Do not** send micro-onboarding this turn. Prefer the linking invite only (after the real answer). |
| Linking already done / prompted / linked | Micro-onboarding **allowed** on vague openers (first session or rare help ask). |
| Client already stated intent (“je veux Reformer lundi”) | **No** onboarding menu — go straight to tools. |
| Onboarding was shown | Free text always still works; options map to existing tools (`get_class_schedule`, booking flow, `check_membership` / plans, café menu, `handoff_to_human`). |

### Implementation

- **Prompt-only interactive** via `present_options` when:
  - client language intent is vague, AND
  - dynamic context flag `offer_onboarding: true` (server computes: few/no prior assistant turns, not `unlinkedNeverAsked`, not mid payment/verification).
- Suggested options (≤5, list or buttons):  
  `Réserver un cours` · `Voir le planning` · `Mon abonnement` · `Commander au café` · `Parler à la réception`
- **Do not** add “Relier mon compte” to this list if we skip onboarding while unlinked — linking remains the dedicated server message.
- Optional: if we ever want both, **merge** linking into onboarding only with explicit product sign-off; default is **mutual exclusion** above.

**Files:** `systemPrompt.ts`, `agent/index.ts` (flag into `dynamicContext`), unit test for “onboarding suppressed when shouldOfferLinking”.

---

## 17 — Custom domain (Wix DNS)

**Goal:** Payment success/error URLs look like Revive, not `*.up.railway.app`.

**Code reality:** Wave already uses:

```ts
success_url: `${config.BASE_URL}/payment/success`
error_url:   `${config.BASE_URL}/payment/error`
```

So **no app rewrite is required** if `BASE_URL` becomes the custom domain and that host reaches this Fastify service. Admin links also use `BASE_URL`.

### Ops steps (DNS on Wix)

1. Choose host, e.g. `bookings.revive.sn` or `pay.revive.sn` (subdomain on the existing Revive domain).
2. In **Wix DNS** for revive.sn: add **CNAME** (or A record per Railway docs) pointing to the Railway-provided domain.
3. In **Railway**: add the custom domain to the service, wait for TLS.
4. Set production `BASE_URL=https://bookings.revive.sn` (no trailing slash).
5. Redeploy / restart so Wave checkouts pick up new success/error URLs.
6. Smoke-test: create a checkout → pay (or abandon) → browser lands on branded host → wa.me button works (#12).

**Optional code:** none, or a one-line README / PROGRESS note. Do **not** host payment pages on Wix site builder (would duplicate routes and break admin on same BASE_URL). Keep pages on this service; Wix is only DNS.

---

## 18 — Formal receipt after payment

**Goal:** Client can get a studio-branded proof without a handoff for simple “reçu”.

**Approach:**
- After successful class payment (and optionally café / plan payment), generate a **receipt image** with `@napi-rs/canvas` (already used for schedule — same fonts in `assets/fonts/`).
- Content: Revive, client name, service/plan, datetime (if class), amount XOF, payment ref / booking id, “payé via Wave”, date of payment.
- Send via `sendImage` after (or as part of) confirmation flow in `wave.ts` (`processPayment` / cafe / plan handlers).
- Prompt: for “reçu / facture”, if a recent BOOKED/PAID row exists, resend receipt (new tool `send_receipt` or branch in agent) instead of immediate handoff; keep handoff for **facture officielle / SIRET / company** wording.

**Scope v1:** image receipt for Wave class booking + café + plan (same renderer, different fields). No PDF unless needed later.

**Tests:** pure render doesn’t throw; layout smoke; currency formatting.

---

## Suggested implementation order

```text
1. #12  Payment pages wa.me          — tiny, isolated
2. #6   Class tips on confirmation   — pure helper + copy
3. #18  Receipt image                — canvas + wave webhook
4. #9   Waitlist template wiring     — blocked on Meta name until you set env
5. #13  Café menu photos             — assets + send path
6. #7   Mes prochains cours          — context + prompt
7. #15  Micro-onboarding             — after #7 patterns; anti-clash tests
8. #17  Custom domain                — ops/DNS only (can be anytime)
```

---

## Critical files

| Item | Files |
|---|---|
| 6 | `src/lib/classTips.ts` (new), `src/webhooks/wave.ts`, `src/agent/tools.ts` (membership note) |
| 7 | `src/agent/systemPrompt.ts`, `src/agent/index.ts`, `src/domain/repo.ts` (if helper for upcoming count) |
| 9 | `src/config.ts`, `src/domain/waitlistSweep.ts`, `.env.example` |
| 12 | `src/server.ts` |
| 13 | `assets/cafe/*`, `src/lib/cafeOffer.ts` or tools, `src/agent/systemPrompt.ts` |
| 15 | `src/agent/systemPrompt.ts`, `src/agent/index.ts`, `src/lib/linkAsk.ts` (predicate reuse) |
| 17 | Railway + Wix DNS + `BASE_URL` (no code) |
| 18 | `src/lib/receiptImage.ts` (new), `src/webhooks/wave.ts`, `src/lib/whatsapp.ts`, prompt handoff list |

---

## Verification

1. `npm run build && npm test` (and integration if wave paths touched).
2. **#12:** Open `/payment/success` and `/payment/error` → wa.me works on mobile.
3. **#6:** Book Reformer vs Aquabike (simulate webhook) → tip differs.
4. **#18:** After simulated Wave complete → image receipt on WhatsApp.
5. **#9:** With template env set, force waitlist notify (or unit-test template branch); with env empty, free-text path unchanged.
6. **#13:** “Le menu” → image(s) + list; missing assets → list only.
7. **#7:** Client with upcoming booking, vague “salut” → option to list bookings; tap works.
8. **#15:** Unlinked first user → **linking message only**, no onboarding list. Linked vague user → onboarding OK.
9. **#17:** BASE_URL custom host; Wave redirect hits it; TLS OK.

---

## Out of scope (explicitly dropped)

Session reminders, interactive refund/expiry nudges, Wave auto-refund copy changes, Orange Money, named group participants, private sessions automation, Wolof native rewrite pass, rebundling café into class payment.
