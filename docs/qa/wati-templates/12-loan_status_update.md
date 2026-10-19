# WATI template: `loan_status_update`

| Field | Value |
|---|---|
| Template name (exact) | `loan_status_update` |
| Status in code | **NOT WIRED** |
| Meta category | UTILITY |
| Language | English (en) |
| Recipient | Buyer |

## When it is sent
Loan application status changes (documents verified, sent to bank, sanctioned, disbursed, rejected). In-app notification LOAN_STATUS_UPDATE exists.

## Where in the code
- modules/admin/admin.service.js updateLoanStatus l.~1343 (next to createNotification)

## Variables (names must match exactly)
| Variable | Example value | Meaning |
|---|---|---|
| `{{name}}` | Krishna | Buyer name |
| `{{bank}}` | HDFC Bank | Bank |
| `{{status}}` | Sanctioned | Human-readable status |

## Body text to enter in WATI
```
Hello {{name}}, your home loan application with {{bank}} is now {{status}}. Open Realtydoor to see the details and next steps.
```

## Buttons
Optional URL button "View loan"

## Checklist
- [ ] Created in WATI with the exact name above
- [ ] Category, language and sample values filled in, submitted to Meta
- [ ] Status is APPROVED / Live in WATI
- [ ] Code change made to send it (not sent by the app today)
