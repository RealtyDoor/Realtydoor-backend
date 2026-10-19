# WATI template: `dispute_update`

| Field | Value |
|---|---|
| Template name (exact) | `dispute_update` |
| Status in code | **NOT WIRED** |
| Meta category | UTILITY |
| Language | English (en) |
| Recipient | Buyer |

## When it is sent
Admin changes a dispute status or resolves it (bug B71: nobody is notified today).

## Where in the code
- modules/disputes/disputes.service.js adminResolveDispute

## Variables (names must match exactly)
| Variable | Example value | Meaning |
|---|---|---|
| `{{name}}` | Krishna | Buyer name |
| `{{status}}` | Resolved | New status |
| `{{note}}` | No issue found; plan stays active. | Admin note, single line |

## Body text to enter in WATI
```
Hello {{name}}, your dispute with Realtydoor is now {{status}}. Note from our team: {{note}}
```

## Buttons
None

## Meta / product notes
- Variable {{note}} sits at the end of the body; add a trailing sentence if Meta rejects that.

## Checklist
- [ ] Created in WATI with the exact name above
- [ ] Category, language and sample values filled in, submitted to Meta
- [ ] Status is APPROVED / Live in WATI
- [ ] Code change made to send it (not sent by the app today)
