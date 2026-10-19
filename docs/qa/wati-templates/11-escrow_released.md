# WATI template: `escrow_released`

| Field | Value |
|---|---|
| Template name (exact) | `escrow_released` |
| Status in code | **NOT WIRED** |
| Meta category | UTILITY |
| Language | English (en) |
| Recipient | Partner and buyer (two wordings recommended) |

## When it is sent
Admin releases an escrow (bug B34: neither party is currently notified).

## Where in the code
- modules/escrow/escrow.service.js release(), after RELEASED

## Variables (names must match exactly)
| Variable | Example value | Meaning |
|---|---|---|
| `{{name}}` | Developer One | Recipient name |
| `{{lead_ref}}` | RD-L-000086 | Lead reference |
| `{{amount}}` | 50,000 | Escrow amount in rupees |

## Body text to enter in WATI
```
Hello {{name}}, the escrow of Rs {{amount}} for {{lead_ref}} has been released. Payouts usually reach the bank account within one working day.
```

## Buttons
None

## Meta / product notes
- Create a second template (escrow_released_buyer) if the buyer text should differ.

## Checklist
- [ ] Created in WATI with the exact name above
- [ ] Category, language and sample values filled in, submitted to Meta
- [ ] Status is APPROVED / Live in WATI
- [ ] Code change made to send it (not sent by the app today)
