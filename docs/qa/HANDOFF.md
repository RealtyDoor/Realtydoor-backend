# RealtyDoor QA — handoff (19 Oct 2026)

Cross-role end-to-end QA of the buyer (user), admin and partner apps, run by Claude in three Chrome profiles against the local stack. This file is the starting point for whoever picks it up. No secrets are written here.

## 1. Where everything is

| What | Where |
|---|---|
| Full bug log (B1–B99), per-phase results, ranked summary | `admin-nextjs/QA_BUGS.md` (local, untracked) |
| WhatsApp (WATI) template documents, one file per template + setup README | `wati-templates/` (this folder, outside both git repos) |
| This handoff | `HANDOFF.md` |
| Frontend repo | `admin-nextjs/` → `github.com/RealtyDoor/realtydoor-frontend` |
| Backend repo | `Rbac/realtydoorBackend/` → `github.com/dev2-realtydoor/Rbac` |

## 2. Stack and accounts used

- Frontend `http://localhost:3000` (Next dev), backend `http://localhost:5000` (nodemon). MongoDB via Prisma.
- Roles tested: admin `dev0@realtydoor.com` (Dev 0, platform owner), partner `dev1@realtydoor.com` (Developer One), buyer `krishna@realtydoor.com` (Krishna M, phone `<owner-test-number>`, the owner's own number — all WhatsApp OTPs went there).
- Payments: Razorpay **test mode** only (test card `4111 1111 1111 1111`, mock bank page "Success/Failure"). No live money moved.
- Partner payout account used dummy bank details taken from `prisma/seed.js` / `API.md`.

## 3. What was tested (all with sync checks between roles)

1. Lead assign, partner-added lead, visit scheduling + WhatsApp OTP, OTP verify, token payment, allocation letter, close, commission lock, escrow release (two deals) — full buyer-originated run included.
2. Service tickets (raise, dispatch, notes), partner listing (4-step form), Property Queue, public site, KYC queue (view only).
3. Documents + loans (upload, approve, apply, sanction), services/subscription purchase (incl. failed-payment retry), disputes, partner support, contact messages, NRI video tour, NRI lead, CMS (blog, services, locality insights), favorites/compare/alerts/ratings/profile, vendors, team/roles page, WATI page, analytics, audit logs.

Everything that worked is listed per phase in `QA_BUGS.md`; the ranked list of problems is at the top of that file.

## 4. Top problems to fix first

Blockers/high (details and file/line pointers in `QA_BUGS.md`):
- **B31** every RazorpayX payout rejected (idempotency key 64 chars, limit 36) — fixed locally, see section 5.
- **B12** partner-added leads vanish after admin confirm; **B21** the buyer never sees partner-added leads.
- **B17** PDF allocation letter upload returns 500 (image-only uploader).
- **B27/B35** orphaned `partnerId` on properties crashes commission preview and other reads.
- **B52** "RERA Verified" shown publicly for unverified, placeholder RERA numbers.
- **B59** new loans stuck at "Documents Pending" (admin has no buttons); **B40/B41** admin can't resolve tickets or see notes.
- **B69/B70/B71** disputes: no buyer UI, admin dialog silently keeps OPEN, no notifications.
- **B81** unpublished CMS content stays publicly visible (no revalidation).
- **B89** admin partner/vendor ratings are hard-coded samples; **B97** admin "Team & roles" is a hard-coded fictional staff list; **B92** audit log misses many sensitive admin actions.
- Notifications are missing almost everywhere (B34, B42, B79) and many links are wrong (`/partner/…` vs `/partners/…`, `/dashboard/services`).

## 5. Changes made on this machine (not in git unless noted)

**Code (uncommitted):**
- WhatsApp notifications: `src/lib/wati.js` (`notifyUser`, `sendTicketVendorDispatched`) plus one-line calls in `admin.service.js`, `escrow.service.js`, `partnerTicket.admin.service.js`, `jobs/paymentReconcile.js`, `webhooks.controller.js`. Only approved templates send; others switch on via `WATI_LIVE_TEMPLATES` (see `wati-templates/ACCOUNT_CHECK.md`).
- `Rbac/realtydoorBackend/src/lib/razorpay.js` l.87-88: payout idempotency key now `.slice(0, 36)` (fixes B31). Review, commit and push it, or reapply it.

**Environment files (values not recorded here):**
- Backend `.env` and `.env.local`: `WATI_API_ENDPOINT`/`WATI_ACCESS_TOKEN` switched from tenant 422632 to the owner's logged-in WATI account (tenant 422588); verified with a read-only API call. The token was pasted into the chat — regenerate it in WATI if the transcript is shared.
- Backend `.env` and `.env.local`: new Razorpay **test** key pair (the old pair returned 401). Old files were backed up in the Claude session scratchpad (temporary).
- `admin-nextjs/.env.local`: added `NEXT_PUBLIC_RAZORPAY_KEY_ID` (checkout needs it).
- The test key secret was pasted into the chat; rotate it in the Razorpay dashboard if the transcript is shared.

**Database / config:**
- Property `6ac8fd9824511fa2becd53bb` ("Maruthi Nilya") `partnerId` changed from the orphaned `6ac54a1c19eab3d81bc4735a` to `6ac248758cba2a7822eeae70` (Mock QA Owner — Verified). Revert by setting the old value back.
- New PlatformConfig key `default_partner_share_pct` = `2`.
- Krishna's profile address changed from "hshsd" to "E2E QA Address, Jayanagar, Bengaluru".
- Loan `6ad5b95bb42af539e3dad77e` moved to DOCUMENTS_VERIFIED through the admin status API, then sanctioned through the UI.

**Test records created (safe to delete in a dev database):**
- Leads RD-L-000085 (partner-added, Krishna; never paid), RD-L-000086; RD-L-000077 assigned to Developer One.
- Escrows `6ad5aa5564ac1ac2a8b65096` (RD-L-000084) and `6ad5b1b2b42af539e3dad76e` (RD-L-000086): ₹50,000 each, RELEASED; payouts `pout_TpepFxXrz7NYMk`, `pout_Tpf25152gAXzZb`; Razorpay payments `pay_TpeSCeehog4Jvi`, `pay_TpezMjh7VFN6TP`.
- Partner payout account for Developer One (dummy bank details) with RazorpayX contact + fund account.
- Property P-DAD778 `6ad5b700b42af539e3dad778` (live, slug `e2e-qa-2bhk-apartment-whitefield-1792390912370`), 5 test photos.
- Service ticket TKT-D776 `6ad5b581b42af539e3dad776` (+ auto "Maintenance Premium — Initial Setup" ticket), subscription `6ad5bb34b42af539e3dad781` (₹4,599, payment `pay_TpfggbWJzIj6XD`), dispute `6ad5bc2cb42af539e3dad784` (resolved), partner ticket SUP-0011.
- 3 blank test documents (PAN/Aadhaar/salary slip images) approved; loan application sanctioned.
- Contact message, NRI video tour (assigned), NRI lead "Krishna M (E2E QA)", 4★ rating on RD-L-000084, 2 favorites, vendor "E2E QA Vendor" (inactive), blog `e2e-qa-test-article` (unpublished but still served — B81), a "New Draft" CMS row, service description edited then reverted.
- WhatsApp messages (visit OTPs and others) were sent to `<owner-test-number>` only.

## 6. Cloud fix sessions

- Frontend session `QA bug fixes: frontend (Next.js app)` on `RealtyDoor/realtydoor-frontend`: **started by the owner** (branch + PR, not merged). Its brief lists the frontend bugs with file pointers.
- Backend session on `dev2-realtydoor/Rbac`: **could not be created after four attempts** (Claude GitHub app access to that account/org). The full backend brief exists in the Claude conversation; the backend bugs are not being worked yet. Options: grant the Claude GitHub app access to `dev2-realtydoor/Rbac` (or move the repo into the `RealtyDoor` org, where the app is installed on all repos), or run the fixes in a local session in `Rbac/realtydoorBackend`.

## 7. Decisions needed from the owner

- **B21** how a partner-added lead reaches the buyer (claim by phone/OTP? partner "send escrow link"?). Today the deal cannot reach escrow.
- **B65** the "Subscribe — coming soon" lock is cosmetic (`/user/subscriptions/book/<id>` takes payment); enforce it or remove it.
- **B29** buyer deal confirmation is WhatsApp-only; add an in-app way, or keep it and set up the WATI webhook.
- **OTP wording**: Meta's authentication template says "do not share", the app tells buyers to read the code to the partner (see `wati-templates/01-site_visit_otp.md`).
- What `default_partner_share_pct` should really be (2 was a test value) and whether partner share is a % of the fee or of the held amount (two settings with different bases, B28).

## 8. Things only the owner can do

1. WhatsApp templates: the five the code sends already exist and are APPROVED in WATI; fix the `buyer_feedback_request` wording (it greets the partner's name but is sent to the buyer, no quick-reply buttons) — see `wati-templates/ACCOUNT_CHECK.md`. Then set `WATI_WEBHOOK_TOKEN` and the WATI webhook (needs a public URL or tunnel).
2. Configure the Razorpay webhook (`POST /api/webhooks/razorpay`, secret in `RAZORPAY_WEBHOOK_SECRET`) via a tunnel when testing locally; payments currently settle through the client confirm + reconcile job.
3. Fix the GitHub access for `dev2-realtydoor/Rbac` (section 6) and push/commit the `razorpay.js` fix.
4. Clean orphaned `partnerId` references (properties "CS REddy vilas", "3 BHK Flat in Baner") and the junk/duplicate seed data (duplicate "3 BHK Flat in Baner" ×6, junk "New Draft" blog, junk tickets SUP-0009/0010, vendor "Dev 0", duplicate vendor "Ankur").
5. Change the GitHub password (GitHub banner: it is on a commonly used list, auto-reset after 14 Nov 2026).

## 9. Not tested

KYC submission/approval (needs a new partner sign-up), partner Bulk CSV listings, partner profile/KYC screens, escrow freeze/refund/dispute paths, Razorpay and WATI webhooks, the "I acknowledge" data-use agreement, platform-config edits beyond one key, team invites (would send real emails), the NRI video-tour buyer view after assignment, the 24h/7d WhatsApp feedback jobs, and a production build (`npm run build`) — the app was exercised on the Next dev server only.

## 10. How to re-test / gotchas

- Start order: backend (nodemon, `touch server.js` restarts it), frontend dev server (the owner runs it on :3000; don't kill it).
- First visit to a route triggers a Next dev compile (10–40 s); pages can briefly show "session expired" while compiling (B86) — wait and retry before concluding anything.
- Backend rate limit is 100 requests per 15 minutes per IP locally; long sweeps can hit it.
- Admin cannot open `/user/*` (and vice-versa) — role isolation works, so use the right browser profile (admin, partner, buyer each have their own).
- Razorpay mock bank page opens in a popup tab: click **Success** (or **Failure** to test the failed-payment retry).
- Destructive or outward-facing steps (WhatsApp sends to other people, real emails, terms/consent checkboxes, irreversible releases) were only done on the owner's explicit say-so and only with the owner's own phone or dummy data. Keep that rule.
