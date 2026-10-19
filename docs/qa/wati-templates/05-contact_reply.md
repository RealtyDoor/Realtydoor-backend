# WATI template: `contact_reply`

| Field | Value |
|---|---|
| Template name (exact) | `contact_reply` |
| Status in code | **IMPLEMENTED** |
| Meta category | UTILITY |
| Language | English (en) |
| Recipient | Person who used the public Contact Us form (only when admin ticks "also WhatsApp") |

## When it is sent
Admin replies to a contact message with the WhatsApp option enabled (admin Contact Messages -> Send reply).

## Where in the code
- modules/contact/contact.admin.service.js l.46 -> sendTemplateMessage(msg.phone, "contact_reply", [{name:"1",value:msg.name},{name:"2",value:body.slice(0,600)}])
- Sent unconditionally (no user/gate), email goes out in parallel

## Variables (names must match exactly)
| Variable | Example value | Meaning |
|---|---|---|
| `{{1}}` | Krishna | Contact person's name (positional {{1}}) |
| `{{2}}` | Thanks for reaching out. Our advisor will call you today between 4 and 6 pm. | Admin's reply text, truncated to 600 characters (positional {{2}}) |

## Body text to enter in WATI
```
Hello {{1}}, thank you for contacting Realtydoor. {{2}} Reply here if you need anything else.
```

## Buttons
None

## Setup notes
WhatsApp forbids newlines, tabs and 4+ consecutive spaces inside variable values; strip them from the admin reply before sending (currently not sanitised) or WATI/Meta will reject the send.

## Meta / product notes
- A template message can be sent outside the 24h window; free-text replies cannot - that is why a template is needed.
- If the template is not approved, only the WhatsApp leg fails and the email still goes out (see the comment in contact.admin.service.js).

## Checklist
- [ ] Created in WATI with the exact name above
- [ ] Category, language and sample values filled in, submitted to Meta
- [ ] Status is APPROVED / Live in WATI
- [ ] Tested from the app (see README "How to test")
