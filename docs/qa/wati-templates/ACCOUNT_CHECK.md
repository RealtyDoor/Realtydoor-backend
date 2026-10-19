# WATI account check — 19 Oct 2026

Read-only check of the live WATI account (`live.wati.io/422588`, number +91 98444 12345, 29 templates). Nothing was created, edited or submitted. This supersedes the "create these in WATI" steps for templates 01–05.

## The 5 templates the code sends — all exist and are APPROVED

| Template (code) | WATI category | Approved body in WATI | Variables code sends | Verdict |
|---|---|---|---|---|
| `site_visit_otp` | Authentication | `{{1}} is your verification code. For your security, do not share this code.` + "Copy code" button, expiry 10 min | `1` = OTP | Matches. Worked in the E2E run (OTPs arrived on <owner-test-number>). |
| `phone_verification_otp` | Authentication | same body and button, expiry 10 min | `1` = OTP | Matches. |
| `lead_assigned_notice` | Utility | `Hello {{partner_name}}, a new lead has been assigned to you. Please check your dashboard for details.` + "Visit us" URL button | `partner_name` | Matches. Check the URL button's target is the partner dashboard, not a placeholder. |
| `buyer_feedback_request` | Utility | `Hi {{partner_name}}, please share your feedback on the recent lead assigned to you.` — **no buttons** | `partner_name` | **Mismatch in meaning.** The code passes the *partner's* name, but the text greets the name as if it were the recipient and speaks as if the partner is being asked for feedback. The recipient is the *buyer*. A buyer will read "Hi Developer One, please share your feedback on the recent lead assigned to you." Also no Interested / Not interested / Still deciding quick replies (webhook still understands typed 1/2/3/yes/no/maybe). |
| `contact_reply` | Utility | `Hi {{1}}, regarding your query: {{2}} - Regards, Team` | `1` = name, `2` = reply body (≤600 chars) | Matches. Sample for `{{2}}` is short; real replies are long but within the 1024 limit. |

### What to do about it
1. **`buyer_feedback_request` (needs a fix):** either resubmit the template with the wording in `04-buyer_feedback_request.md` (buyer-facing text, 3 quick-reply buttons), or change what the code passes. An approved template cannot be edited in place without going back to Meta review; create a new name (e.g. `buyer_feedback_request_v2`) and switch `lib/wati.js` to it.
2. Nothing else needs creating for the five implemented templates.

## Other templates in the account
- `ticket_vendor_dispatched` (Utility, APPROVED, 18 Oct 2026): `Hi, an update on your RealtyDoor service request "{{ticket_subject}}": we've assigned it to {{vendor_name}}. They'll contact you shortly to arrange the next steps. You can reply here if you have any questions.` Variables `ticket_subject`, `vendor_name`. **Not sent by any code today** (no reference in `src/`). It covers the same event as my proposed `06-ticket_vendor_assigned`, so use this one and drop 06 — wire it in where the admin dispatches a ticket to a vendor (`dispatchTicket`) with `[{name:'ticket_subject',…},{name:'vendor_name',…}]`, category OPERATIONAL.
- 23 older marketing/utility templates (festival greetings, Sreenidhi, Vrunda, etc.) are unrelated to the app.

## Still missing and not wired in code
Templates 07–15 (listing approved/changes requested, visit reminder, escrow token received/released, loan status, dispute update, partner support reply, NRI video tour scheduled) do not exist in WATI and nothing in the backend sends them. Only create them once the sending code is written.

---

## Update — drafts created (19 Oct 2026)

Created in the logged-in WATI account (`live.wati.io/422588`) as **Draft**, Utility, English. **None were submitted to Meta**; each still needs a click on "Submit" in the WATI template list.

| Draft | Variables | Note |
|---|---|---|
| `buyer_feedback_request_v2` | `partner_name` | Buyer-facing wording + quick replies Interested / Not interested / Still deciding. Backend still sends the old name until `lib/wati.js` is switched. |
| `listing_approved` | `partner_name`, `property_title` | no button |
| `listing_changes_requested` | `partner_name`, `property_title`, `reason` | no button |
| `visit_reminder` | `name`, `property_title`, `visit_time`, `partner_name` | no button |
| `escrow_token_received` | `name`, `amount`, `property_title`, `payment_id` | closing sentence added so the body does not end on a variable |
| `escrow_released` | `name`, `amount`, `lead_ref` | |
| `loan_status_update` | `name`, `bank`, `status` | no button |
| `dispute_update` | `name`, `status`, `note` | closing sentence added ("Please open the Realtydoor app for full details.") |
| `partner_support_reply` | `partner_name`, `ticket_ref` | no button |
| `nri_video_tour_scheduled` | `name`, `property_title`, `tour_time` | |

Not created: `ticket_vendor_assigned` (06) — `ticket_vendor_dispatched` already exists and is approved. The optional URL buttons were left out because they need the production domain.

Resolved 19 Oct 2026: the backend `.env` and `.env.local` now use this account (`https://live-mt-server.wati.io/422588`, token from its API Docs page). A read-only `getMessageTemplates` call with those credentials returned HTTP 200 and listed the 5 approved templates and the 10 drafts. The old values (tenant 422632) are backed up in the Claude session scratchpad only. Templates 07–15 are still not sent by any backend code.

## Update — notifications wired (19 Oct 2026, uncommitted backend change)
`src/lib/wati.js` now has `notifyUser(userId, template, params)` (looks up the user's phone and WhatsApp preference, never throws, skips any template not on the live list) and `sendTicketVendorDispatched`. It is called next to the in-app notification at these places:

| Event | Template | Status |
|---|---|---|
| Admin dispatches/reassigns a ticket vendor (`dispatchTicket`) | `ticket_vendor_dispatched` | LIVE (approved, tested) |
| Listing approved (`admin.service.js`) | `listing_approved` | off until approved |
| Listing changes requested | `listing_changes_requested` | off until approved |
| Token advance received (`escrow.service.js`) | `escrow_token_received` | off until approved |
| Partner payout processed (webhook + reconcile job) | `escrow_released` | off until approved |
| Loan status updated | `loan_status_update` | off until approved |
| Admin replies to a partner support ticket | `partner_support_reply` | off until approved |

Not wired (no matching event/notification exists yet): `visit_reminder` (needs a scheduled job), `dispute_update` (disputes send no notification at all, B71), `nri_video_tour_scheduled`.

**To switch a template on after Meta approves it:** add its name to `WATI_LIVE_TEMPLATES` (comma-separated) in `Rbac/realtydoorBackend/.env` and `.env.local`, then `touch server.js`. No code change needed.
