# WATI template: `site_visit_otp`

| Field | Value |
|---|---|
| Template name (exact) | `site_visit_otp` |
| Status in code | **IMPLEMENTED** |
| Meta category | AUTHENTICATION |
| Language | English (en) |
| Recipient | Buyer (from the visit/OTP flow) |

## When it is sent
Partner schedules a site visit, resends the OTP, or admin schedules/overrides a visit. The buyer reads the code to the partner at the property to unlock their phone number.

## Where in the code
- modules/leads/leads.service.js l.356 (scheduleVisit) and l.389 (resendOtp)
- modules/admin/admin.service.js l.360 (admin schedule/override)
- lib/wati.js sendSiteVisitOtp -> template "site_visit_otp", always sent (TRANSACTIONAL, ignores the buyer's WhatsApp toggle)

## Variables (names must match exactly)
| Variable | Example value | Meaning |
|---|---|---|
| `{{1}}` | 482913 | 6-digit visit OTP (positional variable {{1}}, parameter name "1") |

## Body text to enter in WATI
```
{{1}} is your verification code. For your security, do not share this code.
```

## Buttons
Copy code (WATI/Meta "one-tap or copy code" button)

## Setup notes
Code expiry: OTP_EXPIRY_MINUTES (currently 120) -> enable "Add expiry text" and set it to match.

## Meta / product notes
- Meta requires OTPs to be AUTHENTICATION templates; the body text is fixed by Meta and cannot be customised (no names, dates, or URLs).
- PRODUCT CONFLICT: the in-app preview says "Your OTP for the site visit on Tue, 20 Oct, 15:00 is ••••••. Share with your partner at the property only." Meta's required wording says "do not share this code", and the date/time cannot be in the template. Keep Meta's wording and explain the sharing step in the app (the schedule dialog and visit page), or the preview text must be changed to match what WhatsApp actually sends.
- If you submit it as a UTILITY template with the custom wording instead, Meta will usually re-categorise it to AUTHENTICATION or reject it.

## Checklist
- [ ] Created in WATI with the exact name above
- [ ] Category, language and sample values filled in, submitted to Meta
- [ ] Status is APPROVED / Live in WATI
- [ ] Tested from the app (see README "How to test")
