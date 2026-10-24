# Frontend handoff — changes needed after backend PR #3 (QA batch 3)

Backend PR: RealtyDoor/Realtydoor-backend#3 (into `develop-extended`). File paths below come from `QA_BUGS.md`; they were not re-checked against the frontend repo.

## 1. Use the new backend fields / behaviour

| Bug | Where | Change |
|---|---|---|
| B90 | Admin user list + detail | Read the new `inquiryCount` and `totalSpend` (captured escrow tokens + successful subscriptions, in rupees). The Inquiries / Spend / LTV columns currently show 0 and "—". |
| B33 | Partner finance page | Show `partnerShareTotal` and `partnerShareThisMonth` as "Your earnings". `releasedTotal` / `releasedThisMonth` are still whole escrow amounts: label them as deal volume. |
| B77 | Admin NRI video tours table | Show `assignedToName` instead of the raw id in "Assigned to". |
| B78 | Admin "Manage video tour" dialog | Replace the free-text staff id with a picker of admin accounts. The backend now returns 400 for a non-admin id. |
| B36 | Partner close-deal page | No change needed; "You receive" now uses the same fee rate as release. Re-check the number against a released deal. |
| B15 | Partner OTP page | The backend now rejects verify-otp earlier than 2 hours before the booked slot (400, code `VISIT_NOT_STARTED`, nothing counted against the 3 attempts). Disable "Verify" until then and show the scheduled time. |
| B10 | Partner "Add a new lead" | The property picker must list only the partner's APPROVED listings (backend returns 404 otherwise). |
| B67 | Admin revenue P&L | No change; "Escrow commission" now equals the dashboard's platform fee. |

## 2. Surface the new error codes (show `error.message`, not a generic toast)

| Code | Endpoint | Meaning |
|---|---|---|
| `VISIT_NOT_STARTED` | partner verify-otp | too early for the visit |
| `KYC_NO_DOCUMENTS` | admin KYC approve | partner uploaded nothing |
| `LISTING_NO_PHOTOS` | admin property approve | listing has no photos |
| `INVALID_LOAN_TRANSITION` | admin loan status | e.g. DISBURSED → anything, or backward after SANCTIONED; same-status re-save is also refused |
| `CONFIG_SECRET_REFUSED` | admin platform config save | key looks like a secret; values of such keys are shown as `********` |

## 3. Need from the frontend team

Real route names, so the backend can add or fix notification links: admin contact messages, NRI leads, video tours (those notifications currently carry no link), and confirmation that these exist: `/partners/listings/<id>`, `/partners/projects`, `/partners/referrals`, `/admin/tickets/<id>`, `/admin/partner-support`, `/admin/escrow`, `/user/documents`, `/user/nri`, `/user/inquiries/<id>`, `/admin/leads/<id>`.

## 4. Frontend-only bugs (not fixable in the backend repo)

| Bug | Fix |
|---|---|
| B22 | Escrow table: read `t.lead.buyerName`, `t.lead.property.title`, `t.lead.assignedPartner.name` (page.tsx l.137, 165, 263-268, 307, 318). |
| B28 | Release modal: seller name prefilled with the assigned partner (`escrow/page.tsx` l.318 → `ReleaseEscrowModal.tsx` l.100). The seller is the listing owner (`lead.property.partner`). |
| B43 | Release modal "suggested partner share" ignores the locked commission; the plan response already has `entitlements`. Needs a product decision on which base to show (B28 note). |
| B69 | Buyer app has no way to raise a dispute. API exists: `POST/GET /api/user/disputes`. Add a "Report a problem" screen and link it from the escrow pages. |
| B2 / B3 | Lead Dispatch SLA banner lists 10+-day-old and already-assigned leads as "approaching breach"; assigned rows still show "Assign". |
| B4 / B47 | Partner dashboard: "deals pending" counts leads; "Listings live 1 · all approved" while the only listing is rejected. |
| B14 / B7 | Partner lead timeline wording ("dispatched by Admin" on a partner-added lead; "Visit scheduled" highlighted with no visit). |
| B19 | OTP success page: show the stored `otpVerifiedAt`, not the current time. |
| B23 | Close page: hide the "allocation letter required" banner / redirect after closing. |
| B13 / B24 / B25 | Confirm button styled destructive; `/user` root 404 (redirect to `/user/dashboard`); escrow amount pre-fills the maximum instead of the minimum. |
| B80 / B81 / B82 | CMS: "New article" saves a junk draft immediately; related-blogs shows only the junk post; author not shown. |
| B87 / B84 | Alerts: duplicate "PRICE DROPPED" cards, "View deal" goes to `/properties`; compare page lists unverified listings. |
| B94 / B100 | Ticket dispatch: pick a vendor from the directory and call `/dispatch` instead of free-text name + phone. |
| B40 / B41 | Done in the earlier frontend work; re-verify after merge. |
| B45–B49, B54–B56, B66, B74–B76, B86, B88, B95, B97 | Layout/copy items listed in `QA_BUGS.md`: clipped action column, ticket form shows a junk "current ticket", photo-rule copy disagrees, unfinished compliance copy, duplicated type in listing title, broken service image, contact form not prefilled, NRI form (price format, no success state), Next dev "session expired" flash, rating shows "Agent", vendor deactivate wording, staff pages. |
| B103 / B104 | Dev bucket for uploads; add-lead redirect (done locally, confirm it was committed). |

## 5. Owner decisions (not frontend, not backend yet)
B21 (partner-added leads reaching the buyer), B29 (in-app buyer deal confirmation), B65 (the "Subscribe — coming soon" lock), OTP wording.
