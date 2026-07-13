# Plan — Pack Découverte & plan activation: final decision

## Context

Two product tracks for Awa plan sales (Babakar, 13/07):

| Track | Goal | Status |
|---|---|---|
| **A — Eligibility** | Never sell Pack Découverte to someone who already did Pilates at Revive | **Shipped** (`a6ad317`) |
| **B — Activation** | After payment, activate the plan without client pain | **B1 shipped; B2 closed as no-go** |

Live Wix probes (13/07) settled B2:

| Case | Offline order |
|---|---|
| Bare contact (no member) + `memberId = contactId` | **400** `MEMBER_DOESNT_EXIST` |
| Create member via API (`POST /members/v1/members`) then offline | **200** ACTIVE (even `status: PENDING`) |
| Create member via API | **Client receives Wix email** (invite / set-password / welcome) |
| Dashboard manual plan assign | Staff can choose **send email or not** — that control is **not** available on the API path we probed |

**Product conclusion:** Awa must **not** auto-create members to activate plans. The email is unacceptable for a silent WhatsApp payment flow. Reception keeps the dashboard path (optional email). Awa auto-activates **only when a member already exists**.

Clarify language for docs/code comments:

- Non-members **can have** plans (dashboard, CRM).
- **API** `createOfflineOrder` **requires** a real `memberId`.
- Having ≠ auto-activating via Awa.

---

## Final product rules (locked)

### A. Pack Découverte eligibility (done)

Server decides, before any payment link:

1. Plan is discovery if `isDiscoveryPlan(name)` → `/découverte|discovery|essai|trial/i`.
2. If linked `contactId` and `hasPastPilatesBooking(contactId)` (any CONFIRMED/PENDING booking whose title matches `/pilates/i`) → refuse with `discovery_not_eligible`; Awa offers à-la-carte.
3. No contact / unlinked → sell without asking (minimal friction; accepted blind spot).
4. Wix/history errors → fail-open (`false`); never block a sale on a bug.
5. Aquabike/yoga alone do **not** disqualify.
6. Scope = Pilates **presence**, not “already bought discovery pack”.

### B. Plan activation after payment (done + closed)

| Client state at link creation | Behaviour |
|---|---|
| `memberId` resolved | Auto: `createOfflinePlanOrder` in webhook → ACTIVATED + client “plan active” |
| `memberId` null | Manual: stay PAID → email réception → client told activation by team (B1 note **before** pay) |
| Lazy `createMember` in webhook | **No-go** (Wix email to client) |

No new activation feature until Wix offers create-member without email (or site settings fully suppress it and we re-probe).

---

## Recommended remaining work (docs + hygiene only)

No product code for B2. Small doc/comment alignment so the next agent does not re-open the wrong path.

### 1. Record probe outcome in `PROGRESS.md`

Replace “étape 2 EN ATTENTE d’un probe” with closed decision:

- Probes: bare contact fails; createMember works + **emails**; B2 **abandoned**.
- Auto-activation only if `member_id` set at link creation.
- Manual = dashboard (optional email); Awa must not create members for activation.
- Point to `scripts/probe-contact-plan.ts` / `scripts/probe-create-member.ts` if kept for re-check after Wix setting changes.

### 2. Fix overstated comments in code

Update wording in:

- `src/lib/wix.ts` — `createOfflinePlanOrder` / `resolveMemberIdForPlan` comments  
- `scripts/probe-create-member.ts` header (if kept)  
- Reception copy in `processPlanPayment` is already correct; optional tighten: “attribuer le plan dans Wix (dashboard → option email off si possible)”

Accurate phrasing:

> Offline API requires a Wix **member** id. Contacts can hold plans when assigned in the dashboard. Awa does not create members (API emails the client).

### 3. Ops probe script

- Keep `scripts/probe-contact-plan.ts` (local) as the re-validation tool if Babakar later disables Wix welcome emails site-wide.
- Optional: add npm script `wix:probe-contact-plan` + commit the file, or leave untracked.
- **Do not** wire create-member into production fulfillment.

### 4. Cleanup test data (ops, manual)

Cancel free test orders / junk members from probes if still active:

- `bbd25011@gmail.com` / test test — free *Programme Ambassadrice*  
- `bbd2501+test@gmail.com` / Baba Test — free plan + member `3bc20458-…`  
- Contact *Probe NoMember* if still in CRM  

### 5. Explicit non-goals

- No lazy `createMember` in `processPlanPayment`.
- No offline order with bare `contactId` (proven 400).
- No discovery pre-flag in dynamic context (nice-to-have; gate is enough).
- No block on “already bought discovery pack” (presence only).
- No plan-fulfillment lease/reconcile in this plan (separate robustness track).

---

## Already in production (no re-implement)

| Piece | Location |
|---|---|
| `isDiscoveryPlan` | `src/lib/wix.ts` |
| `hasPastPilatesBooking` | `src/lib/wix.ts` |
| Gate `discovery_not_eligible` | `src/agent/tools.ts` → `create_plan_payment_link` |
| business-info discovery rule | `business-info.md` |
| Unit tests | `test/discoveryPlan.test.ts` |
| B1 `manual_after_payment` + activation note | `src/agent/tools.ts` |
| Auto offline when `member_id` set | `src/domain/fulfillment.ts` → `processPlanPayment` |

---

## Verification (already done + regression)

**Probes (done):**

- Contact-only offline → fail  
- createMember + offline → success + email received  
- Dashboard mental model: email optional for humans only  

**Code regression (if only docs change):**

```bash
npm run build && npm test
```

**Live (when convenient):**

1. Linked client with past Pilates → Pack Découverte refused → à-la-carte.  
2. Linked without Pilates → discovery link OK.  
3. Unknown number → discovery OK without past questions.  
4. Client **with** Wix member → plan pay → auto ACTIVE.  
5. Client **without** member → plan pay → manual path + honest pre-pay warning; réception activates in dashboard without email if preferred.

---

## Execution checklist (when implementing remaining docs work)

1. Update `PROGRESS.md` (B2 closed + probe summary).  
2. Soften/correct “member-only” comments in `wix.ts` (+ probe script header if committed).  
3. Optionally commit `scripts/probe-contact-plan.ts` + package.json script.  
4. `npm run build && npm test`.  
5. Commit + push only those doc/script files (not unrelated dirty work: new-chat notify, etc.).  
6. Manual Wix cleanup of probe junk.

**Effort:** ~30–60 minutes. **Risk:** none to payment path if code behaviour unchanged.
