# WATI template: `partner_support_reply`

| Field | Value |
|---|---|
| Template name (exact) | `partner_support_reply` |
| Status in code | **NOT WIRED (email/in-app only)** |
| Meta category | UTILITY |
| Language | English (en) |
| Recipient | Partner |

## When it is sent
Admin replies to a partner support ticket. The admin reply box says "The partner gets an in-app notification and an email"; the in-app one exists (PARTNER_TICKET_UPDATED).

## Where in the code
- modules/partners (partnerTicketCtrl.updatePartnerTicket)

## Variables (names must match exactly)
| Variable | Example value | Meaning |
|---|---|---|
| `{{partner_name}}` | Developer One | Partner name |
| `{{ticket_ref}}` | SUP-0011 | Support ticket reference |

## Body text to enter in WATI
```
Hello {{partner_name}}, our team has replied to your support ticket {{ticket_ref}}. Please open the Realtydoor partner app to read the response.
```

## Buttons
Optional URL button "Open ticket" -> https://<your-domain>/partners/support

## Checklist
- [ ] Created in WATI with the exact name above
- [ ] Category, language and sample values filled in, submitted to Meta
- [ ] Status is APPROVED / Live in WATI
- [ ] Code change made to send it (not sent by the app today)
