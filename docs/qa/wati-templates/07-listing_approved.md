# WATI template: `listing_approved`

| Field | Value |
|---|---|
| Template name (exact) | `listing_approved` |
| Status in code | **NOT WIRED (promised in the app)** |
| Meta category | UTILITY |
| Language | English (en) |
| Recipient | Partner |

## When it is sent
Admin approves a listing. The listing-submitted screen says "You'll be notified by WhatsApp when it's approved or if changes are needed."

## Where in the code
- Where the PROPERTY_APPROVED in-app notification is created (admin property approve)

## Variables (names must match exactly)
| Variable | Example value | Meaning |
|---|---|---|
| `{{partner_name}}` | Developer One | Partner name |
| `{{property_title}}` | E2E QA 2BHK Apartment Whitefield | Listing title |

## Body text to enter in WATI
```
Hello {{partner_name}}, your listing {{property_title}} has been approved and is now live on Realtydoor. Buyers can now find it in search.
```

## Buttons
Optional URL button "View listing"

## Checklist
- [ ] Created in WATI with the exact name above
- [ ] Category, language and sample values filled in, submitted to Meta
- [ ] Status is APPROVED / Live in WATI
- [ ] Code change made to send it (not sent by the app today)
