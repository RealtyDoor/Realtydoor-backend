# QA bug log — cross-role (user / admin / partner)

Profiles: user = krishna@realtydoor.com (connected later in the run), admin = dev0@realtydoor.com, partner = dev1@realtydoor.com (Developer One). Chrome extension display names renumber; match by Google account.
App: http://localhost:3000 (Next.js), backend http://localhost:5000. Run date: 2026-10-19.

## Summary for the fixing agent (ranked)

Paths: backend = `Rbac/realtydoorBackend/src`, frontend = `admin-nextjs/src`. Full detail for each ID is in the Bugs table below.

**Local change NOT committed:** `Rbac/realtydoorBackend/src/lib/razorpay.js` l.87-88 — `X-Payout-Idempotency` key now `.slice(0, 36)` (fixes B31). Review and commit it, or redo it. Nothing else in code was edited.

**Local data/config changes made during the run (not code):**
- Backend `.env` and `.env.local`: new Razorpay test key pair; admin-nextjs `.env.local`: `NEXT_PUBLIC_RAZORPAY_KEY_ID` added (B20).
- DB: property `6ac8fd9824511fa2becd53bb` `partnerId` changed from orphaned `6ac54a1c19eab3d81bc4735a` to `6ac248758cba2a7822eeae70` (B27).
- PlatformConfig: new key `default_partner_share_pct` = 2 (B27b).
- Test records created: lead RD-L-000085, escrow 6ad5aa5564ac1ac2a8b65096 (₹50,000, RELEASED, payout pout_TpepFxXrz7NYMk), partner payout account for Developer One (dummy seed bank details), lead RD-L-000077 assigned to Developer One.

### Blockers / critical
- **B31** every RazorpayX payout rejected: idempotency key 64 chars, max 36 — `backend lib/razorpay.js` l.87 (patched locally, see above).
- **B20** Razorpay keys in `.env` were invalid (401) — resolved with a new key pair; webhooks still not configured (needs a public tunnel to `/api/webhooks/razorpay`).
- **B12** partner-added lead: admin Confirm sets UNASSIGNED, partner never sees their own lead; post-submit page says "This lead isn't available right now" — `backend admin.service.js confirmLead` (~l.261-266), `leads.service.js partnerAddLead` (~l.185-204).

### High
- **B52** "RERA Verified" shown to partner, admin and the public for an unverified, placeholder RERA number (DB `isVerified:false`).
- **B89** admin "Partner/Vendor ratings" are hard-coded samples; buyers' real ratings (stored on `Lead.buyerRating`) never reach admin. **B97** admin "Team & roles" (`platform/staff/page.tsx` l.16 `const STAFF`) is fictional data presented as real security/permission info. **B92** audit log misses loan, document, dispute, config, CMS, service, video-tour and KYC actions. **B81** unpublished content stays publicly visible (no revalidation). **B69** the buyer app has no way to raise a dispute.
- **Not tested:** KYC submission/approval (needs a new partner sign-up), partner Bulk CSV listings, partner profile/KYC screens, escrow dispute/freeze/refund paths, WATI webhook, Razorpay webhooks, the "I acknowledge" data-use agreement, admin Platform Config edits other than the one key added.
- **Cloud fix sessions:** frontend session (`RealtyDoor/realtydoor-frontend`) was started by the user; the backend session (`dev2-realtydoor/Rbac`) could not be created after four attempts (GitHub app access), so the backend fixes are not being worked on yet.
- **B40 / B42** admin ticket screen has no resolve/comment, and no ticket events notify anyone (tickets can't be closed end to end).
- **B35** more properties with orphaned `partnerId` ("CS REddy vilas", "3 BHK Flat in Baner") — same crash class as B27; clean data and add null-safe reads.
- **B17 / B17b** allocation-letter upload returns 500 for PDFs; route uses the image-only uploader — `backend leads.routes.js` l.23 (`visitPhotoUploader` = IMAGE_FORMATS in `lib/fileUpload.js` l.126). Map fileFilter errors to 400.
- **B21** buyer app never sees partner-added leads (`buyerId` null by design) and gets no in-app notification for visit scheduled/OTP, so those deals can't reach escrow.
- **B27** commission prefill/lock crashed on an orphaned `property.partnerId` — `backend commission.service.js` `previewTermsForLead` l.230-236 (inline required `partner` relation); needs a null-safe load and a real 400 message.
- **B10** partner can create a lead against a non-approved listing (only option offered was the rejected "Muneshwara nilaya").

### Medium
- **B22** admin Escrow table shows N/A / Unknown Property / Agent: reads `t.buyer/property/partner` but backend returns them under `t.lead` — `admin-nextjs .../escrow/page.tsx` l.137, 165, 263-268, 307, 318.
- **B28** release form prefills seller bank holder with the assigned partner (`escrow/page.tsx` l.318 → `ReleaseEscrowModal.tsx` l.100); two partner-share settings with different bases; `razorpay_webhook_secret` stored plain in PlatformConfig.
- **B33 / B34 / B4** partner metrics inconsistent after release (dashboard "Escrow released ₹0" vs Finance ₹50,000; "deals pending" counts leads); no closed/released notifications for partner or buyer.
- **B2** admin SLA banner wrong (lists 10+-day-old and already-assigned leads as "approaching breach").
- **B15** OTP accepted ~29 h before the scheduled visit slot.
- **B26 / B29** commission lock and buyer-confirmation steps are invisible/WhatsApp-only; release modal gives no guidance earlier in the flow.
- **B18** dashboard offers "Upload escrow docs" before escrow is HELD; partner has no way to send the escrow link.

### Low / polish
B1, B3, B5, B6, B7, B8, B9 (verify), B11 (dev compile ~35 s), B13, B14, B16, B19, B23, B24 (`/user` root 404), B25, B30, B32.

### Not covered
In-app notification and WhatsApp copy for the visit OTP were confirmed by the user only; public site, KYC queue, property review, CMS, disputes, loans, and tickets were not exercised. Webhook handling untested.

## E2E run 2 — full buyer-originated run (19 Oct, after the razorpay.js idempotency fix)

Lead RD-L-000086 · property "MOCK QA — Change Request Approved" (₹81 L) · escrow 6ad5b1b2b42af539e3dad76e · payout pout_Tpf25152gAXzZb.

| Step | Role | Result |
|------|------|--------|
| 1 Inquiry with message "E2E QA inquiry" (phone verified in app) | user | PASS — "Inquiry sent" page; admin Lead Dispatch shows RD-L-000086 UNASSIGNED with the message |
| 2 Assign to Developer One | admin | PASS — partner sees lead NEW with message; Krishna gets "Your Inquiry is Being Processed" in-app; commission auto-locked v1 at assignment (partner gets "Commission locked") |
| 3 Schedule visit (20 Oct 15:00) → WhatsApp OTP → partner enters OTP | partner/user | PASS — OTP arrived on WhatsApp; "Visit logged", phone revealed; Krishna's card moves to "Token payment pending". FAIL (known): no in-app notification for visit scheduled/OTP (B21/B34) |
| 4 Pay ₹50,000 token, Razorpay test checkout (pay_TpezMjh7VFN6TP) | user | PASS — Payment Successful; partner close page shows ₹50,000 HELD |
| 5 Upload allocation letter + Mark as closed | partner | PASS with PNG; PDF still 500 (B17); "Closed" |
| 6 Release with dummy seller account | admin | PASS — payout created, escrow RELEASED, admin held ₹2,50,000 / released MTD ₹1,00,000. B31 fix verified on a second deal |
| 7 Sync check | all | Admin: "Deal Closed — Escrow Review Needed" to 5 admins (DB). Partner finance: 2 closed deals, "Released this month ₹1.0L (2 deals)" (whole escrow amounts, B33). Krishna: both inquiries stop at "Deal closed" step 5/8 after release; NO closed/released notification for partner or buyer (DB has no such rows) → B34/B37 |

New findings:
| ID | Role | Severity | Where | Detail |
|----|------|----------|-------|--------|
| B35 | admin/data | high | Property data | Besides "Maruthi Nilya" (fixed), approved properties "CS REddy vilas" (6ac8dbd424511fa2becd53b9) and "3 BHK Flat in Baner" (6a44a67c287fb9ab18e3fc55) also have orphaned `partnerId`; any Prisma query that includes the required `partner` relation (e.g. `findMany({select:{partner:…}})`, commission preview, escrow/lead includes) throws "Inconsistent query result: Field partner is required … got null". Needs a data cleanup + null-safe reads / FK integrity |
| B36 | partner | medium | Close deal page | "You receive (after platform fee)" shows ₹49,000 for RD-L-000084 but ₹50,000 for RD-L-000086 (same ₹50,000 token, platform fee 1% / partner commission locked 2%) — calculation differs by deal with no explanation |
| B37 | user | medium | Buyer inquiry timeline | After admin releases escrow the card stays at step 5/8 "Deal closed — your token went through escrow to get here"; steps 6-8 never advance, and Krishna's bell keeps an unread dot while the list has no new item |
| B38 | partner | low | Commission | After release, partner Commission column still "—" / PENDING, even though terms were locked at 2% and partner share recorded (₹1,000) |

## Phase 1 — Service tickets (19 Oct)

Ticket TKT-D776 (6ad5b581b42af539e3dad776) "E2E QA ticket: bathroom tap leaking", General, High.

| Step | Role | Result |
|------|------|--------|
| Raise ticket (subject, description, High) | user | PASS — "Ticket raised" page with ref and "what happens next". Duplicate-open-ticket warning shown but allowed |
| Appears in /admin/tickets as HIGH/OPEN, unassigned count 1 | admin | PASS |
| Dispatch vendor (name + phone, used user's own number) | admin | PASS — list shows IN PROGRESS + vendor, stats update (unassigned 0, in progress 6) |
| User ticket detail: "Vendor en route", vendor + call button, timeline | user | PASS |
| User adds note | user | PASS — shown in user's "Notes on this ticket" |
| Admin sees note / can resolve / can comment | admin | FAIL — see B40/B41 |
| Resolve → user verify | admin/user | NOT REACHABLE from the UI (no resolve action) |

| ID | Role | Severity | Detail |
|----|------|----------|--------|
| B40 | admin | HIGH | Admin ticket detail (`admin-nextjs …/tickets/[id]/page.tsx`) is read-only; the list only offers "Dispatch vendor". The backend already has `PATCH /admin/tickets/:id`, `PATCH /admin/tickets/:id/resolve`, `GET/POST /admin/tickets/:id/comments` (`admin.routes.js` l.201-214) but the UI never calls resolve/comment, so no ticket can reach RESOLVED/VERIFIED and the user's "Verify the fix" step (`/user/tickets/[id]/verify`) can't be exercised |
| B41 | admin | medium | User notes on a ticket never appear on the admin detail page (no comments section) |
| B42 | admin+user | HIGH | No in-app notification for any ticket event: a new HIGH-priority ticket doesn't notify admins, vendor dispatch doesn't notify the user, notes don't notify the other side (DB: none created) |
| B39 | admin | medium | /admin/tickets stat "Avg resolution −20.0 days" (negative) |
| B43 | admin | medium | Release modal "Suggested partner share ₹1,000 (2% of held)" ignores the locked commission (₹3,240 = 2% of the fee) |
| B44 | admin | low | "Deal Closed — Escrow Review Needed" notification shows the raw lead id (`Lead #6ad5b0d3…`) instead of RD-L-000086 |
| B45 | admin | low | /admin/tickets "Dispatch vendor"/"View" action column is clipped at 1470 px viewport (button partly off-screen) |
| B46 | user | low | Raise-ticket form: pre-existing junk ticket ("iojqoiew") is shown as the "Current ticket" for the user; subject accepted with no minimum quality check |

## Phase 2 — Partner listing, Property Queue, KYC Queue, public site (19 Oct)

Listing P-DAD778 "E2E QA 2BHK Apartment Whitefield" (6ad5b700b42af539e3dad778, slug `e2e-qa-2bhk-apartment-whitefield-1792390912370`), ₹75 L, 5 test photos, placeholder RERA `PRM/KA/RERA/1251/446`.

| Step | Role | Result |
|------|------|--------|
| 4-step form (Basics → Photos → Compliance → Review), Maps link "Verify" autofills address/city/state/pincode | partner | PASS. Photo validation works (blocks Next with 0 photos). Terms checkbox ticked and submitted with user's OK |
| Appears in Property Queue (PENDING APPROVAL, RERA "Pending review"), badge 8→9 | admin | PASS |
| Approve (one click, no confirm) | admin | PASS — badge back to 8 |
| Listing LIVE in partner list, "Listing Approved!" notification | partner | PASS |
| Public page and search results show the listing | public/user | PASS |
| KYC Queue | admin | Viewed only: 0 pending / 4 not submitted / 11 verified / 1 rejected; review page with doc viewer + Reject works. New KYC submission/approve NOT tested (needs a new partner sign-up) |
| Reject path | admin | Not re-run (earlier rejection "Compliance — RERA number missing" reached the partner as a notification, seen in the data) |

| ID | Role | Severity | Detail |
|----|------|----------|--------|
| B52 | admin/partner/public | HIGH | RERA shown as "Verified" with no verification: partner Review step says "RERA Verified ✓", admin card flips to "✓ Verified" the moment the listing is approved, and the public page shows "Verified by Realtydoor — RERA Verified" — but the DB has `isVerified:false`, `verifiedAt:null` and the number is a placeholder that only passes a regex ("Format OK"). KYC Queue banner itself says "RERA/PAN aren't auto-verified". Public trust/legal risk |
| B47 | partner | medium | Dashboard said "Listings live 1 · all approved" while the only listing (Muneshwara nilaya) was REJECTED and /partners/listings said "0 live" |
| B48 | partner | low | Photo rules disagree: tip card "Minimum 6 photos", validation "minimum 5 total (cover + 4)", counter "6 more recommended" |
| B49 | partner | low | Compliance step shows unfinished copy: "Upload available once the backend accepts document types" for Khata certificate and Mortgage NOC |
| B50 | admin | medium | Approval gate is empty: ~35 approved listings have RERA "Missing" and 0 photos (MOCK QA set, "Wakad (Pending Approval)", Commercial Office…), many duplicates ("3 BHK Flat in Baner" ×6) |
| B51 | admin | medium | Property Queue "TYPE" shows PLOT for flats/villas/apartments ("3BHK Apartment, Brigade Cosmopolis", "3 BHK Flat in Baner", "3 BHK Flat in Sunrise Towers") — type mapping wrong for legacy rows (the new listing correctly shows FLAT) |
| B53 | admin | medium | KYC Queue lists many partners as VERIFIED with "0 uploaded" documents (Pause Test Partner, Mock QA ×10) — verification doesn't require documents |
| B54 | admin | low | Developer One KYC review: header "Documents 7 uploaded" vs "Documents (2)" list; partner phone "–" even though a verified partner; Property Queue loads all 60 listings with no pagination |
| B55 | partner | low | "Listing submitted" card title reads "2BHK · E2E QA 2BHK Apartment Whitefield" (type duplicated in the title); "RERA NO. ADDED" badge and "Verified ✓" shown together |
| B56 | public | low | Property page shows "Send Inquiry — You'll sign in first so your inquiry is saved to your account" while already signed in as Krishna; similar-properties card shows price "₹—" |

## Phase 3 — Documents + Loans (19 Oct)

Loan application E3DAD77E (6ad5b95bb42af539e3dad77e): Krishna M, HDFC Bank, ₹30,00,000, 20 yrs.

| Step | Role | Result |
|------|------|--------|
| Upload PAN / Aadhaar / Salary slip (blank labelled test PNGs) in /user/documents | user | PASS — rows go "Under review" |
| Admin Document Vault shows 3 PENDING REVIEW, Approve each | admin | PASS |
| /user/loans/new unlocks ("Your required documents are verified") | user | PASS; EMI preview correct (₹26,035/mo @8.5%/20y) |
| DPDPA consent → Authorise & Apply (ticked with user's OK) | user | PASS — application created |
| Appears in /admin/loans (E3DAD77E, HDFC, ₹30 L, Documents (3)) | admin | PASS |
| Sanction / Reject buttons | admin | FAIL until status was moved to DOCUMENTS_VERIFIED via API (B59) |
| Sanction → user tracker "Sanctioned ✓ 5/5", sanctioned screen, notification | admin→user | PASS after unblock |
| Disburse / Reject | admin | NOT run |

| ID | Role | Severity | Detail |
|----|------|----------|--------|
| B59 | admin | HIGH | `admin-nextjs …/loans/page.tsx` l.194-207 only shows Sanction/Reject for DOCUMENTS_SUBMITTED / DOCUMENTS_VERIFIED / SENT_TO_BANK / AWAITING_SANCTION, but every new application is created as DOCUMENTS_PENDING (even when all docs are already admin-verified), and the UI has no way to move it forward — new loans are stuck. I had to PATCH `/api/admin/loan/:id/status` → DOCUMENTS_VERIFIED from the browser to continue. Fix: create at DOCUMENTS_VERIFIED when docs are verified, or add a "Mark documents verified / Send to bank" action |
| B60 | admin | medium | `admin.service.js updateLoanStatus` accepts any status → any status (no transition rules; e.g. DISBURSED → DOCUMENTS_PENDING allowed) |
| B61 | admin/user | medium | Sanctioning asks for no sanction amount, ROI, tenure or letter; the user then sees "Sanction letter ready ₹30,00,000 approved / Download letter" with nothing uploaded by admin (amount = requested amount) |
| B57 | user | low | No in-app notification when the document vault items are approved |
| B58 | user | low | Tracker shows status "Documents Pending" and "STEP 1/5" while its own story says "HDFC Bank verified your documents"; "Reference pending • 1 days" (grammar, no reference) |
| B62 | admin | medium | New loan application creates no notification for admins and no in-app confirmation for the user (DB: only `LOAN_STATUS_UPDATE` rows after status changes) |
| B63 | partner | medium | Partner notification deep links use `/partner/...` (e.g. `/partner/leads/<id>`, `/partner/finance`) but the app routes are `/partners/...` → links 404 |
| B64 | user | low | /user/loans stepper labels "Browse · Loan · Keys · Live" vs admin statuses; step counter says 5/5 at SANCTIONED although disbursement is still pending |

## Phase 4 — Services / subscriptions (19 Oct)

Maintenance Premium ₹4,599/yr, Krishna, Razorpay test card. Payment 1 deliberately failed on the mock bank page (user clicked Failure), payment 2 succeeded (`pay_TpfggbWJzIj6XD`).

| Step | Role | Result |
|------|------|--------|
| Catalog /user/subscriptions: only Maintenance Premium purchasable; Legal etc. "Coming soon" | user | Info |
| Subscribe button | user | Disabled "Subscribe — coming soon" (hard-coded `ComingSoonButton`) — see B65 |
| Direct `/user/subscriptions/book/<serviceId>` → Confirm & pay → Razorpay test checkout | user | PASS (bypasses the gate) |
| Failed payment: "Payment could not be completed" with retry; no stray subscription row (DB: exactly 1 `UserSubscription`) | user | PASS |
| Successful payment: "Maintenance Premium is now active until 19 Oct 2027", "Service Activated" in-app notification | user | PASS |
| Admin Revenue P&L: Service revenue ₹9,598 (2 payments; was ₹4,999) | admin | PASS |
| Admin Service Tickets: auto-created "Maintenance Premium — Initial Setup" OPEN, unassigned (badge 1) | admin | PASS |

| ID | Role | Severity | Detail |
|----|------|----------|--------|
| B65 | user | medium | The "Coming soon" lock on Subscribe is cosmetic: `/user/subscriptions/book/<id>` is directly reachable and takes a real payment, activates the plan and creates the ticket. Either enforce the flag on the booking page and `POST` subscription/payment endpoints, or remove the lock |
| B66 | user | low | Service card/booking page show a broken image icon for Maintenance Premium (`imageUrl` broken) |
| B67 | admin | medium | Revenue P&L "Escrow commission ₹1,700 · 2 closed deals · avg ₹850" does not reconcile with releases: each ₹50,000 release shows platform fee ₹500 (1%), i.e. ₹1,000 total (partner share ₹1,000 each is recorded separately) |
| B68 | admin | low | Paid subscription and its auto-created ticket generate no admin notification (DB: only `SERVICE_ACTIVATED` to the user); sidebar badge is the only signal. Service Tickets stat "Avg resolution −20.0 days" (B39) persists |

## Phase 5 — Disputes and partner support (19 Oct)

Dispute 6ad5bc2cb42af539e3dad784 (SERVICE, Krishna, raised via API because the buyer app has no dispute UI). Partner ticket SUP-0011 (6ad5bcbbb42af539e3dad785).

| Step | Role | Result |
|------|------|--------|
| Raise a dispute from the buyer app | user | FAIL — no UI exists (B69); raised with `POST /api/user/disputes` from Krishna's session |
| Dispute appears in /admin/disputes OPEN, counters | admin | PASS |
| Review dialog: note + status | admin | FAIL first try: "Dispute updated" toast but status stayed OPEN (B70); PASS after explicitly choosing "Resolved" — counters update (open 0, resolved MTD 2) |
| Buyer informed of dispute update/resolution | user | FAIL — no notification (B71) |
| Partner raises support ticket (category/subject/description) | partner | PASS — SUP-0011 shown OPEN in list |
| Admin /admin/partner-support shows it, reply, "Answered" status, reply & resolve controls | admin | PASS — list updates immediately |
| Partner sees ANSWERED + admin response; in-app notification created | partner | PASS (detail page), notification link broken (B63/B72) |

| ID | Role | Severity | Detail |
|----|------|----------|--------|
| B69 | user | HIGH | No buyer-facing way to raise a dispute: backend `POST /user/disputes` + `GET /user/disputes` exist (`users.routes.js` l.98-99, `disputes.service.js`), but the user app has no dispute screen or link (escrow pages promise a 48-hour refund path but offer no "Raise a dispute"/"Report a problem") |
| B70 | admin | HIGH | Admin dispute dialog displays "Under review" as selected but doesn't send it: saving with only a note leaves status OPEN while the toast says "Dispute updated"; list/counters also don't refresh until reload. Make the displayed status the real form value (or add "Open") and revalidate the list |
| B71 | user/admin | medium | `disputes.service.js` raise/resolve create no notifications: admin isn't alerted to a new dispute, Krishna isn't told when it's under review/resolved or the admin's note |
| B72 | user | low | `SERVICE_ACTIVATED` notification links to `/dashboard/services` (no such route; should be `/user/subscriptions`) |
| B63b | partner | medium | `PARTNER_TICKET_UPDATED` link is `/partner/support-tickets/<id>`; real route is `/partners/support/<id>` (same `/partner/` vs `/partners/` mistake as B63) |
| B73 | partner | low | Answered partner ticket has no reply box (no way to follow up); two junk tickets from 18 Oct (SUP-0009/0010) are still OPEN with no reply despite "Avg reply 2h on weekdays" |

## Phase 6 — Contact messages, NRI video tours, NRI leads (19 Oct)

| Step | Role | Result |
|------|------|--------|
| Public /contact form (name, email, phone, subject, message) → "Thank you, message sent" | public/user | PASS |
| Admin Contact Messages: new message at top (NEW, full details), unread 27→26 after Mark resolved | admin | PASS (email reply not sent to avoid real outbound mail) |
| Video tour request at /user/nri (slot, timezone, questions) → "Latest request: PENDING" | user | PASS, but no confirmation message and form stays filled |
| Admin NRI Video Tours shows request PENDING; "Manage video tour" dialog (staff id, scheduled at, video URL, note) → ASSIGNED with schedule | admin | PASS (see B76-B78) |
| Public /nri 4-step wizard (area, home type, timeline, budget) + name/phone → "You're all set" | public | PASS |
| Admin NRI Leads: new lead listed with all wizard answers; Mark read (unread 7→6) | admin | PASS |
| Buyer sees assigned/scheduled video tour | user | Not re-checked after assign |

| ID | Role | Severity | Detail |
|----|------|----------|--------|
| B79 | all | medium | No in-app notification for any of: new contact message, new video-tour request, tour assigned/scheduled, new NRI lead (DB: none created). Admins rely on sidebar counts; buyer isn't told the tour was scheduled |
| B76 | admin | medium | NRI video-tour admin row/dialog doesn't show the time slot the buyer picked (Scheduled "—") or the buyer's questions; admin has to re-enter a time with no reference |
| B77 | admin | low | "Assigned to" column shows a raw user id (`6accd985…`) instead of the staff name |
| B78 | admin | medium | "Manage video tour" asks for a free-text "staff ID" (no picker/validation) — I could assign a partner user id as staff |
| B74 | public | low | /contact is not prefilled for a signed-in user (name/email/phone empty) |
| B75 | user | low | /user/nri: banner "Mark yourself as an NRI in profile to unlock remote video tours" shown while the booking form works; price shown unformatted ("Bengaluru · 7500000"); no success toast or form reset after confirming, so a second click can create a duplicate request |

## Phase 7 — CMS: blogs, services, locality insights (19 Oct)

Test article `e2e-qa-test-article` (created, published, unpublished). Service "Property Valuation Report" short description edited then reverted.

| Step | Role | Result |
|------|------|--------|
| "New article" → editor (title, slug, image, author, excerpt, content, tags, SEO) → Save | admin | PASS, but see B80 |
| Draft not visible publicly (`/blog/<slug>` → 404) | public | PASS |
| Publish from list → `/blog/e2e-qa-test-article` shows title/excerpt/content | public | PASS |
| Unpublish → public page removed | public | **FAIL** — DB `isPublished:false` but the public page still rendered 3+ min later (B81) |
| Services CMS edit (short description) → appears on `/user/subscriptions?category=VALUATION` immediately; reverted | admin→user | PASS |
| Locality insights CMS (29 rows, 4 stale) vs public property page ("Whitefield ₹14,500/sqft, yield 3.06%") | admin→public | PASS (read-only check) |
| Admin account opening `/user/...` | admin | PASS — "You don't have access to the User portal" (role isolation works) |

| ID | Role | Severity | Detail |
|----|------|----------|--------|
| B81 | admin/public | HIGH | Unpublishing (and presumably editing/deleting) a post doesn't invalidate the public page cache: `app/actions.ts` only calls `revalidatePath("/admin","layout")`; nothing revalidates `/blog`, `/blog/[slug]`, locality or property pages. Unpublished content stays publicly visible. Add `revalidatePath('/blog')`, `revalidatePath('/blog/<slug>')` (or tags) on publish/unpublish/edit/delete |
| B80 | admin | medium | Clicking "New article" immediately persists a DRAFT titled "New Draft" (slug `new-draft-<timestamp>`) — every click/abandoned editor leaves a junk row; this is how the live public post titled "New Draft" (slug `plot-buyers-6-month-investment-check-in`) exists, and it is listed as the only "Related Blogs" on every article |
| B82 | public | low | Published blog page doesn't show the author ("QA Team"); `Related Blogs` shows only the junk "New Draft" |
| B83 | admin | low | Services catalog "Price changes are live immediately" but Revenue P&L shows "Maintenance Premium avg ₹4,799" (₹4,999 and ₹4,599 mixed in one stream) — price history isn't tracked per payment |

## Phase 8 — User features + admin visibility (19 Oct)

| Step | Role | Result |
|------|------|--------|
| Save listing to favorites → /user/favorites (2 saved) | user | PASS |
| Select 2 saved → "Compare 2 side-by-side" → /user/properties/compare | user | PASS |
| /user/alerts (8 alerts, tabs All / Price drop / New matches) | user | PASS with issues (B87) |
| Rate partner (4 stars + comment) → "Thanks for the feedback" | user | PASS; stored on lead (`buyerRating:4`, comment, `buyerRatedAt`) |
| Admin Ratings & Reviews shows that rating / partner average | admin | **FAIL** (B89) |
| Edit profile (address) → Save → profile summary reflects inquiries 2, services 1, vault 3 verified, loan sanctioned | user | PASS |
| Admin User Management list/detail for Krishna (role, status, vault summary matches) | admin | PASS with issues (B90, B91) |
| Admin Audit Logs lists admin actions with actor/IP/time | admin | PASS for leads, commission, escrow, property, contact, partner tickets, ticket dispatch/resolve; gaps in B92 |

| ID | Role | Severity | Detail |
|----|------|----------|--------|
| B89 | admin | HIGH | Buyer partner ratings never reach admin: `/admin/ratings` "Partner ratings" and "Vendor ratings" are hard-coded sample rows ("Sample · backend pending": Anita Reddy ★4.9, Ravi Kumar ★4.7, Suresh Patel, Kiran Mehta; Mr. Plug, CoolFix…). Krishna's real 4★ review of Developer One (stored in `Lead.buyerRating`) appears nowhere, and no partner average/low-rating flagging exists (`admin-nextjs …/ratings/page.tsx` l.48). Only property reviews are moderated |
| B92 | admin | HIGH | Audit log ("Every admin action is logged… Immutable") misses: loan status changes, document approvals/rejections, dispute updates, platform-config create/edit (e.g. `default_partner_share_pct`), CMS publish/unpublish/edit, service edits, NRI video-tour assign, NRI lead mark-read, KYC. Only leads/commission/escrow/property/contact/partner-ticket/service-ticket actions are recorded |
| B90 | admin | medium | User Management list and detail show Inquiries 0 / Spend "—" / LTV "—" for Krishna (he has 2 inquiries, 3 payments ≈ ₹1.05 L); header "Phone verified 25 (76%)" fine |
| B91 | admin | low | Krishna's detail "Recent activity: No admin actions logged yet" even though admin approved his documents, sanctioned his loan, resolved his dispute (consequence of B92); detail Overview doesn't show profile address or city |
| B87 | user | medium | /user/alerts: 8 alerts with 3 identical "PRICE DROPPED · 3BHK Brigade Cosmopolis ₹1.05Cr → ₹98L, 12d ago" cards, each claiming "You have an active inquiry here" (Krishna has none on it); every "View deal" link goes to the generic `/properties` |
| B84 | user | medium | Compare page "Popular properties in Pune — RERA-verified projects across Pune" lists MOCK QA listings that have no RERA; QA listing shows "REALTY DOOR VERIFIED" (B52) |
| B88 | user | low | "Rate your partner" shows Developer One as "Agent" (partner is OWNER) and uses karnataka/Bengaluru; no list of partners rated, no way to edit a submitted rating |
| B86 | all | low (dev) | While a route compiles (Next dev), pages briefly render "Your session has expired — sign in again" even though the session is valid (APIs return 200) — confusing; verify it doesn't appear in production builds |

## Phase 9 — Admin settings: vendors, team and roles, WATI, analytics (19 Oct)

| Step | Role | Result |
|------|------|--------|
| Vendor Management: Add vendor (name, phone, email, category, city, notes) → listed ACTIVE (8→9); Deactivate → INACTIVE with "Reactivate" | admin | PASS (QA vendor left INACTIVE) |
| Team & roles (/admin/platform/staff) | admin | **Static sample data** (B97) |
| Public team roster (/admin/platform/team) | admin | PASS (3 people, Invite/Edit/Revoke; not exercised to avoid real invite emails) |
| WATI templates / delivery log | admin | Viewed: 1 template; stats inconsistent (B98) |
| Platform Analytics | admin | Funnels reconcile with other screens (leads 34, escrow GMV ₹1,85,000, service revenue ₹9,598, top partner Developer One 2 deals); growth/total mismatch (B99) |

| ID | Role | Severity | Detail |
|----|------|----------|--------|
| B97 | admin | HIGH | `/admin/platform/staff` ("Team & roles") is hard-coded: `app/admin/(dashboard)/platform/staff/page.tsx` l.16 `const STAFF` (and `staff/[id]/page.tsx`) — fictional people (Vikram Kothari, Anjali Sharma, … `@realtydoor.in`), fake IPs/cities, "2FA enforced 6/7", "Ashwin Mehta has 2FA disabled — grace ends 20 May 2026" (a past date), "Active sessions 4", "Sensitive actions (7d) 184", "Force enrollment" button. None of the real admin accounts (Dev 0, Admin Test, Admin User, Ank K, piku k) appear, so the page presents false security/permission information. Back it with real data or label it a mock |
| B94 | admin | medium | Ticket "Dispatch vendor" takes free-text name+phone and never creates or references a Vendor Management record (my "QA Test Vendor" isn't in the list); the vendors list (8) is unused by dispatch. Let dispatch pick from active vendors by category |
| B95 | admin | low | Vendor deactivate confirm says "This can't be undone" but the row then offers "Reactivate"; list contains duplicate vendor "Ankur" (same email, two phones) and a vendor named after the admin ("Dev 0", city typo "Banglore") |
| B98 | admin | medium | WhatsApp templates page: "Messages (MTD) 81" but "Delivery rate 0%" and "Spend 0"; the only template listed is "QA Sample Template" (PENDING META) although the app sends OTP/lead/ticket WhatsApp messages (those templates aren't shown or managed); "New template" is disabled |
| B99 | admin | low | Platform Analytics: "User growth Oct 26 = 32" while "Total users 19 (role USER)" (and User Management shows "Total users 33 … Partners 18") — counts mix roles; "Service revenue ₹9,598 — no prior month data" while the chart shows ₹4,999 in Jun 26 |

## Phase 10 — WhatsApp wiring, webhooks, platform config (19 Oct, run 3)

WATI account switched to the owner's logged-in tenant (422588); all 6 approved templates sent to <owner-test-number> and arrived. New code (uncommitted, backend): `notifyUser` in `lib/wati.js` + calls at ticket dispatch, listing approve/changes, token received, payout processed, loan status, partner support reply (draft templates stay off until listed in `WATI_LIVE_TEMPLATES`).

| ID | Role | Sev | Area | Finding | Status |
|---|---|---|---|---|---|
| B100 | admin | HIGH | Service tickets > "Dispatch vendor" | The dialog calls PATCH /admin/tickets/:id (free-text vendorName/phone), not the `/dispatch` endpoint, so the buyer got NO notification (in-app or WhatsApp) and no Vendor link is set. | Patched locally in `updateTicketStatus` (in-app + WhatsApp `ticket_vendor_dispatched`); verified: ticket 6ad5bb96… dispatched in the UI, WatiMessageLog row linked to the ticket, notification row created. Real fix: make the dialog pick a Vendor from the directory and call `/dispatch`. |
| B101 | backend | HIGH (security) | POST /api/webhooks/wati | `WATI_WEBHOOK_TOKEN` is unset, so the token check is skipped and ANY caller (even with a wrong token) is accepted; a forged "yes/no" reply changes a lead's buyerFeedbackStatus, which feeds the escrow-release "buyer confirmed" condition. | Patched locally: 503 in production when the token is missing, warning in dev. Owner must still set the token and the WATI webhook header. |
| B102 | admin | medium | Platform > Config | Numeric keys accept any text: `escrow_auto_escalate_days` saved as "abc" with a "Setting updated" toast (reverted to 14). No type/range validation. | Open |
| OK | backend | — | Razorpay webhook | Bad signature -> HTTP 400; valid signature -> 200. | Pass |
| OK | backend | — | WATI webhook | Delivery event updates the log (DELIVERED); unrelated text ignored; "2" with no matching lead -> `no_matching_lead`. | Pass (apart from B101) |
| OK | admin | — | Platform config edit | Edit saves and reflects in the list. | Pass |

Still not tested: KYC submission/approval (needs a new partner sign-up), partner bulk CSV listings, escrow freeze/refund/dispute paths, NRI video-tour buyer view, the 24h/7d feedback jobs, a production build.

## Fixes applied locally (19 Oct, uncommitted)

Backend (`Rbac/realtydoorBackend`):
| Bug | Fix | Verified |
|---|---|---|
| B102 | `config.service.js`: numeric/boolean keys validated on write (non-negative number, `_pct` ≤ 100, true/false) | unit check: "abc", -1, 150, "maybe" rejected; phone and text keys still accepted |
| B27/B35 | `commission.service.js`: partner subtype / payer name read via a separate `findUnique` in `previewTermsForLead`, `setLeadTerms`, invoice | `previewTermsForLead` on lead RD-L-000011 (orphaned property) returns terms instead of throwing |
| B17 | new `dealDocUploader` (jpg/png/pdf) for allocation letter, token receipt, closure docs in `leads.routes.js` and `partners.routes.js`; multer/filter errors now 400 | syntax + module load only (not re-uploaded through the UI) |
| B12 | `confirmLead`: with no partner chosen, a partner-added lead is assigned to the adding partner (if KYC verified) | syntax only |
| B59 | `createLoanApplication`: new applications start at DOCUMENTS_VERIFIED (docs are already verified at that point), history has both entries | syntax only |
| B52 (backend) | `properties.service.js`: `reraVerified` now needs `isVerified` as well as a number | syntax only |
| B100 | `updateTicketStatus` notifies the buyer (in-app + WhatsApp) | verified in the UI earlier |
| B101 | WATI webhook rejects with 503 in production when `WATI_WEBHOOK_TOKEN` is unset | syntax only |

Frontend (`admin-nextjs`): B52 — public property page and `/user/properties/[id]` show "RERA Verified" only when the number AND `isVerified` are set; the partner Review step no longer claims "RERA verified". `tsc --noEmit` passes; `npm run build` NOT run (dev server is using .next).

Not touched: B21, B65, B29 (owner decisions), B40/B41/B70/B71/B81/B89/B92/B97 (frontend or larger work).

### Fixes applied locally — batch 2 (19 Oct, uncommitted)
| Bug | Fix | Verified |
|---|---|---|
| B40/B41 | New `ResolveTicketModal` ("Mark resolved" on IN_PROGRESS tickets, visit/parts charge + note → PATCH /admin/tickets/:id/resolve) and `TicketComments` thread (GET/POST /admin/tickets/:id/comments) on the admin ticket detail page | page renders with the button and an empty thread (UI); resolve/reply not submitted |
| B70 | `ResolveDisputeModal`: dropdown shows the real status (adds "Open (no change)" while OPEN), status only sent when changed, list refreshes after save | type-check only |
| B71 | `disputes.service.js`: admins notified on a new dispute; the buyer gets an in-app notification (+ `dispute_update` WhatsApp once approved) on every admin update; audit row `DISPUTE_UPDATED` | syntax only |
| B81 | `app/actions.ts`: after an admin edit, revalidates the public pages for that content (`/blog`, `/faqs`, `/press`, `/about`, `/services`, `/locality`, `/properties`) | type-check only |
| B89 | New `GET /admin/ratings/summary` (partner avg from Lead.buyerRating, vendor avg from ServiceTicket.vendorRating, <3 flagged); `/admin/ratings` shows real data, sample rows removed | page shows Developer One ★4 (2 closed deals, 1 rating); vendors empty state |
| B92 | New `middleware/auditAction.js` applied to CMS, loan status, services, documents, NRI lead read, team, video tours, vendors, platform config; dispute updates logged | config edit via UI wrote `PLATFORM_CONFIG_SET` with the value; others not exercised |
| B97 | `/admin/platform/staff` and `/[id]` now read GET /admin/staff and the admin's audit log (real accounts, roles, status); fake 2FA/sessions/IPs/alerts removed; Invite page labelled "does nothing yet" with Send disabled | page shows the 5 real admin accounts, all with "no role set" (warning shown) |

Also confirmed in the UI: B102 — saving "abc" for a numeric config key now shows "must be a non-negative number".
Still open from this list: B69 (no buyer dispute screen — notification link omitted until it exists), B92 for KYC/user-role (already audited in their services), and everything in the owner-decision list.

### UI verification of fixes (19 Oct, run 3)
| Fix | Result |
|---|---|
| B40/B41 ticket reply + resolve | PASS — admin posted a reply on ticket 6ad5bb96… (shows in the thread, "Reply sent to the user"), then "Mark resolved" with no charge + note: status RESOLVED, "Awaiting user verification", note shown under Admin notes |
| B17 PDF allocation letter | PASS — partner uploaded a PDF on /partners/leads/<RD-L-000085>/close: step turned green ("Allocation letter · Uploaded"), DB has `allocationLetterUrl …/visits/<uuid>.pdf` and `allocationLetterUploadedAt` |
| B12 partner-added confirm | PASS — Developer One added RD-L-000087 (Krishna M, with the buyer-consent box ticked); admin confirmed it from Partner-added; DB: status ASSIGNED, assignedPartnerId = addedByPartnerId (Developer One). Before the fix it became UNASSIGNED with no partner |
| B59 loan apply | PASS — Krishna applied (HDFC, ₹30,00,000, document-sharing consent ticked): new application starts at DOCUMENTS_VERIFIED with both history entries; the buyer tracker shows "Documents Verified" and the admin Loan origination row shows Sanction/Reject buttons (before: stuck at Documents Pending, no buttons) |

New finding (B104, partner, medium — FIXED locally in `AddLeadForm.tsx`: after a successful submit it shows "Lead sent to admin for review…" and returns to the list instead of opening the dead detail page; type-check + eslint pass, not re-run in the UI because that would create another lead): right after "Submit lead" the partner is redirected to /partners/leads/<new id>, which shows "This lead isn't available right now." until admin confirms (the lead is AWAITING_ADMIN, which the partner detail endpoint refuses). Should show a "Sent to admin for review" state or return to the list.
New finding (B103, owner): the local backend uploads to the S3 bucket `realtydoor-production` (`visits/…`, earlier `properties/…`, `receipts/…`). Test files from QA runs are in the production bucket; use a separate dev bucket.

## Pre-push test report (19 Oct, run 3)

Automated: backend jest 88/88 pass; frontend vitest 364/364 pass (it caught two of my components using native `maxLength`, which the project forbids — fixed); `tsc --noEmit` clean; eslint on the changed frontend files 0 errors; `node --check` on every changed backend file; production build (`next build --webpack` in a scratchpad copy, so the dev server was untouched) succeeded. Note: the default build uses Turbopack, which refuses a symlinked node_modules, so the Turbopack build itself was not run.

Manual / UI results:
| Change | Result |
|---|---|
| B102 config validation | PASS (UI toast for "abc"; unit check for -1, >100 pct, bad boolean; phone/text keys accepted) |
| B27/B35 commission preview | PASS (lead on an orphaned property returns terms) |
| B17 PDF allocation letter | PASS (UI) |
| B12 partner-added confirm | PASS (UI) |
| B59 loan apply + admin Sanction | PASS (UI: starts Documents Verified, admin sanctions it, buyer notified, audit row LOAN_STATUS_UPDATED) |
| B40/B41 ticket reply + resolve | PASS (UI) |
| B70 dispute dialog | PASS (UI: shows "Open (no change)", list/counters refresh at once) |
| B71 dispute notifications | PASS (5 admin notifications on raise; buyer notification + audit row on update) |
| B81 public cache | FOUND A GAP AND FIXED: the first version (path-by-path revalidation) left an unpublished post at HTTP 200; now `revalidatePath("/", "layout")` for content endpoints. Re-test: publish then unpublish in the CMS -> public /blog/<slug> returns 404 immediately |
| B89 ratings | PASS (UI shows Developer One ★4) |
| B92 audit | PASS for config, CMS, dispute and loan actions (rows written; they also show on the admin's staff detail page) |
| B97 staff pages | PASS (list + detail show the real admin accounts) |
| B52 RERA label | PASS (UI: isVerified listing shows RERA Verified; unverified listing shows only the number) |
| B100 vendor dispatch notification | PASS (UI + WATI log) |
| B101 WATI webhook | PASS (prod/no token 503; dev/no token 200; wrong token 401; right token 200) |
| B104 add-lead redirect | NOT run in the UI (needs another lead); type-check + eslint only |
| WhatsApp wiring for draft templates (listing, escrow token/payout, loan, partner support) | gating verified (draft skipped, live template sent); the escrow-token and payout call sites were NOT exercised (need a payment) |

## Actions performed (so other roles can verify sync)
| # | Role | Action | Entity / ID | Expected effect elsewhere |
|---|------|--------|-------------|---------------------------|
| 1 | admin | Opened /admin dashboard | - | - |
| 2 | admin | Lead Dispatch → Assign RD-L-000077 (Leo Joshi) to Developer One | lead 6ac76e873ed12d2398168d13 | Partner: lead appears as NEW, notification + dashboard count (after reload) — VERIFIED |
| 3 | partner | Opened Schedule site visit for RD-L-000077, cancelled (would send real WhatsApp OTP to Leo Joshi via live WATI token) | same | not sent |
| 4 | partner | Add a new lead: Krishna M, <owner-test-number>, Muneshwara nilaya, consent ticked → submitted | RD-L-000085 (6ad5a1c194d29d2feecabff7) | Admin /leads/partner-added shows it AWAITING ADMIN — VERIFIED |
| 5 | admin | Confirm RD-L-000085 | same | Partner should see it assigned — FAILED (B12), lead went UNASSIGNED |
| 6 | admin | Manually Assign RD-L-000085 to Developer One | same | Partner sees it as NEW — VERIFIED |
| 7 | partner | Schedule site visit 20 Oct 15:00 → Send OTP & schedule | same | WhatsApp OTP to +91 <owner-test-number> — received (user supplied code) |
| 7b | user (manual) | User confirmed WhatsApp OTP arrived on <owner-test-number>; in-app notification for krishna NOT yet verified (profile not connected) | same | pending |
| 7c | user (krishna) | Inspected /user/inquiries and /user/notifications | RD-L-000084 only; RD-L-000085 absent (B21) | verified |
| 7d | user (krishna) | Pay token ₹50,000 for RD-L-000084 via Razorpay test checkout (test card 4111…, mock bank Success) | pay_TpeSCeehog4Jvi, escrow 6ad5aa5564ac1ac2a8b65096 | Krishna: "Token held in escrow" + in-app "Token Advance Received" — VERIFIED. Partner: close page shows ₹50,000 HELD, you receive ₹49,000 — VERIFIED. Admin: /admin/escrow new HELD ₹50,000, held total ₹3,00,000 — VERIFIED. No webhook configured; HELD status reached via client verify |
| 7e | partner | Uploaded allocation letter to RD-L-000084 (PDF → 500; PNG → ok) then Mark as closed | RD-L-000084 | "Lead marked as closed. Admin will review escrow release." Admin release modal opened, NOT confirmed (blocked by commission lock; irreversible payout) |
| 7f | partner | /partners/bank-account → linked dummy seed account (HDFC Bank, holder Developer One, 50100123456280, HDFC0001234 from prisma/seed.js) with user's OK | Developer One | "Bank details registered for payouts", VERIFIED; DB payoutAccountStatus ACTIVE with RazorpayX contact + fund account (test key accepted); admin Release modal now shows "Partner payout account is active ✓". Buyer-confirmed condition still ✗ (WhatsApp-only, B29) |
| 7g | admin | Release: seller = Mock QA Owner dummy (ICIC0001234 / 50100987654321, seed phone/email), partner share payout OFF, Confirm release | escrow 6ad5aa5564ac1ac2a8b65096 | FAILED with idempotency-key error (B31); escrow still HELD, nothing paid |
| 7h | code | Fixed B31 locally: `Rbac/realtydoorBackend/src/lib/razorpay.js` l.87-88 idempotency key `.slice(0, 36)` (NOT committed); nodemon restarted backend | — | — |
| 7i | admin | Retried Confirm release (same dummy seller details) | escrow 6ad5aa5564ac1ac2a8b65096 | RELEASED; payout pout_TpepFxXrz7NYMk processing; admin table: held ₹2,50,000, released MTD ₹50,000 — VERIFIED. Partner: finance shows released ₹50,000 (B33), Krishna: inquiry shows "Deal closed" — VERIFIED; notifications missing (B34) |
| 8 | partner | Entered the OTP at /partners/leads/<id>/otp | same | "Visit logged", phone revealed. Admin Lead Dispatch shows RD-L-000085 SITE VISIT DONE, source PARTNER — VERIFIED. "I acknowledge" (data-use agreement) left for user to click |

## Bugs
| ID | Role | Severity | Where | Steps | Expected | Actual | Status |
|----|------|----------|-------|-------|----------|--------|--------|
| B1 | admin | low | /admin dashboard | Open dashboard | "Service revenue mix" sums to the headline ₹4,999 ("1 subscriptions" grammar too) | Mix items sum to ₹4,998; label reads "1 subscriptions"; top partners all show 0 | open (verify) |
| B2 | admin | medium | Lead Dispatch SLA banner | Open /admin/leads | Banner lists leads actually within 30 min of the 4h SLA | "7 leads approaching SLA breach … within 30 minutes" lists leads inquired 7–8 Oct (10+ days old) and some already assigned (Krishnamurthy M Gokarnkar). Should say breached, and only unassigned ones | open |
| B3 | admin | low | Lead Dispatch rows | Open /admin/leads | Already-assigned leads show Reassign (or nothing) | Every row, incl. ASSIGNED/SITE VISIT DONE, shows an "Assign" button | open |
| B4 | partner | medium | Dashboard "Escrow in flight" | Admin assigns a lead; reload partner dashboard | "N deals pending" counts deals | Count tracks active leads (3→4 after assigning a lead, 0 deals exist) | open |
| B5 | partner | low | Notifications | Admin assigns lead | Notification names the lead and links to it | Generic "A new buyer lead has been assigned to you." no lead name/ID/link | open |
| B6 | partner | low | Sync | Admin assigns lead while partner has /partners/leads open | Count/list updates without manual reload | Stays stale (badge 3) until full reload; no polling/refresh | open |
| B7 | partner | low | Lead detail timeline | Open NEW lead (no visit) | "Visit scheduled" step not highlighted | Banner says "No site visit scheduled yet" but timeline marks "Visit scheduled" as current step | open |
| B8 | partner | low | Stale data | /partners/leads RD-L-000082 | Visit dated 16 Oct (past, today 19 Oct) shows overdue/missed | Still "VISIT SCHEDULED", offers Enter OTP | open (data) |
| B10 | partner | medium | Add a new lead → Property of interest | Open Add a new lead as Developer One | Only approved/live listings selectable | Only option is "Muneshwara nilaya", which the dashboard says was NOT approved (RERA missing); the partner's 1 live listing is not offered | open |
| B11 | admin | low | Dev perf | First click on partner "Schedule visit" | Navigates promptly | ~35s "Compiling" before route loaded (Next dev compile; likely dev-only) | info |
| B12 | admin+partner | HIGH | Partner-added lead flow | Partner adds lead → admin Partner-added → Confirm | Lead stays with the adding partner (dialog says "stays with the assigned partner"; partner form says "assigned to you") and partner can schedule visit | Partner column blank; Confirm sets status UNASSIGNED with no assignedPartnerId → lead absent from partner list; partner redirected after submit to /partners/leads/<id> showing "This lead isn't available right now."; Lead Dispatch badge +1. Backend: `admin.service.js` confirmLead (~l.261-266) ignores `lead.addedByPartnerId`; `leads.service.js` partnerAddLead (~l.185-204) never sets assignedPartnerId. Fix: assign to addedByPartnerId (status ASSIGNED) when no partnerId passed, and let partner see own AWAITING_ADMIN leads as "Pending admin review" | open |
| B13 | admin | low | Confirm dialog | Partner-added → Confirm | Confirm button primary style | Confirm button is red like a destructive action | open |
| B14 | partner | low | Lead detail timeline | Open partner-added lead | "Inquiry added by you" | Says "Inquiry dispatched by Admin" | open |
| B15 | partner | medium | OTP verify vs visit time | Schedule visit for tomorrow 15:00, enter OTP today | Reject/warn before the scheduled slot | "Visit logged · OTP verified 19 Oct 10:25" accepted ~29h before slot; admin shows SITE VISIT DONE | open |
| B16 | admin | low | Notifications page | Open /admin/notifications | Consistent date format; events for visit logged; stale items cleared | Dates are MM/DD/YYYY here vs DD/MM/YYYY on Lead Dispatch; "Escrow release overdue ₹2,50,000" listed twice; "Partner-added lead needs review" still unread after Confirm; "New Unassigned Lead" entries persist for leads now assigned; no admin notification when visit scheduled/OTP verified | open |
| B17 | partner | HIGH | Close deal → Allocation letter upload | /partners/leads/<id>/close → upload a PDF (UI says "PDF signed by buyer and seller") | Uploaded; 400 with a clear message if invalid | PATCH /api/leads/partner/:id/document → 500, UI shows bare "Internal Server Error". Likely cause (not yet confirmed with a PNG): `leads.routes.js` l.23 uses `visitPhotoUploader` = `buildUploader('visits', IMAGE_FORMATS)` (jpg/png/webp only) for allocationLetter/tokenReceipt/closureDocs, so a .pdf is rejected by fileFilter; that `Error` has no status so it surfaces as 500. Fix: use an uploader with DOC_FORMATS (pdf) for those fields, and map multer/fileFilter errors to 400 | open |
| B18 | partner | medium | Deals flow | Dashboard action queue vs /close page | Consistent prerequisites | Dashboard offers "Upload escrow docs" on OTP-verified leads; /close page needs buyer escrow HELD first and has no way for partner to send the escrow link ("Not sent yet", no button) | open (clarify design) |
| B19 | partner | low | OTP success page | Reload /otp page after verify | Timestamp stable | "OTP verified at …" shows 10:25 then 10:26 on revisit (looks like current time, not stored) | open (verify) |
| B20 | all (blocker) | BLOCKER | Payment gateway (Razorpay) | From backend dir: `new Razorpay({key_id,key_secret}).orders.all({count:1})` with the keys in `.env` | 200 | **401 "Authentication failed" (BAD_REQUEST_ERROR)**. Key is `rzp_test_…` (test mode) so credentials are revoked/mismatched, not live. Every create-order (buyer escrow token), RazorpayX payout, and reconcile job will fail. Escrow flow (buyer pays → HELD → allocation letter → admin release) cannot be exercised until valid test keys (+ RAZORPAY_WEBHOOK_SECRET, RAZORPAYX_ACCOUNT_NUMBER) are put in `.env` and backend restarted. Needs the owner to generate keys in the Razorpay dashboard; a code agent can't fix this | RESOLVED 19 Oct: user supplied a new test pair (ID rzp_test_TpeG…); verified orders.all=200 and a ₹1 order created (order_TpeGoYe7Sz76ro); written to backend `.env` (old file backed up in session scratchpad); backend restarted via nodemon. Same pair also written to backend `.env.local`, and `NEXT_PUBLIC_RAZORPAY_KEY_ID` added to admin-nextjs `.env.local` (it was missing, so buyer checkout would have shown the key-missing message; `.env.example` leaves it blank). NOTE: webhooks still not configured (localhost needs a tunnel → POST /api/webhooks/razorpay; also set RAZORPAY_WEBHOOK_SECRET). `.env.local`/`.env.example` hold placeholder `rzp_live_xxxx` keys and server.js loads only `.env` |
| B21 | user+partner | HIGH | Partner-added leads vs buyer app | Partner adds lead for an existing buyer (Krishna), schedules visit, verifies OTP | Buyer sees the inquiry, gets in-app notifications, and can pay the escrow token | `partnerAddLead` deliberately leaves `buyerId` null → RD-L-000085 never appears in /user/inquiries; Krishna has NO in-app notification for the visit scheduled / OTP sent (only a 3-day-old one). So a partner-added deal can't reach escrow through the buyer app at all; the close page then dead-ends at "Escrow link not sent" with no way to send it | open (decide product flow: claim-by-phone/OTP, or partner "send escrow link") |
| B22 | admin | medium | Escrow table | /admin/escrow | Buyer, property, partner filled in | Every row shows Buyer "N/A", Property "Unknown Property", Partner "Agent"; yet the Release modal for the same row correctly says "RD-L-000084 · Developer One". ROOT CAUSE (verified in code, corrects earlier "backend lacks include" note): backend `escrow.service.js getAllEscrow` (l.802-826) DOES return `lead.buyerName`, `lead.property.{title,locality,city}`, `lead.assignedPartner.{name,companyName}`, but `admin-nextjs/src/app/admin/(dashboard)/escrow/page.tsx` reads `t.buyer?.name`, `t.property?.title`, `t.partner?.name` (l.137, 165, 263-268, 307, 318) which don't exist. Frontend-only fix: read from `t.lead.*` (also in the search filter l.137 and CSV export l.165) | open (frontend) |
| B23 | partner | low | Close deal page after closing | Mark as closed | Banner updates / hides | Success toast appears but amber "Escrow and allocation letter are required" banner and the escrow path remain; no redirect | open |
| B24 | user | low | /user root | Open http://localhost:3000/user | Redirect to /user/dashboard | 404 "This door doesn't lead anywhere" | open |
| B25 | user | low | Escrow payment | /user/visits/<id>/escrow-payment | Default to minimum or empty token | Pre-fills ₹2,50,000 (the max chip), not the ₹50,000 minimum | open |
| B26 | admin | medium | Escrow release gate | Release ₹50,000 for RD-L-000084 after partner closes | Admin can release once docs on file | Blocked: "Commission terms are locked on the lead" (needs "Prefill & lock commission"); buyer confirmation + partner payout account also missing (advisory). Not a bug per se, but nothing tells the partner/admin earlier in the flow; also PARTNER default_partner_share_pct is "Not set" on Razorpay config page (commission lock fails without it) | open (verify) |
| B27 | admin | HIGH (blocks release) | Escrow Release → "Prefill & lock commission" | /admin/escrow → Release on the ₹50,000 escrow (RD-L-000084) → Prefill & lock commission | Commission terms prefilled and locked (or a clear, actionable error) | Toast "Something went wrong on our side". Reproduced offline: `commission.service.js` `previewTermsForLead` (l.230-236) throws Prisma "Inconsistent query result: Field partner is required to return data, got null". Cause: property "Maruthi Nilya" (6ac8fd9824511fa2becd53bb) has `partnerId` 6ac54a1c19eab3d81bc4735a that no longer exists in User (orphaned reference), and `price` is null. Fix: (1) data: repoint/clean that property's partnerId; (2) code: don't select the required `partner` relation inline in previewTermsForLead (load the partner with a null-safe findUnique, as `lead.property?.partner?.` already assumes), and return a 400 with a real message instead of a generic 500; (3) the Release modal should surface the ApiError message. Also the lead has no deal price, so fee can't be computed from the property | open |
| B27b | admin | medium | Follow-up to B27 | After repair | — | 19 Oct: with user's OK, set property 6ac8fd9824511fa2becd53bb `partnerId` from orphaned 6ac54a1c19eab3d81bc4735a to "Mock QA Owner — Verified" (6ac248758cba2a7822eeae70) in the DB. Preview now resolves (feePct 2, sellerType OWNER) and the UI shows a proper message: "No partner share % is configured … Add a rate card or set default_partner_share_pct". Commission lock still blocked until `default_partner_share_pct` (platform config) or a rate card exists. To revert the data repair, set partnerId back to the old value. | open (needs business value) |
| B28 | admin | medium | Release modal / config | Release ₹50,000 for RD-L-000084 | Seller bank details prefilled from the seller; one partner-share setting | After setting `default_partner_share_pct`=2 (new PlatformConfig key, 19 Oct, via /admin/platform/config) commission locked v1 and the modal says "Ready to release". But: "Seller bank account holder" is prefilled with "Developer One" (the partner, not the seller) — code: escrow/page.tsx l.318 `sellerName={t.partner?.name || t.lead?.assignedPartner?.name}` → ReleaseEscrowModal l.100 seeds `seller.name`; the seller is the listing owner (`lead.property.partner`), not the assigned agent, so this risks a payout to the wrong holder name; the "Suggested partner share ₹1,000 (2% of held)" comes from `escrow_partner_share_pct` (% of held) while `default_partner_share_pct` is % of the fee — two similarly-named settings with different bases; `razorpay_webhook_secret` is stored in PlatformConfig as plain text (`whsec_seed_placeholder`) although the dialog warns never to store secrets. Release NOT confirmed: needs real seller bank details for an irreversible RazorpayX payout (QA stopped here). Escrow 6ad5aa5564ac1ac2a8b65096 stays HELD. | open |
| B29 | user+admin | medium | Release conditions (advisory) | Release modal for RD-L-000084 | Buyer can confirm the deal in the app; partner payout account can be completed in-app | (1) "Buyer confirmed the deal" = `lead.buyerFeedbackStatus === 'VERIFIED_CLOSED'`, which is ONLY set by the WATI WhatsApp reply webhook (`wati.handler.js` l.34-36: "1"/"yes"/"interested"); there is no in-app buyer confirmation, and on localhost the webhook can't be reached without a tunnel. (2) "Partner payout account is active" needs the partner to POST `/partners/payout-account` (real bank details → RazorpayX contact/fund account) and then admin `PATCH /admin/partners/:id/payout-account/status` → ACTIVE (`escrow.service.js` l.403). Both are advisory, not blocking: modal already says "Ready to release". Without an ACTIVE payout account the partner share can't be paid (`PARTNER_PAYOUT_ACCOUNT_NOT_ACTIVE`, l.532) | open (design) |
| B30 | partner | low | /partners/bank-account | Open the page as a partner with no bank details | Clear empty state / examples | Placeholders for account number and IFSC are real-looking values (`50100123456280`, `HDFC0001234`) that read as filled-in data in the grey text; success banner says "We verify the account with the bank before the first payout" while status is already shown VERIFIED/ACTIVE right after save (test-mode validation is skipped in `lib/razorpay.js` validateFundAccountOrWarn) | open |
| B31 | admin | CRITICAL | Escrow Release (RazorpayX payout) | /admin/escrow → Release ₹50,000 (RD-L-000084) → seller details (dummy) → Confirm release | Payout created, escrow → RELEASED | Error "RazorpayX error: The idempotency key may not be greater than 36 characters." Cause: `src/lib/razorpay.js` l.87 `idempotencyKey = sha256(...).digest('hex')` = 64 chars, but RazorpayX's `X-Payout-Idempotency` max is 36, so EVERY payout (seller and partner, release and retry) is rejected. Fix: `.digest('hex').slice(0, 36)` (or a 32-char hash / UUID) — keeps determinism for retries. State after failure is clean: escrow still HELD, no payout id, no status change. Related: Razorpay test key does accept contacts and fund accounts (partner payout account linked fine), so the rest of the path is reachable once this is fixed | open — blocks all releases |
| B32 | admin | low | Escrow release record | Release with "Also pay partner share" OFF | partnerPayoutStatus stays null | After release DB shows `razorpayPayoutId` pout_TpepFxXrz7NYMk, `sellerPayoutStatus: processing` AND `partnerPayoutStatus: processing` although no partner payout was requested ("partner share is only recorded") | open (verify) |
| B33 | partner | medium | Partner metrics after release | Admin releases ₹50,000 (seller ₹48,500; partner share ₹1,000 recorded only) | Consistent, partner-specific figures | /partners/finance "Released this month ₹50,000 (1 deal)" = whole escrow amount, not the partner's earnings, while dashboard "Escrow released ₹0" for the same month; Commission column "—", status PENDING; dashboard still shows "Escrow in flight ₹0 · 4 deals pending" (B4) | open |
| B34 | partner+user | medium | Notifications on close/release | Partner marks closed; admin releases | Partner and buyer get "deal closed" / "escrow released" in-app notifications | Partner Recent activity has only "Commission locked"; Krishna's notifications have only "Token Advance Received" (no closed/released); Krishna's bell shows an unread dot while the list has nothing new. His inquiry card does update to "Deal closed — your token went through escrow to get here" (step 5/8) | open |
| B17b | partner | HIGH | Allocation letter | Upload qa .png vs .pdf to /close | PDF accepted | CONFIRMED: PNG accepted (leads.routes uses image-only uploader), PDF → 500. UI text still says "PDF signed by buyer and seller" | open |
| B9 | admin | info | Dashboard | Open /admin | "Escrow held ₹2,50,000 (1 txn)" matches partner "Escrow in flight" | Partner Developer One shows ₹0 in flight; admin top partners all 0; "Lead #E3FC60 dropped by Partner Unknown" | open (verify who owns escrow) |

### Backend fixes — batch 3 (cloud session, branched from develop-extended)
| Bug | Fix | Verified |
|---|---|---|
| B42 | `users.service.js`: HIGH/URGENT ticket and a user note notify all admins (`notifyAdmins`, new in `lib/notifications.js`) | unit test for `notifyAdmins`; not run against a DB |
| B63/B63b/B72 | all `createNotification` `linkUrl`s now use `/partners/...` (was `/partner/...`), `/partners/support/<id>`, `/user/subscriptions` (was `/dashboard/services`) | grep only |
| B34/B44 | partner closes deal → buyer notified, admin message shows ref code; escrow release → buyer + assigned partner notified | not run |
| B5 | assignment notification names the lead (ref code + buyer); drop-request messages use the ref code | not run |
| B62 | new loan application notifies admins and confirms to the buyer | not run |
| B57 | document approve/reject notifies the buyer | not run |
| B79/B68 | contact message, NRI lead, video-tour request, paid subscription notify admins; tour scheduled/completed notifies the buyer | not run |
| B60 | `lib/loanTransitions.js` enforces the loan pipeline in `updateLoanStatus` | unit tests |
| B39 | `lib/ticketStats.js`: rows with resolvedAt < createdAt are skipped in the average | unit tests |
| B10 | `partnerAddLead` only accepts the partner's APPROVED listings | not run |
| B77/B78 | video-tour list returns `assignedToName`; `assignedTo` must be an ADMIN-role user | not run |
| B90 | admin user list/detail return additive `inquiryCount` and `totalSpend` (captured escrow tokens + successful subscriptions); frontend must read them | not run |
| B33 | partner finance summary returns additive `partnerShareTotal` / `partnerShareThisMonth`; existing fields unchanged | not run |
| B16 | admin "needs review"/"unassigned lead" notifications are marked read on confirm/assign; admins notified when a visit is logged; escalation notification links to `/admin/escrow` | not run |
| B21/B34 (partial) | buyer gets in-app notifications when a visit is scheduled (no OTP in the text) and confirmed. Partner-added leads (no `buyerId`) are still not covered: owner decision | not run |

### Backend fixes — batch 3c
| Bug | Fix | Verified |
|---|---|---|
| B36 | partner-facing "you receive" now uses `escrow_platform_fee_pct` (the rate release() deducts) for every deal | not run |
| B67 | revenue P&L "Escrow commission" sums `platformFeePaise` of RELEASED escrows (same source as the dashboard); pre-column rows are not counted | not run |
| B15 | verify-otp refused earlier than `visit_otp_early_window_hours` (default 2) before the slot, without consuming an attempt; no upper bound | unit tests |
| B53 | KYC APPROVE refused when the partner has no uploaded documents | not run |
| B50 | property approval refused when the listing has no photos | not run |
| B28 (secret part) | secret-looking PlatformConfig keys are masked in the admin list and refused on write; seed no longer inserts `razorpay_webhook_secret` (code reads the env var) | unit tests |
| B73 (partial) | new partner support ticket notifies admins; ticket number retries on collision | not run |

### Backend fixes — batch 4 (on top of batch 3/3c)
| Bug | Fix | Verified |
|---|---|---|
| B32 | Root cause: the release request carries `partnerShare` even with "Also pay the partner share" unticked, and the partner's stored payout account then paid it automatically. `payPartner: true` (or `partnerDetails`) is now required to pay; otherwise the share is only recorded | schema unit test; release flow not run |
| B61 | `PATCH /admin/loan/:id/status` accepts `sanctionedAmountPaise` (the frontend Sanction dialog sends it with rate, tenure, EMI, letter URL) | unit test |
| B71 | dispute-update notification to the buyer links to `/user/disputes` | not run |
| B38 | partner lead escrow select exposes `netAmount` and `partnerShareAmount` (the Commission column falls back to it) | not run |
