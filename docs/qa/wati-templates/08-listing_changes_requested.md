# WATI template: `listing_changes_requested`

| Field | Value |
|---|---|
| Template name (exact) | `listing_changes_requested` |
| Status in code | **NOT WIRED (promised in the app)** |
| Meta category | UTILITY |
| Language | English (en) |
| Recipient | Partner |

## When it is sent
Admin rejects a listing or requests changes (reason is already stored and shown in the in-app notification, e.g. "Compliance - RERA number missing").

## Where in the code
- Where the listing rejection / changes-requested in-app notification is created

## Variables (names must match exactly)
| Variable | Example value | Meaning |
|---|---|---|
| `{{partner_name}}` | Developer One | Partner name |
| `{{property_title}}` | Muneshwara nilaya | Listing title |
| `{{reason}}` | Compliance - RERA number missing | Admin reason (single line, max ~200 chars) |

## Body text to enter in WATI
```
Hello {{partner_name}}, your listing {{property_title}} needs changes before it can go live. Reason: {{reason}}. Please update the listing and resubmit it for review.
```

## Buttons
Optional URL button "Edit listing"

## Meta / product notes
- Strip newlines from {{reason}}.

## Checklist
- [ ] Created in WATI with the exact name above
- [ ] Category, language and sample values filled in, submitted to Meta
- [ ] Status is APPROVED / Live in WATI
- [ ] Code change made to send it (not sent by the app today)
