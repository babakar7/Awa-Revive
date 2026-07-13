# Orange Money / Max It — create a payment link (no terminal copy)

Awa does **not** send a QR image. It creates a payment session and gives you an
**HTTPS link** that opens the **Orange Money** or **Max It** app on the phone.

---

## Easiest way (recommended)

### 1. In Terminal, only run this (you don’t need to copy the output)

```bash
cd /Users/BABS/Desktop/WEB/projects/resabot
npm run om:create-link -- 100
```

### 2. Open this file in Finder / TextEdit / Cursor

```
/Users/BABS/Desktop/WEB/projects/resabot/om-last-links.txt
```

Or from Terminal:

```bash
open /Users/BABS/Desktop/WEB/projects/resabot/om-last-links.txt
```

### 3. Copy the full URL from that file

In `om-last-links.txt` you will see something like:

```
ORANGE_MONEY_LINK=
https://sugu.orange-sonatel.com/mp/…………

MAX_IT_LINK=
https://sugu.orange-sonatel.com/mp/…………
```

Select the **entire** `https://…` line (one line, no spaces), copy it, paste into
Safari / Messages / WhatsApp on your phone, and open it.

The file is rewritten every time you run `npm run om:create-link`.

---

## Options

```bash
# amount in XOF (default 100)
npm run om:create-link -- 500

# real pending booking / plan / bar order id (so payment can confirm a booking)
npm run om:create-link -- 100 --order YOUR-PENDING-UUID

# validity window in minutes (default = PAYMENT_LINK_TTL_MINUTES, usually 20)
npm run om:create-link -- 100 --ttl 20
```

---

## Requirements (`.env`)

These must be set (already on your machine if you followed setup):

- `OM_CLIENT_ID`
- `OM_CLIENT_SECRET`
- `OM_MERCHANT_CODE` (e.g. `553651`)
- `BASE_URL` — used for the webhook callback  
  For production webhook tests use:  
  `https://resabot-production.up.railway.app`

---

## What happens after you pay

1. You open the link → Orange Money or Max It.
2. You pay.
3. Sonatel calls Awa:  
   `{BASE_URL}/webhooks/orange-money`
4. Awa checks the transaction with Sonatel, then confirms the booking  
   **only if** `--order` was a real pending payment id.

If the order id is `manual-…` (default), the webhook is only logged — no booking.

---

## When Awa does this for clients

When Orange Money is enabled on Railway (`OM_*` env vars set):

1. Client books a class with Awa.
2. Chooses **Payer Wave** / **Payer Orange Money** / **Payer Max It**.
3. Awa sends the deep link in WhatsApp (same kind of URL as in `om-last-links.txt`).

Until `OM_*` is set on Railway, Awa only offers Wave.

---

## Troubleshooting

| Problem | What to do |
|---|---|
| Link expired | Run `npm run om:create-link -- 100` again and open the new `om-last-links.txt` |
| “OM not configured” | Check the three `OM_*` lines in `.env` |
| Paid but no confirmation | Use `--order` with a real `AWAITING_PAYMENT` id, and a public `BASE_URL` that reaches Awa |
| Can’t copy from chat | Don’t — always open `om-last-links.txt` in an editor |

---

*This how-to file is safe to keep in the repo.  
`om-last-links.txt` is gitignored (contains live one-off payment links).*
