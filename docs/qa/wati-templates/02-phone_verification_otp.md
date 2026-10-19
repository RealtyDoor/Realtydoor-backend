# WATI template: `phone_verification_otp`

| Field | Value |
|---|---|
| Template name (exact) | `phone_verification_otp` |
| Status in code | **IMPLEMENTED** |
| Meta category | AUTHENTICATION |
| Language | English (en) |
| Recipient | Any user verifying their phone (sign-in / inquiry / phone change) |

## When it is sent
A user requests a phone verification code (buyer inquiry phone check, onboarding, change phone).

## Where in the code
- lib/otpAuth.js l.113 -> sendPhoneVerificationOtp
- lib/wati.js -> template "phone_verification_otp", always sent (TRANSACTIONAL)

## Variables (names must match exactly)
| Variable | Example value | Meaning |
|---|---|---|
| `{{1}}` | 204718 | 6-digit code (positional {{1}}, parameter name "1") |

## Body text to enter in WATI
```
{{1}} is your verification code. For your security, do not share this code.
```

## Buttons
Copy code

## Setup notes
Expiry text should match the OTP validity used in lib/otpAuth.js.

## Meta / product notes
- Same Meta authentication format as site_visit_otp; keep the two templates separate so delivery stats and failures are tracked per purpose.

## Checklist
- [ ] Created in WATI with the exact name above
- [ ] Category, language and sample values filled in, submitted to Meta
- [ ] Status is APPROVED / Live in WATI
- [ ] Tested from the app (see README "How to test")
