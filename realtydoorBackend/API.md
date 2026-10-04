# RealtyDoor Backend — API Reference

---

## Overview

**Base URL:** `http://localhost:5000/api` (dev) · `https://api.realtydoor.in/api` (prod)

### Authentication

All protected routes require a Clerk JWT in the `Authorization` header:

```
Authorization: Bearer <clerk_session_token>
```

Roles: `USER` · `PARTNER` · `ADMIN`. Role is always resolved from the database on every request, never from a claim embedded in the JWT itself — so a role change via `POST /auth/set-role` (or an admin action) takes effect on the very next request, with no stale-token window.

**`POST /auth/sync` is no longer required before any other call.** If a valid Clerk JWT has no matching DB row yet (a brand-new Google/Clerk identity that's never hit this backend before), `authenticate` creates it on demand using the exact same logic as `POST /auth/sync` (see below), then continues the original request — there's no 401-then-sync-then-retry needed on any path (proxy, server-side fetches, client fetches, Postman, a future mobile client). Calling `/auth/sync` explicitly right after login is still worthwhile — it's the one endpoint that returns the full profile shape in a single round trip — but nothing is load-bearing on it happening first anymore. One consequence: the collision/validation errors `/sync` can throw (`400 EMAIL_REQUIRED`, `403` suspended, `409 EXISTING_USER`, `409 PHONE_IN_USE`) can now surface from *any* authenticated endpoint for a not-yet-synced user, not just from `/auth/sync` — the error codes are identical either way, so a client that already handles them on `/sync` needs to handle the same codes globally.

### Response Envelope

```json
{
  "success": true,
  "message": "Success",
  "data": { ... }
}
```

Error response:

```json
{
  "success": false,
  "message": "Error description"
}
```

### Paginated Responses

Paginated endpoints return this shape inside `data`:

```json
{
  "data": [ ... ],
  "pagination": {
    "total": 100,
    "page": 1,
    "limit": 20,
    "totalPages": 5,
    "hasNext": true,
    "hasPrev": false
  }
}
```

Default: `page=1`, `limit=20`.

### HTTP Status Codes

| Code | Meaning |
|------|---------|
| 200 | OK |
| 201 | Created |
| 204 | No Content (DELETE) |
| 400 | Bad Request / Validation error |
| 401 | Unauthenticated |
| 403 | Forbidden (wrong role / KYC not verified) |
| 404 | Not found |
| 409 | Conflict (duplicate) |
| 429 | Rate limited / OTP locked |
| 500 | Server error |

---

## 1. Auth

### POST /api/auth/sync

Verifies Clerk JWT, upserts DB user record, returns profile. Called on every login — this is also the completion hook for a Google sign-in: a brand-new Clerk identity gets an "incomplete" DB row (`phoneVerified: false`) here, and the response's `onboardingComplete` flag tells the frontend whether to show the phone-verification step (`POST /api/auth/google/phone/otp`, using our own `PhoneOtp`/WATI flow — this endpoint does not read or trust Clerk's own phone verification status).

Recommended right after login for the full profile in one call, but **not required** first — `middleware/auth.js`'s `authenticate` runs this exact same upsert logic on demand for any authenticated route when the DB row doesn't exist yet (see the Authentication section above).

- **Email is required.** If the Clerk user has no email address at all, this returns `400 EMAIL_REQUIRED` — `User.email` is a required, unique field.
- **Phone**, if present on the Clerk profile, is synced as a plain field (not treated as verified) — guarded against colliding with a different existing account (`409 PHONE_IN_USE`).
- **`name` and `profileImageUrl` are only seeded from Clerk the first time this person's row is created.** On every later sync they are left untouched, so an edit made via `PATCH /user/profile` is never reverted back to the Google account's name/photo on the next page load.

**Auth:** Clerk JWT in `Authorization` header (token verified manually, no middleware)

**Request Body:** _(none)_

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "id": "64abc...",
    "clerkId": "user_2abc...",
    "name": "Rajdeep Kumar",
    "email": "rajdeep@example.com",
    "phone": "+919876543210",
    "phoneVerified": true,
    "emailVerified": true,
    "role": "USER",
    "isNRI": false,
    "profileImageUrl": "https://img.clerk.com/...",
    "partnerSubType": null,
    "companyName": null,
    "bio": null,
    "websiteUrl": null,
    "kycStatus": "NOT_SUBMITTED",
    "kycVerifiedAt": null,
    "kycRejectionNote": null,
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-15T10:30:00.000Z",
    "onboardingComplete": true
  }
}
```

`emailVerified` is stamped once, at row-creation time, from Clerk's email verification status as of that moment — it is not re-derived from Clerk on every sync.

**Errors:**
- `401` — the Clerk token itself is invalid or expired. This is the *only* case that returns 401; any other failure (DB error, Clerk API error) returns `500`, so a real outage never looks like an expired session to the frontend.
- `400 EMAIL_REQUIRED` — no email on the Clerk user.
- `403` — the account is suspended (checked here the same way `authenticate` checks it on every other request).
- `409 EXISTING_USER` — the Clerk email already belongs to a *different* Clerk identity (e.g. a phone-OTP account signing in with Google using the same email later) — the frontend should sign the user out and show "an account with this email already exists". If the newly-created duplicate Clerk identity has no DB row and was created moments ago, it's deleted automatically as part of this response; anything older is left alone to avoid deleting a real account.
- `409 PHONE_IN_USE` — Clerk's phone number for this user already belongs to a *different* account (e.g. they changed their phone in Clerk to a number someone else on RealtyDoor already has verified).

`onboardingComplete` is computed by the same shared helper `/auth/me`, `/auth/onboarding-status`, and every authenticated request use (`src/lib/onboarding.js`) — verified phone, or still inside the pre-migration grace window (`phoneVerifyDeadline`). All four call sites always agree.

---

### GET /api/auth/me

Returns the full profile for the authenticated user including active subscription and unread notification count.

**Auth:** Required (any role)

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "id": "64abc...",
    "clerkId": "user_2abc...",
    "name": "Rajdeep Kumar",
    "email": "rajdeep@example.com",
    "phone": "+919876543210",
    "phoneVerified": true,
    "phoneVerifiedAt": "2024-01-15T10:30:00.000Z",
    "role": "PARTNER",
    "isNRI": false,
    "profileImageUrl": "https://img.clerk.com/...",
    "address": null,
    "language": "en",
    "notificationPreferences": { "push": true, "email": true, "whatsapp": true, "marketing": false, "visitReminders": true },
    "buyerType": null,
    "city": null,
    "budget": null,
    "bhk": [],
    "timeline": null,
    "partnerSubType": "AGENT",
    "companyName": "RealtyPro Solutions",
    "bio": "10 years in Pune real estate.",
    "websiteUrl": "https://realtypro.in",
    "kycStatus": "VERIFIED",
    "kycVerifiedAt": "2024-02-01T00:00:00.000Z",
    "kycRejectionNote": null,
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-02-01T00:00:00.000Z",
    "unreadNotifications": 3,
    "activeSubscription": {
      "plan": "Maintenance Premium",
      "paymentStatus": "SUCCESS",
      "expiresAt": "2025-02-01T00:00:00.000Z"
    }
  }
}
```

`activeSubscription` is `null` if the user has no subscription. The response also includes `onboardingComplete` (computed the same way as everywhere else — see `GET /onboarding-status` below).

---

### GET /api/auth/onboarding-status

Cheap re-check of onboarding state without a full `/sync` round-trip — use after the Google phone-completion step, or on app resume.

**Auth:** Required (any role)

**Response `200`:**

```json
{ "success": true, "message": "Success", "data": { "onboardingComplete": false, "phoneVerified": false, "role": "USER" } }
```

`onboardingComplete` itself reflects phone status only — `true` once the phone is verified, or while still inside the pre-migration grace period (`phoneVerifyDeadline`); it does **not** factor in role. Non-`USER` accounts are instead exempted one layer up, at the route gate (`middleware/requireOnboarded.js` lets any non-`USER` role through regardless of this flag) — so a `PARTNER`/`ADMIN` can see `onboardingComplete: false` here without that blocking anything.

---

### POST /api/auth/signup/otp

New-account signup, step 1. Normalizes `phone` to E.164, rejects if the email or phone is already registered in the DB or the email already exists in Clerk, then sends a 6-digit code via WhatsApp.

`phone` accepts any valid international number, not just Indian ones (backed by `libphonenumber-js`) — for NRI signups. A bare national number with no `+`/country code (e.g. `"9000000099"`, `"09000000099"`) is assumed Indian; anything with a leading `+` (or `00` IDD prefix) is parsed as full international input against whatever country it declares (e.g. `"+1 415-555-2671"`, `"+44 20 7946 0958"`). `isNRI` is a self-declared display/admin flag only — it doesn't gate or change which phone formats are accepted. This same rule (`src/lib/phoneUtils.js`'s `phoneField`) applies to every phone-OTP endpoint in this section and to `POST /user/verify-phone`.

**Auth:** Public (per-IP rate limited; per-phone resend cooldown of 30s and cap of 3 sends/hour enforced separately)

**Request Body:**

```json
{ "name": "Suresh Mehta", "email": "suresh@example.com", "phone": "9000000099", "isNRI": false, "marketingOptIn": false, "role": "USER" }
```

`isNRI` and `marketingOptIn` are both optional (default `false`) — captured here rather than via a follow-up call so nothing is lost if the frontend doesn't make a second request. They're carried through the OTP row and applied when the account is actually created in `/signup/verify`.

`role` is optional (default `"USER"`); the only other accepted value is `"PARTNER"` — this is a direct partner signup, an alternative to signing up as `USER` and self-upgrading via `POST /auth/set-role`. `"ADMIN"` is rejected by the schema; that role is never self-assignable.

**Response `200`:**

```json
{ "success": true, "message": "OTP sent via WhatsApp", "data": { "expiresAt": "2026-09-24T10:10:00.000Z" } }
```

**Errors:** `409 ALREADY_REGISTERED` (an *active* account already has this email or phone — a soft-deleted account's old email/phone doesn't block a fresh signup) · `429 OTP_SEND_LIMIT` / `OTP_RESEND_COOLDOWN`.

---

### POST /api/auth/signup/verify

New-account signup, step 2. On success, creates the Clerk user (generated username, random strong password, `publicMetadata: { role, phone }` — `role` is whatever was passed to `/signup/otp`, `"USER"` if omitted) and the DB row — `phoneVerified: true`, `phoneVerifiedAt`, `emailVerified` (from Clerk's status at creation time), `isNRI` and `marketingOptIn`/`marketingOptInAt` (from `/signup/otp`), and `termsAcceptedAt`/`privacyAcceptedAt` stamped to now (submitting the signup form is the agreement action per the signup screen's copy) — in one transaction-like step. If the DB write fails, the just-created Clerk user is deleted so nothing is left orphaned. Returns a 60-second Clerk sign-in token for the frontend to complete sign-in with.

**Auth:** Public

**Request Body:**

```json
{ "phone": "9000000099", "code": "482913" }
```

**Response `201`:**

```json
{
  "success": true,
  "message": "Account created",
  "data": {
    "signInToken": "sit_...",
    "user": { "id": "64abc...", "name": "Suresh Mehta", "email": "suresh@example.com", "phone": "+919000000099", "phoneVerified": true, "emailVerified": false, "role": "USER" }
  }
}
```

**Errors:** `400 OTP_INVALID` (wrong, expired, or already-used code — deliberately generic) · `429 OTP_LOCKED` (5 wrong attempts → 10-minute lock).

---

### POST /api/auth/login/otp

Existing-account login, step 1.

**Auth:** Public

**Request Body:**

```json
{ "phone": "9000000003" }
```

**Response `200`:**

```json
{ "success": true, "message": "OTP sent via WhatsApp", "data": { "expiresAt": "2026-09-24T10:10:00.000Z" } }
```

**Errors:** `404 ACCOUNT_NOT_FOUND` — no *active* user has this phone (a soft-deleted account's old number reports this too, same as if it never existed, rather than sending a code that can never be used) — the frontend should redirect to signup.

---

### POST /api/auth/login/verify

Existing-account login, step 2. Checks the account isn't suspended and isn't `ADMIN` before issuing a sign-in token — `USER` and `PARTNER` both sign in through this phone flow; only an `ADMIN` account gets `403 WRONG_PORTAL` instead of a token (admins have no phone-login path).

**Auth:** Public

**Request Body:**

```json
{ "phone": "9000000003", "code": "482913" }
```

**Response `200`:**

```json
{
  "success": true,
  "message": "Login successful",
  "data": { "signInToken": "sit_...", "user": { "id": "64abc...", "name": "Suresh Mehta", "phone": "+919000000003", "phoneVerified": true, "role": "USER" } }
}
```

**Errors:** `400 OTP_INVALID` · `403` suspended account · `403 WRONG_PORTAL` (`data.role` tells the frontend which portal to redirect to).

---

### POST /api/auth/google/phone/otp

Phone-completion step after a Google sign-in whose onboarding is incomplete (see `/sync` and `/onboarding-status` above).

**Auth:** Required (any authenticated user). Rate limited per-IP (`otpSendLimiter`) **and** per-user, 5 requests/hour (`perUserPhoneOtpLimiter`, keyed by `req.user.id`) — since this endpoint is behind login, per-IP alone wouldn't stop one signed-in account from working through many different target phone numbers.

**Request Body:**

```json
{ "phone": "9000000099" }
```

**Response `200`:**

```json
{ "success": true, "message": "OTP sent via WhatsApp", "data": { "expiresAt": "2026-09-24T10:10:00.000Z" } }
```

**Errors:** `400 PHONE_ALREADY_VERIFIED` · `409 PHONE_IN_USE` · `429` (per-IP or per-user cap).

---

### POST /api/auth/google/phone/verify

**Auth:** Required (any authenticated user). Rate limited per-IP (`otpVerifyLimiter`) and per-user, 5 requests/hour (`perUserPhoneOtpLimiter`).

**Request Body:**

```json
{ "phone": "9000000099", "code": "482913" }
```

On success, writes `phone` to the DB **and** to Clerk `publicMetadata.phone` together, and marks `phoneVerified: true` — onboarding is now complete.

**Response `200`:**

```json
{ "success": true, "message": "Phone verified", "data": { "id": "64abc...", "phone": "+919000000099", "phoneVerified": true, "onboardingComplete": true } }
```

**Errors:** `400 OTP_INVALID` · `409 PHONE_IN_USE` (claimed by another account in the meantime) · `429` (per-IP or per-user cap).

---

### POST /api/auth/set-role

Self-service role upgrade: `USER` → `PARTNER` only. Idempotent if already PARTNER.

**Auth:** Required (USER)

**Request Body:**

```json
{ "role": "PARTNER" }
```

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": { "role": "PARTNER" }
}
```

**Errors:** `400` if role is not `"PARTNER"` · `500` if the Clerk metadata update fails (the DB role is only changed after Clerk confirms — this prevents Clerk and the DB from ever disagreeing on role, which previously let `/auth/sync` silently downgrade a partner back to `USER`).

---

## 2. Properties

### GET /api/properties

Search published, non-B2B properties.

**Auth:** Public

**Query Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `q` | string | Full-text search (title, description, locality) |
| `city` | string | Case-insensitive exact match |
| `locality` | string | Case-insensitive contains |
| `propertyType` | string | `FLAT` · `INDEPENDENT_HOUSE` · `VILLA` · `PLOT` · `COMMERCIAL_OFFICE` · `RETAIL_SHOP` |
| `listingType` | string | `SALE` · `RENT` · `LEASE` |
| `propertyStatus` | string | `PRE_LAUNCH` · `READY_TO_MOVE` · `UNDER_CONSTRUCTION` · `SOLD` · `RENTED` |
| `bhk` | number | Number of bedrooms |
| `minPrice` | number | Min price (₹) — filters `monthlyRent` instead of `price` when `listingType` is `RENT` or `LEASE` |
| `maxPrice` | number | Max price (₹) — same `monthlyRent`/`price` switch as `minPrice` |
| `minArea` | number | Min carpet area (sq ft) |
| `maxArea` | number | Max carpet area (sq ft) |
| `furnishing` | string | Free text e.g. `Furnished` |
| `isVerified` | boolean | Filter verified listings |
| `amenities` | string | Comma-separated e.g. `Gym,Pool` |
| `sort` | string | `price_asc` · `price_desc` · `newest` · `area_asc` (default: `newest`) |
| `page` | number | Default: `1` |
| `limit` | number | Default: `20` |

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "data": [
      {
        "id": "64abc...",
        "title": "3 BHK Flat in Baner",
        "slug": "3-bhk-flat-in-baner-1700000000000",
        "price": 8500000,
        "monthlyRent": null,
        "propertyType": "FLAT",
        "listingType": "SALE",
        "propertyStatus": "READY_TO_MOVE",
        "bhk": 3,
        "balconies": 2,
        "carpetArea": 1200,
        "locality": "Baner",
        "city": "Pune",
        "images": ["https://cdn.realtydoor.in/prop1.jpg"],
        "coverImageIndex": 0,
        "isVerified": true,
        "isFeatured": false,
        "reraNumber": "P52100012345",
        "createdAt": "2024-01-10T00:00:00.000Z",
        "facing": "East",
        "furnishing": "Semi-Furnished",
        "previousPrice": 9000000,
        "priceChange6m": -5,
        "unitsLeft": 3,
        "viewsThisWeek": 12,
        "builtUpArea": 1400,
        "ageOfProperty": 2,
        "floorNumber": 4,
        "totalFloors": 10,
        "latitude": 18.5581,
        "longitude": 73.8099
      }
    ],
    "pagination": {
      "total": 45,
      "page": 1,
      "limit": 20,
      "totalPages": 3,
      "hasNext": true,
      "hasPrev": false
    }
  }
}
```

`previousPrice`, `priceChange6m`, `unitsLeft`, `balconies` are all `null` until an admin sets them on the listing. `viewsThisWeek` increments on every `GET /api/properties/:slug` and resets to `0` every Monday at midnight. `builtUpArea`, `ageOfProperty`, `floorNumber`, `totalFloors` are included specifically for the property detail page's peer-comparison logic (it fetches this same endpoint for similar listings and computes "better/below average" tags from them). `latitude`/`longitude` are `null` until set on the listing (via `POST`/`PATCH /api/properties`) — included here (not just on the detail page) so the listing page can render a map with a pin per result without an extra round trip per property.

---

### GET /api/properties/featured

Returns up to 12 featured approved listings.

**Auth:** Public

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": [
    {
      "id": "64abc...",
      "title": "Luxury Villa in Koregaon Park",
      "slug": "luxury-villa-koregaon-park-1700000000000",
      "price": 25000000,
      "monthlyRent": null,
      "propertyType": "VILLA",
      "listingType": "SALE",
      "bhk": 4,
      "locality": "Koregaon Park",
      "city": "Pune",
      "images": ["https://cdn.realtydoor.in/villa1.jpg"],
      "coverImageIndex": 0,
      "isVerified": true,
      "facing": "North",
      "furnishing": "Fully Furnished",
      "balconies": 3,
      "previousPrice": null,
      "priceChange6m": null,
      "unitsLeft": null,
      "viewsThisWeek": 4,
      "latitude": 18.5362,
      "longitude": 73.8938
    }
  ]
}
```

Note: this list is cached for 10 minutes (`FEATURED_PROPERTIES` key) — a cache entry written before the new fields were added won't show them until it naturally expires or an admin edit invalidates it.

---

### GET /api/properties/:slug

Full property detail for a single approved listing. `isB2BOnly` listings 404 here the same as a search — a direct slug link can no longer be used to bypass the public/B2B separation.

**Auth:** Public

**Response `200`:**

The top-level response keeps every existing flat field exactly as before (`price`, `bhk`, `locality`, `partner.companyName`, etc. — unchanged, so nothing already reading this shape needs to change). `partner` now also includes `id`, `name`, `kycStatus`, and `profileImageUrl` (previously only `companyName`/`partnerSubType`).

Three keys are new, additive, and built from the same underlying data — nested for a newer consumer that wants a structured shape instead of the flat one:

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "...(all existing flat fields, unchanged)...": "...",
    "partner": { "id": "64partner...", "name": "Sunetra", "companyName": "RealtyPro Solutions", "partnerSubType": "AGENT", "kycStatus": "VERIFIED", "profileImageUrl": null },

    "property": {
      "id": "64abc...", "title": "3 BHK Flat in Baner", "propertyType": "FLAT", "listingType": "SALE", "status": "APPROVED",
      "location": { "address": "Plot 12, Baner Road", "locality": "Baner", "city": "Pune", "state": "Maharashtra", "country": "India", "pincode": "411045" },
      "pricing": { "minPrice": 8500000, "maxPrice": 8500000, "monthlyRent": null, "priceNegotiable": true, "currency": "INR", "pricePerSqft": 7083 },
      "configuration": { "bhk": 3, "bathrooms": 2, "balconies": null, "facing": "East", "furnishing": "Semi-Furnished" },
      "area": { "carpetArea": 1200, "builtUpArea": 1400, "plotArea": null, "carpetEfficiency": 86, "unit": "sqft" },
      "floorDetails": { "floorNumber": 4, "totalFloors": 10 },
      "propertyAge": { "value": 2, "unit": "years" },
      "parking": null,
      "description": "Spacious 3 BHK with great amenities...",
      "media": {
        "coverImage": "https://cdn.realtydoor.in/prop1.jpg", "images": ["https://cdn.realtydoor.in/prop1.jpg"], "totalImages": 1,
        "videoTour": { "available": false, "url": null }, "virtualTour": { "available": false, "url": null }, "floorPlanUrl": null
      },
      "verification": { "realtyDoorVerified": true, "reraVerified": true, "reraNumber": "P52100012345", "legalVerified": null, "loanApproved": true, "bankApprovals": ["SBI", "HDFC"] },
      "badges": ["FEATURED", "REALTYDOOR_VERIFIED", "BANK_APPROVED"],
      "amenities": ["Gym", "Swimming Pool", "24x7 Security"],
      "societyFeatures": ["Club House", "Children's Play Area"],
      "propertyMetrics": { "carpetEfficiency": 86, "unitsRemaining": null, "weeklyViews": 12, "priceIncreaseLast6Months": null },
      "agent": { "id": "64partner...", "name": "Sunetra", "companyName": "RealtyPro Solutions", "designation": "AGENT", "verified": true, "profileImage": null },
      "projectDetails": { "developer": "Purvankara Limited", "projectStatus": "PRE_LAUNCH", "rating": 4.5, "ratingCount": 2, "landArea": { "value": 3.2, "unit": "acres" }, "openSpace": 80, "totalUnits": 260 },
      "timestamps": { "createdAt": "2024-01-10T00:00:00.000Z", "updatedAt": "2024-01-15T00:00:00.000Z" }
    },

    "propertyDetailsComparison": {
      "title": "Similar Properties",
      "properties": [{
        "id": "64peer...", "name": "Aashrithaa Serene", "slug": "aashrithaa-serene-...",
        "location": { "locality": "Hoskote", "city": "Bengaluru" }, "image": "https://cdn.realtydoor.in/peer1.jpg",
        "basicInformation": { "developer": "Aashrithaa Developers", "projectStatus": "UNDER_CONSTRUCTION", "rating": 4.2, "ratingCount": 14, "propertyType": "PLOT", "landArea": { "value": 5, "unit": "acres" }, "openSpace": 70, "totalUnits": 400 }
      }]
    },

    "localityInsights": {
      "locality": "Baner", "lastUpdated": "2026-05-01T00:00:00.000Z",
      "market": { "averagePrice": 5490, "currency": "INR", "priceUnit": "sqft", "oneYearAppreciation": 8.4, "rentYield": 3.2, "estimatedMonthlyRent": 35000 },
      "nearbyPlaces": [{ "name": "D-Mart" }, { "name": "Orchid School" }]
    }
  }
}
```

Notes on the nested `property` section:
- `pricing.minPrice`/`maxPrice` are always equal — this schema stores one price per listing, not a range (a true range would need a multi-unit "project" concept this codebase doesn't model).
- `parking` and `verification.legalVerified` are always `null` — not modeled anywhere; never fabricated.
- `propertyMetrics.unitsRemaining`/`priceIncreaseLast6Months` (mirroring `unitsLeft`/`priceChange6m`) are always `null` today — nothing in the codebase writes to those fields yet.
- `agent` has no `experienceYears`, `designation` (beyond `partnerSubType`), `rating`, or `statistics` — not modeled on the partner profile. Real partner ratings exist (`Lead.buyerRating`) but are only surfaced via the partner's own `GET /partner/ratings`, not joined into this public response.
- `verification.reraVerified` reflects only whether a RERA number is on file, not a separately-audited verified status — there's no distinct field for that.
- **`projectDetails`** (on `property`) and **`propertyDetailsComparison.properties[].basicInformation`** (on each peer) carry the same fields: `developer`, `projectStatus` (mirrors `propertyStatus`, now including `PRE_LAUNCH`), `rating`/`ratingCount`, `landArea` (`{value, unit}`), `openSpace` (%), `totalUnits`. `developer`/`landArea`/`openSpace`/`totalUnits` are partner-settable at creation (see `POST /api/properties`) and are `null` for a regular listing that was never given them. `rating`/`ratingCount` are **never** partner-settable — computed live from real, moderated `PropertyReview` rows (unapproved reviews are excluded); `null`/`0` when there are no approved reviews yet.
- `localityInsights` is `null` when no admin-curated `LocalityInsight` row exists yet for that city/locality (same graceful fallback as the existing locality panel) — it's the same model/data as `GET /locality-insights/insight`, just remapped field names, not a second data source.

**Errors:** `404` if not found, not approved, or `isB2BOnly`.

---

### POST /api/properties

Create a new property listing (submitted for admin review).

**Auth:** PARTNER + KYC verified

**Request Body:**

```json
{
  "title": "3 BHK Flat in Baner",
  "description": "Spacious apartment with modern amenities in prime location.",
  "propertyType": "FLAT",
  "listingType": "SALE",
  "propertyStatus": "READY_TO_MOVE",
  "price": 8500000,
  "priceNegotiable": true,
  "bhk": 3,
  "bathrooms": 2,
  "carpetArea": 1200,
  "builtUpArea": 1400,
  "floorNumber": 4,
  "totalFloors": 10,
  "ageOfProperty": 2,
  "furnishing": "Semi-Furnished",
  "facing": "East",
  "address": "Plot 12, Baner Road",
  "locality": "Baner",
  "city": "Pune",
  "state": "Maharashtra",
  "pincode": "411045",
  "latitude": 18.5596,
  "longitude": 73.7769,
  "nearbyLandmarks": ["D-Mart", "Orchid School"],
  "amenities": ["Gym", "Swimming Pool"],
  "societyFeatures": ["Club House"],
  "reraNumber": "P52100012345",
  "developer": "Purvankara Limited",
  "landAreaValue": 3.2,
  "landAreaUnit": "acres",
  "openSpacePct": 80,
  "totalUnits": 260
}
```

Fields `publishStatus`, `isVerified`, `partnerId` are silently stripped.

`furnishing` and `facing` are optional — if omitted, they default to `"Unfurnished"` and `"East"` respectively.

`propertyStatus` now also accepts `PRE_LAUNCH`, in addition to `READY_TO_MOVE`/`UNDER_CONSTRUCTION`.

`developer`, `landAreaValue`/`landAreaUnit`, `openSpacePct`, `totalUnits` are project-level fields — meaningful for a developer-led project/township listing (typically paired with `isFeaturedProject`), left unset for a regular single-unit listing. There's deliberately no `rating` field here: a partner can't self-report their own project's rating — it's computed live from real `PropertyReview` rows instead (see `GET /api/properties/:slug`'s `property.projectDetails.rating`).

**Response `201`:**

```json
{
  "success": true,
  "message": "Listing submitted for review",
  "data": {
    "id": "64abc...",
    "slug": "3-bhk-flat-in-baner-1700000000000",
    "publishStatus": "PENDING_APPROVAL",
    "partnerId": "64partner...",
    "createdAt": "2024-01-10T00:00:00.000Z"
  }
}
```

---

### PATCH /api/properties/:id

Update own listing. Fields `publishStatus`, `isVerified`, `partnerId` are stripped.

**Auth:** PARTNER + KYC verified

**Request Body:** Partial property fields (same as POST).

**⚠️ Behaviour depends on whether the listing is live (docs 4.8).**

**If `publishStatus` is not `APPROVED`** (draft, pending, rejected, archived) the
edit applies immediately — there is nothing published to protect:

```json
{
  "success": true,
  "message": "Listing updated",
  "data": { "property": { "...": "the updated listing" }, "changeRequest": null }
}
```

**If `publishStatus` is `APPROVED`** the listing is **not** modified. The diff is
held as a `PropertyChangeRequest` for admin review and the live listing keeps
serving its approved content:

```json
{
  "success": true,
  "message": "Changes submitted for admin review. Your listing stays live until they are reviewed.",
  "data": {
    "property": { "...": "UNCHANGED — still the approved version" },
    "changeRequest": {
      "id": "6a44b1...",
      "status": "PENDING",
      "fieldCount": 3,
      "changes": { "price": { "before": "1400000", "after": "1900000" } },
      "createdAt": "2026-10-04T10:27:25.000Z"
    }
  }
}
```

`data.property` is the **current live listing, not what you just sent.** Do not
read it back as confirmation that the edit applied — read `changeRequest`
instead, and poll `GET /api/partner/listings/change-requests` for the outcome.

If nothing in the payload actually differs from the stored listing, no request
is created and the message is `No changes to review` with `changeRequest: null`.

Submitting a second edit while one is still `PENDING` marks the earlier request
`SUPERSEDED`, so the admin queue only ever holds the latest diff per listing.

**Why it works this way:** previously the edit was written straight to the
property and `publishStatus` was flipped back to `PENDING_APPROVAL`. That took
the listing dark — the good approved version vanished from search along with
the unreviewed one — and because `PropertyEditLog` was only written for admin
edits, the admin re-reviewing the listing had no record of what the partner had
changed.

**Errors:** `403` not your listing · `404` not found.

---

### POST /api/properties/:id/images

Upload images to a listing.

**Auth:** PARTNER (KYC not required)

**Request:** `multipart/form-data`, field name `images`, up to 10 files.

**Response `200`:**

```json
{ "success": true, "message": "Images uploaded", "data": { "images": ["url1", "url2"] } }
```

**Errors:** `400` no images provided · `403` not your listing.

---

### POST /api/properties/:id/videos

Upload videos to a listing.

**Auth:** PARTNER (KYC not required)

**Request:** `multipart/form-data`, field name `videos`, up to 5 files.

**Response `200`:**

```json
{ "success": true, "message": "Videos uploaded", "data": { "videos": ["url1", "url2"] } }
```

**Errors:** `400` no videos provided · `403` not your listing.

---

### POST /api/properties/:id/documents

Upload listing documents (brochure, RERA certificate, sale agreement, etc.) — appended to the listing's `documents` array.

**Auth:** PARTNER (KYC not required)

**Request:** `multipart/form-data`, field name `documents`, up to 10 files (`jpg`/`png`/`pdf`, max 10MB each).

**Response `200`:**

```json
{
  "success": true,
  "message": "Documents uploaded",
  "data": {
    "documents": [
      { "name": "brochure.pdf", "url": "https://...s3.../properties/documents/abc123.pdf", "uploadedAt": "2026-09-20T10:00:00.000Z" }
    ]
  }
}
```

**Errors:** `400` no documents provided · `403` not your listing.

---

### GET /api/properties/:id/edit-logs

Admin and partner edit history for a listing.

**Auth:** PARTNER + KYC verified (must own the listing)

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": [
    {
      "id": "64log...",
      "propertyId": "64prop...",
      "field": "price",
      "oldValue": "8500000",
      "newValue": "9000000",
      "changedBy": "Rajdeep Kumar",
      "changedAt": "2024-02-01T10:00:00.000Z"
    }
  ]
}
```

**Errors:** `404` listing not found or not yours.

---

### GET /api/properties/:id/construction-updates

Construction milestone timeline for an under-construction property.

**Auth:** Public (property must be APPROVED)

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": [
    {
      "id": "64cu...",
      "propertyId": "64prop...",
      "milestoneTitle": "Foundation complete",
      "description": "Foundation and basement work finished.",
      "mediaUrls": ["https://cdn.realtydoor.in/progress1.jpg"],
      "completionPct": 25,
      "postedAt": "2024-03-01T00:00:00.000Z"
    }
  ]
}
```

Ordered by `postedAt` descending. Returns `[]` if no updates yet.

**Errors:** `404` property not found or not APPROVED.

---

### POST /api/properties/:id/construction-updates

Add a construction milestone update to an under-construction listing.

**Auth:** PARTNER + KYC verified (must own the listing, `propertyStatus` must be `UNDER_CONSTRUCTION`)

**Request Body:**

```json
{
  "milestoneTitle": "Foundation complete",
  "description": "Foundation and basement work finished ahead of schedule.",
  "mediaUrls": ["https://cdn.realtydoor.in/progress1.jpg"],
  "completionPct": 25
}
```

`milestoneTitle` required (3–200 chars). `description` max 2000. `mediaUrls` max 10 URLs. `completionPct` 0–100 integer.

**Response `201`:**

```json
{
  "success": true,
  "data": {
    "id": "64cu...",
    "propertyId": "64prop...",
    "milestoneTitle": "Foundation complete",
    "completionPct": 25,
    "postedAt": "2024-03-01T00:00:00.000Z"
  }
}
```

**Errors:** `404` property not found or not yours · `400` property is not UNDER_CONSTRUCTION.

---

### GET /api/properties/:id/reviews

Approved public reviews for a property.

**Auth:** None

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": [
    {
      "id": "64rev...",
      "rating": 4,
      "title": "Great locality, minor maintenance issues",
      "body": "The flat is well-designed but the society maintenance could be better.",
      "createdAt": "2024-02-15T00:00:00.000Z",
      "user": { "name": "Suresh Mehta", "profileImageUrl": null }
    }
  ]
}
```

Only returns `isApproved: true` reviews. `:id` is the property's MongoDB ObjectId (not slug).

**Errors:** `404` property not found or not approved.

---

### POST /api/properties/:id/reviews

Submit a review for a property. One review per user per property. Reviews require admin approval before appearing publicly.

**Auth:** USER

**Request Body:**

```json
{
  "rating": 4,
  "title": "Great locality, minor maintenance issues",
  "body": "The flat is well-designed but the society maintenance could be better."
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `rating` | integer | Yes | 1–5 |
| `title` | string | No | 3–150 chars |
| `body` | string | No | 10–3000 chars |

**Response `201`:**

```json
{
  "success": true,
  "message": "Review submitted — pending moderation",
  "data": {
    "id": "64rev...",
    "propertyId": "64prop...",
    "rating": 4,
    "title": "Great locality, minor maintenance issues",
    "body": "The flat is well-designed...",
    "isApproved": false,
    "createdAt": "2024-02-15T00:00:00.000Z"
  }
}
```

**Errors:** `404` property not found · `409` you have already reviewed this property.

---

## 3. Leads

### POST /api/leads

Submit a buyer inquiry.

**Auth:** USER + phone verified

**Request Body:**

```json
{
  "propertyId": "64abc...",
  "buyerName": "Suresh Mehta",
  "buyerMessage": "Interested in a site visit this weekend."
}
```

`buyerName` and `buyerMessage` are both optional. `buyerEmail`/`buyerPhone` are **no longer accepted from the client** — they're always snapshotted server-side from the authenticated, phone-verified account (`req.user.email`/`req.user.phone`), so a submitted contact value can never diverge from the account actually making the request. If `buyerName` is omitted, the account's own `name` is used.

**Limits** (platform config, see `GET /api/config/public` and admin config endpoints):
- `max_active_inquiries` (default 5) — total leads for this buyer not yet `CLOSED`/`DROPPED`.
- `max_inquiries_per_day` (default 3) — leads submitted since 00:00 IST today.
- One inquiry per buyer per property still applies (unchanged).

**Response `201`:**

```json
{
  "success": true,
  "message": "We'll reach out within 24 hours",
  "data": {
    "id": "64lead...",
    "refCode": "RD-L-000123",
    "buyerName": "Suresh Mehta",
    "buyerEmail": "suresh@example.com",
    "buyerPhone": "+919876543210",
    "propertyId": "64abc...",
    "status": "UNASSIGNED",
    "createdAt": "2024-01-15T10:00:00.000Z"
  }
}
```

**Errors:** `400` if either limit is exceeded, or a duplicate inquiry already exists for this property; `403` if the account's phone isn't verified.

---

### POST /api/leads/partner

Partner logs a buyer they sourced themselves. Also mounted as `POST /api/partner/leads`.

**Auth:** PARTNER + KYC verified

**Request Body:**

```json
{
  "buyerName": "Suresh Mehta",
  "buyerPhone": "9876543210",
  "buyerEmail": "suresh@example.com",
  "propertyId": "64abc...",
  "budget": "80L-1Cr",
  "note": "Walk-in at the site on Saturday."
}
```

`buyerEmail`, `budget` and `note` are optional. `buyerPhone` accepts the same formats as every other phone field (bare 10-digit Indian, or full international for NRI) and is normalized to E.164. `propertyId` **must be one of the partner's own listings** — anything else 404s.

Creates the lead with `status: AWAITING_ADMIN` and `source: PARTNER`, so it stays out of the normal pipeline until an admin confirms it (see `PATCH /api/admin/leads/:id/confirm`). A partner can't self-assign work this way.

`buyerId` is deliberately left `null` even if a registered account has that phone: the buyer hasn't authenticated or consented to this inquiry, so attributing it to their account would surface it in their own dashboard as something they never submitted, and would consume their `POST /api/leads` quota.

**Response `201`:** the created lead (partner-sanitized), plus `isRepeatBuyer` and `relatedLead`.

```json
{
  "success": true,
  "message": "Lead added. Admin will confirm it shortly.",
  "data": {
    "refCode": "RD-L-000123",
    "status": "AWAITING_ADMIN",
    "source": "PARTNER",
    "isRepeatBuyer": true,
    "relatedLead": { "id": "64lead...", "refCode": "RD-L-000098" }
  }
}
```

If this phone already has an earlier lead on a **different** property, the new lead is linked to the most recent one via `relatedLeadId` and `isRepeatBuyer` is `true`, so admin sees a repeat buyer rather than a new one. The link is informational — deleting the earlier lead leaves a dangling id rather than blocking.

**Errors:** `404` property not in your listings · `409 DUPLICATE_LEAD` — this buyer already has an active (not closed/dropped) lead for this same property; `data.lead` carries the existing one.

---

### GET /api/leads/partner

All leads assigned to the authenticated partner. Phone **and email** are masked until OTP is verified (previously only phone was masked — email leaked in full).

**Auth:** PARTNER + KYC verified

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": [
    {
      "id": "64lead...",
      "refCode": "RD-L-000123",
      "buyerName": "Suresh Mehta",
      "buyerEmail": "suXXXXX@example.com",
      "buyerPhone": "+91XXXXXX3210",
      "buyerRef": "RD-U-000045",
      "buyerPhoneVerified": true,
      "status": "ASSIGNED",
      "isOtpVerified": false,
      "assignedAt": "2024-01-15T12:00:00.000Z",
      "property": {
        "title": "3 BHK Flat in Baner",
        "slug": "3-bhk-flat-in-baner-...",
        "locality": "Baner",
        "city": "Pune"
      },
      "createdAt": "2024-01-15T10:00:00.000Z"
    }
  ]
}
```

`buyerRef` (the buyer's own user `refCode`) and `buyerPhoneVerified` back the frontend's "Verified buyer" badge — note this is the *account's* phone verification state, independent of `isOtpVerified` (which is this specific lead's site-visit OTP gate). `adminNotes` is never included in a partner-facing lead, regardless of OTP state.

Each lead also carries `escrowTransactions` (newest first, same field set as the buyer-facing one) and `netAmount` — what the partner receives, i.e. the newest escrow's `amount` less the platform fee. The rate comes from that lead's own `platformCommissionPct` when set, so a deal closed under an older rate keeps it, otherwise from the `platform_commission_pct` config (currently **2%**, not the 2.5% some designs show — worth reconciling). `netAmount` is `null` when no escrow exists yet.

---

### GET /api/leads/partner/:id

Single lead detail. Full property record included.

**Auth:** PARTNER + KYC verified

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "id": "64lead...",
    "refCode": "RD-L-000123",
    "buyerName": "Suresh Mehta",
    "buyerPhone": "+91XXXXXX3210",
    "buyerRef": "RD-U-000045",
    "buyerPhoneVerified": true,
    "status": "ASSIGNED",
    "isOtpVerified": false,
    "siteVisitScheduledAt": null,
    "visitNotes": null,
    "visitPhotoUrls": [],
    "closureDocumentUrls": [],
    "property": { ... },
    "createdAt": "2024-01-15T10:00:00.000Z"
  }
}
```

`buyerPhone` and `buyerEmail` are both unmasked once `isOtpVerified` is `true`, masked before that.  
**Errors:** `404` not found or not assigned to this partner.

---

### POST /api/leads/partner/:id/schedule-visit

Schedule a site visit and send a 6-digit OTP to the buyer via WhatsApp.

**Auth:** PARTNER + KYC verified

**Request Body:**

```json
{ "scheduledAt": "2024-01-20T10:00:00.000Z" }
```

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": { "message": "OTP sent to buyer via WhatsApp. Enter it at the site." }
}
```

**Errors:** `400` if lead is already closed.

---

### POST /api/leads/partner/:id/resend-otp

Resends the site-visit OTP without moving the scheduled visit time (unlike `schedule-visit`, which would also reset it). Reuses the same `site_visit_otp` WhatsApp template — no new Meta template approval needed.

**Auth:** PARTNER + KYC verified (rate-limited)

**Request Body:** _(none)_

**Response `200`:**

```json
{ "success": true, "message": "Success", "data": { "message": "A new OTP has been sent to the buyer via WhatsApp." } }
```

Deliberately does **not** reset the 3-attempt lockout counter — a resend can't be used to repeatedly reset the anti-leakage lock. If the OTP is currently locked, this returns `429` instead of sending anything; use `request-otp-override` in that case.

**Errors:** `404` lead not found or not yours · `400` no site visit scheduled · `429` OTP is locked.

---

### POST /api/leads/partner/:id/request-otp-override

Flags a locked lead for Admin to review and unlock manually. This endpoint only requests — it never unlocks the OTP itself.

**Auth:** PARTNER + KYC verified

**Request Body:** _(none)_

**Response `200`:**

```json
{ "success": true, "message": "Success", "data": { "message": "Admin has been notified." } }
```

Sets `otpOverrideRequestedByPartner`/`otpOverrideRequestedAt` on the lead (a real, queryable queue) and broadcasts a notification to every admin.

**Errors:** `404` lead not found or not yours · `400` the OTP isn't currently locked.

---

### POST /api/leads/partner/:id/verify-otp

Verify the 6-digit site-visit OTP. Reveals the buyer's full phone number on success.

**Auth:** PARTNER + KYC verified (rate-limited)

**Request Body:**

```json
{ "otp": "7412" }
```

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "message": "OTP verified. Buyer contact revealed.",
    "buyerPhone": "+919876543210"
  }
}
```

**Errors:** `400` invalid/expired OTP · `429` too many attempts (lead locked, contact admin).

---

### PATCH /api/leads/partner/:id/document

Upload visit notes and files for a lead.

**Auth:** PARTNER + KYC verified

**Request:** `multipart/form-data`

| Field | Type | Description |
|-------|------|-------------|
| `visitNotes` | string | Notes about the visit |
| `partnerNotes` | string | Internal notes |
| `visitPhotos` | file[] | Up to 10 site photos |
| `closureDocs` | file[] | Up to 5 closure documents |

**Response `200`:** the updated lead, same sanitized shape as `GET /api/leads/partner/:id` (masked `buyerPhone`/`buyerEmail` until `isOtpVerified`, `buyerRef`/`buyerPhoneVerified` included, `adminNotes`/`siteVisitOTP` stripped — previously this returned the raw, unmasked lead with the live OTP still on it, regardless of verification state).

```json
{
  "success": true,
  "message": "Documentation uploaded",
  "data": {
    "id": "64lead...",
    "visitNotes": "Buyer was very interested.",
    "visitPhotoUrls": ["https://..."],
    "closureDocumentUrls": ["https://..."],
    "buyerPhone": "+91XXXXXX3210",
    "buyerEmail": "suXXXXX@example.com"
  }
}
```

---

### PATCH /api/leads/partner/:id/request-drop

Request to drop/abandon a lead. Requires admin approval before the lead is actually dropped.

**Auth:** PARTNER + KYC verified

**Request Body:** _(none)_

**Response `200`:**

```json
{
  "success": true,
  "message": "Drop request submitted",
  "data": { "id": "64lead...", "status": "DROP_REQUESTED" }
}
```

**Errors:** `400` lead already closed or dropped · `404` not found or not assigned to partner.

---

### PATCH /api/leads/partner/:id/status

Partner reports what came of the site visit. Also mounted as `PATCH /api/partner/leads/:id/status`.

**Auth:** PARTNER + KYC verified

**Request Body:**

```json
{ "outcome": "NEGOTIATING", "note": "Buyer negotiating on price, wants a second visit with family." }
```

`outcome` is one of `STILL_DECIDING` · `WANTS_ANOTHER_VISIT` · `NEGOTIATING`. `note` is optional (max 1000 chars) and writes `partnerNotes`.

**This is informational only — it never moves `lead.status`.** Closing and dropping keep their own guarded endpoints (`/close` needs a HELD escrow per Rule 6; `/request-drop` needs admin approval), so `CLOSED`/`DROPPED` are rejected here with a message naming the right route. It's also deliberately separate from `buyerFeedbackStatus`, which is what the *buyer* told the WhatsApp bot — admin compares the two to catch a misreported outcome, so neither overwrites the other.

**Response `200`:** the updated lead, same sanitized shape as `GET /api/leads/partner/:id`, with `visitOutcome` and `visitOutcomeAt` set.

**Errors:** `400` outcome not one of the three allowed values · `400 OTP_NOT_VERIFIED` — the site visit hasn't been verified yet, so there's no outcome to report · `400` lead already closed or dropped · `404` not found or not assigned to this partner.

---

### PATCH /api/leads/partner/:id/close

Mark lead as closed. Requires an escrow with `status: HELD` and a captured payment. Irreversible by partner.

**Auth:** PARTNER + KYC verified

**Request Body:** _(none)_

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": { "message": "Lead marked as closed. Admin will review escrow release." }
}
```

**Errors:** `400` no HELD escrow with captured payment · `400` already closed.

---

## 4. User Dashboard

All `/api/user/*` routes require `authenticate` + `requireUser`. All routes except `/profile`, `/verify-phone`, and `/verify-phone/otp` additionally require `requireOnboarded` for role `USER` — a USER account with no verified phone (and past its `phoneVerifyDeadline` grace period, if any) gets `403 ONBOARDING_INCOMPLETE` on everything else. PARTNER/ADMIN accounts are never blocked by this gate.

### POST /api/user/verify-phone

Request a 6-digit phone verification OTP via WhatsApp. Backed by the shared `PhoneOtp` table (purpose `PROFILE_VERIFY`) — same OTP mechanism as signup/login (§1), with a 10-minute expiry, 5-attempt lock (10 minutes), 30s resend cooldown, and 3-sends/hour cap.

`phone` is **not** written to the user's row at this step — only once `POST /verify-phone/otp` below actually checks the code. This prevents one account from squatting on someone else's real number before proving ownership of it.

**Auth:** USER (rate-limited)

**Request Body:**

```json
{ "phone": "+919876543210" }
```

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": { "message": "OTP sent via WhatsApp", "expiresAt": "2026-09-24T10:10:00.000Z" }
}
```

**Errors:** `409 PHONE_IN_USE` — phone already registered to another account · `429` OTP locked / resend cooldown / send limit.

---

### POST /api/user/verify-phone/otp

Verify the 6-digit OTP to confirm phone ownership. `phone` must be included in the body (it's what's checked against the code — the endpoint no longer trusts whatever happens to already be on the user row). Only on success is `phone` actually written to the user's row, together with `phoneVerified: true`.

**Auth:** USER (rate-limited)

**Request Body:**

```json
{ "phone": "+919876543210", "otp": "748213" }
```

**Response `200`:**

```json
{
  "success": true,
  "message": "Phone number verified",
  "data": { "phoneVerified": true, "phone": "+919876543210" }
}
```

**Errors:** `400 OTP_INVALID` (wrong, expired, or already-used code) · `429 OTP_LOCKED` · `409 PHONE_IN_USE` (someone else claimed the number between the OTP request and this verify call).

---

### PATCH /api/user/profile

Update profile, settings, and onboarding preferences.

**Auth:** USER

**Request Body:**

```json
{
  "name": "Suresh Mehta",
  "isNRI": false,
  "address": "123 MG Road, Bengaluru",
  "language": "kn",
  "notificationPreferences": { "push": false, "whatsapp": true, "marketing": true },
  "buyerType": "INVESTOR",
  "city": "Bengaluru",
  "budget": "80L-1.2Cr",
  "bhk": ["2", "3"],
  "timeline": "NOW"
}
```

All fields are optional (at least one must be provided). `language`: `en` · `kn` · `hi`. `notificationPreferences` is a partial object — send only the keys you want to change (`push`, `email`, `whatsapp`, `marketing`, `visitReminders`); untouched keys keep their existing value. `buyerType`: `BUYER` · `RENTER` · `INVESTOR`. `timeline`: `NOW` · `3_6_MONTHS` · `BROWSING`. The `buyerType`/`city`/`budget`/`bhk`/`timeline` group is the mandatory "let's get started" step collected right after Google + phone verification.

**Response `200`:**

```json
{
  "success": true,
  "message": "Profile updated",
  "data": {
    "id": "64user...", "name": "Suresh Mehta", "isNRI": false,
    "address": "123 MG Road, Bengaluru", "language": "kn",
    "notificationPreferences": { "push": false, "email": true, "whatsapp": true, "marketing": true, "visitReminders": true },
    "buyerType": "INVESTOR", "city": "Bengaluru", "budget": "80L-1.2Cr", "bhk": ["2", "3"], "timeline": "NOW"
  }
}
```

Note: `city` here is the buyer's *preferred* city (an onboarding preference, stored internally as `preferredCity`) — unrelated to any property's own `city` field. The full profile (including all of the above) is also readable from `GET /api/auth/me`, so a second device/session picks up the same preferences.

---

### PATCH /api/user/consent

Record onboarding consent (terms, privacy, marketing).

**Auth:** USER

**Request Body:**

```json
{ "termsAccepted": true, "privacyAccepted": true, "marketingOptIn": false }
```

All three fields are optional; at least one must be provided. `termsAccepted`/`privacyAccepted` record a one-time acceptance timestamp and are not revocable once set (sending `false` is a no-op for them). `marketingOptIn` is a genuine on/off toggle.

**Response `200`:**

```json
{
  "success": true,
  "message": "Consent recorded",
  "data": {
    "id": "64user...",
    "termsAcceptedAt": "2026-09-20T10:00:00.000Z",
    "privacyAcceptedAt": "2026-09-20T10:00:00.000Z",
    "marketingOptIn": false,
    "marketingOptInAt": null
  }
}
```

---

### GET /api/user/leads

All inquiries submitted by the authenticated user.

**Auth:** USER

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": [
    {
      "id": "64lead...",
      "refCode": "RD-L-000123",
      "buyerName": "Suresh Mehta",
      "status": "ASSIGNED",
      "createdAt": "2024-01-15T10:00:00.000Z",
      "property": {
        "title": "3 BHK Flat in Baner",
        "slug": "3-bhk-flat-in-baner-...",
        "city": "Pune",
        "locality": "Baner",
        "images": ["https://cdn.realtydoor.in/prop1.jpg"],
        "price": 10500000,
        "builtUpArea": 1400,
        "carpetArea": 1200,
        "bhk": 3
      },
      "escrowTransactions": [
        {
          "id": "64esc...", "amount": 50000, "currency": "INR", "status": "HELD",
          "heldAt": "2024-01-16T00:00:00.000Z", "releasedAt": null, "refundedAt": null, "failedAt": null,
          "createdAt": "2024-01-15T12:00:00.000Z"
        }
      ],
      "assignedPartner": {
        "id": "64partner...", "name": "Rajdeep Kumar", "profileImageUrl": null, "companyName": "RealtyPro Solutions"
      }
    }
  ]
}
```

`assignedPartner` is `null` until a partner is assigned. **It never includes the partner's phone or email** — the buyer never dials the partner directly; the frontend's "Contact agent" action should call the shared telecaller number from `GET /api/config/public`'s `telecaller_phone` instead. `property.locality`/`price`/`builtUpArea`/`carpetArea`/`bhk` back the inquiry page's summary lines (e.g. "Whitefield · ₹1.05Cr · 1,840 sqft" and "Agent · Whitefield"). `escrowTransactions` is empty if no token advance has ever been paid on this lead, newest first otherwise. A number of internal-only fields (admin/partner notes, OTP attempt count, commission/invoice fields, drop-request fields) are stripped from every lead returned to a buyer. See `GET /api/escrow/:id` for polling a single escrow's status directly (e.g. right after a Razorpay Checkout attempt).

---

### GET /api/user/leads/:id

Single inquiry detail for the authenticated buyer. Same shape and same `assignedPartner`/sanitization rules as the list endpoint above.

**Auth:** USER (must own the lead)

**Errors:** `400` malformed `:id` · `404` not found or not yours (same response for both, so a 404 never confirms whether the id exists).

---

### POST /api/user/leads/:leadId/rating

Buyer rates the partner assigned to a lead. Allowed only once the lead's `status` is `SITE_VISIT_DONE` or `CLOSED`, and only once per lead.

**Auth:** USER (must own the lead)

**Request Body:**

```json
{ "rating": 5, "comment": "Partner was punctual and answered all my questions." }
```

`rating` is required, integer 1–5. `comment` is optional, max 1000 characters.

**Response `200`:**

```json
{
  "success": true,
  "message": "Rating submitted",
  "data": {
    "id": "64lead...",
    "buyerRating": 5,
    "buyerRatingComment": "Partner was punctual and answered all my questions.",
    "buyerRatedAt": "2026-09-20T10:00:00.000Z"
  }
}
```

**Errors:** `404` lead not found or not yours · `400` site visit hasn't happened yet · `409` already rated.

---

### POST /api/user/leads/:id/cancel

Buyer cancels their own inquiry, with a conditional Razorpay refund.

**Auth:** USER (must own the lead)

**Request Body:**

```json
{ "reason": "Found a better option", "reasonLabel": "Changed my mind" }
```

**Response `200`:**

```json
{ "success": true, "message": "Inquiry cancelled", "data": { "refund": { "amount": 60000, "refundId": "rfnd_...", "refundTo": "original payment method", "eta": "5-7 business days" } } }
```

`refund` is present only if there was an active `HELD` escrow within the refund window (`escrowRefundWindowHours` config, default 48h) — a real Razorpay refund is issued in that case. If the escrow was only `PAYMENT_PENDING` (nothing captured yet), it's just marked `CANCELLED`, no refund object. If there's no active escrow, or the `HELD` escrow is outside the window, `refund` is omitted and the lead still closes.

**Errors:** `404` lead not found or not yours · `400` inquiry already closed/dropped.

---

### GET /api/user/favorites

All properties the user has saved.

**Auth:** USER

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": [
    {
      "id": "64fav...",
      "propertyId": "64prop...",
      "createdAt": "2024-01-12T00:00:00.000Z",
      "property": {
        "title": "3 BHK Flat in Baner",
        "slug": "3-bhk-flat-in-baner-...",
        "city": "Pune",
        "price": 8500000,
        "images": ["https://cdn.realtydoor.in/prop1.jpg"],
        "facing": "East",
        "furnishing": "Semi-Furnished"
      }
    }
  ]
}
```

---

### POST /api/user/favorites

Toggle property in/out of favorites.

**Auth:** USER + phone verified

**Request Body:**

```json
{ "propertyId": "64abc..." }
```

**Response `200`:**

```json
{ "success": true, "message": "Success", "data": { "favorited": true } }
```

`favorited: false` when removed.

---

### GET /api/user/documents

All documents in the user's vault.

**Auth:** USER

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": [
    {
      "id": "64doc...",
      "documentType": "PAN_CARD",
      "fileUrl": "https://cdn.realtydoor.in/docs/pan.pdf",
      "fileName": "pan_card.pdf",
      "status": "PENDING_REVIEW",
      "isVerified": false,
      "uploadedAt": "2024-01-10T00:00:00.000Z"
    }
  ]
}
```

---

### POST /api/user/documents

Upload a document.

**Auth:** USER + phone verified

**Request:** `multipart/form-data`

| Field | Type | Description |
|-------|------|-------------|
| `file` | file | Single file |
| `documentType` | string | `PAN_CARD` · `AADHAR` · `SALARY_SLIP` · `FORM_16` · `BANK_STATEMENT` · `PASSPORT` · `OCI_PIO_CARD` · `POA_DRAFT` · `POA_NOTARIZED` · `NRE_NRO_PROOF` (the last five are for NRI users) |

**Response `201`:**

```json
{
  "success": true,
  "message": "Document uploaded",
  "data": {
    "id": "64doc...",
    "documentType": "PAN_CARD",
    "fileUrl": "https://...",
    "fileName": "pan_card.pdf",
    "status": "PENDING_REVIEW",
    "isVerified": false,
    "uploadedAt": "2024-01-10T00:00:00.000Z"
  }
}
```

---

### GET /api/user/subscriptions

All service subscriptions with associated tickets.

**Auth:** USER

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": [
    {
      "id": "64sub...",
      "serviceId": "64svc...",
      "razorpayOrderId": "order_...",
      "razorpayPaymentId": "pay_...",
      "paymentStatus": "SUCCESS",
      "amountPaid": 4999,
      "currency": "INR",
      "startDate": "2024-01-10T00:00:00.000Z",
      "endDate": "2025-01-10T00:00:00.000Z",
      "service": { "name": "Maintenance Premium", "category": "MAINTENANCE" },
      "tickets": [
        { "id": "64tkt...", "subject": "Plumbing leak", "status": "OPEN", "createdAt": "..." }
      ]
    }
  ]
}
```

---

### GET /api/user/tickets

All support tickets raised by the authenticated user.

**Auth:** USER

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": [
    {
      "id": "64tkt...",
      "subject": "Plumbing leak in bathroom",
      "status": "IN_PROGRESS",
      "priority": "HIGH",
      "createdAt": "2024-02-01T00:00:00.000Z"
    }
  ]
}
```

---

### GET /api/user/tickets/:id

Single ticket detail (must belong to authenticated user).

**Auth:** USER

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "id": "64tkt...",
    "subject": "Plumbing leak in bathroom",
    "description": "Slow leak under the wash basin.",
    "status": "IN_PROGRESS",
    "priority": "HIGH",
    "category": "PLUMBING",
    "createdAt": "2024-02-01T00:00:00.000Z",
    "updatedAt": "2024-02-02T00:00:00.000Z"
  }
}
```

**Errors:** `404` not found or belongs to another user.

---

### POST /api/user/tickets

Raise a service ticket under an active subscription.

**Auth:** USER + phone verified

**Request Body:**

```json
{
  "subscriptionId": "64sub...",
  "subject": "Plumbing leak in bathroom",
  "description": "Slow leak under the wash basin.",
  "category": "PLUMBING",
  "priority": "HIGH",
  "propertyId": "64prop...",
  "photos": ["https://cdn.realtydoor.in/tickets/leak1.jpg"]
}
```

`category`: `PLUMBING` · `ELECTRICAL` · `PAINTING` · `GENERAL`  
`priority`: `NORMAL` (default) · `HIGH` · `URGENT`  
`propertyId` and `photos` are both optional.

**Response `201`:**

```json
{
  "success": true,
  "message": "Ticket raised",
  "data": {
    "id": "64tkt...",
    "subject": "Plumbing leak in bathroom",
    "status": "OPEN",
    "priority": "HIGH",
    "propertyId": "64prop...",
    "photos": ["https://cdn.realtydoor.in/tickets/leak1.jpg"],
    "createdAt": "2024-02-01T00:00:00.000Z"
  }
}
```

**Errors:** `404` subscription not found · `400` service not active.

---

### PATCH /api/user/tickets/:id/reopen

Reopen a ticket the user believes wasn't actually fixed. Only valid when `status === 'RESOLVED'`.

**Auth:** USER

**Request Body:**

```json
{ "reason": "The leak came back after two days" }
```

**Response `200`:**

```json
{
  "success": true,
  "message": "Ticket reopened",
  "data": { "id": "64tkt...", "status": "IN_PROGRESS", "reopenReason": "The leak came back after two days", "resolvedAt": null }
}
```

**Errors:** `404` not found · `400` ticket is not `RESOLVED`.

---

### DELETE /api/user/tickets/:id

Withdraw a ticket. Only valid when `status === 'OPEN'` and no vendor has been assigned yet.

**Auth:** USER

**Response `200`:**

```json
{ "success": true, "message": "Ticket withdrawn", "data": null }
```

**Errors:** `404` not found · `400` ticket is not `OPEN`, or a vendor is already assigned.

---

### GET /api/user/tickets/:id/comments

Full comment thread for a ticket — same thread the admin ticket detail view sees.

**Auth:** USER (must own the ticket)

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": [
    { "id": "64cmt...", "ticketId": "64tkt...", "authorId": "64usr...", "authorRole": "USER", "text": "Any update on this?", "photos": [], "createdAt": "..." }
  ]
}
```

**Errors:** `404` if the ticket doesn't exist or isn't yours (never reveals someone else's ticket by ID).

---

### POST /api/user/tickets/:id/comments

Post a comment to the thread.

**Auth:** USER (must own the ticket)

**Request Body:**

```json
{ "text": "Any update on this?", "photos": [] }
```

**Response `201`:**

```json
{
  "success": true,
  "message": "Comment posted",
  "data": { "id": "64cmt...", "ticketId": "64tkt...", "authorId": "64usr...", "authorRole": "USER", "text": "Any update on this?", "photos": [], "createdAt": "..." }
}
```

**Errors:** `404` not found or not yours.

---

### PATCH /api/user/tickets/:id/verify

Confirm service was completed. Moves ticket to `VERIFIED_BY_USER`.

**Auth:** USER

**Request Body:**

```json
{ "vendorRating": 4, "vendorRatingComment": "Good work, bit slow" }
```

Both fields optional.

**Response `200`:**

```json
{
  "success": true,
  "message": "Ticket verified and closed",
  "data": { "id": "64tkt...", "status": "VERIFIED_BY_USER", "verifiedAt": "...", "vendorRating": 4, "vendorRatingComment": "Good work, bit slow" }
}
```

**Errors:** `404` not found · `400` ticket is not `RESOLVED`.

---

### POST /api/user/loan

Submit a home loan application.

**Auth:** USER + phone verified

**Request Body:**

```json
{
  "propertyId": "64abc...",
  "preferredBank": "HDFC Bank",
  "loanAmountRequestedPaise": 7000000
}
```

All fields are optional. `loanAmountRequestedPaise` is in paise (₹1 = 100 paise).

**Response `201`:**

```json
{
  "success": true,
  "message": "Loan application submitted",
  "data": {
    "id": "64loan...",
    "userId": "64user...",
    "propertyId": "64abc...",
    "preferredBank": "HDFC Bank",
    "loanAmountRequestedPaise": 7000000,
    "status": "DOCUMENTS_PENDING",
    "createdAt": "2024-01-15T00:00:00.000Z"
  }
}
```

---

### GET /api/user/loan

All loan applications for the authenticated user.

**Auth:** USER

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": [
    {
      "id": "64loan...",
      "status": "DOCUMENTS_SUBMITTED",
      "preferredBank": "HDFC Bank",
      "loanAmountRequestedPaise": 7000000,
      "sanctionedAmountPaise": null,
      "adminNote": null,
      "createdAt": "2024-01-15T00:00:00.000Z",
      "property": { "title": "3 BHK Flat in Baner", "slug": "...", "city": "Pune" }
    }
  ]
}
```

---

### GET /api/user/loan/:id

Single loan application (must belong to authenticated user).

**Auth:** USER

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "id": "64loan...",
    "userId": "64user...",
    "propertyId": "64abc...",
    "preferredBank": "HDFC Bank",
    "loanAmountRequestedPaise": 7000000,
    "sanctionedAmountPaise": null,
    "status": "DOCUMENTS_SUBMITTED",
    "adminNote": null,
    "bankRefNumber": null,
    "sanctionedAt": null,
    "disbursedAt": null,
    "rejectionReason": null,
    "submittedDocIds": [],
    "createdAt": "2024-01-15T00:00:00.000Z",
    "updatedAt": "2024-01-15T00:00:00.000Z"
  }
}
```

**Errors:** `404` not found or belongs to another user.

---

### POST /api/user/video-tour

Request a virtual video tour of a property (NRI feature). Prevents duplicate requests — throws 409 if an active PENDING or ASSIGNED request already exists for the same property.

**Auth:** USER + phone verified

**Request Body:**

```json
{
  "propertyId": "64abc...",
  "userNote": "Please show the view from the balcony and car parking area."
}
```

`propertyId` required. `userNote` optional (max 500 chars).

**Response `201`:**

```json
{
  "success": true,
  "message": "Video tour requested",
  "data": {
    "id": "64vt...",
    "userId": "64user...",
    "propertyId": "64prop...",
    "userNote": "Please show the balcony view.",
    "status": "PENDING",
    "createdAt": "2024-03-01T00:00:00.000Z"
  }
}
```

**Errors:** `404` property not found or not APPROVED · `409` active request already exists for this property.

---

### GET /api/user/video-tours

All video tour requests submitted by the authenticated user.

**Auth:** USER

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": [
    {
      "id": "64vt...",
      "status": "ASSIGNED",
      "userNote": "Please show the balcony view.",
      "scheduledAt": "2024-03-10T11:00:00.000Z",
      "videoUrl": null,
      "adminNote": "Our partner will call you before the tour.",
      "createdAt": "2024-03-01T00:00:00.000Z",
      "property": {
        "title": "3 BHK Flat in Baner",
        "slug": "3-bhk-flat-in-baner-...",
        "city": "Pune",
        "images": ["https://cdn.realtydoor.in/prop1.jpg"]
      }
    }
  ]
}
```

Ordered by `createdAt` descending.

---

### POST /api/user/disputes

Raise a dispute against a Lead, EscrowTransaction, or UserSubscription. One active dispute per record at a time.

**Auth:** USER

**Request Body:**

```json
{
  "type":        "ESCROW",
  "referenceId": "64escrow...",
  "reason":      "Payment deducted but escrow not created",
  "description": "I paid ₹50,000 via Razorpay on 10 Jan but the escrow transaction shows FAILED. Please investigate."
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | string | Yes | `LEAD` · `ESCROW` · `SERVICE` |
| `referenceId` | ObjectId | Yes | ID of the Lead, EscrowTransaction, or UserSubscription |
| `reason` | string | Yes | Short summary (5–200 chars) |
| `description` | string | Yes | Full details (10–2000 chars) |

**Response `201`:**

```json
{
  "success": true,
  "message": "Dispute raised",
  "data": {
    "id": "64dis...",
    "userId": "64user...",
    "type": "ESCROW",
    "referenceId": "64escrow...",
    "reason": "Payment deducted but escrow not created",
    "description": "I paid ₹50,000...",
    "status": "OPEN",
    "adminNote": null,
    "resolvedAt": null,
    "createdAt": "2024-03-01T00:00:00.000Z"
  }
}
```

**Errors:** `404` referenced record not found or does not belong to you · `409` active dispute already exists for this record.

---

### GET /api/user/disputes

All disputes raised by the authenticated user.

**Auth:** USER

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": [
    {
      "id": "64dis...",
      "type": "ESCROW",
      "referenceId": "64escrow...",
      "reason": "Payment deducted but escrow not created",
      "status": "UNDER_REVIEW",
      "adminNote": "We are investigating with the payment gateway.",
      "resolvedAt": null,
      "createdAt": "2024-03-01T00:00:00.000Z"
    }
  ]
}
```

Ordered by `createdAt` descending.

---

## 5. Partner

All `/api/partner/*` routes require `authenticate` + `requirePartner`.

### POST /api/partner/terms/accept

Record the partner's acceptance of a versioned commission/terms agreement.

**Auth:** PARTNER

**Request Body:** `{ "version": "2026-10-v1" }`

Versioned rather than a boolean: when the agreement text changes, a partner who accepted `v1` must accept again, so the *version accepted* is the record. The accepting IP is stored for the same evidentiary reason (not returned). Accepting a new version overwrites the old one; re-posting the same version just refreshes the timestamp.

**Response `200`:** `{ "success": true, "message": "Terms accepted", "data": { "partnerTermsVersion": "2026-10-v1", "partnerTermsAcceptedAt": "2026-10-04T10:00:00.000Z" } }`

---

### POST /api/partner/kyc/consent

Record KYC consent. Must be called before `POST /api/partner/kyc` will accept documents. Idempotent — calling it again after consent is already recorded just returns the original timestamp, it doesn't overwrite it.

**Auth:** PARTNER

**Request Body:** _(none)_

**Response `200`:**

```json
{ "success": true, "message": "KYC consent recorded", "data": { "kycConsentAt": "2026-10-03T10:00:00.000Z" } }
```

---

### POST /api/partner/kyc

Submit KYC documents for admin review (up to 5 files).

**Auth:** PARTNER (KYC not required to submit — consent is, see above)

**Request:** `multipart/form-data`, field name `documents`, up to 5 files.

**Response `200`:**

```json
{
  "success": true,
  "message": "KYC submitted for review. Usually verified within 24 hours.",
  "data": { "id": "64user...", "kycStatus": "PENDING_REVIEW", "kycDocumentUrls": ["..."] }
}
```

**Errors:** `400` KYC already VERIFIED · `400` KYC already under review · `400 KYC_CONSENT_REQUIRED` — `POST /api/partner/kyc/consent` hasn't been called yet. Status is checked before consent, so a partner verified before this field existed still gets "already verified" on a resubmit rather than being asked for consent.

---

### GET /api/partner/profile

**Auth:** PARTNER

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "id": "64user...",
    "name": "Rajdeep Kumar",
    "email": "rajdeep@example.com",
    "phone": "+919876543210",
    "companyName": "RealtyPro Solutions",
    "bio": "10 years in Pune real estate.",
    "profileImageUrl": "https://img.clerk.com/...",
    "websiteUrl": "https://realtypro.in",
    "partnerSubType": "AGENT",
    "kycStatus": "VERIFIED",
    "kycRejectionNote": null,
    "kycVerifiedAt": "2024-02-01T00:00:00.000Z",
    "kycConsentAt": "2026-10-03T10:00:00.000Z",
    "createdAt": "2024-01-01T00:00:00.000Z"
  }
}
```

`kycConsentAt` is `null` until `POST /api/partner/kyc/consent` is called — the frontend should use it to skip re-asking for consent on resume rather than inferring it from `kycStatus`.

---

### PATCH /api/partner/profile

Update partner profile. Fields `role`, `kycStatus`, `kycDocumentUrls`, `email` are protected and silently stripped.

**Auth:** PARTNER

**Request Body:**

```json
{
  "name": "Rajdeep Kumar",
  "phone": "+919876543210",
  "companyName": "RealtyPro Solutions",
  "bio": "Updated bio.",
  "websiteUrl": "https://realtypro.in",
  "partnerSubType": "AGENT"
}
```

**Response `200`:**

```json
{ "success": true, "message": "Profile updated", "data": { ... } }
```

---

### POST /api/partner/profile/photo

Upload/replace the partner's profile photo.

**Auth:** PARTNER

**Request:** `multipart/form-data`, field name `photo` (jpg/png/webp).

**Response `200`:**

```json
{ "success": true, "message": "Profile photo updated", "data": { "id": "64partner...", "profileImageUrl": "https://...s3.../partners/profile-photos/abc123.jpg" } }
```

**Errors:** `400` no file provided.

---

### GET /api/partner/listings

Partner's own property listings.

**Auth:** PARTNER + KYC verified

**Query Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `status` | string | `PENDING_APPROVAL` · `APPROVED` · `REJECTED` · `ARCHIVED` |

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": [
    {
      "id": "64prop...",
      "title": "3 BHK Flat in Baner",
      "slug": "3-bhk-flat-in-baner-...",
      "publishStatus": "APPROVED",
      "rejectionNote": null,
      "propertyType": "FLAT",
      "listingType": "SALE",
      "city": "Pune",
      "locality": "Baner",
      "price": 8500000,
      "bhk": 3,
      "images": ["https://cdn.realtydoor.in/prop1.jpg"],
      "createdAt": "2024-01-10T00:00:00.000Z",
      "facing": "East",
      "furnishing": "Semi-Furnished"
    }
  ]
}
```

---

### GET /api/partner/listings/:id

Single listing owned by the partner.

**Auth:** PARTNER + KYC verified

**Response `200`:** Full property record.

**Errors:** `404` not found or belongs to another partner.

---

### GET /api/partner/finance

Partner finance / escrow summary.

**Auth:** PARTNER + KYC verified

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": { "totalLeads": 12, "closedDeals": 3, "escrowHeld": 150000 }
}
```

`escrowHeld` is the sum in ₹ of HELD escrow on the partner's closed leads.

---

### GET /api/partner/ratings

Ratings buyers have left for this partner. Backed by `Lead.buyerRating`/`buyerRatingComment` (set via `POST /api/user/leads/:leadId/rating`) — there's no separate rating model, each `Lead` already scopes one buyer's rating to one partner.

**Auth:** PARTNER + KYC verified

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "average": 4.5,
    "count": 2,
    "ratings": [
      { "leadId": "64lead...", "rating": 5, "comment": "Great partner", "ratedAt": "...", "buyerName": "Suresh Mehta" }
    ]
  }
}
```

`average` is `null` when `count` is 0.

---

### GET /api/partner/analytics

Analytics dashboard for the authenticated partner.

**Auth:** PARTNER + KYC verified

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "totalLeads": 12,
    "leadsByStatus": {
      "UNASSIGNED": 0,
      "ASSIGNED": 5,
      "SITE_VISIT_SCHEDULED": 2,
      "SITE_VISIT_DONE": 2,
      "CLOSED": 2,
      "DROPPED": 1
    },
    "totalListings": 8,
    "listingsByStatus": {
      "PENDING_APPROVAL": 1,
      "APPROVED": 6,
      "REJECTED": 0,
      "ARCHIVED": 1
    },
    "escrowHeld": 150000,
    "closedDeals": 2,
    "conversionRate": 16.67
  }
}
```

`conversionRate` is `closedDeals / totalLeads * 100` (percent, 2 decimal places). `escrowHeld` in ₹.

---

### GET /api/partner/analytics/benchmark

The partner's own funnel and response times beside the platform median, plus
their percentile rank (B9.4-B9.6). This replaces the frontend's previous
hard-coded "platform average" multipliers.

**Auth:** PARTNER + KYC verified

**Query:** `period` - `MTD`, `3M`, `6M`, `YTD` or `ALL` (default `ALL`).

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "period": "ALL",
    "partner": {
      "funnel": {
        "received": 16, "accepted": 16, "visitsScheduled": 4,
        "otpsVerified": 5, "decided": 2, "closed": 1,
        "otpRatePct": 125, "closeRatePct": 6.3
      },
      "responseDays": {
        "note": "No first-contact timestamp exists, so leadToAssignment measures assignment, not contact. visitBookingLeadDays is a booking horizon, not a response time. Time-to-schedule is not measurable: siteVisitScheduledAt is the booked slot, not when scheduling happened.",
        "leadToAssignment": 3.14,
        "leadToAssignmentSamples": 12,
        "leadToAssignmentDiscardedNegative": 4,
        "assignmentToOtp": 1,
        "assignmentToOtpSamples": 5,
        "otpToEscrow": 0,
        "otpToEscrowSamples": 1,
        "otpToEscrowDiscardedNegative": 1,
        "visitBookingLeadDays": 2.38,
        "visitBookingLeadDaysSamples": 4
      }
    },
    "platform": { "funnel": { "...": "same shape" }, "responseDays": { "...": "same shape" } },
    "anomalies": [
      { "key": "OTP_WITHOUT_SCHEDULED_VISIT", "detail": "5 OTPs verified but only 4 visits scheduled - some leads are OTP-verified with no siteVisitScheduledAt" },
      { "key": "NEGATIVE_DURATION", "detail": "4 lead(s) have out-of-order timestamps for leadToAssignment" }
    ],
    "ranking": {
      "percentile": null,
      "partnersCompared": 1,
      "closedDeals": 1
    }
  }
}
```

**Response notes the frontend must respect:**

- Each response-time stage reports a **median**, not a mean - one stalled lead
  sitting open for months would drag an average far enough to make the number
  useless.
- `<stage>` is `null` when no usable record exists. Always check
  `<stage>Samples` before presenting a figure as confident; a median over 1
  sample is not a benchmark.
- `<stage>DiscardedNegative` is present only when records were dropped for
  having out-of-order timestamps.
- `leadToAssignment` measures time to **assignment**, not first contact. No
  first-contact timestamp exists anywhere in the schema; the stage is named and
  annotated for what it really measures rather than passed off as contact time.

**The four stages and what they actually mean:**

| Stage | Measures | Notes |
| --- | --- | --- |
| `leadToAssignment` | `assignedAt - createdAt` | How fast a lead reaches a partner. |
| `assignmentToOtp` | `otpVerifiedAt - assignedAt` | Assignment through to a completed, OTP-verified site visit. The real throughput number. |
| `otpToEscrow` | first `heldAt - otpVerifiedAt` | Verified visit to money in escrow. |
| `visitBookingLeadDays` | `siteVisitScheduledAt - assignedAt` | **Not a response time** - how far ahead the appointment slot was booked. |

**There is deliberately no "time to schedule" stage.** `siteVisitScheduledAt`
stores the *booked appointment slot* and `POST /partner/leads/:id/schedule-visit`
requires it to be in the future, so nothing records *when* scheduling happened.
For the same reason, `otpVerifiedAt` is routinely earlier than
`siteVisitScheduledAt` - the buyer's OTP can be verified any time before the
slot - and that is normal, not a data fault. Do not compute a duration against
`siteVisitScheduledAt` and treat a negative result as an error.

- `ranking.percentile` is the share of partners this partner closed *more* than,
  and is `null` when `partnersCompared` is 1 or less, since a rank against
  nobody is meaningless. Hide the rank entirely in that case.
- `anomalies` being non-empty means the underlying data is inconsistent (see the
  admin analytics notes). Surface a warning rather than rendering `otpRatePct:
  125` as a real conversion rate.

---

### GET /api/partner/listings/change-requests

The partner's own view of edits they submitted to live listings (docs 4.8).

Without this a partner has no way to tell what happened to an edit: the
listing deliberately still shows the old approved content, so the change looks
as though it was ignored.

**Auth:** PARTNER + KYC verified

**Query:** `status` — `PENDING`, `APPROVED`, `REJECTED`, `SUPERSEDED` or `ALL`
(default: all of the partner's own) · `propertyId` · `page` · `limit`

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "data": [
      {
        "id": "6a44b1...",
        "status": "REJECTED",
        "fieldCount": 1,
        "changes": [
          { "field": "price", "before": 1400000, "after": 1900000, "impact": "HIGH" }
        ],
        "property": { "id": "...", "title": "...", "slug": "...", "publishStatus": "APPROVED" },
        "reviewNote": "Price is above the mandate ceiling for this unit",
        "reviewedAt": "2026-10-04T11:02:00.000Z",
        "createdAt": "2026-10-04T10:27:25.000Z"
      }
    ],
    "total": 1, "page": 1, "limit": 20, "totalPages": 1
  }
}
```

`reviewNote` carries the admin's reason verbatim — it is the only thing telling
the partner what to change, so show it rather than a generic "rejected".

A `SUPERSEDED` row means the partner submitted a newer edit to the same listing
before this one was reviewed.

---

### PATCH /api/partner/listings/change-requests/:id/withdraw

Take back an edit that has not been reviewed yet.

**Auth:** PARTNER + KYC verified

**Response `200`:** the request, now `status: "REJECTED"` with
`reviewNote: "Withdrawn by partner"`.

Recorded as a rejection rather than deleted, so the listing's edit history
stays complete. A withdrawal is distinguishable from an admin rejection by
`reviewedByAdminId` being null.

**Errors:** `400` the request is not `PENDING` · `404` not found, or not yours
(both return 404 — a partner is never told whether another partner's request id
exists).

---


---

### GET /api/partner/settings

Partner's visit availability, notification preferences, and lead preferences.

**Auth:** PARTNER

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "visitDays": ["Mon","Tue","Wed","Thu","Fri","Sat"],
    "visitFromTime": "10:00",
    "visitToTime": "19:00",
    "notifNewLead": true,
    "notifLeadExpiring": true,
    "notifEscrowReleased": true,
    "notifListingUpdate": true,
    "notifWeeklyReport": false,
    "leadAutoAccept": false,
    "leadPauseOverloaded": true,
    "leadPreferredLocalities": ["Baner", "Kothrud"]
  }
}
```

---

### PATCH /api/partner/settings

Update any combination of visit availability, notification toggles, or lead preferences.

**Auth:** PARTNER

**Request Body:** All fields optional; at least one required.

```json
{
  "visitDays": ["Mon","Tue","Wed","Thu","Fri","Sat"],
  "visitFromTime": "10:00",
  "visitToTime": "19:00",
  "notifNewLead": true,
  "notifLeadExpiring": true,
  "notifEscrowReleased": true,
  "notifListingUpdate": true,
  "notifWeeklyReport": false,
  "leadAutoAccept": false,
  "leadPauseOverloaded": true,
  "leadPreferredLocalities": ["Baner", "Kothrud"]
}
```

| Field | Type | Notes |
|-------|------|-------|
| `visitDays` | string[] | Valid values: `Mon` `Tue` `Wed` `Thu` `Fri` `Sat` `Sun` |
| `visitFromTime` | string | `HH:MM` 24-hr format, e.g. `"10:00"` |
| `visitToTime` | string | `HH:MM` 24-hr format, e.g. `"19:00"` |
| `notifNewLead` | boolean | WhatsApp + push on lead dispatch |
| `notifLeadExpiring` | boolean | Alert before 15-min accept window closes |
| `notifEscrowReleased` | boolean | Alert when admin releases escrow |
| `notifListingUpdate` | boolean | Alert on listing approve/reject |
| `notifWeeklyReport` | boolean | Weekly performance email (Monday 9am) |
| `leadAutoAccept` | boolean | Accept all dispatched leads immediately |
| `leadPauseOverloaded` | boolean | Stop new leads when >5 active simultaneously |
| `leadPreferredLocalities` | string[] | Only receive leads for these localities |

**Response `200`:** `{ "success": true, "message": "Settings saved", "data": { ...updated settings } }`

---

### GET /api/partner/bank-account

Partner's linked bank account for escrow payouts.

**Auth:** PARTNER + KYC verified

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "bankName": "HDFC Bank",
    "bankBranch": "HSR Layout Branch, Bangalore",
    "bankAccountNo": "XXXX XXXX 6280",
    "bankIfsc": "HDFC0000634",
    "bankHolderName": "Ravi Kumar",
    "razorpayRouteAccountId": "acc_0qK8WnNRouteX",
    "bankLinkedAt": "2024-01-10T00:00:00.000Z"
  }
}
```

---

### PATCH /api/partner/bank-account

Link or update the partner's bank account for escrow payouts.

**Auth:** PARTNER + KYC verified

**Request Body:**

```json
{
  "bankName": "HDFC Bank",
  "bankBranch": "HSR Layout Branch, Bangalore",
  "bankAccountNo": "50100123456280",
  "bankIfsc": "HDFC0000634",
  "bankHolderName": "Ravi Kumar",
  "razorpayRouteAccountId": "acc_0qK8WnNRouteX"
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `bankName` | Yes | Bank name |
| `bankAccountNo` | Yes | Full account number (5–20 chars) |
| `bankIfsc` | Yes | Must match pattern `XXXX0XXXXXX` |
| `bankHolderName` | Yes | Name as on bank account |
| `bankBranch` | No | Branch name/address |
| `razorpayRouteAccountId` | No | Razorpay Route linked account ID |

**Response `200`:** `{ "success": true, "message": "Bank account updated", "data": { ...bank fields } }`

**Errors:** `400` invalid IFSC format.

---

### GET /api/partner/support-tickets

List the authenticated partner's support tickets (paginated).

**Auth:** PARTNER

**Query Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `status` | string | `OPEN` · `IN_PROGRESS` · `RESOLVED` · `CLOSED` |
| `page` | number | Default: `1` |
| `limit` | number | Default: `20` |

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "data": [
      {
        "id": "64tkt...",
        "ticketNo": "SUP-1042",
        "subject": "Escrow release delayed for D-0038",
        "category": "ESCROW",
        "status": "OPEN",
        "adminReply": null,
        "createdAt": "2024-06-27T00:00:00.000Z"
      }
    ],
    "pagination": { "total": 3, "page": 1, "limit": 20, "totalPages": 1 }
  }
}
```

---

### POST /api/partner/support-tickets

Raise a new support ticket. Auto-generates a `SUP-XXXX` ticket number.

**Auth:** PARTNER

**Request Body:**

```json
{
  "subject": "Escrow release delayed for D-0038",
  "description": "The deal was closed 5 days ago but the escrow has not been released yet. Please investigate.",
  "category": "ESCROW"
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `subject` | Yes | 5–200 characters |
| `description` | Yes | 10–2000 characters |
| `category` | No | `LEAD` · `ESCROW` · `LISTING` · `PAYMENT` · `GENERAL` |

**Response `201`:**

```json
{
  "success": true,
  "message": "Support ticket raised",
  "data": {
    "id": "64tkt...",
    "ticketNo": "SUP-1043",
    "subject": "Escrow release delayed for D-0038",
    "category": "ESCROW",
    "status": "OPEN",
    "createdAt": "2024-07-03T00:00:00.000Z"
  }
}
```

---

### GET /api/partner/support-tickets/:id

Single support ticket detail.

**Auth:** PARTNER (own tickets only)

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "id": "64tkt...",
    "ticketNo": "SUP-1042",
    "subject": "Escrow release delayed for D-0038",
    "description": "The deal was closed 5 days ago but the escrow has not been released yet.",
    "category": "ESCROW",
    "status": "RESOLVED",
    "adminReply": "Escrow has been released. Funds will reflect in your account within T+1.",
    "repliedAt": "2024-06-28T14:00:00.000Z",
    "resolvedAt": "2024-06-28T14:00:00.000Z",
    "createdAt": "2024-06-27T00:00:00.000Z"
  }
}
```

**Errors:** `404` ticket not found or does not belong to you.

---

## 6. Services

### GET /api/services

All active services in the catalog.

**Auth:** Public

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": [
    {
      "id": "64svc...",
      "name": "Maintenance Premium",
      "shortDesc": "Annual home maintenance package",
      "description": "Includes plumbing, electrical, painting.",
      "price": 4999,
      "category": "MAINTENANCE",
      "features": ["Annual AMC", "Priority Support", "24x7 Helpline"],
      "imageUrl": "https://cdn.realtydoor.in/services/maintenance.jpg",
      "sortOrder": 1,
      "isActive": true
    }
  ]
}
```

---

### POST /api/services/create-order

Create a Razorpay order to purchase a service subscription.

**Auth:** USER + phone verified

**Request Body:**

```json
{ "serviceId": "64svc..." }
```

**Response `201`:**

```json
{
  "success": true,
  "message": "Order created",
  "data": {
    "subscription": {
      "id": "64sub...",
      "serviceId": "64svc...",
      "razorpayOrderId": "order_...",
      "paymentStatus": "PENDING",
      "amountPaid": 4999,
      "endDate": "2025-01-15T00:00:00.000Z"
    },
    "razorpayOrder": { "id": "order_...", "amount": 499900, "currency": "INR" },
    "key": "rzp_live_..."
  }
}
```

**Errors:** `404` service not found or inactive.

---

### POST /api/services/verify-payment

Confirm a service subscription payment after Razorpay checkout. Idempotent — safe to call multiple times. Sets `startDate` and `endDate` on success.

**Auth:** USER

**Request Body:**

```json
{
  "razorpayOrderId":   "order_xxx",
  "razorpayPaymentId": "pay_xxx",
  "razorpaySignature": "string"
}
```

**Response `200`:**

```json
{
  "success": true,
  "message": "Payment verified",
  "data": {
    "id": "64sub...",
    "paymentStatus": "SUCCESS",
    "startDate": "2024-01-15T00:00:00.000Z",
    "endDate": "2025-01-15T00:00:00.000Z"
  }
}
```

**Errors:** `400` invalid signature · `404` order not found.

---

## 7. Escrow

### POST /api/escrow/create-order

Create a Razorpay escrow order (token advance). `leadId` must belong to the authenticated buyer — previously any logged-in user could create (and pay into) an order for *any* lead by id, with no ownership check at all. The lead's `status` must also be `SITE_VISIT_DONE` — escrow can't be created earlier in the flow. Only one active escrow (`PAYMENT_PENDING` or `HELD`) per lead — enforced by a real DB-level partial unique index (`scripts/createEscrowLeadUniqueIndex.js`), not just an application check, so two concurrent requests for the same lead can't both create an order.

**Auth:** USER + phone verified

**Request Body:**

```json
{ "leadId": "64lead...", "amount": 50000 }
```

`amount` in ₹.

**Response `201`:**

```json
{
  "success": true,
  "message": "Escrow order created",
  "data": {
    "escrow": {
      "id": "64esc...",
      "leadId": "64lead...",
      "buyerId": "64user...",
      "razorpayOrderId": "order_...",
      "amount": 50000,
      "currency": "INR",
      "status": "PAYMENT_PENDING",
      "createdAt": "2024-01-15T00:00:00.000Z"
    },
    "razorpayOrder": { "id": "order_...", "amount": 5000000, "currency": "INR" }
  }
}
```

`payment.captured` webhook moves status to `HELD`.  
**Errors:** `404` lead not found or not yours · `400` lead isn't `SITE_VISIT_DONE` yet, amount below minimum, or active escrow already exists.

---

### POST /api/escrow/verify-payment

Confirm an escrow payment after Razorpay checkout. Idempotent — safe to call multiple times.

**Auth:** USER

**Request Body:**

```json
{
  "razorpayOrderId":   "order_xxx",
  "razorpayPaymentId": "pay_xxx",
  "razorpaySignature": "string"
}
```

**Response `200`:**

```json
{
  "success": true,
  "message": "Payment verified",
  "data": {
    "id": "64esc...",
    "status": "HELD",
    "razorpayPaymentId": "pay_xxx",
    "heldAt": "2024-01-16T00:00:00.000Z"
  }
}
```

`razorpayOrderId` must belong to the authenticated caller — an order ID that exists but belongs to a different user's escrow 404s the same way a nonexistent one does.

**Errors:** `400` invalid signature · `404` order not found or not yours.

---

### GET /api/escrow/:id

Fetch a single escrow's current status — for polling right after a Checkout attempt, or refreshing later, without needing the full leads list. Scoped to the authenticated buyer; another user's escrow (or a nonexistent id) both return a plain `404`, never a `403` — so this endpoint can't be used to probe whether a given escrow id exists.

**Auth:** USER (must be the escrow's own buyer)

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "id": "64esc...", "leadId": "64lead...", "razorpayOrderId": "order_xxx",
    "amount": 50000, "currency": "INR", "status": "HELD",
    "heldAt": "2024-01-16T00:00:00.000Z", "releasedAt": null, "refundedAt": null, "failedAt": null,
    "createdAt": "2024-01-15T12:00:00.000Z"
  }
}
```

**Errors:** `404` not found, or not owned by the requesting user.

---

## 8. Notifications

All `/api/notifications/*` require `authenticate` + `requireUser`.

### GET /api/notifications

Paginated notifications for the authenticated user.

**Auth:** USER

**Query Parameters:** `page`, `limit`

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "data": [
      {
        "id": "64notif...",
        "title": "Listing Approved!",
        "message": "Your listing is now live.",
        "type": "PROPERTY_APPROVED",
        "isRead": false,
        "linkUrl": "/properties/...",
        "createdAt": "2024-01-15T10:00:00.000Z"
      }
    ],
    "pagination": { "total": 10, "page": 1, "limit": 20, "totalPages": 1, "hasNext": false, "hasPrev": false }
  }
}
```

---

### GET /api/notifications/unread-count

Count of unread notifications for the authenticated user — for a header badge, without paginating the full list.

**Auth:** USER

**Response `200`:** `{ "success": true, "message": "Success", "data": { "count": 3 } }`

---

### PATCH /api/notifications/:id/read

Mark a notification as read. Sets both `isRead: true` and `readAt` to the current time.

**Auth:** USER

**Response `200`:** `{ "success": true, "message": "Marked as read", "data": null }`

---

### PATCH /api/notifications/read-all

Mark all unread notifications as read. Sets both `isRead: true` and `readAt` to the current time on every affected row.

**Auth:** USER

**Response `200`:** `{ "success": true, "message": "All marked as read", "data": null }`

---

## 9. Blog / CMS

### GET /api/blog

Published content blocks (paginated).

**Auth:** Public

**Query Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `type` | string | `BLOG_POST` · `FAQ` · `BANNER` · `ANNOUNCEMENT` · `PAGE` |
| `page` | number | Default: `1` |
| `limit` | number | Default: `20` |

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "data": [
      {
        "id": "64cms...",
        "type": "BLOG",
        "title": "Top 5 areas in Pune to buy in 2024",
        "slug": "top-5-areas-pune-2024",
        "content": "<p>Full article content...</p>",
        "excerpt": "A quick guide to the best neighbourhoods.",
        "imageUrl": "https://cdn.realtydoor.in/blog/pune-areas.jpg",
        "author": "Rajdeep",
        "tags": ["Pune", "Investment", "2024"],
        "isPublished": true,
        "publishedAt": "2024-01-10T00:00:00.000Z",
        "seoTitle": "Top 5 Pune Areas 2024 | RealtyDoor",
        "seoDesc": "Discover the best areas in Pune."
      }
    ],
    "pagination": { "total": 25, "page": 1, "limit": 20, "totalPages": 2, "hasNext": true, "hasPrev": false }
  }
}
```

---

### GET /api/blog/:slug

Single published content block by slug.

**Auth:** Public

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "id": "64cms...",
    "type": "BLOG",
    "title": "Top 5 areas in Pune to buy in 2024",
    "slug": "top-5-areas-pune-2024",
    "content": "<p>Full article content...</p>",
    "excerpt": "A quick guide to the best neighbourhoods.",
    "imageUrl": "https://cdn.realtydoor.in/blog/pune-areas.jpg",
    "author": "Rajdeep",
    "tags": ["Pune", "Investment"],
    "isPublished": true,
    "publishedAt": "2024-01-10T00:00:00.000Z",
    "seoTitle": "Top 5 Pune Areas 2024 | RealtyDoor",
    "seoDesc": "Discover the best areas in Pune.",
    "createdAt": "2024-01-05T00:00:00.000Z",
    "updatedAt": "2024-01-10T00:00:00.000Z"
  }
}
```

**Errors:** `404` if not found or not published.

---

## 10. FAQ

Dedicated read-only endpoints over the same `ContentBlock` (`type: 'FAQ'`) records exposed by `GET /api/blog`, but with `content` pre-parsed to JSON instead of a raw string — clients don't need to `JSON.parse()` it themselves.

### GET /api/faqs

All published FAQ content blocks.

**Auth:** Public

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": [
    {
      "id": "64cms...",
      "type": "FAQ",
      "title": "Bengaluru Plot Buying FAQs",
      "slug": "bengaluru-plot-buying-faqs",
      "content": {
        "categories": [
          {
            "category": "Legal & Document Verification",
            "faqs": [
              {
                "question": "What are the 3 documents every plot buyer MUST check?",
                "answerHtml": "<p>...</p><ul><li>...</li></ul>",
                "relatedBlogSlug": "critical-plot-documents-checklist-bangalore"
              }
            ]
          }
        ]
      },
      "excerpt": "Categorized FAQs for Bengaluru plot buyers...",
      "tags": ["FAQ", "Bengaluru", "Plots", "Legal", "NRI"],
      "isPublished": true,
      "publishedAt": "2026-09-13T00:00:00.000Z"
    }
  ]
}
```

The shape of `content` is whatever JSON the FAQ block was created with — the flat `[{q, a}]` list (legacy `faq` block) and the categorized `{categories: [{category, faqs: [{question, answerHtml, relatedBlogSlug}]}]}` shape (e.g. `bengaluru-plot-buying-faqs`) both come back parsed as-is.

---

### GET /api/faqs/:slug

Single FAQ content block by slug.

**Auth:** Public

**Response `200`:** Same shape as one entry of the `GET /api/faqs` array.

**Errors:** `404` if not found, not published, or not type `FAQ`.

---

## 11. Contact

### POST /api/contact

Submit a contact form (authenticated or public).

**Auth:** Optional

**Request Body:**

```json
{
  "name": "Priya Sharma",
  "email": "priya@example.com",
  "phone": "+919876543210",
  "subject": "Inquiry about listing my property",
  "message": "I would like to know more about listing my property on RealtyDoor."
}
```

`phone` and `email` are both optional (most mobile callback-form submitters don't type an email). `name` min 2. `subject` min 3. `message` min 10 chars.

**Response `201`:**

```json
{
  "success": true,
  "message": "Message received. We will get back to you shortly.",
  "data": { "id": "64msg..." }
}
```

---

### POST /api/service-requests

Interest from the public Services page or a "request a callback" banner — a distinct lead type from `/api/contact`, tagged with which service(s) and where it came from, so it can be reported on per-service.

**Auth:** Public

**Request Body:**

```json
{
  "name": "Priya Sharma",
  "phone": "+919876543210",
  "email": "priya@example.com",
  "serviceIds": ["64svc1...", "64svc2..."],
  "note": "Interested in both services",
  "source": "services-page"
}
```

`email` and `note` are optional. `serviceIds` requires at least one valid `Service` ID.

**Response `201`:**

```json
{ "success": true, "message": "We will get back to you shortly.", "data": { "id": "64svcreq..." } }
```

**Errors:** `400` no `serviceIds` provided, or one is not a valid ObjectId.

---

## 12. NRI Leads

Inbound home-buying interest capture from the NRI landing page. Not tied to a specific property listing or an authenticated user — a standalone lead-gen form submission.

### POST /api/nri-leads

**Auth:** Public (rate-limited)

**Request Body:**

```json
{
  "name": "Suresh Mehta",
  "phone": "+919876543210",
  "area": "Whitefield",
  "homeType": "Apartment",
  "bedrooms": "3",
  "timeline": "3-6 months",
  "budget": "80L-1Cr"
}
```

All fields are required strings. `phone` should be sent pre-formatted with country code (e.g. `+91XXXXXXXXXX`) — the API does not add or infer a country code.

**Response `201`:**

```json
{
  "success": true,
  "message": "We will get back to you shortly.",
  "data": { "id": "64nri..." }
}
```

---

### GET /api/admin/nri-leads

All NRI leads (paginated).

**Auth:** ADMIN

**Query Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `isRead` | boolean | Filter unread (`false`) or read (`true`) |
| `page` | number | Default: `1` |
| `limit` | number | Default: `20` |

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "data": [
      {
        "id": "64nri...",
        "name": "Suresh Mehta",
        "phone": "+919876543210",
        "area": "Whitefield",
        "homeType": "Apartment",
        "bedrooms": "3",
        "timeline": "3-6 months",
        "budget": "80L-1Cr",
        "isRead": false,
        "createdAt": "2026-09-13T00:00:00.000Z"
      }
    ],
    "pagination": { "total": 12, "page": 1, "limit": 20, "totalPages": 1, "hasNext": false, "hasPrev": false }
  }
}
```

---

### PATCH /api/admin/nri-leads/:id/read

Mark an NRI lead as read.

**Auth:** ADMIN

**Request Body:** _(none)_

**Response `200`:** `{ "success": true, "message": "Marked as read", "data": { "id": "...", "isRead": true, ... } }`

**Errors:** `404` NRI lead not found.

---

## 13. Locality Insights

### GET /api/locality-insights/insight

Public point-lookup for a city + locality pair. Both params are required. Returns the full `LocalityInsight` record (core price panel + all locality market-intelligence fields, if curated) — used by the property-detail "Locality Insights" panel.

**Auth:** Public

**Query Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `city` | string | Yes | e.g. `Pune` |
| `locality` | string | Yes | e.g. `Baner` |

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "id": "64loc...",
    "city": "Pune",
    "locality": "Baner",
    "avgPricePerSqftPaise": 2500000,
    "minPricePerSqftPaise": 2200000,
    "maxPricePerSqftPaise": 2800000,
    "avgRentPerMonthPaise": null,
    "priceChangeLastMonthPct": 8.5,
    "nearbyInfra": ["Metro", "Highway"],
    "subtitle": "Prime residential locality...",
    "dataAsOfDate": "2024-01-15T00:00:00.000Z",
    "updatedAt": "2024-01-15T00:00:00.000Z"
  }
}
```

Money fields are in **paise** (₹1 = 100 paise). `dataAsOfDate`/`updatedAt` reflect the last admin refresh (monthly cadence).

**Errors:** `400` if either query param is missing · `404` no data for that city+locality.

---

### GET /api/locality-insights/page

Public — full locality market-intelligence landing page. Merges the admin-curated `LocalityInsight` record with **live** stats computed at request time from the `Property` collection (`inventoryLive`, `topVerifiedPicks`) — never stored, always fresh.

**Auth:** Public

**Query Parameters:** same as `/insight` — `city`, `locality` (both required).

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "city": "Bengaluru",
    "locality": "Whitefield",
    "subtitle": "India's most dynamic IT corridor",
    "snapshot": {
      "localityScore": 8.6,
      "marketStage": "Mature Growth",
      "rentalDemand": "High",
      "infrastructureStrength": "Strong",
      "bestFor": ["IT Professionals", "Families", "Investors", "Rental Income"]
    },
    "stats": {
      "avgPricePerSqftPaise": 549000,
      "minPricePerSqftPaise": 480000,
      "maxPricePerSqftPaise": 620000,
      "priceChangeLastMonthPct": 8.4,
      "medianPricePaise": 1080000000,
      "medianPricePropertyType": "3BHK",
      "avgRentYieldPct": 3.2,
      "inventoryLive": { "total": 542, "addedThisWeek": 38 }
    },
    "priceTrends": {
      "historical": [{ "period": "Aug 2023", "price": 4100 }],
      "growth": { "oneYear": 8.4, "threeYear": 17.2, "fiveYear": 31.8 }
    },
    "propertyMix": [{ "type": "3BHK", "percentage": 42, "count": 228 }],
    "microMarkets": [{ "name": "ITPL", "avgPricePerSqft": 6200, "rentalDemand": "Very High" }],
    "keyInfrastructure": [{ "name": "ITPL", "category": "Tech Park", "distance": "5 min drive" }],
    "connectivity": {
      "metro": [{ "name": "Whitefield Metro Station", "line": "Purple Line", "status": "Operational" }],
      "airports": [{ "name": "Kempegowda International Airport", "code": "BLR", "distance": "42 km" }],
      "majorRoads": ["Whitefield Main Road"],
      "travelTimes": [{ "destination": "ITPL", "time": "15 min" }]
    },
    "infrastructureProjects": [{ "name": "Whitefield Metro Phase 2", "category": "Metro", "status": "Operational", "year": 2026, "impact": "High" }],
    "prosAndCons": { "pros": ["Strong IT employment base"], "cons": ["Peak-hour traffic"] },
    "investmentScore": { "overall": 8.4, "factors": { "priceGrowth": 8.8, "rentalDemand": 9.1 } },
    "buyVsRent": { "buyerDemandPct": 76, "sellerDemandPct": 24, "avgRentByBhk": { "2BHK": 32000, "3BHK": 48000 }, "rentalYieldPct": 3.2 },
    "faqs": [{ "question": "Is Whitefield good for investment?", "answer": "Yes." }],
    "topVerifiedPicks": [
      {
        "badge": "NEW",
        "bedroomConfig": "3BHK",
        "project": "Prestige Falcon City",
        "locality": "Whitefield",
        "price": 12800000,
        "area": 1800,
        "areaUnit": "sqft",
        "facing": "East",
        "floorNumber": 4,
        "totalFloors": 12,
        "slug": "prestige-falcon-city-..."
      }
    ],
    "dataAsOfDate": "2026-08-24T00:00:00.000Z",
    "updatedAt": "2026-08-24T00:00:00.000Z"
  }
}
```

Any curated section with no admin-entered data returns `null` (or `[]`/`{total:0,addedThisWeek:0}` for the live sections). `badge` on a pick is `"PREMIUM"` if the listing is admin-featured, `"NEW"` if created within the last 30 days, else `null`. `topVerifiedPicks` only includes `APPROVED` + `isVerified` listings, newest/featured first, capped at 6.

**Errors:** `400` if either query param is missing · `404` no curated locality data found for that city+locality (create one via `POST /api/locality-insights` first).

---

### GET /api/locality-insights/report

Public — downloadable PDF report built from the same data as `/page` (structured text, no charts/AI). Streamed as `Content-Type: application/pdf` with `Content-Disposition: attachment`.

**Auth:** Public (rate-limited at the search tier — 30 req/min/IP — since PDF generation is heavier than a plain JSON read)

**Query Parameters:** same as `/page` — `city`, `locality` (both required).

**Response `200`:** binary PDF body.

**Errors:** `400` if either query param is missing · `404` no curated locality data found for that city+locality.

---

### GET /api/locality-insights/cities-summary

Aggregated city-level stats for all cities that have locality insight data. Used by the homepage city cards.

**Auth:** Public

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": [
    {
      "city": "Pune",
      "localityCount": 12,
      "avgPricePerSqft": 22500,
      "trendingCount": 4
    },
    {
      "city": "Mumbai",
      "localityCount": 8,
      "avgPricePerSqft": 45000,
      "trendingCount": 3
    }
  ]
}
```

---

### GET /api/locality-insights

List all locality records (paginated). Optional city filter.

**Auth:** ADMIN

**Query Parameters:** `city`, `page`, `limit`

**Response `200`:** Paginated list of locality records.

---

### GET /api/locality-insights/:id

Single locality record by ID.

**Auth:** ADMIN

**Response `200`:** Full locality record · `404` if not found.

---

### POST /api/locality-insights

Create or update (upsert by city + locality). `dataAsOfDate` defaults to now if omitted.

**Auth:** ADMIN

**Request Body:**

```json
{
  "city":                 "Pune",
  "locality":             "Baner",
  "avgPricePerSqftPaise": 2500000,
  "minPricePerSqftPaise": 2200000,
  "maxPricePerSqftPaise": 2800000,
  "priceChangeLastMonthPct": 8.5,
  "nearbyInfra":          ["Metro", "Highway"],

  "subtitle":               "Prime residential locality...",
  "localityScore":          8.6,
  "marketStage":            "Mature Growth",
  "rentalDemand":           "High",
  "infrastructureStrength": "Strong",
  "bestFor":                ["IT Professionals", "Families"],
  "medianPricePaise":       10800000000,
  "medianPricePropertyType": "3BHK",
  "avgRentYieldPct":        3.2,

  "priceTrends":            { "historical": [{ "period": "Aug 2023", "price": 4100 }], "growth": { "oneYear": 8.4 } },
  "propertyMix":            [{ "type": "3BHK", "percentage": 42, "count": 228 }],
  "microMarkets":           [{ "name": "ITPL", "avgPricePerSqft": 6200, "rentalDemand": "Very High" }],
  "keyInfrastructure":      [{ "name": "ITPL", "category": "Tech Park", "distance": "5 min drive" }],
  "connectivity":           { "metro": [{ "name": "Whitefield Metro Station", "line": "Purple Line" }], "majorRoads": ["ITPL Main Road"] },
  "infrastructureProjects": [{ "name": "Metro Phase 2", "status": "Operational", "year": 2026, "impact": "High" }],
  "prosAndCons":            { "pros": ["Strong IT employment base"], "cons": ["Peak-hour traffic"] },
  "investmentScore":        { "overall": 8.4, "factors": { "priceGrowth": 8.8 } },
  "buyVsRent":              { "buyerDemandPct": 76, "sellerDemandPct": 24, "avgRentByBhk": { "3BHK": 48000 }, "rentalYieldPct": 3.2 },
  "faqs":                   [{ "question": "Is this locality good for investment?", "answer": "Yes." }]
}
```

`city`, `locality`, and `avgPricePerSqftPaise` are required. Every market-intelligence field (`subtitle` through `faqs`) is optional and independently updatable — send only the fields you're refreshing.

**Response `201`:** `{ "success": true, "message": "Locality insight saved", "data": { ... } }`

---

### DELETE /api/locality-insights/:id

**Auth:** ADMIN

**Response `200`:** `{ "success": true, "message": "Locality insight deleted", "data": null }`

---

## 14. Platform Config (Public)

### GET /api/config/public

Returns all platform configuration keys that have `isPublic: true`. No authentication required. Used by the frontend to read non-sensitive settings (e.g. feature flags, RERA state info, support phone numbers).

**Auth:** None

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "support_phone": "+919876543210",
    "support_email": "support@realtydoor.in",
    "rera_disclaimer": "RERA registrations vary by state. Verify before investing.",
    "platform_name": "RealtyDoor",
    "telecaller_phone": "+919844412345"
  }
}
```

Returns a flat key → value object. Only keys with `isPublic: true` appear here. `telecaller_phone` is the shared number the frontend's "Contact agent" action should dial — the buyer is never given the assigned partner's own phone number (see `PATCH /api/admin/leads/:id/assign` and `GET /api/user/leads`).

---

## 15. Webhooks

### POST /api/webhooks/razorpay

Handles `payment.captured` and `payment.failed` from Razorpay.

**Auth:** Razorpay HMAC signature (`x-razorpay-signature` header)

**`payment.captured`:**
- Escrow → status moves to `HELD`
- Subscription → status moves to `SUCCESS`, creates service ticket, sends notification + email

**`payment.failed`:**
- Escrow → status moves to `FAILED`
- Subscription → status moves to `FAILED`

**Response `200`:** `{ "status": "ok" }`

---

### POST /api/webhooks/wati

Inbound WhatsApp reply handler. Buyer replies to site-visit feedback message; this webhook maps their keyword to a lead feedback status.

**Auth:** Optional `x-wati-token` header (set `WATI_WEBHOOK_TOKEN` env var to enable)

**Keyword → Status mapping:**

| Keyword | Status set on lead |
|---|---|
| `1`, `yes`, `interested` | `VERIFIED_CLOSED` |
| `2`, `no`, `not interested` | `VERIFIED_DROPPED` |
| `3`, `maybe`, `still deciding` | `STILL_DECIDING` |

**Response `200`:** `{ "status": "ok" }`

---

### POST /api/webhooks/clerk

Handles `user.created`, `user.updated`, `user.deleted` from Clerk.

**Auth:** Svix signature (`svix-id`, `svix-timestamp`, `svix-signature` headers)

**Response `200`:** `{ "status": "ok" }`

---

## 16. Admin

All `/api/admin/*` routes require `authenticate` + `requireAdmin`.

### GET /api/admin/leads

All leads (paginated). Filter by status and partner.

**Auth:** ADMIN

**Query Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `status` | string | `UNASSIGNED` · `ASSIGNED` · `SITE_VISIT_SCHEDULED` · `SITE_VISIT_DONE` · `CLOSED` · `DROPPED` |
| `partnerId` | string | Filter by assigned partner ID |
| `search` | string | Case-insensitive match against lead `refCode`, `buyerName`, or `buyerEmail` |
| `page` | number | Default: `1` |
| `limit` | number | Default: `20` |

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "data": [
      {
        "id": "64lead...",
        "refCode": "RD-L-000123",
        "buyerName": "Suresh Mehta",
        "buyerEmail": "suresh@example.com",
        "buyerPhone": "+919876543210",
        "status": "ASSIGNED",
        "isOtpVerified": false,
        "createdAt": "2024-01-15T10:00:00.000Z",
        "property": { "title": "3 BHK Flat in Baner", "slug": "...", "city": "Pune" },
        "assignedPartner": { "name": "Rajdeep Kumar", "email": "rajdeep@example.com" },
        "buyer": {
          "id": "64user...", "refCode": "RD-U-000045", "name": "Suresh Mehta",
          "email": "suresh@example.com", "phone": "+919876543210",
          "phoneVerified": true, "phoneVerifiedAt": "2024-01-10T08:00:00.000Z",
          "createdAt": "2024-01-10T08:00:00.000Z"
        },
        "inquiryCount": 3
      }
    ],
    "pagination": { "total": 50, "page": 1, "limit": 20, "totalPages": 3, "hasNext": true, "hasPrev": false }
  }
}
```

`buyer` (full identity, unlike every buyer- or partner-facing endpoint) and `inquiryCount` (total leads this buyer has ever submitted, across all statuses — a quick abuse signal against the per-buyer limits on `POST /api/leads`) are admin-only additions. `buyer` is `null` for legacy leads with no linked account (see `scripts/backfillLeadBuyerId.js`).

---

### GET /api/admin/leads/:id

Full lead detail including property, assigned partner, buyer identity, and escrow transactions.

**Auth:** ADMIN

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "id": "64lead...",
    "refCode": "RD-L-000123",
    "buyerName": "Suresh Mehta",
    "buyerPhone": "+919876543210",
    "status": "CLOSED",
    "isOtpVerified": true,
    "siteVisitScheduledAt": "2024-01-20T10:00:00.000Z",
    "visitNotes": "Buyer very interested.",
    "visitPhotoUrls": ["https://..."],
    "closureDocumentUrls": ["https://..."],
    "property": { "title": "3 BHK Flat in Baner", "city": "Pune", ... },
    "assignedPartner": { "name": "Rajdeep Kumar", "companyName": "RealtyPro Solutions" },
    "buyer": {
      "id": "64user...", "refCode": "RD-U-000045", "name": "Suresh Mehta",
      "email": "suresh@example.com", "phone": "+919876543210",
      "phoneVerified": true, "phoneVerifiedAt": "2024-01-10T08:00:00.000Z",
      "createdAt": "2024-01-10T08:00:00.000Z"
    },
    "inquiryCount": 3,
    "escrowTransactions": [
      { "id": "64esc...", "amount": 50000, "status": "HELD", "heldAt": "..." }
    ],
    "createdAt": "2024-01-15T10:00:00.000Z"
  }
}
```

**Errors:** `404` lead not found.

---

### PATCH /api/admin/leads/:id/approve-drop

Approve a partner's drop request. Moves lead status to `DROPPED`.

**Auth:** ADMIN

**Request Body:** _(none)_

**Response `200`:** `{ "success": true, "message": "Drop approved", "data": { "id": "...", "status": "DROPPED" } }`

---

### PATCH /api/admin/leads/:id/reject-drop

Reject a partner's drop request. Reverts lead back to `ASSIGNED`.

**Auth:** ADMIN

**Request Body:** _(none)_

**Response `200`:** `{ "success": true, "message": "Drop rejected", "data": { "id": "...", "status": "ASSIGNED" } }`

---

### POST /api/admin/leads

Admin logs a lead that arrived off-platform (phone call, walk-in, referral).

**Auth:** ADMIN

**Request Body:**

```json
{
  "buyerName": "Phone Enquiry",
  "buyerPhone": "9876543210",
  "buyerEmail": "caller@example.com",
  "source": "PHONE",
  "propertyId": "64abc...",
  "propertyInterest": "3BHK in Whitefield, not listed yet",
  "budget": "1-1.2Cr",
  "note": "Called the office, wants a callback this week.",
  "partnerId": "64partner..."
}
```

`source` is one of `PHONE` · `WALK_IN` · `REFERRAL` · `EMAIL` · `OTHER`. **Either `propertyId` or `propertyInterest` is required** — `propertyId` for a live listing, `propertyInterest` as free text when the property isn't on the platform (in which case `propertyId` comes back `null`, so treat `property` as nullable in responses). `buyerEmail`, `budget`, `note` and `partnerId` are optional.

Passing `partnerId` assigns the lead immediately (`status: ASSIGNED`) and notifies that partner; the partner must be KYC-verified, same gate as `/assign`. Without it the lead lands as `UNASSIGNED`. Repeat buyers are linked via `relatedLeadId` exactly as in `POST /api/leads/partner`. `buyerId` stays `null` — nobody authenticated. Writes an audit log.

**Response `201`:** the created lead.

**Errors:** `400` neither `propertyId` nor `propertyInterest` given, or partner not found / not KYC verified · `404` property not found.

---

### PATCH /api/admin/leads/:id/confirm

Admin vets a partner-added lead (one in `AWAITING_ADMIN`), moving it into the normal pipeline.

**Auth:** ADMIN

**Request Body:** `{ "partnerId": "64partner..." }` — optional. Omit it to confirm into `UNASSIGNED` (the assignment queue); pass one to confirm *and* assign in a single step. Passing a partner other than the one who added the lead is the **reassign** case.

**Response `200`:** the updated lead. Notifies the assigned partner, or the partner who added it when left unassigned. Writes an audit log.

**Errors:** `400` the lead isn't `AWAITING_ADMIN` (the message names its actual status), or partner not found / not KYC verified · `404` lead not found.

---

### PATCH /api/admin/leads/:id/reject

Admin rejects a partner-added lead outright. Sets `status: DROPPED` with the reason, and notifies the partner who added it.

**Auth:** ADMIN

**Request Body:** `{ "reason": "Buyer not reachable on the given number" }` (min 5 chars)

**Errors:** `400` the lead isn't `AWAITING_ADMIN` · `404` lead not found.

---

### PATCH /api/admin/leads/:id/assign

Assign lead to a KYC-verified partner.

**Auth:** ADMIN

**Request Body:** `{ "partnerId": "64partner..." }`

**Response `200`:**

```json
{
  "success": true,
  "message": "Lead assigned",
  "data": { "id": "64lead...", "status": "ASSIGNED", "assignedPartnerId": "64partner...", "assignedAt": "..." }
}
```

Also sends the buyer an in-app `LEAD_ASSIGNED` notification (`linkUrl: /user/inquiries/:leadId`) naming the partner by `companyName`/`name` only — the partner's phone is never included, in the message or anywhere else the buyer can see. The buyer's own lead detail (`GET /api/user/leads/:id`) likewise never exposes `assignedPartner.phone`; the frontend's "Contact agent" action should dial the shared number from `GET /api/config/public`'s `telecaller_phone` instead.

**Errors:** `404` lead not found · `400` partner not found or not KYC verified.

---

### GET /api/admin/properties

Properties filtered by status (paginated).

**Auth:** ADMIN

**Query Parameters:** `page`, `limit`, `status` (`PENDING_APPROVAL` · `APPROVED` · `REJECTED` · `ARCHIVED` — defaults to `PENDING_APPROVAL` when omitted)

Each of the four status tabs on the admin Property Queue page now returns rows that actually match that status — previously `status` was ignored entirely and every tab showed pending-only rows.

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "data": [
      {
        "id": "64prop...",
        "title": "3 BHK Flat in Baner",
        "publishStatus": "PENDING_APPROVAL",
        "city": "Pune",
        "createdAt": "2024-01-10T00:00:00.000Z",
        "partner": { "name": "Rajdeep Kumar", "email": "rajdeep@example.com", "companyName": "RealtyPro Solutions" }
      }
    ],
    "pagination": { "total": 10, "page": 1, "limit": 20, "totalPages": 1, "hasNext": false, "hasPrev": false }
  }
}
```

---

### PATCH /api/admin/properties/:id/approve

Approve a pending listing. Notifies partner + sends email.

**Auth:** ADMIN

**Request Body:** _(none)_

**Response `200`:**

```json
{ "success": true, "message": "Property approved", "data": { "id": "...", "publishStatus": "APPROVED", "rejectionNote": null } }
```

---

### PATCH /api/admin/properties/:id/reject

Reject a pending listing.

**Auth:** ADMIN

**Request Body:** `{ "note": "Please provide RERA number and clearer images." }`

**Response `200`:**

```json
{ "success": true, "message": "Property rejected", "data": { "id": "...", "publishStatus": "REJECTED", "rejectionNote": "..." } }
```

---

### PATCH /api/admin/properties/:id

Admin edit of any property. Protected fields `partnerId` and `slug` are silently stripped. Creates per-field `PropertyEditLog` entries.

**Auth:** ADMIN

**Request Body:** Any property fields except `partnerId`, `slug`.

```json
{ "price": 9000000, "isVerified": true, "reraNumber": "P52100099999" }
```

**Response `200`:** `{ "success": true, "message": "Property updated", "data": { ... } }`

---

### GET /api/admin/properties/:id

Full property detail by ID (any publishStatus).

**Auth:** ADMIN

**Response `200`:** Full property record including partner info and edit logs.

**Errors:** `404` property not found.

---

## Listing change requests (docs 4.8 / 4.9)

A partner's edit to an **already-live** listing is held here instead of being
written to the property. See `PATCH /api/properties/:id` for the submitting
side. The live listing is never modified until one of these endpoints applies
the diff.

All four routes are registered **above** `/admin/properties/:id`, so
`change-requests` is never parsed as a property id.

---

### GET /api/admin/properties/change-requests

The review queue.

**Auth:** ADMIN

**Query:** `status` — `PENDING` (default), `APPROVED`, `REJECTED`,
`SUPERSEDED`, or `ALL` · `propertyId` · `partnerId` · `page` · `limit`

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "data": [
      {
        "id": "6a44b1...",
        "status": "PENDING",
        "fieldCount": 1,
        "hasHighImpact": true,
        "fields": ["price"],
        "property": { "id": "...", "title": "2 BHK Flat for Rent in Kothrud", "slug": "...", "city": "Pune", "locality": "Kothrud", "publishStatus": "APPROVED" },
        "partner": { "id": "...", "name": "Rahul Sharma", "companyName": "Sharma Realty" },
        "reviewNote": null,
        "reviewedAt": null,
        "createdAt": "2026-10-04T10:27:25.000Z"
      }
    ],
    "total": 1, "page": 1, "limit": 20, "totalPages": 1
  }
}
```

`hasHighImpact` and `fields` are on the list row so the queue can sort the
risky ones up without fetching every diff.

**Errors:** `400` unrecognised `status`.

---

### GET /api/admin/properties/change-requests/:id

The full diff, plus conflict detection.

**Auth:** ADMIN

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "id": "6a44b1...",
    "status": "PENDING",
    "fieldCount": 1,
    "changes": [
      { "field": "price", "before": null, "after": 1900000, "impact": "HIGH" }
    ],
    "conflicts": [
      { "field": "price", "expectedBefore": null, "actualCurrent": 1000001 }
    ],
    "hasConflicts": true,
    "highImpactFields": ["price", "monthlyRent", "carpetArea", "..."],
    "property": { "...": "the full current listing" },
    "partner": { "id": "...", "name": "...", "companyName": "...", "phone": "..." },
    "reviewNote": null, "reviewedByAdminId": null, "reviewedAt": null,
    "createdAt": "2026-10-04T10:27:25.000Z"
  }
}
```

**`conflicts` is the field to check before approving.** A diff is recorded
against the listing as it stood at submission time. If an admin edit — or an
earlier approved request — has since moved the same field, approving would
silently overwrite that later change. Each conflict names the value the request
expected to find (`expectedBefore`) against what is actually there now
(`actualCurrent`).

**Errors:** `404` not found.

---

### PATCH /api/admin/properties/change-requests/:id/approve

Applies the diff to the live listing.

**Auth:** ADMIN

**Request Body:**

```json
{ "note": "Verified with partner over call", "force": false }
```

| Field | Required | Notes |
| --- | --- | --- |
| `note` | only when `force` is true | Max 500 chars. Recorded on every resulting `PropertyEditLog` row. |
| `force` | no | Apply despite conflicts. Requires a `note` of at least 5 characters. |

**Response `200`:**

```json
{
  "success": true,
  "message": "Applied 1 change(s), overwriting later edits to price",
  "data": {
    "property": { "...": "the updated listing" },
    "appliedFields": ["price"],
    "forcedOverConflicts": ["price"]
  }
}
```

On success this writes one `PropertyEditLog` row per field, **attributed to the
partner** (`editedByName: "Partner (approved by admin)"`) rather than to the
approving admin — the edit log answers "who changed this listing", and the
approving admin is named in `editNote` and in their own audit-log entry.

Fields on the forbidden list (`publishStatus`, `isVerified`, `partnerId`,
`slug`, `id`) are dropped at approval time, not merely at submission time, so a
request stored before that list grew cannot slip one through.

**Errors:**
- `400` the request is already `APPROVED` / `REJECTED` / `SUPERSEDED`, or has no
  applicable fields left after the forbidden filter
- `400` `force: true` without a `note` of at least 5 characters
- `409` the listing changed after submission and `force` was not set — the
  message names the conflicting fields
- `404` not found

---

### PATCH /api/admin/properties/change-requests/:id/reject

**Auth:** ADMIN

**Request Body:**

```json
{ "note": "Price is above the mandate ceiling for this unit" }
```

`note` is required, 5–500 characters: the partner is shown it verbatim as the
reason, so a blank rejection is refused here rather than sent as an empty
notification.

**Response `200`:** the updated change request, `status: "REJECTED"`.

**Errors:** `400` not `PENDING`, or `note` too short · `404` not found.

---

### GET /api/admin/properties/edit-logs

Override history across **every** property (docs 4.12 / 4.13).
`PropertyEditLog` already existed but was only readable as the last 10 rows
nested inside a single property; this is the paginated, filterable list.

**Auth:** ADMIN

**Query:** `propertyId` · `editedBy` (user id) · `field` · `impact`
(`HIGH` or `NORMAL`) · `from` / `to` (ISO dates, inclusive) · `page` · `limit`

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "data": [
      {
        "id": "...",
        "property": { "id": "...", "title": "...", "slug": "...", "city": "Pune", "publishStatus": "APPROVED" },
        "editedBy": "6a44a67...",
        "editedByName": "Partner (approved by admin)",
        "field": "price",
        "impact": "HIGH",
        "before": null,
        "after": 1900000,
        "note": "Change request 6a44b1... approved by Admin User",
        "editedAt": "2026-10-04T10:27:26.000Z"
      }
    ],
    "total": 1, "page": 1, "limit": 20, "totalPages": 1,
    "highImpactFields": ["price", "monthlyRent", "carpetArea", "..."]
  }
}
```

**On `impact`:** docs 4.13 asks to filter by impact, but impact is not a stored
concept anywhere in this schema. Rather than invent a column, it is derived
from *which field changed*: the fields in `highImpactFields` are the ones that
change what a buyer is being sold or where it is; everything else is
presentational. That list is the whole definition, and it is returned in the
response so a caller can see exactly what `HIGH` means instead of guessing.
`impact=HIGH` and `impact=NORMAL` partition the unfiltered set exactly.

---


---

### GET /api/admin/kyc

Partners with `PENDING_REVIEW` KYC (paginated).

**Auth:** ADMIN

**Query Parameters:** `page`, `limit`

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "data": [
      {
        "id": "64user...",
        "name": "Rajdeep Kumar",
        "email": "rajdeep@example.com",
        "companyName": "RealtyPro Solutions",
        "partnerSubType": "AGENT",
        "kycDocumentUrls": ["https://cdn.realtydoor.in/kyc/pan.pdf"],
        "createdAt": "2024-01-01T00:00:00.000Z"
      }
    ],
    "pagination": { "total": 5, "page": 1, "limit": 20, "totalPages": 1, "hasNext": false, "hasPrev": false }
  }
}
```

---

### PATCH /api/admin/kyc/:userId/verify

Approve or reject partner KYC.

**Auth:** ADMIN

**Request Body:**

```json
{ "action": "APPROVE", "note": "Documents verified." }
```

`action`: `"APPROVE"` or `"REJECT"`. `note` required when rejecting.

**Response `200`:** `{ "success": true, "message": "KYC approved", "data": null }`

---

### GET /api/admin/kyc/:userId

Full KYC record for a specific partner including uploaded document URLs.

**Auth:** ADMIN

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "id": "64user...",
    "name": "Rajdeep Kumar",
    "email": "rajdeep@example.com",
    "kycStatus": "PENDING_REVIEW",
    "kycDocumentUrls": ["https://cdn.realtydoor.in/kyc/pan.pdf", "https://cdn.realtydoor.in/kyc/aadhar.pdf"],
    "kycRejectionNote": null,
    "kycVerifiedAt": null,
    "partnerSubType": "AGENT",
    "companyName": "RealtyPro Solutions",
    "createdAt": "2024-01-01T00:00:00.000Z"
  }
}
```

**Errors:** `404` user not found.

---

### GET /api/admin/revenue

Platform revenue summary (MTD = month-to-date).

**Auth:** ADMIN

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "escrowHeld":        { "amount": 250000, "count": 5 },
    "escrowReleasedMTD": { "amount": 150000, "count": 3 },
    "serviceRevenueMTD": { "amount": 49990,  "count": 10 },
    "closedLeadsMTD": 3,
    "totalLeads": 50
  }
}
```

Amounts in ₹.

---

### GET /api/admin/audit-logs

All audit log entries (paginated, newest first).

**Auth:** ADMIN

**Query Parameters:** `page`, `limit`

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "data": [
      {
        "id": "64audit...",
        "adminId": "64admin...",
        "action": "PROPERTY_APPROVED",
        "targetType": "Property",
        "targetId": "64prop...",
        "before": "{\"publishStatus\":\"PENDING_APPROVAL\"}",
        "after": "{\"publishStatus\":\"APPROVED\"}",
        "ipAddress": "103.x.x.x",
        "createdAt": "2024-01-15T12:00:00.000Z"
      }
    ],
    "pagination": { "total": 200, "page": 1, "limit": 20, "totalPages": 10, "hasNext": true, "hasPrev": false }
  }
}
```

`before` and `after` are JSON strings.

---

### GET /api/admin/partners

Performance metrics for all KYC-verified partners.

**Auth:** ADMIN

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": [
    {
      "id": "64user...",
      "name": "Rajdeep Kumar",
      "companyName": "RealtyPro Solutions",
      "partnerSubType": "AGENT",
      "totalLeads": 12,
      "closedLeads": 3,
      "totalListings": 8,
      "activeListings": 6
    }
  ]
}
```

---

### GET /api/admin/partners/:id

Full partner profile drill-down including all leads and listings.

**Auth:** ADMIN

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "id": "64user...",
    "name": "Rajdeep Kumar",
    "email": "rajdeep@example.com",
    "companyName": "RealtyPro Solutions",
    "partnerSubType": "AGENT",
    "kycStatus": "VERIFIED",
    "kycVerifiedAt": "2024-02-01T00:00:00.000Z",
    "totalLeads": 12,
    "closedLeads": 3,
    "totalListings": 8,
    "activeListings": 6,
    "escrowHeld": 150000,
    "createdAt": "2024-01-01T00:00:00.000Z"
  }
}
```

**Errors:** `404` partner not found.

---

### PATCH /api/admin/escrow/:id/release

Release a HELD escrow. `sellerDetails` gets a RazorpayX Payout for the escrow amount net of `partnerShare`/`platformFee` (direct bank transfer — no seller Razorpay onboarding required); `partnerDetails` additionally pays `partnerShare` out as a second payout. `platformFee` is never paid out anywhere — it's simply the portion held back in the RazorpayX account. Requires `HELD` status + captured payment.

**Auth:** ADMIN

**Request Body:**

```json
{
  "sellerDetails": {
    "name": "Seller Name",
    "email": "seller@example.com",
    "phone": "+919800000000",
    "ifsc": "HDFC0000123",
    "accountNumber": "50100xxxxxxxx"
  },
  "partnerDetails": {
    "name": "Partner Name",
    "email": "partner@example.com",
    "phone": "+919800000001",
    "ifsc": "ICIC0000456",
    "accountNumber": "60200xxxxxxxx"
  },
  "partnerShare": 5000,
  "platformFee": 2000,
  "note": "Release approved."
}
```

Either `sellerDetails` (a real RazorpayX payout is made to that bank account, for `amount - partnerShare - platformFee`) **or** `manualTransferConfirmed: true` with a required `note` (the payout was made outside Razorpay — e.g. bank transfer) must be provided. Previously this was silently optional with no alternative, meaning an escrow could be marked `RELEASED` with no real transfer of any kind and no record of why. `partnerShare + platformFee` must be less than the escrow amount.

`partnerDetails` is optional and independent of `sellerDetails` — if omitted, `partnerShare` is still recorded on the escrow (held back from the seller's payout) but no automated payout is made for it, same as before; provide `partnerDetails` (with a positive `partnerShare`) to also pay the partner directly via RazorpayX.

The release is atomic: if two requests for the same escrow race, only one succeeds — the other gets `400 "This escrow was already released or refunded"` before any Razorpay call is made, so a double-click or retry can never trigger two payouts. Each payout also passes the escrowId as its `reference_id`, which RazorpayX itself treats as an idempotency key — including across the seller and partner payouts separately. If either payout call fails, the escrow is rolled back to `HELD` (not left stuck `RELEASED` with no money moved) and the error is returned; a retry after a partial failure safely skips re-paying whichever leg already succeeded.

**Response `200`:**

```json
{
  "success": true,
  "message": "Escrow released",
  "data": { "id": "64esc...", "status": "RELEASED", "releasedAt": "...", "adminNote": "..." }
}
```

**Errors:** `400` not HELD · `400` payment not captured · `400` already released/refunded (race) · `400` neither `sellerDetails` nor `manualTransferConfirmed` provided.

---

### POST /api/admin/escrow/:id/refund

Refund a HELD escrow to buyer. Sends buyer notification.

**Auth:** ADMIN

**Request Body:** _(none)_

Same atomic-claim protection as release above — a race between two refund requests (or a refund racing a release) leaves only one winner, and a failed Razorpay refund call rolls the escrow back to `HELD` instead of leaving it stuck.

**Response `200`:**

```json
{ "success": true, "message": "Escrow refunded", "data": { "id": "64esc...", "status": "REFUNDED", "refundedAt": "..." } }
```

**Errors:** `400` not HELD · `400` payment not captured · `400` already released/refunded (race).

---

### GET /api/admin/escrow

All escrow transactions (paginated).

**Auth:** ADMIN

**Query Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `status` | string | `PAYMENT_PENDING` · `HELD` · `RELEASED` · `REFUNDED` · `FAILED` · `CANCELLED` |
| `page` | number | Default: `1` |
| `limit` | number | Default: `20` |

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "data": [
      {
        "id": "64esc...",
        "leadId": "64lead...",
        "buyerId": "64user...",
        "razorpayOrderId": "order_...",
        "razorpayPaymentId": "pay_...",
        "razorpayRefundId": null,
        "amount": 50000,
        "currency": "INR",
        "status": "HELD",
        "heldAt": "2024-01-16T00:00:00.000Z",
        "createdAt": "2024-01-15T00:00:00.000Z",
        "lead": {
          "buyerName": "Suresh Mehta",
          "buyerEmail": "suresh@example.com",
          "property": { "title": "3 BHK Flat in Baner", "locality": "Baner", "city": "Pune" },
          "assignedPartner": { "name": "Rajdeep Kumar", "companyName": "RealtyPro Solutions" }
        }
      }
    ],
    "pagination": { "total": 20, "page": 1, "limit": 20, "totalPages": 1, "hasNext": false, "hasPrev": false }
  }
}
```

Each row's `lead` object carries buyer/property/partner context — previously absent, so the admin UI showed those three columns blank.

---

### GET /api/admin/escrow/stats

Real aggregate figures over the whole table — not sampled from whichever page happened to be loaded.

**Auth:** ADMIN

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "heldSum": 150000,
    "refundedSum": 0,
    "releasedSumThisMonth": 250000,
    "refundedSumThisMonth": 0,
    "heldCount": 3,
    "releasedCountThisMonth": 2,
    "avgHoldDays": 6.5,
    "payoutFailedCount": 0
  }
}
```

`avgHoldDays` is the average of `releasedAt - createdAt` (in days) across all `RELEASED` transactions. `heldSum`/`heldCount` include `HELD_PAYOUT_FAILED` — that money hasn't left the account either, it's just stuck on a failed payout attempt; `payoutFailedCount` is what surfaces that it needs attention. The `*ThisMonth` figures are calendar-month-to-date.

---

### GET /api/admin/content

List all content blocks including unpublished drafts (paginated).

**Auth:** ADMIN

**Query Parameters:**

| Param | Type | Description |
|---|---|---|
| `type` | string | `BLOG_POST` · `FAQ` · `BANNER` · `ANNOUNCEMENT` · `PAGE` |
| `page` | number | Default: `1` |
| `limit` | number | Default: `20` |

**Response `200`:** Paginated list of content blocks (same shape as public `/api/blog` but includes unpublished records).

---

### GET /api/admin/content/:id

Single content block by ID (published or draft).

**Auth:** ADMIN

**Response `200`:** Full content block · `404` if not found.

---

### POST /api/admin/content

Create a CMS content block.

**Auth:** ADMIN

**Request Body:**

```json
{
  "type": "BLOG",
  "title": "Top 5 areas in Pune to buy in 2024",
  "slug": "top-5-areas-pune-2024",
  "content": "<p>Full article content here...</p>",
  "excerpt": "A quick guide to the best neighbourhoods.",
  "imageUrl": "https://cdn.realtydoor.in/blog/pune-areas.jpg",
  "author": "Rajdeep",
  "tags": ["Pune", "Investment", "2024"],
  "isPublished": true,
  "seoTitle": "Top 5 Pune Areas 2024 | RealtyDoor",
  "seoDesc": "Discover the best areas to invest in Pune."
}
```

If `isPublished: true` and `publishedAt` omitted, defaults to now.

**Response `201`:** `{ "success": true, "message": "Created", "data": { "id": "64cms...", ... } }`

---

### PATCH /api/admin/content/:id

Update a CMS content block.

**Auth:** ADMIN

**Request Body:** Partial content block fields.

**Response `200`:** `{ "success": true, "message": "Success", "data": { ... } }`

---

### DELETE /api/admin/content/:id

Delete a CMS content block.

**Auth:** ADMIN

**Response `204`:** _(no body)_

---

### GET /api/admin/tickets

All support tickets (paginated).

**Auth:** ADMIN

**Query Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `status` | string | `OPEN` · `IN_PROGRESS` · `RESOLVED` · `VERIFIED_BY_USER` |
| `userId` | string | Filter by user ID |
| `category` | string | `PLUMBING` · `ELECTRICAL` · `PAINTING` · `GENERAL` |
| `search` | string | Free-text, matches `subject`, `description`, or `vendorName` (case-insensitive) |
| `page` | number | Default: `1` |
| `limit` | number | Default: `20` |

`category` and `search` compose correctly with pagination — the total/page math reflects the filtered set, not the whole table.

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "data": [
      {
        "id": "64tkt...",
        "subject": "Plumbing leak in bathroom",
        "status": "OPEN",
        "priority": "HIGH",
        "createdAt": "2024-02-01T00:00:00.000Z",
        "user": { "name": "Suresh Mehta", "email": "suresh@example.com" },
        "subscription": { "id": "64sub...", "amountPaid": 4999 }
      }
    ],
    "pagination": { "total": 15, "page": 1, "limit": 20, "totalPages": 1, "hasNext": false, "hasPrev": false }
  }
}
```

---

### GET /api/admin/tickets/stats

The four stat cards on the admin tickets page — computed over the full table, not the currently-loaded page.

**Auth:** ADMIN

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": { "unassigned": 3, "inProgress": 5, "resolvedThisWeek": 2, "avgResolutionDays": 1.8 }
}
```

`unassigned` counts tickets with no `vendorName` set. `resolvedThisWeek` counts by `resolvedAt` falling in the current week (Sunday–Saturday), regardless of current status.

---

### GET /api/admin/tickets/:id

Full detail for a single service ticket.

**Auth:** ADMIN

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "id": "64tick...",
    "subject": "Leaking kitchen tap",
    "description": "Kitchen tap has been dripping for 2 days.",
    "category": "PLUMBING",
    "status": "RESOLVED",
    "priority": "HIGH",
    "adminNotes": "Vendor dispatched on 2024-01-15.",
    "vendorName": "Quick Fix Plumbers",
    "vendorPhone": "+919800100200",
    "resolvedAt": "2024-01-15T00:00:00.000Z",
    "createdAt": "2024-01-13T00:00:00.000Z",
    "user": { "id": "64user...", "name": "Suresh Mehta", "email": "suresh@example.com", "phone": "+919000000003" },
    "subscription": { "service": { "name": "Maintenance Premium", "category": "MAINTENANCE" } }
  }
}
```

**Errors:** `404` ticket not found.

---

### PATCH /api/admin/tickets/:id

Update ticket status. Enforces transition machine: `OPEN → IN_PROGRESS → RESOLVED`.

**Auth:** ADMIN

**Request Body:** `{ "status": "IN_PROGRESS" | "RESOLVED" }`

**Response `200`:** `{ "success": true, "message": "Ticket in progress", "data": { ... } }`

**Errors:** `400` invalid transition · `404` ticket not found.

---

### POST /api/admin/notifications/broadcast

Broadcast notification to all users of specified roles.

**Auth:** ADMIN

**Request Body:**

```json
{
  "roles": ["USER", "PARTNER"],
  "title": "System Maintenance",
  "message": "Platform down Sunday 2AM–4AM.",
  "type": "ANNOUNCEMENT"
}
```

`roles` optional — omit to broadcast to all users.

**Response `200`:** `{ "success": true, "message": "Broadcast sent", "data": { ... } }`

---

### GET /api/admin/loan

All loan applications (paginated).

**Auth:** ADMIN

**Query Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `status` | string or string[] | Any of `DOCUMENTS_PENDING` · `DOCUMENTS_SUBMITTED` · `DOCUMENTS_VERIFIED` · `SENT_TO_BANK` · `AWAITING_SANCTION` · `SANCTIONED` · `DISBURSED` · `REJECTED`. Pass multiple (`?status=A&status=B`) to match any of them — used by tabs like "Pending" (5 statuses) or "Sanctioned" (2 statuses) |
| `userId` | string | Filter by user ID |
| `page` | number | Default: `1` |
| `limit` | number | Default: `20` |

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "data": [
      {
        "id": "64loan...",
        "status": "DOCUMENTS_SUBMITTED",
        "preferredBank": "HDFC Bank",
        "loanAmountRequestedPaise": 7000000,
        "sanctionedAmountPaise": null,
        "adminNote": null,
        "createdAt": "2024-01-15T00:00:00.000Z",
        "user": { "name": "Suresh Mehta", "email": "suresh@example.com", "phone": "+919876543210" },
        "property": { "title": "3 BHK Flat in Baner", "slug": "...", "city": "Pune" }
      }
    ],
    "pagination": { "total": 30, "page": 1, "limit": 20, "totalPages": 2, "hasNext": true, "hasPrev": false }
  }
}
```

---

### PATCH /api/admin/loan/:id/status

Update loan status. Sets `sanctionedAt` on `SANCTIONED`, `disbursedAt` on `DISBURSED`. Also accepts the sanction details, independent of status.

**Auth:** ADMIN

**Request Body:**

```json
{
  "status": "SANCTIONED",
  "adminNote": "Sanctioned by HDFC. Ref: HDFC2024012345.",
  "interestRatePct": 8.5,
  "tenureMonths": 240,
  "emiPaise": 4500000,
  "sanctionLetterUrl": "https://cdn.realtydoor.in/loans/sanction-64loan.pdf"
}
```

`interestRatePct`, `tenureMonths`, `emiPaise`, `sanctionLetterUrl` are all optional — set them whenever the information is available, not only alongside a status change.

**Response `200`:**

```json
{
  "success": true,
  "message": "Loan status updated",
  "data": {
    "id": "64loan...", "status": "SANCTIONED", "sanctionedAt": "...", "disbursedAt": null,
    "interestRatePct": 8.5, "tenureMonths": 240, "emiPaise": 4500000,
    "sanctionLetterUrl": "https://cdn.realtydoor.in/loans/sanction-64loan.pdf"
  }
}
```

**Errors:** `404` loan not found.

---

### GET /api/admin/loan/bank-stats

Per-bank aggregate — applications, sanctioned count, close rate, average requested amount — for the admin loan page's bank cards.

**Auth:** ADMIN

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": [
    { "bank": "HDFC Bank", "applications": 12, "sanctioned": 5, "closeRatePct": 41.7, "avgRequestedPaise": 650000000 }
  ]
}
```

`sanctioned` counts loans currently `SANCTIONED` or `DISBURSED`. Only banks with at least one application appear.

---

### GET /api/admin/users

All users (paginated). Filter by role or search.

**Auth:** ADMIN

**Query Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `role` | string | `USER` · `PARTNER` · `ADMIN` |
| `search` | string | Case-insensitive search on name, email, or `refCode` |
| `page` | number | Default: `1` |
| `limit` | number | Default: `20` |

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "data": [
      {
        "id": "64user...",
        "refCode": "RD-U-000045",
        "name": "Suresh Mehta",
        "email": "suresh@example.com",
        "phone": "+919876543210",
        "phoneVerified": true,
        "role": "USER",
        "kycStatus": "NOT_SUBMITTED",
        "partnerSubType": null,
        "createdAt": "2024-01-01T00:00:00.000Z"
      }
    ],
    "pagination": { "total": 120, "page": 1, "limit": 20, "totalPages": 6, "hasNext": true, "hasPrev": false }
  }
}
```

---

### PATCH /api/admin/users/:id/role

Change a user's role. Syncs to Clerk publicMetadata and creates audit log.

**Auth:** ADMIN

**Request Body:** `{ "role": "PARTNER" }`

**Response `200`:**

```json
{
  "success": true,
  "message": "Role updated to PARTNER",
  "data": { "id": "64user...", "name": "Suresh Mehta", "email": "suresh@example.com", "role": "PARTNER", "clerkId": "user_2abc..." }
}
```

**Errors:** `400` invalid role · `404` user not found.

---

### GET /api/admin/users/:id

Full user profile by ID.

**Auth:** ADMIN

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "id": "64user...",
    "name": "Suresh Mehta",
    "email": "suresh@example.com",
    "phone": "+919876543210",
    "phoneVerified": true,
    "role": "USER",
    "isNRI": false,
    "kycStatus": "NOT_SUBMITTED",
    "partnerSubType": null,
    "companyName": null,
    "createdAt": "2024-01-01T00:00:00.000Z"
  }
}
```

**Errors:** `404` user not found.

---

### PATCH /api/admin/users/:id/suspend

Suspend or unsuspend a user. Suspended users receive `403` on every authenticated request. Cannot suspend ADMINs or yourself.

**Auth:** ADMIN

**Request Body:**

```json
{ "suspend": true, "reason": "Spamming property listings" }
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `suspend` | boolean | Yes | `true` = suspend · `false` = unsuspend |
| `reason` | string | No | Stored on the user record; shown in audit log |

**Response `200`:**

```json
{
  "success": true,
  "message": "User suspended",
  "data": {
    "id": "64user...",
    "name": "Suresh Mehta",
    "email": "suresh@example.com",
    "role": "USER",
    "isSuspended": true,
    "suspendedAt": "2024-03-10T10:00:00.000Z",
    "suspendReason": "Spamming property listings"
  }
}
```

**Errors:** `400` missing `suspend` field · `400` cannot suspend yourself · `403` cannot suspend an admin · `404` user not found.

---

### GET /api/admin/services

All services in the catalog (including inactive ones).

**Auth:** ADMIN

**Response `200`:** Array of service objects (same shape as public `GET /api/services` but includes `isActive: false` records).

---

### POST /api/admin/services

Create a new service in the catalog.

**Auth:** ADMIN

**Request Body:**

```json
{
  "name": "Legal Advisory Pack",
  "shortDesc": "Expert property legal guidance",
  "description": "Full legal support for property purchase...",
  "price": 9999,
  "category": "LEGAL",
  "features": ["Title search", "Agreement drafting", "Registration support"],
  "isActive": true,
  "sortOrder": 2,
  "imageUrl": "https://cdn.realtydoor.in/services/legal.jpg"
}
```

`category`: `MAINTENANCE` · `CONSTRUCTION` · `LEGAL` · `LOAN` · `VALUATION`

**Response `201`:** `{ "success": true, "message": "Service created", "data": { "id": "64svc...", ... } }`

---

### PATCH /api/admin/services/:id

Update a service in the catalog.

**Auth:** ADMIN

**Request Body:** Partial service fields (at least one required).

**Response `200`:** `{ "success": true, "message": "Success", "data": { ... } }`

**Errors:** `404` service not found.

---

### DELETE /api/admin/services/:id

Deactivate a service (`isActive → false`). Does not hard-delete.

**Auth:** ADMIN

**Response `200`:** `{ "success": true, "message": "Service deactivated", "data": null }`

**Errors:** `404` service not found.

---

### GET /api/admin/documents

All user documents (paginated). Filter by status or userId.

**Auth:** ADMIN

**Query Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `status` | string | `PENDING_REVIEW` · `APPROVED` · `REJECTED` · `EXPIRED` |
| `userId` | string | Filter by user ID |
| `page` | number | Default: `1` |
| `limit` | number | Default: `20` |

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "data": [
      {
        "id": "64doc...",
        "documentType": "PAN_CARD",
        "fileUrl": "https://cdn.realtydoor.in/docs/pan.pdf",
        "fileName": "pan_card.pdf",
        "status": "PENDING_REVIEW",
        "isVerified": false,
        "uploadedAt": "2024-01-10T00:00:00.000Z",
        "user": { "name": "Suresh Mehta", "email": "suresh@example.com" }
      }
    ],
    "pagination": { "total": 30, "page": 1, "limit": 20, "totalPages": 2, "hasNext": true, "hasPrev": false }
  }
}
```

---

### PATCH /api/admin/documents/:id/verify

Approve or reject a user document.

**Auth:** ADMIN

**Request Body:**

```json
{ "action": "APPROVE", "note": "Document verified successfully." }
```

`action`: `"APPROVE"` or `"REJECT"`. `note` required when rejecting.

**Response `200`:** `{ "success": true, "message": "Document approved", "data": { "id": "...", "status": "APPROVED", "isVerified": true } }`

**Errors:** `404` document not found.

---

### GET /api/admin/contact

All contact form submissions (paginated).

**Auth:** ADMIN

**Query Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `isRead` | boolean | Filter unread (`false`) or read (`true`) |
| `page` | number | Default: `1` |
| `limit` | number | Default: `20` |

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "data": [
      {
        "id": "64msg...",
        "name": "Priya Sharma",
        "email": "priya@example.com",
        "phone": "+919876543210",
        "subject": "Inquiry about listing",
        "message": "I would like to know more...",
        "isRead": false,
        "createdAt": "2024-02-10T00:00:00.000Z"
      }
    ],
    "pagination": { "total": 45, "page": 1, "limit": 20, "totalPages": 3, "hasNext": true, "hasPrev": false }
  }
}
```

---

### PATCH /api/admin/contact/:id/read

Mark a contact form message as read.

**Auth:** ADMIN

**Request Body:** _(none)_

**Response `200`:** `{ "success": true, "message": "Marked as read", "data": { "id": "...", "isRead": true } }`

**Errors:** `404` message not found.

---

### GET /api/admin/team

All team members (active and inactive).

**Auth:** ADMIN

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": [
    {
      "id": "64tm...",
      "name": "Priya Sharma",
      "title": "Head of Operations",
      "email": "priya@realtydoor.in",
      "phone": "+919876543210",
      "avatarUrl": "https://cdn.realtydoor.in/team/priya.jpg",
      "isActive": true,
      "sortOrder": 1
    }
  ]
}
```

---

### POST /api/admin/team

Add a team member.

**Auth:** ADMIN

**Request Body:**

```json
{
  "name": "Priya Sharma",
  "title": "Head of Operations",
  "email": "priya@realtydoor.in",
  "phone": "+919876543210",
  "avatarUrl": "https://cdn.realtydoor.in/team/priya.jpg",
  "isActive": true,
  "sortOrder": 1
}
```

`name` and `title` required.

**Response `201`:** `{ "success": true, "message": "Team member added", "data": { "id": "64tm...", ... } }`

---

### PATCH /api/admin/team/:id

Update a team member.

**Auth:** ADMIN

**Request Body:** Partial team member fields (at least one required).

**Response `200`:** `{ "success": true, "message": "Team member updated", "data": { ... } }`

**Errors:** `404` team member not found.

---

### DELETE /api/admin/team/:id

Remove a team member.

**Auth:** ADMIN

**Response `200`:** `{ "success": true, "message": "Team member removed", "data": null }`

**Errors:** `404` team member not found.

---

### GET /api/admin/video-tours

All video tour requests (paginated). Filter by status or assignedTo.

**Auth:** ADMIN

**Query Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `status` | string | `PENDING` · `ASSIGNED` · `COMPLETED` |
| `assignedTo` | string | Filter by assigned partner ID |
| `page` | number | Default: `1` |
| `limit` | number | Default: `20` |

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "data": [
      {
        "id": "64vt...",
        "status": "PENDING",
        "userNote": "Please show the balcony view.",
        "scheduledAt": null,
        "videoUrl": null,
        "adminNote": null,
        "assignedTo": null,
        "createdAt": "2024-03-01T00:00:00.000Z",
        "user": {
          "id": "64user...",
          "name": "Suresh Mehta",
          "email": "suresh@example.com",
          "phone": "+919876543210",
          "isNRI": true
        },
        "property": {
          "id": "64prop...",
          "title": "3 BHK Flat in Baner",
          "slug": "3-bhk-flat-in-baner-...",
          "city": "Pune",
          "images": ["https://cdn.realtydoor.in/prop1.jpg"]
        }
      }
    ],
    "pagination": { "total": 15, "page": 1, "limit": 20, "totalPages": 1, "hasNext": false, "hasPrev": false }
  }
}
```

---

### PATCH /api/admin/video-tours/:id

Assign a partner to a tour, schedule it, or mark it completed with a video URL.

**Auth:** ADMIN

**Request Body:** At least one field required.

```json
{
  "assignedTo":  "64partner...",
  "scheduledAt": "2024-03-10T11:00:00.000Z",
  "adminNote":   "Our partner will call you 1 hour before.",
  "videoUrl":    "https://cdn.realtydoor.in/tours/baner-tour.mp4",
  "status":      "ASSIGNED"
}
```

| Field | Effect |
|-------|--------|
| `assignedTo` | Sets partner and auto-sets `status → ASSIGNED` |
| `videoUrl` | Sets video URL, auto-sets `status → COMPLETED` and `completedAt → now` |
| `scheduledAt` | Sets the scheduled tour datetime |
| `adminNote` | Internal note shown to user |
| `status` | Manual status override |

**Response `200`:** `{ "success": true, "message": "Video tour updated", "data": { ... } }`

**Errors:** `404` video tour request not found.

---

### POST /api/admin/video-tours/:id/upload

Upload the recorded video file for a tour request. Stores it in S3 and auto-sets `status → COMPLETED`.

**Auth:** ADMIN

**Request Body:** `multipart/form-data`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `video` | File | Yes | Accepted formats: `mp4`, `mov`, `webm`, `avi`. Max size: **500 MB** |

**Response `200`:**

```json
{
  "success": true,
  "message": "Video uploaded and tour marked completed",
  "data": {
    "id": "64tour...",
    "userId": "64user...",
    "propertyId": "64prop...",
    "videoUrl": "https://your-bucket.s3.ap-south-1.amazonaws.com/video-tours/uuid.mp4",
    "status": "COMPLETED",
    "completedAt": "2024-03-10T13:45:00.000Z",
    "scheduledAt": "2024-03-10T11:00:00.000Z",
    "assignedTo": "64partner...",
    "adminNote": "Our partner will call you 1 hour before.",
    "createdAt": "2024-03-08T09:00:00.000Z",
    "updatedAt": "2024-03-10T13:45:00.000Z"
  }
}
```

**Errors:** `400` no file attached · `400` unsupported file type · `404` tour request not found.

---

### GET /api/admin/vendors

Admin-managed vendor catalog (paginated). Vendors are dispatched on service tickets.

**Auth:** ADMIN

**Query Parameters:**

| Param | Type | Description |
|---|---|---|
| `category` | string | `PLUMBING` · `ELECTRICAL` · `PAINTING` · `GENERAL` · `CARPENTRY` · `OTHER` |
| `city` | string | Filter by city |
| `isActive` | boolean | `true` (default) or `false` |
| `page` | number | Default: `1` |
| `limit` | number | Default: `20` |

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "data": [
      {
        "id": "64ven...",
        "name": "Ramesh Plumbers",
        "phone": "+919876543210",
        "email": "ramesh@example.com",
        "category": "PLUMBING",
        "city": "Pune",
        "notes": "Available 7 days, handles burst pipes.",
        "isActive": true,
        "createdAt": "2024-01-01T00:00:00.000Z"
      }
    ],
    "pagination": { "total": 8, "page": 1, "limit": 20, "totalPages": 1, "hasNext": false, "hasPrev": false }
  }
}
```

---

### POST /api/admin/vendors

Add a vendor to the catalog.

**Auth:** ADMIN

**Request Body:**

```json
{
  "name":     "Ramesh Plumbers",
  "phone":    "+919876543210",
  "email":    "ramesh@example.com",
  "category": "PLUMBING",
  "city":     "Pune",
  "notes":    "Available 7 days, handles burst pipes."
}
```

`name`, `phone`, and `category` are required. `category`: `PLUMBING` · `ELECTRICAL` · `PAINTING` · `GENERAL` · `CARPENTRY` · `OTHER`

**Response `201`:** `{ "success": true, "message": "Vendor added", "data": { "id": "64ven...", ... } }`

---

### PATCH /api/admin/vendors/:id

Update a vendor's details.

**Auth:** ADMIN

**Request Body:** Partial vendor fields (at least one required).

**Response `200`:** `{ "success": true, "message": "Vendor updated", "data": { ... } }`

**Errors:** `404` vendor not found.

---

### DELETE /api/admin/vendors/:id

Deactivate a vendor (`isActive → false`). Does not hard-delete.

**Auth:** ADMIN

**Response `200`:** `{ "success": true, "message": "Vendor deactivated", "data": { ... } }`

**Errors:** `404` vendor not found.

---

### GET /api/admin/analytics

Platform-level funnel and cohort analytics for the last 6 months.

**Auth:** ADMIN

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "totals": {
      "users": 1240,
      "partners": 87,
      "activeListings": 412
    },
    "leadFunnel": {
      "UNASSIGNED": 45,
      "ASSIGNED": 30,
      "SITE_VISIT_SCHEDULED": 18,
      "SITE_VISIT_DONE": 12,
      "CLOSED": 56,
      "DROPPED": 22
    },
    "propertyFunnel": {
      "PENDING_APPROVAL": 8,
      "APPROVED": 412,
      "REJECTED": 14,
      "ARCHIVED": 3
    },
    "userGrowth": [
      { "month": "2023-10", "users": 85, "partners": 6 },
      { "month": "2023-11", "users": 102, "partners": 9 },
      { "month": "2023-12", "users": 130, "partners": 11 },
      { "month": "2024-01", "users": 148, "partners": 14 },
      { "month": "2024-02", "users": 167, "partners": 18 },
      { "month": "2024-03", "users": 190, "partners": 22 }
    ],
    "revenueByMonth": [
      { "month": "2023-10", "revenue": 49950 },
      { "month": "2023-11", "revenue": 69900 },
      { "month": "2023-12", "revenue": 89850 },
      { "month": "2024-01", "revenue": 119800 },
      { "month": "2024-02", "revenue": 109750 },
      { "month": "2024-03", "revenue": 149700 }
    ]
  }
}
```

`revenueByMonth` reflects service subscription payments (`paymentStatus: SUCCESS`) only.

---

## Analytics (13.1-13.5)

All endpoints below accept an optional `?period=` query param: `MTD` (default),
`3M`, `6M`, `YTD` or `ALL`. An unrecognised value falls back to `MTD`.

Two honesty rules apply across this group:

- A metric the backend genuinely cannot produce is returned as `null` with an
  `unavailable` reason, never substituted with a lookalike number.
- Records with impossible timestamps (e.g. `releasedAt` before `createdAt`) are
  excluded from medians and reported separately under `anomalies` /
  `discardedNegative`, so a data problem can't masquerade as performance.

---

### GET /api/admin/analytics/overview

Every section below in a single call, for the dashboard's first paint.

**Auth:** ADMIN

**Response `200`:** `data` contains `period`, `funnel`, `users`, `nri`,
`revenue` and `escrowFloat`, each with the same shape as its dedicated
endpoint.

---

### GET /api/admin/analytics/funnel

**Auth:** ADMIN

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "period": "ALL",
    "stages": [
      { "key": "VISITORS", "count": null, "unavailable": "anonymous site traffic is not tracked by the backend", "conversionFromPrev": null },
      { "key": "REGISTRATIONS", "count": 4, "conversionFromPrev": null },
      { "key": "INQUIRIES", "count": 19, "conversionFromPrev": 475 },
      { "key": "ASSIGNED", "count": 16, "conversionFromPrev": 84.2 },
      { "key": "VISITS_SCHEDULED", "count": 4, "conversionFromPrev": 25 },
      { "key": "OTP_VERIFIED", "count": 5, "conversionFromPrev": 125 },
      { "key": "DECIDED", "count": 2, "conversionFromPrev": 40 },
      { "key": "ESCROW_HELD", "count": 2, "conversionFromPrev": 100 },
      { "key": "CLOSED", "count": 1, "conversionFromPrev": 50 }
    ],
    "inquiryToClosePct": 5.3
  }
}
```

`VISITORS` is permanently `null`: nothing in this backend records anonymous
traffic, and `Property.viewsThisWeek` is per-listing and resets weekly, so it
cannot be summed into a visitor count.

`conversionFromPrev` is measured against the previous *available* stage, so the
untracked visitor stage doesn't force a bogus `0%` onto registrations.

**The funnel is not monotonic, and that is correct.** `INQUIRIES` can exceed
`REGISTRATIONS` because a lead can be created without a registered buyer
account, and `OTP_VERIFIED` can exceed `VISITS_SCHEDULED` where a lead was
OTP-verified without `siteVisitScheduledAt` ever being set. Do not render these
as a strictly narrowing funnel.

---

### GET /api/admin/analytics/users

**Auth:** ADMIN

**Response `200`:** `data` has `period`, `newUsers`, `otpVerifiedUsers`,
`otpVerifiedPct`, `nriUsers`, `totalUsers`. Soft-deleted users are excluded.
`otpVerifiedPct` is `null` when `newUsers` is 0.

---

### GET /api/admin/analytics/nri

**Auth:** ADMIN

**Response `200`:** `data` has `period`, `registrations`, `videoToursBooked`,
`nriLeadsCaptured`, `dealsClosed`, `avgDealValue`.

`nriLeadsCaptured` counts the public NRI capture form, which is a separate
funnel from registered NRI users. `avgDealValue` uses `dealPriceAtLock` where
terms were locked and falls back to the property's list price, and is `null`
when no closed deal has a usable value.

---

### GET /api/admin/analytics/revenue

**Auth:** ADMIN

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "period": "YTD",
    "totalRevenue": 6699,
    "streams": [
      { "stream": "Maintenance Premium", "volume": 1, "revenue": 4999, "avgTicket": 4999, "previousRevenue": 0, "changePct": null },
      { "stream": "Escrow commission", "volume": 1, "revenue": 1700, "avgTicket": 1700, "previousRevenue": 0, "changePct": null }
    ]
  }
}
```

Streams are service subscriptions (`paymentStatus: SUCCESS`) plus one synthetic
`Escrow commission` row, which is the platform's own slice of the fee taken
from `Lead.commissionAmountPaise` on closed leads - not the gross deal value.

`previousRevenue` is the equivalent-length window immediately before this one.
`changePct` is `null` when there was no prior revenue to divide by, rather than
`Infinity`. For `period=ALL` there is no previous window, so `previousRevenue`
is always `0` and `changePct` always `null`.

---

### GET /api/admin/analytics/escrow-float

**Auth:** ADMIN

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "heldAmount": 50000,
    "heldCount": 1,
    "avgHoldDays": null,
    "anomalousHoldRecords": 1,
    "annualYieldPct": 0,
    "floatIncomePotential": 0
  }
}
```

`annualYieldPct` comes from the admin config key
`escrow_float_annual_yield_pct` and **defaults to 0**, so
`floatIncomePotential` reports 0 until the business sets a rate - the backend
does not invent an interest rate.

`avgHoldDays` counts only non-negative holds. `anomalousHoldRecords` is the
number of released escrows whose `releasedAt` precedes `createdAt`; when it is
greater than 0, warn rather than presenting the hold time as reliable.

---

### GET /api/admin/analytics/benchmarks

Platform-wide partner funnel and response-time medians (B9.4-B9.6).

**Auth:** ADMIN

**Response `200`:** same shape as the `platform` half of
`GET /api/partner/analytics/benchmark`, plus `sampleLeads` and `anomalies`.
Defaults to `period=ALL`.

---

### GET /api/admin/disputes

All disputes (paginated). Filter by status, type, or userId.

**Auth:** ADMIN

**Query Parameters:**

| Param | Type | Description |
|---|---|---|
| `status` | string | `OPEN` · `UNDER_REVIEW` · `RESOLVED` · `CLOSED` |
| `type` | string | `LEAD` · `ESCROW` · `SERVICE` |
| `userId` | string | Filter by user ID |
| `page` | number | Default: `1` |
| `limit` | number | Default: `20` |

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "data": [
      {
        "id": "64dis...",
        "type": "ESCROW",
        "referenceId": "64escrow...",
        "reason": "Payment deducted but escrow not created",
        "description": "I paid ₹50,000...",
        "status": "OPEN",
        "adminNote": null,
        "resolvedAt": null,
        "createdAt": "2024-03-01T00:00:00.000Z",
        "user": { "id": "64user...", "name": "Suresh Mehta", "email": "suresh@example.com", "phone": "+919876543210" }
      }
    ],
    "pagination": { "total": 5, "page": 1, "limit": 20, "totalPages": 1, "hasNext": false, "hasPrev": false }
  }
}
```

---

### PATCH /api/admin/disputes/:id

Update dispute status or add an admin note.

**Auth:** ADMIN

**Request Body:** At least one field required.

```json
{
  "status":    "UNDER_REVIEW",
  "adminNote": "We are investigating with the payment gateway team."
}
```

`status`: `UNDER_REVIEW` · `RESOLVED` · `CLOSED`

Setting `RESOLVED` or `CLOSED` stamps `resolvedAt` automatically.

**Response `200`:** `{ "success": true, "message": "Dispute updated", "data": { ... } }`

**Errors:** `404` dispute not found · `400` dispute is already closed.

---

### GET /api/admin/reviews

All property reviews (paginated), including pending moderation.

**Auth:** ADMIN

**Query Parameters:**

| Param | Type | Description |
|---|---|---|
| `isApproved` | boolean | `true` (approved) · `false` (pending) |
| `propertyId` | string | Filter by property ID |
| `page` | number | Default: `1` |
| `limit` | number | Default: `20` |

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "data": [
      {
        "id": "64rev...",
        "rating": 4,
        "title": "Great locality",
        "body": "Flat is well-designed...",
        "isApproved": false,
        "moderatedAt": null,
        "createdAt": "2024-02-15T00:00:00.000Z",
        "user":     { "id": "64user...", "name": "Suresh Mehta", "email": "suresh@example.com" },
        "property": { "id": "64prop...", "title": "3 BHK Flat in Baner", "slug": "3-bhk-flat-in-baner-..." }
      }
    ],
    "pagination": { "total": 22, "page": 1, "limit": 20, "totalPages": 2, "hasNext": true, "hasPrev": false }
  }
}
```

---

### PATCH /api/admin/reviews/:id/moderate

Approve or reject a property review. Approved reviews become publicly visible.

**Auth:** ADMIN

**Request Body:**

```json
{ "action": "APPROVE" }
```

`action`: `"APPROVE"` or `"REJECT"`.

**Response `200`:** `{ "success": true, "message": "Review approved", "data": { "id": "...", "isApproved": true, "moderatedAt": "..." } }`

**Errors:** `404` review not found.

---

### GET /api/admin/config

All platform config entries (including non-public ones).

**Auth:** ADMIN

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": [
    {
      "id": "64cfg...",
      "key": "support_phone",
      "value": "+919876543210",
      "description": "Customer support WhatsApp number shown on website",
      "isPublic": true,
      "updatedByAdminId": "64admin...",
      "updatedAt": "2024-01-10T00:00:00.000Z"
    },
    {
      "id": "64cfg2...",
      "key": "razorpay_webhook_secret",
      "value": "whsec_...",
      "description": "Razorpay webhook signing secret",
      "isPublic": false,
      "updatedByAdminId": "64admin...",
      "updatedAt": "2024-01-05T00:00:00.000Z"
    }
  ]
}
```

Ordered alphabetically by `key`.

---

### PUT /api/admin/config/:key

Create or update a config key. Upserts — creates if the key doesn't exist.

**Auth:** ADMIN

**URL Param:** `:key` is the string config key (e.g. `support_phone`, `platform_commission_percent`).

**Request Body:**

```json
{
  "value":       "+919876543210",
  "description": "Customer support WhatsApp number",
  "isPublic":    true
}
```

`value` is required. `description` and `isPublic` are optional (omitting them preserves existing values on update).

**Response `200`:** `{ "success": true, "message": "Config updated", "data": { "key": "support_phone", "value": "...", "isPublic": true, ... } }`

---

### DELETE /api/admin/config/:key

Delete a platform config key permanently.

**Auth:** ADMIN

**Response `200`:** `{ "success": true, "message": "Config key deleted", "data": null }`

**Errors:** `404` key not found.

---

## Enums Reference

### Role
`USER` · `PARTNER` · `ADMIN`

### PropertyType
`FLAT` · `INDEPENDENT_HOUSE` · `VILLA` · `PLOT` · `COMMERCIAL_OFFICE` · `RETAIL_SHOP`

### ListingType
`SALE` · `RENT` · `LEASE`

### PublishStatus
`PENDING_APPROVAL` · `APPROVED` · `REJECTED` · `ARCHIVED`

### PropertyStatus
`PRE_LAUNCH` · `READY_TO_MOVE` · `UNDER_CONSTRUCTION` · `SOLD` · `RENTED`

### LeadStatus
`UNASSIGNED` · `ASSIGNED` · `SITE_VISIT_SCHEDULED` · `SITE_VISIT_DONE` · `CLOSED` · `DROPPED`

### EscrowStatus
`PAYMENT_PENDING` · `HELD` · `RELEASED` · `REFUNDED` · `FAILED` · `CANCELLED`

### KycStatus
`NOT_SUBMITTED` · `PENDING_REVIEW` · `VERIFIED` · `REJECTED`

### LoanStatus
`DOCUMENTS_PENDING` · `DOCUMENTS_SUBMITTED` · `DOCUMENTS_VERIFIED` · `SENT_TO_BANK` · `AWAITING_SANCTION` · `SANCTIONED` · `DISBURSED` · `REJECTED`

### PartnerSubType
`AGENT` · `BUILDER` · `ADVISOR` · `OWNER`

### PaymentStatus (subscriptions)
`PENDING` · `SUCCESS` · `FAILED` · `REFUNDED`

### TicketStatus
`OPEN` · `IN_PROGRESS` · `RESOLVED` · `VERIFIED_BY_USER`

### DocumentStatus
`PENDING_REVIEW` · `APPROVED` · `REJECTED` · `EXPIRED`

### CommissionStatus
`PENDING` · `INVOICED` · `COLLECTED` · `DISPUTED`

### ContentBlock Type
`BLOG_POST` · `FAQ` · `BANNER` · `ANNOUNCEMENT` · `PAGE`

### VideoTourRequestStatus
`PENDING` · `ASSIGNED` · `COMPLETED`

### BuyerFeedbackStatus (WATI webhook)
`VERIFIED_CLOSED` · `VERIFIED_DROPPED` · `STILL_DECIDING`

### DisputeType
`LEAD` · `ESCROW` · `SERVICE`

### DisputeStatus
`OPEN` · `UNDER_REVIEW` · `RESOLVED` · `CLOSED`

### VendorCategory
`PLUMBING` · `ELECTRICAL` · `PAINTING` · `GENERAL` · `CARPENTRY` · `OTHER`

### Notification Type (examples)
`LEAD_NEW` · `LEAD_ASSIGNED` · `PROPERTY_APPROVED` · `PROPERTY_REJECTED` · `PROPERTY_EDITED_BY_ADMIN` · `KYC_PENDING` · `KYC_UPDATE` · `DEAL_CLOSED` · `ESCROW_REFUNDED` · `SERVICE_ACTIVATED` · `LOAN_STATUS_UPDATE` · `ANNOUNCEMENT`
