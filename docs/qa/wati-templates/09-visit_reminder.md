# WATI template: `visit_reminder`

| Field | Value |
|---|---|
| Template name (exact) | `visit_reminder` |
| Status in code | **NOT WIRED (setting exists)** |
| Meta category | UTILITY |
| Language | English (en) |
| Recipient | Buyer |

## When it is sent
Reminder before a scheduled site visit. The profile has a "visit reminders" preference (notifVisitReminders) but no job sends reminders.

## Where in the code
- New hourly job similar to jobs/whatsappFeedback.js; respect user.notifVisitReminders

## Variables (names must match exactly)
| Variable | Example value | Meaning |
|---|---|---|
| `{{name}}` | Krishna | Buyer name |
| `{{property_title}}` | E2E QA 2BHK Apartment Whitefield | Property |
| `{{visit_time}}` | Tue, 20 Oct, 3:00 PM | Local visit time |
| `{{partner_name}}` | Developer One | Partner |

## Body text to enter in WATI
```
Hello {{name}}, this is a reminder of your site visit to {{property_title}} on {{visit_time}} with {{partner_name}}. Please keep your visit code ready to share with the partner at the property.
```

## Buttons
None

## Meta / product notes
- Do not put the OTP in this message.

## Checklist
- [ ] Created in WATI with the exact name above
- [ ] Category, language and sample values filled in, submitted to Meta
- [ ] Status is APPROVED / Live in WATI
- [ ] Code change made to send it (not sent by the app today)
