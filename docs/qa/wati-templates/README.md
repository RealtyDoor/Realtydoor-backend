# RealtyDoor WhatsApp (WATI) templates

> **Update 19 Oct 2026:** the WATI account was checked read-only. Templates 01-05 already exist and are APPROVED (one has a wording mismatch, `buyer_feedback_request`), and `ticket_vendor_dispatched` already exists and replaces 06. See [ACCOUNT_CHECK.md](ACCOUNT_CHECK.md) before creating anything.

One document per WhatsApp message. The backend sends messages with `POST /api/v1/sendTemplateMessage` (`lib/wati.js`), so **every template below must exist in your WATI account, with the exact name and variable names, and be approved by Meta, before the app can send it.** A missing or unapproved template shows up as a FAILED row in the admin WhatsApp templates delivery log (and the visit OTP simply never reaches the buyer).

| # | Template | Status in code | Category | Recipient |
|---|---|---|---|---|
| 01 | [`site_visit_otp`](01-site_visit_otp.md) | IMPLEMENTED | AUTHENTICATION | Buyer (from the visit/OTP flow) |
| 02 | [`phone_verification_otp`](02-phone_verification_otp.md) | IMPLEMENTED | AUTHENTICATION | Any user verifying their phone (sign-in / inquiry / phone change) |
| 03 | [`lead_assigned_notice`](03-lead_assigned_notice.md) | IMPLEMENTED | UTILITY | Partner (agent/owner/builder) |
| 04 | [`buyer_feedback_request`](04-buyer_feedback_request.md) | IMPLEMENTED | UTILITY | Buyer |
| 05 | [`contact_reply`](05-contact_reply.md) | IMPLEMENTED | UTILITY | Person who used the public Contact Us form (only when admin ticks "also WhatsApp") |
| 06 | [`ticket_vendor_assigned`](06-ticket_vendor_assigned.md) | NOT WIRED (promised in the app) | UTILITY | Buyer / subscriber |
| 07 | [`listing_approved`](07-listing_approved.md) | NOT WIRED (promised in the app) | UTILITY | Partner |
| 08 | [`listing_changes_requested`](08-listing_changes_requested.md) | NOT WIRED (promised in the app) | UTILITY | Partner |
| 09 | [`visit_reminder`](09-visit_reminder.md) | NOT WIRED (setting exists) | UTILITY | Buyer |
| 10 | [`escrow_token_received`](10-escrow_token_received.md) | NOT WIRED (receipt) | UTILITY | Buyer |
| 11 | [`escrow_released`](11-escrow_released.md) | NOT WIRED | UTILITY | Partner and buyer (two wordings recommended) |
| 12 | [`loan_status_update`](12-loan_status_update.md) | NOT WIRED | UTILITY | Buyer |
| 13 | [`dispute_update`](13-dispute_update.md) | NOT WIRED | UTILITY | Buyer |
| 14 | [`partner_support_reply`](14-partner_support_reply.md) | NOT WIRED (email/in-app only) | UTILITY | Partner |
| 15 | [`nri_video_tour_scheduled`](15-nri_video_tour_scheduled.md) | NOT WIRED | UTILITY | Buyer (NRI) |

Templates 01-05 are what the backend sends today. Templates 06-15 are messages the app screens promise or that its settings imply, but no code sends them yet; create them only when you also wire the sending (they are tied to the notification bugs B34, B42, B71, B79 in `admin-nextjs/QA_BUGS.md`).

## One-time setup in WATI
1. WATI -> Broadcast / Template messages -> **New template message**.
2. Enter the **template name exactly** as in the document (lowercase, underscores), choose the **category** and language **English**.
3. Paste the **body text**; use the **variables exactly as listed**. OTP templates use positional `{{1}}`; the others use named variables (`{{partner_name}}` etc.), because that is how `lib/wati.js` builds the parameters.
4. Add the buttons listed in the document, fill the **sample values** from the Variables table, **submit to Meta**. Approval usually takes minutes to 48 hours; wait for status **APPROVED**.
5. Backend env (Rbac/realtydoorBackend/.env): `WATI_API_ENDPOINT`, `WATI_ACCESS_TOKEN` (already set); for replies and delivery status also set `WATI_WEBHOOK_TOKEN` and, in WATI -> Webhooks, point the webhook to `https://<public-domain>/api/webhooks/wati` with header `x-wati-token: <WATI_WEBHOOK_TOKEN>`. Locally this needs a public tunnel (same as the Razorpay webhook).
6. (Optional) Add each approved template to the admin page /admin/platform/wati so delivery stats appear there. Today that page lists only "QA Sample Template" and shows 81 messages with 0% delivery (bug B98), which is why the real templates must be registered/synced.

## Rules that apply to all of them (Meta)
- A variable cannot be the very first or last thing in the body, and values cannot contain newlines, tabs or more than 3 spaces in a row.
- OTP codes must use the **Authentication** category, with Meta's fixed wording and a "Copy code" button.
- Do not put marketing text in Utility templates; Meta will re-categorise or reject them.
- Opt-out: templates 03, 04, 06-09, 12-15 are OPERATIONAL and respect the user's WhatsApp toggle; OTPs and receipts are TRANSACTIONAL and always go out (`lib/notificationGate.js`).

## How to test (each implemented template)
- `site_visit_otp`: partner schedules a visit on a lead whose buyer is a number you control.
- `phone_verification_otp`: start a phone verification from the buyer app.
- `lead_assigned_notice`: admin assigns a lead to a partner whose profile phone you control.
- `buyer_feedback_request`: either wait for the hourly job, or set a lead's `otpVerifiedAt` to more than 24h ago in a test database and clear `whatsappSentAt`.
- `contact_reply`: admin Contact Messages -> reply with "also WhatsApp" on a message from a number you control.
After each test, check /admin/platform/wati/log (or the `WatiMessageLog` collection) for SENT / DELIVERED / FAILED.
