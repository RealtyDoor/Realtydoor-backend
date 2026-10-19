# WATI template: `escrow_token_received`

| Field | Value |
|---|---|
| Template name (exact) | `escrow_token_received` |
| Status in code | **NOT WIRED (receipt)** |
| Meta category | UTILITY |
| Language | English (en) |
| Recipient | Buyer |

## When it is sent
Buyer's escrow token payment is captured (status HELD). Receipts are TRANSACTIONAL in the notification gate (always sent).

## Where in the code
- modules/escrow/escrow.service.js confirmPayment, next to the ESCROW_HELD in-app notification

## Variables (names must match exactly)
| Variable | Example value | Meaning |
|---|---|---|
| `{{name}}` | Krishna | Buyer name |
| `{{amount}}` | 50,000 | Amount in rupees, formatted |
| `{{property_title}}` | Maruthi Nilya | Property |
| `{{payment_id}}` | pay_TpeSCeehog4Jvi | Razorpay payment id |

## Body text to enter in WATI
```
Hello {{name}}, we have received your token advance of Rs {{amount}} for {{property_title}}. It is held securely in escrow until the allocation letter is verified. Payment reference: {{payment_id}}.
```

## Buttons
Optional URL button "View receipt"

## Checklist
- [ ] Created in WATI with the exact name above
- [ ] Category, language and sample values filled in, submitted to Meta
- [ ] Status is APPROVED / Live in WATI
- [ ] Code change made to send it (not sent by the app today)
