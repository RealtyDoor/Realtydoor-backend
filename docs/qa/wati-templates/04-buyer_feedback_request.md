# WATI template: `buyer_feedback_request`

| Field | Value |
|---|---|
| Template name (exact) | `buyer_feedback_request` |
| Status in code | **IMPLEMENTED** |
| Meta category | UTILITY |
| Language | English (en) |
| Recipient | Buyer |

## When it is sent
(a) Hourly job: 24 hours after the visit OTP was verified (jobs/whatsappFeedback.js). (b) Hourly job: 7 days after the buyer answered "still deciding" (jobs/stillDecidingFollowup.js).

## Where in the code
- jobs/whatsappFeedback.js l.39 and jobs/stillDecidingFollowup.js l.38 -> sendBuyerFeedbackRequest(lead.buyerPhone, partnerName)
- lib/wati.js -> template "buyer_feedback_request", OPERATIONAL
- Replies are read by POST /api/webhooks/wati (modules/webhooks/wati.handler.js KEYWORD_MAP)

## Variables (names must match exactly)
| Variable | Example value | Meaning |
|---|---|---|
| `{{partner_name}}` | Developer One | Partner company or name (named variable {{partner_name}}); falls back to "your agent" |

## Body text to enter in WATI
```
Hello, thank you for visiting a property with {{partner_name}} through Realtydoor. How did it go? Please tap a reply below so we can help with the next step.
```

## Buttons
THREE quick-reply buttons with EXACTLY these labels: "Interested", "Not interested", "Still deciding". The webhook maps the typed/tapped text: interested/yes/1 -> VERIFIED_CLOSED, not interested/no/2 -> VERIFIED_DROPPED, still deciding/maybe/3 -> STILL_DECIDING.

## Setup notes
The WATI webhook must be configured (WATI -> Webhooks) to POST to https://<public-domain>/api/webhooks/wati with header x-wati-token = WATI_WEBHOOK_TOKEN. This also needs a public URL or tunnel when testing locally.

## Meta / product notes
- Without the webhook the admin release modal's "Buyer confirmed the deal" condition can never turn green (bug B29).
- The same template is reused for the 7-day nudge; if you want different wording, create buyer_feedback_followup and change jobs/stillDecidingFollowup.js.

## Checklist
- [ ] Created in WATI with the exact name above
- [ ] Category, language and sample values filled in, submitted to Meta
- [ ] Status is APPROVED / Live in WATI
- [ ] Tested from the app (see README "How to test")
