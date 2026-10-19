# WATI template: `lead_assigned_notice`

| Field | Value |
|---|---|
| Template name (exact) | `lead_assigned_notice` |
| Status in code | **IMPLEMENTED** |
| Meta category | UTILITY |
| Language | English (en) |
| Recipient | Partner (agent/owner/builder) |

## When it is sent
Admin assigns a lead to a partner (manual assign, partner-added confirm, or auto-assign).

## Where in the code
- modules/admin/admin.service.js l.455 -> sendLeadAssignedNotice(partner.phone, partner.name, {}, partner)
- lib/wati.js -> template "lead_assigned_notice", OPERATIONAL (respects the partner's WhatsApp toggle)

## Variables (names must match exactly)
| Variable | Example value | Meaning |
|---|---|---|
| `{{partner_name}}` | Developer One | Partner's name (named variable {{partner_name}}) |

## Body text to enter in WATI
```
Hello {{partner_name}}, a new buyer lead has been assigned to you on Realtydoor. Please open your dashboard to review it and schedule a site visit.
```

## Buttons
Optional URL button "View lead" -> https://<your-domain>/partners/leads (static URL; Meta only allows one variable at the end of a button URL).

## Setup notes
The code currently sends no lead reference or property name. If you want them in the message, add variables (e.g. {{lead_ref}}, {{property}}) here AND in lib/wati.js sendLeadAssignedNotice.

## Meta / product notes
- Variable must not be at the very start or end of the body (Meta rule) - the wording above already avoids that.
- Fires for every assignment, so expect volume spikes during auto-assign.

## Checklist
- [ ] Created in WATI with the exact name above
- [ ] Category, language and sample values filled in, submitted to Meta
- [ ] Status is APPROVED / Live in WATI
- [ ] Tested from the app (see README "How to test")
