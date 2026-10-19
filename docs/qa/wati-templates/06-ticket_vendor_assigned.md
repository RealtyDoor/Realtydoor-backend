# WATI template: `ticket_vendor_assigned`

| Field | Value |
|---|---|
| Template name (exact) | `ticket_vendor_assigned` |
| Status in code | **NOT WIRED (promised in the app)** |
| Meta category | UTILITY |
| Language | English (en) |
| Recipient | Buyer / subscriber |

## When it is sent
Admin dispatches a vendor on a service ticket. The "Ticket raised" screen already promises "You'll get a WhatsApp update once a vendor is assigned".

## Where in the code
- Add after PATCH /admin/tickets/:id dispatch in admin.service.js (same place the in-app notification should be created - bug B42/B79)

## Variables (names must match exactly)
| Variable | Example value | Meaning |
|---|---|---|
| `{{name}}` | Krishna | Customer name |
| `{{ticket_ref}}` | TKT-D776 | Ticket reference |
| `{{vendor_name}}` | QA Test Vendor | Vendor name |
| `{{vendor_phone}}` | +919000000099 | Vendor phone |

## Body text to enter in WATI
```
Hello {{name}}, a vendor has been assigned to your Realtydoor service ticket {{ticket_ref}}. {{vendor_name}} will contact you on {{vendor_phone}} to schedule the visit.
```

## Buttons
Optional URL button "Track ticket" -> https://<your-domain>/user/tickets

## Meta / product notes
- Respect the user's WhatsApp toggle (OPERATIONAL).

## Checklist
- [ ] Created in WATI with the exact name above
- [ ] Category, language and sample values filled in, submitted to Meta
- [ ] Status is APPROVED / Live in WATI
- [ ] Code change made to send it (not sent by the app today)
