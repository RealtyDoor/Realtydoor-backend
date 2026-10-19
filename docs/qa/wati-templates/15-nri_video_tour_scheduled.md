# WATI template: `nri_video_tour_scheduled`

| Field | Value |
|---|---|
| Template name (exact) | `nri_video_tour_scheduled` |
| Status in code | **NOT WIRED** |
| Meta category | UTILITY |
| Language | English (en) |
| Recipient | Buyer (NRI) |

## When it is sent
Admin assigns and schedules an NRI video tour (admin NRI Video Tours -> Assign).

## Where in the code
- NRI video-tour update handler (admin)

## Variables (names must match exactly)
| Variable | Example value | Meaning |
|---|---|---|
| `{{name}}` | Krishna | Buyer name |
| `{{property_title}}` | E2E QA 2BHK Apartment Whitefield | Property |
| `{{tour_time}}` | Wed, 21 Oct, 9:30 PM IST | Scheduled time with timezone |

## Body text to enter in WATI
```
Hello {{name}}, your live video tour of {{property_title}} is scheduled for {{tour_time}}. Your Realtydoor partner will walk you through the property on a video call.
```

## Buttons
None

## Checklist
- [ ] Created in WATI with the exact name above
- [ ] Category, language and sample values filled in, submitted to Meta
- [ ] Status is APPROVED / Live in WATI
- [ ] Code change made to send it (not sent by the app today)
