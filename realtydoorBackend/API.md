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

**If `publishStatus` is `CHANGES_REQUESTED`** the edit applies immediately *and*
resubmits the listing: `publishStatus` returns to `PENDING_APPROVAL` and the
admin's fix checklist is cleared. The message is `Changes saved and resubmitted
for review`. See **Listing visibility and requested changes (docs 4.14 / 4.15)**
for the full flow — there is no separate resubmit endpoint, because acting on
the feedback is the resubmission.

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

### POST /api/properties/:id/report-unauthorized

R27 — lets a property's actual owner report that a listing was not
authorized by them. Public and unauthenticated on purpose: the real owner
may have no RealtyDoor account at all. Distinct from doc 4.2's
admin-initiated owner-confirmation flow (`OwnerConfirmation` — admin reaches
out and records what the owner said); this is the owner reaching in first,
on their own initiative.

**Auth:** Public (rate-limited)

**Request Body:**

```json
{
  "reporterName": "Ramesh Owner",
  "reporterEmail": "ramesh@example.com",
  "reporterPhone": "9876543210",
  "message": "I never authorized anyone to list my property on this platform."
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `reporterName` | Yes | 2–100 chars |
| `reporterEmail` | Conditional | At least one of email/phone is required |
| `reporterPhone` | Conditional | At least one of email/phone is required |
| `message` | Yes | 10–1000 chars |

Does two things: logs a `ContactMessage` (`source: "LISTING_REPORT"`, visible
in the general admin inbox) **and** opens a `ListingConflict`
(`type: "OWNER_REPORTED_UNAUTHORIZED"`) on the property, so it also surfaces
directly on the admin Conflicts screen where integrity issues are actually
reviewed. The conflict is deduped against any already-`OPEN` one of the same
type on this property — a second report before admin resolves the first
doesn't create a duplicate conflict row, but the contact message is still
logged every time, since each submission is its own piece of evidence. All
admins are notified (`LISTING_OWNER_REPORTED`, under the Listings chip).

**Response `201`:**

```json
{
  "success": true, "message": "Report received. Our team will review this listing.",
  "data": { "contactMessageId": "...", "conflictCreated": true, "conflictId": "..." }
}
```

`conflictCreated` is `false` (and `conflictId` is `null`) on a repeat report
while the earlier conflict is still open.

**Errors:** `400` missing both email and phone, or message too short · `404` property not found.

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
  "note": "Walk-in at the site on Saturday.",
  "consent": true
}
```

`buyerEmail`, `budget` and `note` are optional. `buyerPhone` accepts the same formats as every other phone field (bare 10-digit Indian, or full international for NRI) and is normalized to E.164. `propertyId` **must be one of the partner's own listings** — anything else 404s.

**`consent` is required and must be the literal boolean `true`** (docs-backend-gaps-handoff.md #4) — not merely truthy. The design already showed a consent checkbox on this form; this is what actually enforces and records it. Recorded as `buyerConsentAt` on the lead — a timestamp, the evidentiary record of *when* the partner attested it, not a bare boolean.

Creates the lead with `status: AWAITING_ADMIN` and `source: PARTNER`, so it stays out of the normal pipeline until an admin confirms it (see `PATCH /api/admin/leads/:id/confirm`). A partner can't self-assign work this way.

`buyerId` is deliberately left `null` even if a registered account has that phone: the buyer hasn't authenticated, so attributing it to their account would surface it in their own dashboard as something they never submitted, and would consume their `POST /api/leads` quota. `consent` above is the partner attesting the buyer's consent to being contacted about this inquiry — a separate thing from the buyer having an authenticated account at all.

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

**Errors:** `400` `consent` missing or not `true` · `404` property not in your listings · `409 DUPLICATE_LEAD` — this buyer already has an active (not closed/dropped) lead for this same property; `data.lead` carries the existing one.

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
    "partnerNotes": null,
    "visitPhotoUrls": [],
    "closureDocumentUrls": [],
    "closingPrice": null,
    "property": { ... },
    "createdAt": "2024-01-15T10:00:00.000Z",
    "updatedAt": "2024-01-15T10:00:00.000Z"
  }
}
```

**Added 2026-10-07 — `partnerNotes`, `closingPrice`, `updatedAt` were
already in the real response but missing from this example.**
`partnerNotes` is the partner's own free-text notes on the lead (distinct
from admin-internal `adminNotes`, which is never included here regardless
of OTP state). `closingPrice` is set once the partner marks the deal
closed (`PATCH .../close`); `null` until then.

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

Privacy spec, 2026-10-10: `notificationPreferences.marketing` now writes the same `marketingOptIn`/`marketingOptInAt` pair that `PATCH /api/user/consent` and `GET /api/user/consent` use — it was previously a separate, unsynced column. Every change under `notificationPreferences` is recorded to the privacy audit trail (not returned in the response).

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

Each consent actually given/changed in a single call is recorded as its own row in the privacy audit trail (`TERMS_ACCEPTED`, `PRIVACY_ACCEPTED`, `MARKETING_OPT_IN`/`MARKETING_OPT_OUT`) — e.g. accepting terms and opting into marketing in the same request writes two rows, not one.

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

### GET /api/user/consent

Privacy spec, 2026-10-10 — read-only view of everything the Settings screen's consent/notification/deletion state depends on, so the app doesn't have to assemble it from several endpoints.

**Auth:** USER

**Response `200`:**

```json
{
  "success": true,
  "data": {
    "termsAcceptedAt": "2026-09-20T10:00:00.000Z",
    "privacyAcceptedAt": "2026-09-20T10:00:00.000Z",
    "marketingOptIn": false,
    "marketingOptInAt": null,
    "consentWithdrawnAt": null,
    "deletionRequestedAt": null,
    "deletionScheduledAt": null,
    "deletionCancelledAt": null,
    "deletionRequested": false,
    "notificationPreferences": { "push": true, "email": true, "whatsapp": true, "marketing": false, "visitReminders": true }
  }
}
```

`kycConsentAt`/`partnerTermsVersion`/`partnerTermsAcceptedAt` are included only for a PARTNER account — omitted entirely (not `null`) for a buyer. `deletionRequested` is `true` only while a deletion is actively pending (set and not yet cancelled or carried out) — a convenience boolean so the app doesn't have to derive it from the two timestamps itself.

---

### POST /api/user/privacy/withdraw-consent

Withdraws consent. Distinct from account deletion below — this records that the user no longer consents to how their data is being processed; it does not by itself request erasure. Recorded to the privacy audit trail as `CONSENT_WITHDRAWN`.

**Auth:** USER

**Response `200`:** `{ "success": true, "message": "Consent withdrawn", "data": { "id": "64user...", "consentWithdrawnAt": "2026-10-10T10:00:00.000Z" } }`

---

### POST /api/user/privacy/delete-account

Requests account deletion, with a 30-day grace period before anything is actually anonymized (see `POST /api/user/privacy/delete-account/cancel` below to call it off within that window). Recorded to the privacy audit trail as `DELETION_REQUESTED`.

**Auth:** USER

**Response `200`:** `{ "success": true, "message": "Account deletion requested. You have 30 days to cancel this before your data is anonymised.", "data": { "id": "64user...", "deletionRequestedAt": "2026-10-10T10:00:00.000Z", "deletionScheduledAt": "2026-11-09T10:00:00.000Z" } }`

**Errors:** `400 MONEY_IN_FLIGHT` — blocked while the caller has an escrow payment held (or payment pending / payout failed) as a buyer, or a loan application that hasn't reached `DISBURSED`/`REJECTED`. `400` the account has already been deleted.

A daily job re-checks this same condition right before the grace period actually expires — a block only pauses the request, it never cancels it; it's retried automatically once the money is no longer in flight.

---

### POST /api/user/privacy/delete-account/cancel

Cancels a pending deletion request before the grace period expires. Recorded to the privacy audit trail as `DELETION_CANCELLED`.

**Auth:** USER

**Response `200`:** `{ "success": true, "message": "Account deletion cancelled", "data": { "id": "64user...", "deletionCancelledAt": "2026-10-12T10:00:00.000Z" } }`

**Errors:** `400` there is no pending deletion request to cancel.

---

**What happens when the grace period expires:** personal fields (name, email, phone, address, profile photo, bio, company name, PAN/GSTIN/RERA numbers and verified names, KYC document URLs, bank and billing contact details, RazorpayX payout ids) are overwritten with anonymized placeholders, and the existing `deletedAt` is set. `email`/`clerkId` are reassigned to a unique `deleted-<id>@...` placeholder rather than left real, freeing them up for reuse by someone else signing up. Business records that reference this user (leads, escrow transactions, loan applications, commissions) are left exactly as they were — they simply end up pointing at the now-anonymized row — and the privacy audit trail itself is never touched, recording a final `DELETION_COMPLETED` entry.

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
      "id": "64prop...",
      "title": "3 BHK Flat in Baner",
      "slug": "3-bhk-flat-in-baner-...",
      "price": 8500000,
      "monthlyRent": null,
      "propertyType": "FLAT",
      "listingType": "SALE",
      "bhk": 3,
      "locality": "Baner",
      "city": "Pune",
      "images": ["https://cdn.realtydoor.in/prop1.jpg"],
      "coverImageIndex": 0,
      "isVerified": true,
      "publishStatus": "APPROVED",
      "facing": "East",
      "furnishing": "Semi-Furnished",
      "favoritedAt": "2024-01-12T00:00:00.000Z"
    }
  ]
}
```

**Corrected 2026-10-07 — previously documented a nested shape
(`{id, propertyId, createdAt, property: {...}}`) that doesn't match the
real response.** Each row is the **property's own fields flattened to the
top level** (`id` here is the *property's* id, not a favorite-row id —
there's no separate favorite id in the response at all) plus
`favoritedAt` (when it was saved, not `createdAt`). There is no nested
`property` key and no `propertyId` field.

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
  "leadId": "64lead...",
  "photos": ["https://cdn.realtydoor.in/tickets/leak1.jpg"]
}
```

`category`: `PLUMBING` · `ELECTRICAL` · `PAINTING` · `GENERAL`  
`priority`: `NORMAL` (default) · `HIGH` · `URGENT`  
`propertyId`, `leadId`, and `photos` are all optional. `leadId` (7.8) is the
deal this post-purchase ticket traces back to, when the user knows it —
admin can also set/correct it afterward via `PATCH /admin/tickets/:id/link-deal`.

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

**7.6 — also sets `wasReopened: true`, permanently.** This is what
`GET /admin/tickets/stats`'s `firstTimeVerifyRatePct` checks — whether the
ticket was ever reopened, not just whether the *current* resolve attempt
was clean.

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
  "loanAmountRequestedPaise": 8400000000,
  "tenureMonths": 240,
  "submittedDocIds": ["64doc1...", "64doc2..."],
  "documentSharingConsent": true,
  "documentSharingConsentVersion": "v1"
}
```

All fields are optional **except `documentSharingConsent`, which is
required on every submission** (must be the literal boolean `true`) —
the frontend only lets the user submit after ticking the consent
checkbox, so this is enforced here too, not just when documents happen
to be attached. `submittedDocIds` must be document ids the user already
owns (`POST /api/user/documents`) — checked, not just trusted; a
document belonging to someone else is refused outright.
`documentSharingConsentVersion` is optional, accepted and stored when
given. `loanAmountRequestedPaise` is in paise (₹1 = 100 paise).

**Corrected 2026-10-08 — field names/requiredness now match the
frontend's actual request exactly** (`documentSharingConsent`, not
`consent`; required unconditionally, not only when `submittedDocIds` is
non-empty). `tenureMonths` here is the request field name only — stored
internally as `tenureMonthsRequested`, a separate column from the
`tenureMonths` admin sets at sanction time (`PATCH
/admin/loan/:id/status`), so a sanctioned tenure never overwrites the
record of what was originally requested.

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
    "loanAmountRequestedPaise": 8400000000,
    "tenureMonthsRequested": 240,
    "submittedDocIds": ["64doc1...", "64doc2..."],
    "documentSharingConsentAt": "2024-01-15T00:00:00.000Z",
    "documentSharingConsentVersion": "v1",
    "status": "DOCUMENTS_PENDING",
    "statusHistory": [
      { "status": "DOCUMENTS_PENDING", "at": "2024-01-15T00:00:00.000Z", "note": null }
    ],
    "createdAt": "2024-01-15T00:00:00.000Z"
  }
}
```

`loanAmountRequestedPaise`/`sanctionedAmountPaise`/`emiPaise` are
**`Float`, not `Int`, as of 2026-10-08** — a real home loan routinely
exceeds the ~₹2.14 crore ceiling a 32-bit `Int` can hold in paise,
which would have overflowed or silently truncated. Still plain JSON
numbers in paise, nothing about reading them changes, just the range.

`statusHistory` is seeded with a first `DOCUMENTS_PENDING` entry the
moment the application is created — see `PATCH .../status` below for
its full shape and how it grows.

**Errors:** `400` `documentSharingConsent` not `true` · `400` one or more submitted document ids don't belong to the caller.

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
      "loanAmountRequestedPaise": 8400000000,
      "tenureMonthsRequested": 240,
      "sanctionedAmountPaise": null,
      "adminNote": null,
      "statusHistory": [
        { "status": "DOCUMENTS_PENDING", "at": "2024-01-15T00:00:00.000Z", "note": null }
      ],
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

### POST /api/partner/data-acknowledgments

Record acceptance of a lead-data-handling or post-OTP-restricted-use notice
(R34 / R35).

**Auth:** PARTNER

**Request Body:**

```json
{ "type": "LEAD_DATA_HANDLING", "version": "2026-10-v1" }
```

| Field | Required | Notes |
| --- | --- | --- |
| `type` | yes | `LEAD_DATA_HANDLING` or `POST_OTP_RESTRICTED_USE`. |
| `version` | yes | Whatever version string the frontend showed — recorded as given, not validated against a registry (same convention as `partnerTermsVersion`). |
| `leadId` | conditional | **Required** for `POST_OTP_RESTRICTED_USE` (recorded per lead) · **must be omitted** for `LEAD_DATA_HANDLING` (recorded once per partner). |

Re-posting the same `(type, version, leadId)` refreshes the timestamp rather
than erroring or duplicating.

**Response `201`:** the acknowledgment row.

**Errors:** `400` `leadId` missing for `POST_OTP_RESTRICTED_USE`, or present for
`LEAD_DATA_HANDLING`.

---

### GET /api/partner/data-acknowledgments

**Auth:** PARTNER

**Query:** `type` (default `LEAD_DATA_HANDLING`) · `leadId` (for
`POST_OTP_RESTRICTED_USE`)

**Response `200`:**

```json
{
  "success": true, "message": "Success",
  "data": {
    "type": "LEAD_DATA_HANDLING", "accepted": true, "version": "2026-10-v1",
    "acceptedAt": "2026-10-04T12:00:00.000Z",
    "requiredVersion": "2026-10-v1", "isCurrent": true
  }
}
```

**`requiredVersion`/`isCurrent` are `null` until the business configures a
required version** via the admin config key
`lead_data_handling_required_version`. Until then, every partner's
acknowledgment reads as accepted-but-not-applicable-for-currency — there is
nothing to be current against yet.

**`LEAD_DATA_HANDLING` gates lead dispatch (R34).** `PATCH
/api/admin/leads/:id/assign` refuses with `400` when the target partner's
latest acceptance doesn't match the configured required version. **This gate
is off by default** — it only activates once
`lead_data_handling_required_version` is set, so it cannot lock out every
partner the day this ships.

**`POST_OTP_RESTRICTED_USE` gates nothing yet.** Whether it should gate
anything (e.g. "call the buyer") is an explicit open decision — this endpoint
only records the acknowledgment.

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

### GET /api/partner/payouts

R31 — the "Released" screen (B12.6): per-deal RazorpayX payout status and
UTR, not just the aggregate totals above. Only escrows that ever had a
payout attempted for this partner are listed — a `HELD` or buyer-refunded
escrow has nothing to show here.

A payout is created `processing` synchronously when admin releases the
escrow, then settles asynchronously. `partnerPayoutStatus` is corrected in
place by the RazorpayX webhook once it does — `processed` (with
`partnerPayoutUtr` now set) on success, `failed`/`reversed` if the money
didn't land after all (which also flags the escrow for admin review).

**Auth:** PARTNER + KYC verified

**Query Parameters:** `page`, `limit`

**Response `200`:**

```json
{
  "success": true, "message": "Success",
  "data": {
    "data": [
      {
        "id": "...", "amount": 250000, "status": "RELEASED",
        "releasedAt": "2026-09-20T10:00:00.000Z",
        "razorpayPartnerPayoutId": "payout_xxx",
        "partnerPayoutStatus": "processed",
        "partnerPayoutUtr": "UTR123456789",
        "lead": { "id": "...", "buyerName": "Ravi Kumar", "property": { "title": "3BHK in HSR Layout" } }
      }
    ],
    "pagination": { "page": 1, "limit": 20, "total": 4, "pages": 1 }
  }
}
```

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
  "bankHolderName": "Ravi Kumar"
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `bankName` | Yes | Bank name |
| `bankAccountNo` | Yes | Full account number (5–20 chars) |
| `bankIfsc` | Yes | Must match pattern `XXXX0XXXXXX` |
| `bankHolderName` | Yes | Name as on bank account |
| `bankBranch` | No | Branch name/address |

This endpoint never talks to Razorpay at all — it is plain bank-detail
storage. The actual payout account (RazorpayX contact + fund account,
created and validated with Razorpay) is a separate concept — see
`GET`/`POST /api/partner/payout-account`. A `razorpayRouteAccountId` field
existed here historically (Razorpay Route, evaluated and rejected in favour
of RazorpayX Payouts) and has been removed from this endpoint; the schema
column is kept so old rows aren't silently dropped, but nothing reads or
writes it.

**Response `200`:** `{ "success": true, "message": "Bank account updated", "data": { ...bank fields } }`

**Errors:** `400` invalid IFSC format.

---

### GET /api/partner/billing

Billing details — who the commission invoice is addressed to, not where
payouts land (that's the bank account above / the RazorpayX payout account).

**Auth:** PARTNER + KYC verified

**Response `200`:**

```json
{
  "success": true, "message": "Success",
  "data": {
    "billingLegalName": "Sharma Realty Private Limited",
    "gstin": "27AAAPL1234C1ZV",
    "billingAddress": "12 MG Road, Pune, Maharashtra 411001",
    "billingAccountsContactName": "Finance Team",
    "billingAccountsContactEmail": "finance@sharmarealty.example.com",
    "billingAccountsContactPhone": "+919800011122"
  }
}
```

### PATCH /api/partner/billing

**Auth:** PARTNER + KYC verified

**Request Body:** any subset of the fields above — at least one required.

**`gstin` is NOT a new field** — it's the existing partner-identity `gstin`
(docs 3.2/3.3/B1.6), also settable via `PATCH /api/partner/profile`. This
endpoint validates it against the real GSTIN format
(`\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]`); the profile endpoint's own
`gstin` field is only loosely length-checked, so prefer this endpoint when
you actually need the format enforced.

**`billingLegalName` is deliberately distinct from `companyName`** (the
partner's trading/display name, shown throughout the app) — a partner can
trade under one name while being registered, for GST/invoicing purposes,
under a different legal entity name. **`billingAddress` is deliberately
distinct from the buyer-facing `address` field** — that one is a buyer's
personal address; this is a business billing address.

**Errors:** `400` invalid GSTIN format, or no field provided.

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

`amount` in ₹. **Capped at a % of the deal's own price** (`escrow_max_token_pct` config, default 10) — `dealPriceAtLock` when commission terms are already set, else the live listing price. Skipped (not refused) when neither is known yet (a free-text lead with no resolvable price). **`escrow_max_token_pct` and `escrow_min_amount_rupees` are both public** (`GET /api/config/public`, 2026-10-08) — the frontend reads its floor/ceiling from there instead of hardcoding `50000`/`10%`.

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
    "razorpayOrder": { "id": "order_...", "amount": 5000000, "currency": "INR" },
    "key": "rzp_live_...",
    "refundProtectionFeePct": 0
  }
}
```

**Added 2026-10-08 — `key` and `refundProtectionFeePct` were both
missing.** `key` is Razorpay's **public** checkout key id
(`RAZORPAY_KEY_ID` — never the secret), so the frontend's Checkout widget
has something to open with straight from this response instead of
needing its own `NEXT_PUBLIC_RAZORPAY_KEY_ID` kept in sync.
`refundProtectionFeePct` is config-driven (`escrow_refund_protection_fee_pct`,
default `0` — genuinely free today, not a placeholder); return this
instead of hardcoding "Free" in the UI, so it's correct the moment it's
ever configured non-zero.

`payment.captured` webhook moves status to `HELD`.  
**Errors:** `404` lead not found or not yours · `400` lead isn't `SITE_VISIT_DONE` yet, amount below minimum or above the deal-price cap, or active escrow already exists.

---

### GET /api/escrow/:id/receipt

**Added 2026-10-08** — the buyer's token-advance payment receipt. Previously there was no backend endpoint at all; the frontend's "receipt" was a browser print of the on-screen summary.

**Auth:** USER (must be the escrow's own buyer)

**Response `200`:** a PDF file (`Content-Type: application/pdf`,
`Content-Disposition: attachment`), not the usual JSON envelope — same
pattern as `GET /api/locality-insights/report`. Generated fresh on every
call from the escrow/lead/property data already on file — not a GST tax
invoice (no GSTIN/HSN/CGST-SGST split), same scope as the commission and
ticket-charge receipts.

**Errors:** `404` escrow not found or not yours · `400` no payment has
been captured yet for this escrow (nothing to issue a receipt for).

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
    "citySlug": "pune",
    "localitySlug": "baner",
    "avgPricePerSqftPaise": 2500000,
    "minPricePerSqftPaise": 2200000,
    "maxPricePerSqftPaise": 2800000,
    "avgRentPerMonthPaise": null,
    "priceChangeLastMonthPct": 8.5,
    "nearbyInfra": ["Metro", "Highway"],
    "subtitle": "Prime residential locality...",
    "localityScore": null,
    "marketStage": null,
    "rentalDemand": null,
    "infrastructureStrength": null,
    "bestFor": [],
    "medianPricePaise": null,
    "medianPricePropertyType": null,
    "avgRentYieldPct": null,
    "priceTrends": null,
    "propertyMix": null,
    "microMarkets": null,
    "keyInfrastructure": null,
    "connectivity": null,
    "infrastructureProjects": null,
    "prosAndCons": null,
    "investmentScore": null,
    "buyVsRent": null,
    "faqs": null,
    "dataAsOfDate": "2024-01-15T00:00:00.000Z",
    "updatedByAdminId": "64admin...",
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-15T00:00:00.000Z"
  }
}
```

**Corrected 2026-10-07 — this is now the actual full record** (the
endpoint returns the raw `LocalityInsight` row with no field selection,
so every field on the Prisma model comes through). The example previously
showed only the core price-panel fields; everything from `localityScore`
down through `faqs` is the admin-curated market-intelligence section
(`/admin/cms/locality-insights`), all `null` until an admin fills it in
for that city/locality. `priceTrends`/`propertyMix`/`microMarkets`/
`keyInfrastructure`/`connectivity`/`infrastructureProjects`/
`prosAndCons`/`investmentScore`/`buyVsRent`/`faqs` are free-form JSON —
see `prisma/schema/locality.prisma` for each one's expected inner shape.

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
    "telecaller_phone": "+919844412345",
    "escrow_min_amount_rupees": "50000",
    "escrow_max_token_pct": "10"
  }
}
```

Returns a flat key → value object — **every value is a string**, including numeric-looking ones like `escrow_min_amount_rupees`; parse on the client. Only keys with `isPublic: true` appear here. `telecaller_phone` is the shared number the frontend's "Contact agent" action should dial — the buyer is never given the assigned partner's own phone number (see `PATCH /api/admin/leads/:id/assign` and `GET /api/user/leads`). `escrow_min_amount_rupees`/`escrow_max_token_pct` (added 2026-10-08, P3) are the escrow token-advance floor/ceiling — read these instead of hardcoding `50000`/`10%` on the token-amount form.

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
        "addedByPartner": { "name": "Rajdeep Kumar", "companyName": "RealtyPro Solutions" },
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

`buyer` (full identity, unlike every buyer- or partner-facing endpoint) and `inquiryCount` (total leads this buyer has ever submitted, across all statuses — a quick abuse signal against the per-buyer limits on `POST /api/leads`) are admin-only additions. `buyer` is `null` for legacy leads with no linked account (see `scripts/backfillLeadBuyerId.js`). `addedByPartner` (`name`/`companyName` only) is `null` unless this lead came in via the partner self-sourced path (`POST /api/leads/partner`) — the admin list previously showed this column blank with no way to tell who submitted it.

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
  "city": "Bengaluru",
  "budget": "1-1.2Cr",
  "note": "Called the office, wants a callback this week.",
  "partnerId": "64partner...",
  "consent": true
}
```

`source` is one of `PHONE` · `WALK_IN` · `REFERRAL` · `EMAIL` · `OTHER`. **Either `propertyId` or `propertyInterest` is required** — `propertyId` for a live listing, `propertyInterest` as free text when the property isn't on the platform (in which case `propertyId` comes back `null`, so treat `property` as nullable in responses). `buyerEmail`, `budget`, `note` and `partnerId` are optional.

**`city` is required when `propertyId` is not given** — a free-text lead still needs a city for the commission rate-card lookup (`property → city → platform default`) to have anything to resolve against. Ignored (stored as `null`) when `propertyId` is given, since the property's own city is used instead.

**`consent` is required and must be the literal boolean `true`** (docs-backend-gaps-handoff.md #4) — not merely truthy, a checkbox that was actually checked. Admin is attesting consent on behalf of a buyer who never interacted with the platform directly, the same reason the partner self-sourced path (`POST /api/leads/partner`) requires it too. Recorded as `buyerConsentAt` on the lead (a timestamp, not a bare boolean — it is the evidentiary record of *when*, same convention as `User.kycConsentAt`). Not required on a buyer's own `POST /api/leads` submission — they are the one submitting, so there is no third party attesting on their behalf.

**Duplicate check, when `propertyId` is given:** refuses with `409` if this
buyer phone already has an active (not `CLOSED`/`DROPPED`) lead on the same
property — the same rule `POST /api/leads/partner` already enforced, now
applied here too. Only runs when a real listing is named; a
`propertyInterest`-only lead has nothing to deduplicate against.

Passing `partnerId` assigns the lead immediately (`status: ASSIGNED`) and notifies that partner; the partner must be KYC-verified, same gate as `/assign`. **It also pre-fills and locks the lead's commission terms** from the rate-card chain (`property → city → platform default`), the same pre-fill `POST .../commission/prefill` performs, immediately followed by the same lock `POST .../commission/lock` performs. This is a deliberate reversal of the earlier "pre-fill only, admin locks separately" behavior — terms are now locked the moment a lead is assigned. A pre-fill or lock failure (most commonly 3.17 — the partner owns this listing, or no rate card resolves at all) is logged and swallowed, never undoing the assignment that already succeeded; check `GET .../commission` afterward if you need to confirm it took, and finish manually via the prefill/lock endpoints if not.

Without `partnerId` the lead lands as `UNASSIGNED`. Repeat buyers are linked via `relatedLeadId` exactly as in `POST /api/leads/partner`. `buyerId` stays `null` — nobody authenticated. Writes an audit log.

**Response `201`:** the created lead.

**Errors:** `400` `consent` missing or not `true`, neither `propertyId` nor `propertyInterest` given, or partner not found / not KYC verified · `404` property not found · `409` an active lead already exists for this buyer and property (`DUPLICATE_LEAD`).

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

Assign a lead to a KYC-verified partner — or **reassign** it, if it's
already assigned to someone else.

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

**Reassignment (2026-10-07):** passing a `partnerId` different from the
lead's current `assignedPartnerId` reassigns it — the previous partner is
notified (`LEAD_ASSIGNED`, "Lead reassigned") and the new one is notified
as usual, and the audit log action is `LEAD_REASSIGNED` (`before`/`after`
both carry `assignedPartnerId`) instead of `LEAD_ASSIGNED`. Passing the
**same** `partnerId` the lead is already assigned to is refused — a no-op
the UI shouldn't be sending, not a real reassignment.

Also sends the buyer an in-app `LEAD_ASSIGNED` notification (`linkUrl: /user/inquiries/:leadId`) naming the partner by `companyName`/`name` only — the partner's phone is never included, in the message or anywhere else the buyer can see. The buyer's own lead detail (`GET /api/user/leads/:id`) likewise never exposes `assignedPartner.phone`; the frontend's "Contact agent" action should dial the shared number from `GET /api/config/public`'s `telecaller_phone` instead.

**Also pre-fills and locks commission terms**, same as `POST /api/admin/leads` with a
`partnerId` above — populated and locked, not left editable; a pre-fill or
lock failure is logged and swallowed rather than undoing the assignment.
**On a reassign where terms are already locked to the previous partner**,
the pre-fill refuses (`COMMISSION_LOCKED`) and that failure is swallowed
the same way — the reassignment itself still succeeds, but the now-stale
terms (still naming the previous partner) are left for admin to revise by
hand via `PUT .../commission` (writes a new version, same as any
post-lock edit). `POST /api/admin/leads/:id/auto-assign` and the batch
form both call this function internally, so they get the same
pre-fill-and-lock for free — but auto-assign itself still refuses an
already-assigned lead outright (reassignment is a deliberate admin
action, not something the auto-picker does).

**Errors:** `404` lead not found · `400` partner not found or not KYC verified · `409` already assigned to this same partner.

---
## Auto-assign leads

The backend picks the partner instead of the admin naming one. Both forms
reuse `assignLead` internally — every guard that endpoint already enforces
(KYC-verified, not already assigned, not closed/dropped, the `LEAD_DATA_HANDLING`
gate above) applies identically whether a human or the picker chose the
partner. Neither endpoint writes `assignedPartnerId` directly.

**Routing rules (backend-work-still-open.md #7) are tried first, ahead of
everything below.** If an active `RoutingRule` (`GET/POST/PATCH/DELETE
/api/admin/routing-rules`, documented after this section) matches the
lead's city/locality/source/propertyType and names a `targetPartnerId`,
that partner gets first refusal — even over a less-loaded candidate, and
even if they have `leadAutoAccept: false` (a deliberate admin override,
not the generic opt-in). They still have to be KYC-verified and not
currently signalling overload (`leadPauseOverloaded`); if they fail
`assignLead`'s own gates, this falls through to the eligibility/ranking
below exactly as it would for any other candidate.

**Eligibility, applied in this order — none of it skipped:**

| Check | Why |
| --- | --- |
| `role: PARTNER`, `kycStatus: VERIFIED`, not soft-deleted | Same bar as manual assignment. |
| `leadAutoAccept: true` | **Defaults to `false`.** A partner who has never touched Settings is excluded by default — auto-assign only reaches partners who opted in. |
| `leadPauseOverloaded` is not `true` | **Defaults to `true`.** Combined with the above, a brand-new partner is excluded on *both* counts until they configure Settings, not just one. `{ not: true }` matches `false` and a genuinely missing field alike, so a partner who predates this setting is not silently excluded by the missing-value case specifically — they are excluded by the default value instead, which is the intended outcome either way. |
| The `LEAD_DATA_HANDLING` acknowledgment gate | Same as manual `assign` — see **Data acknowledgments** above. A candidate who fails only this check is skipped in favour of the next one, not treated as "no eligible partner". |

**Locality ranking** (does not exclude anyone — it only orders the pool):
1. `leadPreferredLocalities` contains the property's locality
2. `leadPreferredLocalities` contains the property's city
3. `coverageAreas` contains the locality
4. `coverageAreas` contains the city
5. No locality signal at all — every eligible partner

The first non-empty tier wins. Within a tier, the partner with the **fewest
currently active leads** (`status notIn [CLOSED, DROPPED]`) is picked —
current workload, not lifetime volume, so a partner who closed 200 deals last
year but has none open now ranks above one sitting on 10 open leads today.

This means a lead in a locality nobody specifically covers is still
assignable — it falls through to tier 5 rather than coming back as
unassignable, which would be the more "correct"-looking but far less useful
behaviour.

---

### POST /api/admin/leads/:id/auto-assign

Auto-assign one lead.

**Auth:** ADMIN

**Request Body:** none.

**Response `200`:**

```json
{
  "success": true,
  "message": "Assigned to Sharma Realty",
  "data": {
    "lead": { "id": "...", "status": "ASSIGNED", "assignedPartnerId": "..." },
    "assignedTo": { "id": "...", "name": "Rahul Sharma", "companyName": "Sharma Realty", "activeLeads": 2 },
    "candidatesConsidered": 1
  }
}
```

`candidatesConsidered` is 1 unless an earlier-ranked candidate failed the
data-handling gate and was skipped — then it is however many were tried
before one actually succeeded.

**Errors:**
- `400` no eligible, KYC-verified, opted-in partner exists at all (names the
  most likely cause — nobody has turned on auto-accept yet)
- `400` every eligible candidate failed for the same reason (names each)
- `404` lead not found · `409` already assigned · `400` lead is
  `CLOSED`/`DROPPED`

---

### POST /api/admin/leads/auto-assign

Auto-assign every currently `UNASSIGNED` lead in one call. Registered
**above** `/leads/:id` — a static path, never swallowed as a lead id.

**Auth:** ADMIN

**Query:** `propertyId` · `city` — both optional, narrow which unassigned
leads are considered. Omit both to sweep every unassigned lead in the system.

**Response `200`:**

```json
{
  "success": true,
  "message": "4 of 5 lead(s) assigned",
  "data": {
    "totalConsidered": 5, "assignedCount": 4, "failedCount": 1,
    "assigned": [{ "leadId": "...", "refCode": "L-2231", "partnerId": "...", "partnerName": "Rahul Sharma" }],
    "failed": [{ "leadId": "...", "refCode": "L-2240", "reason": "No eligible, KYC-verified partner is available..." }]
  }
}
```

**One lead's failure never stops the rest.** Each lead is picked and assigned
independently; both lists are returned so nothing is silently dropped from a
partial run.

---

## Routing rules (backend-work-still-open.md #7)

Admin-named partner/vendor overrides for lead auto-assign and ticket
auto-dispatch. A typed CRUD resource — the handoff doc explicitly flagged
the storage shape as a decision needed before building, and a dedicated
endpoint was chosen over a generic `/config/:key` blob.

Each rule has an `entityType` (`LEAD` or `TICKET`), a `priority` (lower
evaluated first), an `isActive` flag, a sparse set of conditions (every
field that is *set* must match; an unset field matches anything), and
exactly one target matching its `entityType`:

| entityType | Condition fields | Target |
| --- | --- | --- |
| `LEAD` | `city`, `locality`, `source`, `propertyType` | `targetPartnerId` |
| `TICKET` | `city`, `category` | `targetVendorId` |

The first active rule (in priority order) whose every set condition
matches wins. A rule with no conditions at all is a catch-all for its
entityType.

### GET /api/admin/routing-rules

**Auth:** ADMIN

**Query Parameters:** `page`, `limit`, `entityType` (`LEAD` · `TICKET`)

**Response `200`:** paginated list of rules, ordered by `entityType` then `priority`.

---

### POST /api/admin/routing-rules

**Auth:** ADMIN

**Request Body:**

```json
{ "entityType": "LEAD", "city": "Pune", "priority": 0, "targetPartnerId": "64partner..." }
```

A `LEAD` rule must set `targetPartnerId` (and not `targetVendorId`); a
`TICKET` rule must set `targetVendorId` (and not `targetPartnerId`) —
enforced by the request schema, not left to be caught later.

**Response `201`:** the created rule. **Errors:** `400` wrong target for
the entityType, or validation failure · `404` the named partner/vendor
doesn't exist.

---

### PATCH /api/admin/routing-rules/:id

Update conditions, priority, isActive, or the target. `entityType` itself
can't change — delete and recreate instead.

**Auth:** ADMIN

**Request Body:** any subset of the create fields except `entityType`.

**Response `200`:** the updated rule. **Errors:** `400` the target
doesn't match the rule's existing entityType · `404` rule or named
partner/vendor not found.

---

### DELETE /api/admin/routing-rules/:id

**Auth:** ADMIN

**Response `200`:** `{ "id": "..." }`. **Errors:** `404` rule not found.

---

### POST /api/admin/tickets/:id/auto-dispatch

Rule-driven alternative to naming a vendor manually via `PATCH
.../tickets/:id/dispatch`. Looks up the first matching active `TICKET`
rule by the ticket's `category` and (if it has a linked property) city,
and dispatches to that rule's vendor — same underlying `dispatchTicket`
function a manual dispatch uses, so it enforces the same gates (ticket
not terminal, vendor active).

Unlike lead auto-assign, there is **no ranked fallback pool** for
vendors — no existing workload/coverage model to fall back to — so "no
rule matches" is a plain refusal, not a partial pick.

**Auth:** ADMIN

**Request Body:** none.

**Response `200`:** the dispatched ticket (same shape as manual dispatch).

**Errors:** `400` no active rule matches this ticket's category/city, or
the matched rule's vendor is not active · `404` ticket not found.

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

Approve a pending listing. Notifies partner + sends email. Takes an optional
visibility choice — see **Listing visibility and requested changes (docs 4.14 /
4.15)** below for the request body, the three visibility levels and the
`isSearchable` semantics.

**Auth:** ADMIN

**Request Body:** optional — `{ "visibility": { "searchable": true, "homepageFeatured": false } }`

**Response `200`:**

```json
{ "success": true, "message": "Property approved (visible in: public, search)", "data": { "id": "...", "publishStatus": "APPROVED", "isSearchable": true, "isFeatured": false, "rejectionNote": null } }
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

## Exclusive mandates (docs 4.3)

The mandate a partner holds to market a specific unit on an owner's behalf.
The owner's identity is recorded here because conflict detection (4.4) uses it
to check an agent is not quietly listing their own property as somebody
else's.

**Only `ACTIVE` and `REVOKED` are stored.** `EXPIRED` is derived from
`expiryDate` against the current time on every read, so there is no scheduled
job and no window in which a mandate is past its expiry but still reads as
active. Every mandate response therefore carries **`effectiveStatus`**, which
is one of `ACTIVE`, `EXPIRED` or `REVOKED` — read that, not `status`.

---

### POST /api/admin/properties/:id/mandates

**Auth:** ADMIN

**Request Body:**

```json
{
  "ownerName": "Suresh Mehta",
  "ownerPhone": "+919000000099",
  "ownerEmail": "suresh@example.com",
  "ownerPan": "ABCDE1234F",
  "startDate": "2026-10-01T00:00:00.000Z",
  "expiryDate": "2026-12-31T00:00:00.000Z",
  "documentUrl": "https://.../mandate.pdf",
  "note": "Signed hard copy held at the Pune office",
  "partnerId": "6a44a67a..."
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `ownerName` | yes | 2–120 chars. |
| `ownerPhone` | yes | Indian phone format. |
| `ownerEmail` | no | |
| `ownerPan` | no | Validated as `AAAAA9999A` and stored uppercased with spaces stripped, so a formatting difference cannot defeat the 4.4 PAN comparison. Format only — not a checksum. |
| `startDate` / `expiryDate` | yes | ISO datetimes. `expiryDate` must be after `startDate`. |
| `documentUrl` | no | Must be a URL. |
| `partnerId` | no | Defaults to the listing's own partner. |

**Response `201`:**

```json
{
  "success": true,
  "message": "Mandate created; 1 conflict(s) detected",
  "data": {
    "mandate": { "id": "...", "status": "ACTIVE", "effectiveStatus": "ACTIVE", "ownerPan": "ABCDE1234F", "...": "..." },
    "conflicts": [{ "id": "...", "type": "AGENT_OWNER_PAN_MATCH", "detail": "...", "status": "OPEN" }]
  }
}
```

Creating a mandate runs conflict detection immediately, because this is the
moment the agent/owner and overlap checks become answerable. Any conflicts
raised come back in the same response.

**Errors:**
- `409` the listing already has a mandate in force — the message gives its
  expiry date. Revoke it first.
- `400` `expiryDate` not after `startDate`, or a malformed `ownerPan`
- `404` property not found

One-mandate-in-force is enforced by a check, not a unique index, because "in
force" depends on the current time and a partial index cannot express that. Two
admins creating a mandate in the same instant could both pass; that case shows
up as a `MANDATE_OVERLAP` conflict rather than going unnoticed.

---

### GET /api/admin/properties/mandates

**Auth:** ADMIN

**Query:** `propertyId` · `partnerId` · `status` (`ACTIVE`, `EXPIRED`,
`REVOKED`) · `page` · `limit`

Filtering by `status` filters on the **derived** meaning: `ACTIVE` means stored
`ACTIVE` and not yet past expiry, `EXPIRED` means stored `ACTIVE` but past it.

**Response `200`:** paginated mandates, each with `effectiveStatus`, its
`property` and its `partner` (including `partnerSubType`).

---

### GET /api/admin/properties/mandates/:id

**Auth:** ADMIN

**Response `200`:** the mandate, with `effectiveStatus`, the property
(including `address`) and the partner (including `panNumber`, so the PAN
comparison behind an `AGENT_OWNER_PAN_MATCH` conflict can be checked by eye).

**Errors:** `404` not found.

---

### PATCH /api/admin/properties/mandates/:id/revoke

**Auth:** ADMIN

**Request Body:** `{ "reason": "Owner withdrew from the market" }` — required,
5–500 chars. The partner is notified with this text verbatim.

**Response `200`:** the mandate, `status: "REVOKED"`, `effectiveStatus:
"REVOKED"`.

Revoking frees the listing to receive a new mandate.

**Errors:** `400` already revoked · `404` not found.

---

## Listing conflicts (docs 4.4)

Detected automatically when a listing is created and when a mandate is issued,
and re-runnable on demand. Three types:

| Type | Means |
| --- | --- |
| `DUPLICATE_UNIT` | The same physical unit appears on another listing. |
| `AGENT_OWNER_PAN_MATCH` | A mandate's owner PAN equals the submitting partner's own PAN — the partner is listing their own property as someone else's. |
| `MANDATE_OVERLAP` | Two unexpired mandates cover the same unit, held by different partners. |

**How "the same unit" is decided.** There is no unit identifier anywhere in
this schema, so `DUPLICATE_UNIT` uses a heuristic key: the address is
lowercased, split on anything non-alphanumeric, stripped of unit-designator
words (`flat`, `apt`, `unit`, `no`, `house`, `shop`, …), and the remaining
tokens are **sorted** before joining. `pincode`, `floorNumber` and `bhk` must
all match too.

- Catches: punctuation, case, spacing, word order, and a leading
  "Flat"/"Apt"/"No." — so `Flat 302, Tower B, Palm Grove` matches
  `302  tower-b   palm grove`.
- Will also match two genuinely different units when the address records only
  the building and not the unit number. This is why `DISMISSED` exists, and why
  the key is stored on the conflict row as `unitKey` — a false positive can be
  traced to exactly what matched.
- Will miss the same unit described with different wording (`Palm Grove` vs
  `Palmgrove Residency`), or a different pincode/floor/BHK typed for the same
  unit.

Words like `road`, `street`, `tower`, `block` and `wing` are deliberately
**not** stripped, because they distinguish real addresses — dropping `road`
would make `5 Palm Road` and `5 Palm Street` collide.

A listing with no `address` or no `pincode` cannot be keyed, so duplicate
detection is **skipped** for it rather than guessed at.

**Detection is a prompt for a human, not a verdict.**

---

### POST /api/admin/properties/:id/detect-conflicts

Re-runs all three checks for one listing.

**Auth:** ADMIN

**Response `200`:**

```json
{
  "success": true,
  "message": "1 new conflict(s) detected",
  "data": { "detected": 1, "conflicts": [{ "id": "...", "type": "DUPLICATE_UNIT", "detail": "...", "unitKey": "302-b-grove-palm-tower|411038|3|3" }] }
}
```

Idempotent: a conflict is written only when an `OPEN` one of the same type and
same counterpart listing is not already there, so re-running never piles up
duplicate rows. `detected` counts only newly created rows.

Detection also runs automatically inside `POST /api/properties` (listing
submission) and `POST /api/admin/properties/:id/mandates`. In the submission
case a detector failure is logged and swallowed — a transient problem finding
conflicts must not reject a listing the partner legitimately submitted — so
this endpoint is the way to catch up if that happens.

**Errors:** `404` property not found.

---

### GET /api/admin/properties/conflicts

**Auth:** ADMIN

**Query:** `status` — `OPEN` (default), `RESOLVED`, `DISMISSED`, or `ALL` ·
`type` · `propertyId` · `page` · `limit`

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "data": [
      {
        "id": "...",
        "type": "DUPLICATE_UNIT",
        "detail": "The same unit is listed by a different partner as \"3BHK in Palm Grove\".",
        "unitKey": "302-b-grove-palm-tower|411038|3|3",
        "status": "OPEN",
        "property": { "id": "...", "title": "...", "slug": "...", "city": "Pune", "publishStatus": "PENDING_APPROVAL", "partnerId": "..." },
        "conflictingPropertyId": "6a44a67e...",
        "conflictingProperty": { "id": "...", "title": "...", "slug": "...", "publishStatus": "APPROVED", "partnerId": "..." },
        "resolution": null, "resolvedByAdminId": null, "resolvedAt": null,
        "detectedAt": "2026-10-04T12:10:00.000Z"
      }
    ],
    "total": 1, "page": 1, "limit": 20, "totalPages": 1
  }
}
```

`conflictingProperty` is `null` for a conflict that is not about a second
listing (`AGENT_OWNER_PAN_MATCH`), or when that listing has since been deleted.
It is stored as a plain id rather than a relation because Prisma forbids
`onDelete: SetNull` on a self-relation, which would have made a referenced
property undeletable.

**Errors:** `400` unrecognised `status`.

---

### PATCH /api/admin/properties/conflicts/:id/resolve

**Auth:** ADMIN

**Request Body:**

```json
{ "status": "DISMISSED", "resolution": "Different units; the address omitted the unit number" }
```

| Field | Required | Notes |
| --- | --- | --- |
| `status` | yes | `RESOLVED` (a real conflict, dealt with elsewhere) or `DISMISSED` (the detector matched two genuinely different units). |
| `resolution` | yes | 5–1000 chars. Mandatory for both outcomes: the next person needs to know which it was and why. |

**Response `200`:** the updated conflict.

**Errors:** `400` not `OPEN`, bad `status`, or `resolution` too short ·
`404` not found.

---

## Mortgage and loan NOC (docs 4.5)

Four fields on `Property`, settable on create and update by the partner and by
admin edit, and returned on the property detail:

| Field | Type | Notes |
| --- | --- | --- |
| `isMortgaged` | `Boolean?` | **Nullable on purpose.** `null` means "not recorded", which is the truth for every listing predating these fields, and is a different thing from someone having actively answered "no". |
| `mortgageLender` | `String?` | Max 200 chars. |
| `loanNocStatus` | enum? | `NOT_REQUIRED`, `PENDING`, `RECEIVED`, `REJECTED`. |
| `loanNocUrl` | `String?` | Must be a URL. |

**Why `isMortgaged` is nullable rather than `Boolean @default(false)`:** a
Prisma default is applied only at create time, so a required boolean added now
would be *missing*, not `false`, on the 28 listings that already exist. A
required field offers no `isSet` filter, so those rows could not have been
queried or repaired from the Prisma client at all. Nullable keeps them
queryable (`{ isMortgaged: { isSet: false } }`) and avoids a backfill.

Treat `null` as "unknown, ask" rather than as "no" in the owner-listing review.
---

## Listing review checklist (docs 4.1 / 4.2)

A listing's required-document checklist is **persona-specific**, derived from
the submitting partner's `partnerSubType` (`OWNER`, `AGENT`, `BUILDER`, or
unset).

**Scope note — this is not three parallel checklists.** AGENT's items (mandate
letter, owner PAN, owner confirmation) are already fully modelled elsewhere —
`ExclusiveMandate.documentUrl`, `ExclusiveMandate.ownerPan`, and
`OwnerConfirmation` below — so nothing new was built to track them a second
time; the checklist response just points at where each one actually lives.
BUILDER's items (RERA project number, approved plan, commencement certificate,
land title, designated account) belong to a developer-led **Project**, not a
single unit listing — docs 4.10/4.11's Project entity, which does not exist
yet. The checklist reports `available: false` for BUILDER rather than
inventing a per-listing stand-in. **The only new upload/verify model is for
OWNER's genuinely unmodelled items**: sale deed, encumbrance certificate,
khata, society NOC. Loan NOC — also an owner item — already exists as
`Property.loanNocStatus` / `loanNocUrl` (doc 4.5) and is folded into the same
response rather than duplicated.

**4.2's owner confirmation is admin-recorded this phase, not WhatsApp-automated.**
WATI template/conversation work for this was explicitly deferred. An admin
confirms with the owner by whatever channel is actually used — phone call,
email, WhatsApp sent by hand — and records the outcome through the endpoints
below. `requestedVia` is free text describing that channel, not something this
backend drives.

---

### GET /api/admin/properties/:id/checklist

**Auth:** ADMIN

### GET /api/properties/:id/checklist

The partner's own view of the same checklist, scoped to their own listing.

**Auth:** PARTNER (no KYC gate, matching the existing free-form document
upload)

**Response `200`, OWNER persona:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "propertyId": "6a44a67d...",
    "partnerSubType": "OWNER",
    "persona": "OWNER",
    "available": true,
    "reason": null,
    "items": [
      { "id": "6ad1...", "type": "SALE_DEED", "label": "Sale deed", "status": "APPROVED", "fileUrl": "https://...", "uploadedAt": "2026-10-04T...", "rejectionNote": null },
      { "id": "6ad2...", "type": "ENCUMBRANCE_CERTIFICATE", "label": "Encumbrance certificate", "status": "PENDING_REVIEW", "fileUrl": "https://...", "uploadedAt": "2026-10-04T...", "rejectionNote": null },
      { "id": null, "type": "KHATA", "label": "Khata", "status": "MISSING", "fileUrl": null, "uploadedAt": null, "rejectionNote": null },
      { "id": null, "type": "SOCIETY_NOC", "label": "Society NOC", "status": "MISSING", "fileUrl": null, "uploadedAt": null, "rejectionNote": null }
    ],
    "missingCount": 2,
    "ready": false,
    "elsewhere": [],
    "conditionalItems": ["LOAN_NOC (only if the listing is mortgaged)"],
    "ownerConfirmation": null,
    "activeMandateId": null
  }
}
```

`items[].status` is one of `MISSING`, `PENDING_REVIEW`, `APPROVED`, `REJECTED`
— `MISSING` is not a `DocumentStatus` enum value, it means no row exists yet.
`items[].id` is the backing `PropertyDocument` row's ID, or `null` when
`status` is `MISSING` (there's no row yet to reference) — needed by the
frontend for any direct document action (e.g. admin approve/reject) that
targets a specific document rather than a `(propertyId, type)` pair.
A `LOAN_NOC` item appears **only when `Property.isMortgaged` is true** (its
`status` reads from `Property.loanNocStatus` directly, not from a
`PropertyDocument` row, so its `id` is always `null`). `ready` is `true`
only when nothing is `MISSING` or `REJECTED`; it is `null` for a persona
with `available: false`, since "ready" has no meaning there yet.

**Response, AGENT persona:**

```json
{
  "...": "...",
  "persona": "AGENT",
  "items": [],
  "elsewhere": [
    { "item": "Mandate letter", "source": "ExclusiveMandate.documentUrl" },
    { "item": "Owner PAN", "source": "ExclusiveMandate.ownerPan" },
    { "item": "Owner confirmation", "source": "OwnerConfirmation (this module)" }
  ],
  "ownerConfirmation": {
    "id": "6ac3...", "status": "PENDING", "ownerName": "Ramesh Owner", "ownerPhone": "+919000000088",
    "requestedVia": "Phone call to owner", "requestedAt": "2026-10-04T...", "expiresAt": "2026-10-06T...",
    "respondedAt": null, "responseNote": null
  },
  "activeMandateId": "6ac2..."
}
```

`ownerConfirmation.status` is the **newest non-`SUPERSEDED`** confirmation on
the listing, with `PENDING` past `expiresAt` reported as **`TIMED_OUT`** —
derived at read time, the same way `ExclusiveMandate.effectiveStatus` derives
`EXPIRED`. There is no scheduled job, and the stored row's `status` column
never actually becomes `TIMED_OUT`; only the response does.

**Response, AGENT persona who is self-listing (R21):**

```json
{
  "...": "...",
  "partnerSubType": "AGENT",
  "selfListedByAgent": true,
  "persona": "OWNER",
  "items": [
    { "type": "SALE_DEED", "label": "Sale deed", "status": "MISSING", "fileUrl": null, "uploadedAt": null, "rejectionNote": null },
    { "type": "ENCUMBRANCE_CERTIFICATE", "...": "..." },
    { "type": "KHATA", "...": "..." },
    { "type": "SOCIETY_NOC", "...": "..." }
  ],
  "elsewhere": []
}
```

When an in-force `ExclusiveMandate` on the listing names the owner's PAN as
the *submitting partner's own* PAN, this partner isn't representing a third
party at all — there's no genuine mandate letter/owner-PAN/owner-confirmation
to collect from anyone else. The checklist is routed to the OWNER persona's
real documents instead of AGENT's "elsewhere" placeholders, and
`POST /api/properties/:id/checklist-documents` (below) accepts uploads from
this partner for exactly the same reason. `partnerSubType` still reports the
partner's actual registered type; `selfListedByAgent` is what changed the
routing. See also `GET .../commission/preview`'s `sellerType`/`selfListed`,
which routes the fee side of the same fact.

**Response, BUILDER persona:**

```json
{ "...": "...", "persona": "BUILDER", "available": false, "reason": "Builder compliance (...) is modelled at the PROJECT level, which does not exist yet (docs 4.10/4.11). Nothing to check per listing until then.", "items": [] }
```

**Response, no `partnerSubType` set:**

```json
{ "...": "...", "persona": null, "available": false, "reason": "No document checklist is defined for persona (unset)." }
```

**Errors:** `403` (partner route only) not your listing · `404` not found.

---

### POST /api/properties/:id/checklist-documents

Upload one OWNER-persona checklist document. Distinct from
`POST /api/properties/:id/documents` (free-form uploads — brochures, floor
plans): this endpoint is for structured, persona-tracked document types
only.

**Auth:** PARTNER

**Request:** `multipart/form-data`, field name `document` (single file),
plus `documentType` in the body.

| Field | Required | Notes |
| --- | --- | --- |
| `documentType` | yes | One of `SALE_DEED`, `ENCUMBRANCE_CERTIFICATE`, `KHATA`, `SOCIETY_NOC`, `CO_OWNER_CONSENT`, `RERA_CERT`. |

**`CO_OWNER_CONSENT` and `RERA_CERT` are uploadable at any time** (R19), but
only show up as a *required* item on `GET .../checklist` conditionally —
`CO_OWNER_CONSENT` when `Property.hasCoOwners` is `true`, `RERA_CERT` when
`Property.reraNumber` is set. An owner can upload `RERA_CERT` proactively
before `reraNumber` is ever set; it just won't yet be counted toward
`missingCount`/`ready` until the condition is actually true.

**`MORTGAGE_NOC` from R19's original list is NOT a `documentType` here.** It
already exists as `Property.loanNocUrl` / `loanNocStatus` (doc 4.5), folded
into the same checklist response. Adding a second upload mechanism for the
same document would give it two inconsistent homes.

**Response `201`:**

```json
{ "success": true, "message": "Document uploaded", "data": { "id": "...", "documentType": "SALE_DEED", "status": "PENDING_REVIEW", "fileUrl": "https://...", "fileName": "sale-deed.pdf" } }
```

**Re-uploading the same `documentType` replaces the previous attempt** rather
than creating a second row — there is a unique index on
`(propertyId, documentType)`. Any prior `verifiedByAdminId` / `rejectionNote`
is cleared and `status` resets to `PENDING_REVIEW`, so resubmitting after a
rejection puts the document straight back in front of an admin.

**R21 — also accepted from a persona-`AGENT` partner who is self-listing**
(an in-force mandate on the property names their own PAN as the owner's —
see `GET .../checklist`'s `selfListedByAgent`). Refused for any other AGENT.

**Errors:**
- `400` the listing's partner is not persona `OWNER` (and not a self-listing AGENT)
- `400` `documentType` not one of the six values, or no file provided
- `403` not your listing
- `404` property not found

---

### PATCH /api/admin/properties/checklist-documents/:docId/verify

**Auth:** ADMIN

**Request Body:** none.

**Response `200`:** the document, `status: "APPROVED"`.

**Errors:** `404` not found.

---

### PATCH /api/admin/properties/checklist-documents/:docId/reject

**Auth:** ADMIN

**Request Body:** `{ "note": "Scanned copy is unreadable, resend a clearer scan" }` —
required, 5–500 chars, shown to the partner verbatim.

**Response `200`:** the document, `status: "REJECTED"`.

**Errors:** `400` `note` too short · `404` not found.

---

### POST /api/admin/properties/:id/mandates/:mandateId/owner-confirmation/request

Starts (or restarts) the 48-hour confirmation window for an **AGENT** mandate.

**Auth:** ADMIN

**Request Body:** `{ "requestedVia": "Phone call to owner" }` — optional, free
text, max 200 chars. Describes how contact was actually made; it is a record,
not a channel this backend drives.

**Response `201`:**

```json
{
  "success": true,
  "message": "Owner confirmation requested",
  "data": { "id": "...", "status": "PENDING", "ownerName": "Ramesh Owner", "ownerPhone": "+919000000088", "requestedVia": "Phone call to owner", "requestedAt": "2026-10-04T...", "expiresAt": "2026-10-06T..." }
}
```

`ownerName` / `ownerPhone` are copied from the mandate, not re-entered.
`expiresAt` is `requestedAt` + exactly 48 hours, fixed at creation.

**Calling this again on the same mandate marks the previous `PENDING` request
`SUPERSEDED`** and starts a fresh 48-hour window — the checklist only ever
shows the latest one.

**Errors:**
- `400` the mandate's partner is not persona `AGENT` — owner confirmation only
  applies to agent-submitted listings
- `404` mandate not found, or not on this property

---

### PATCH /api/admin/properties/owner-confirmation/:confirmationId

Records the owner's actual response.

**Auth:** ADMIN

**Request Body:**

```json
{ "status": "DENIED", "note": "Owner says they never authorized this agent to list the property" }
```

| Field | Required | Notes |
| --- | --- | --- |
| `status` | yes | `CONFIRMED` or `DENIED`. |
| `note` | yes | 5–1000 chars. How contact was made and what the owner actually said — not just the yes/no. |

**Response `200`:** the confirmation, `status` set as given.

**A `DENIED` response raises a `ListingConflict`** of type
`OWNER_DENIED_MANDATE` — an agent claiming authorization the named owner did
not give is a real integrity problem, not a bookkeeping update. See **Listing
conflicts (docs 4.4)** above for the conflict review endpoints.

**R27's `POST /api/properties/:id/report-unauthorized` (above, public) is
the owner-initiated counterpart** — it raises the same kind of conflict
(`OWNER_REPORTED_UNAUTHORIZED`) but without admin ever having reached out
first.

**Errors:**
- `400` `status` not `CONFIRMED`/`DENIED`, or `note` too short
- `400` this confirmation is no longer `PENDING` (already recorded, or
  superseded by a later request)
- `404` not found


## Listing location (docs 4.6 / 4.7)

A listing carries **three** separate coordinate pairs, deliberately not merged:

| Field pair | What it is |
| --- | --- |
| `latitude` / `longitude` | **Canonical.** What gets displayed and searched on. |
| `mapLinkLatitude` / `mapLinkLongitude` | Coordinates read out of the partner's pasted `mapLink`. |
| `partnerPinLatitude` / `partnerPinLongitude` | The pin the partner dropped themselves. |

They are kept apart so the location check can show *where they disagree*
rather than one silently overwriting another. The partner supplies `mapLink`
and `partnerPin*` on create/update; only an admin sets the canonical pair.

**No geocoding provider is involved.** Coordinates are extracted from a map URL
by string parsing ([src/lib/mapLink.js](src/lib/mapLink.js)) — no network call,
no API key, nothing that can fail at request time. Recognised forms, most
specific first:

| Form | Example |
| --- | --- |
| `!3d…!4d…` (resolved place) | `.../place/X/@18.51,73.84,17z/data=!3m1!4b1!4m5!3d18.5204!4d73.8567` |
| `?q=` / `?query=` / `?ll=` / `?destination=` / `?center=` | `https://maps.google.com/?q=18.5204,73.8567` |
| `/@lat,lng,zoom` (view centre) | `https://www.google.com/maps/@18.5204,73.8567,17z` |
| a bare pair | `18.5204, 73.8567` |

The `!3d!4d` pair beats the `/@` centre when both are present: the first is the
actual place, the second is only where the camera was pointing.

**Shortened links cannot be parsed.** `maps.app.goo.gl`, `goo.gl`, `bit.ly` and
similar hold no coordinates until the redirect is followed, which would mean a
network call. They are detected by host and rejected with an actionable
message rather than a vague parse failure. `(0, 0)` and out-of-range values are
also rejected — in practice `(0, 0)` means "nothing was set", not a point in
the Gulf of Guinea.

**Deriving coordinates from the street address is a different problem** and does
need a third-party provider, which has not been chosen. Every location-check
response says so explicitly under `addressGeocoding` rather than leaving it a
silent gap. The `LocationSource` enum reserves `GEOCODE_PROVIDER` for that day;
nothing writes it today.

---

### GET /api/admin/properties/:id/location-check

Every coordinate source for one listing, how far apart they are, and what is
wrong. Read-only, moves nothing.

**Auth:** ADMIN

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "propertyId": "6a44a67d...",
    "title": "3BHK in Palm Grove",
    "publishStatus": "APPROVED",
    "address": { "address": "Tower B, Palm Grove", "locality": "Kothrud", "city": "Pune", "state": "Maharashtra", "pincode": "411038" },
    "canonical": { "latitude": 18.5204, "longitude": 73.8567, "source": "MAP_LINK", "verifiedAt": "2026-10-04T12:30:00.000Z", "verifiedByAdminId": "6a44a679..." },
    "mapLink": { "url": "https://www.google.com/maps/@18.5204,73.8567,17z", "latitude": 18.5204, "longitude": 73.8567, "parseReason": null, "parsePattern": "at-centre" },
    "partnerPin": { "latitude": 18.5304, "longitude": 73.8567 },
    "distances": { "partnerPinToMapLink": 1112, "canonicalToPartnerPin": 1112, "canonicalToMapLink": 0 },
    "toleranceMetres": 300,
    "withinTolerance": false,
    "issues": [
      { "key": "PIN_MAP_MISMATCH", "detail": "The partner's pin is 1112 m from the map link, over the 300 m tolerance." }
    ],
    "addressGeocoding": { "available": false, "reason": "Address-to-coordinates geocoding needs a third-party provider, which has not been selected. ..." }
  }
}
```

`distances` are great-circle metres, rounded. A distance is `null` when either
endpoint is missing, so "they are far apart" stays distinguishable from "there
is nothing to compare".

**`withinTolerance` is `null`, not `true`, when no comparison is possible** —
no map link, an unparseable one, or no partner pin. "No disagreement found" and
"could not check" are different answers and the UI should not render them the
same way.

`toleranceMetres` comes from the admin config key
`listing_pin_tolerance_metres` and defaults to **300**. It is returned on every
response so nobody has to guess which threshold produced a flag. The default is
a starting point, not a rule from the business.

`mapLink.parseReason` is non-null only when a link exists but yielded no
coordinates, and it carries the actionable text ("Open the link and paste the
full URL from the address bar").

**`issues` keys:**

| Key | Means |
| --- | --- |
| `NO_COORDINATES` | No canonical pair; the listing cannot be placed on a map. |
| `NO_MAP_LINK` | No map link was provided. |
| `UNPARSEABLE_MAP_LINK` | A link exists but no coordinates could be read from it; `detail` says why. |
| `NO_PARTNER_PIN` | Nothing to cross-check the link against. |
| `PIN_MAP_MISMATCH` | Pin and link are further apart than the tolerance. |
| `UNVERIFIED` | No admin has confirmed this location yet. |

**Errors:** `404` property not found.

---

### PATCH /api/admin/properties/:id/location

Set the canonical location. Audited.

**Auth:** ADMIN

**Request Body:**

```json
{
  "reason": "Map link pointed at the wrong tower; corrected by hand",
  "mapLink": "https://www.google.com/maps/@18.5204,73.8567,17z",
  "latitude": 18.5250,
  "longitude": 73.8600
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `reason` | **yes** | 5–500 chars. Written into every resulting `PropertyEditLog` row and sent to the partner verbatim. |
| `mapLink` | one of these | Re-parsed on write, so the stored coordinates always match the stored link. Pass `null` to clear it. |
| `latitude` + `longitude` | one of these | Must be given **together** — a lone latitude would be paired with the old longitude. |

**Which pair wins:**

1. Explicit `latitude`/`longitude` → canonical, `locationSource: ADMIN_OVERRIDE`.
2. Otherwise, if `mapLink` parsed → canonical, `locationSource: MAP_LINK`.
3. Otherwise the canonical pair is left alone.

**An unparseable or cleared `mapLink` never clobbers good canonical
coordinates.** Pasting a shortened link stores the link, records the parse
failure, and leaves the existing location intact.

**Response `200`:**

```json
{
  "success": true,
  "message": "Location updated (3 field(s))",
  "data": {
    "location": { "...": "the full location-check payload, freshly computed" },
    "changedFields": ["latitude", "longitude", "locationSource"],
    "confirmedOnly": false
  }
}
```

Every call stamps `locationVerifiedAt` / `locationVerifiedByAdminId`, which
clears the `UNVERIFIED` issue.

**Confirming a correct location is not an edit.** When nothing actually moves,
`confirmedOnly` is `true`, `changedFields` is empty, the message is "Location
confirmed; nothing changed", **no `PropertyEditLog` rows are written** and the
partner is not notified. The verification stamp is excluded from the diff
because it changes on every call by definition.

**Errors:**
- `400` `reason` shorter than 5 chars
- `400` only one of `latitude`/`longitude` given
- `400` neither `mapLink` nor a coordinate pair given
- `404` property not found

## Listing visibility and requested changes (docs 4.14 / 4.15)

### Three independent visibility levels

Approval is no longer one switch. The three rungs are separate and combinable:

| Level | Field | Means |
| --- | --- | --- |
| public | `publishStatus: APPROVED` | Reachable at its own URL. Always set by approving — that is what approval *is*. |
| search | `isSearchable` | Appears in search results and in the related-listings strip on a detail page. |
| homepage | `isFeatured` | Appears in the featured strip. |

So a listing can be **public-by-link but unlisted**: approved and reachable via
`GET /api/properties/:slug`, absent from `GET /api/properties`.

**`isSearchable` is nullable and `null` means searchable.** It was added after
18 listings were already live and, on MongoDB, a Prisma `@default` is applied
only at create time — so a required `Boolean @default(true)` would have been
*missing* rather than `true` on all of them, and a required field offers no
`isSet` filter to find them with. Those 18 listings would have silently
vanished from search.

Verified against the live database, which is worth recording because the
intuitive filter is the broken one:

| Filter | Rows matched (of 18 with the field missing) |
| --- | --- |
| `{ isSearchable: { isSet: false } }` | **18** |
| `{ isSearchable: null }` | 0 |
| `{ isSearchable: { not: false } }` | 0 |

The live filter is therefore
`{ OR: [{ isSearchable: true }, { isSearchable: { isSet: false } }] }`, and it
is applied as an entry in `AND` — never spread at the top level — because
`searchProperties` assigns `where.OR` for the free-text query, which would
overwrite a top-level `OR` and drop the visibility filter from every keyword
search.

`isSearchable` does **not** affect direct access by slug, the aggregate city
counts, or the B2B partner feed.

---

### PATCH /api/admin/properties/:id/approve — visibility options

(The same endpoint listed earlier under Property approval; this is the full
reference for its body.)

**Auth:** ADMIN

**Request Body:** optional.

```json
{ "visibility": { "searchable": true, "homepageFeatured": false } }
```

| Field | Default | Notes |
| --- | --- | --- |
| `visibility.searchable` | `true` | `false` approves the listing as public-by-link only. |
| `visibility.homepageFeatured` | unchanged | Omitting it leaves `isFeatured` as it was. |

**Sending no body at all is valid and keeps the previous behaviour exactly:**
public and searchable, not featured. Existing callers need no change.

**Response `200`:**

```json
{
  "success": true,
  "message": "Property approved (visible in: public, search)",
  "data": { "...": "the updated property" }
}
```

The message names the levels actually granted. Approving also writes
`isSearchable` explicitly rather than leaving it missing, so every approved
listing carries a definite answer, and it **clears any outstanding change
checklist** — the fixes were either made or are no longer being asked for.

The audit entry records `isSearchable` and `isFeatured` before and after, not
just `publishStatus`.

---

### PATCH /api/admin/properties/:id/request-changes

Ask the partner for specific fixes instead of rejecting the listing (4.15).

**Auth:** ADMIN

**Request Body:**

```json
{
  "items": ["Add interior photos", "Carpet area looks wrong", "RERA number missing"],
  "note": "Resend once these are sorted and it will go straight back in the queue."
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `items` | yes | 1–20 entries, each 3–300 chars. A change request with nothing in it tells the partner nothing. |
| `note` | no | Max 1000 chars. |

**Response `200`:** the property, now `publishStatus: "CHANGES_REQUESTED"`,
with `requestedChanges`, `requestedChangesNote`, `changesRequestedAt` and
`changesRequestedByAdminId` set. Any stale `rejectionNote` is cleared, since it
would contradict the checklist the partner is now being shown.

**`CHANGES_REQUESTED` is a new `PublishStatus` value.** It differs from
`REJECTED` in intent: a rejection is a refusal, this is a live submission the
partner is expected to correct and resend. Both are hidden from every public
surface, exactly like `PENDING_APPROVAL`. Find them with
`GET /api/admin/properties?status=CHANGES_REQUESTED`.

**Refused on a live listing.** Moving an `APPROVED` listing to
`CHANGES_REQUESTED` would pull it out of public view as a side effect of asking
for a correction, which is rarely the intent. Use the change-request flow
(`PATCH /api/properties/:id`) to edit a live listing, or reject it to take it
down deliberately.

**Errors:**
- `400` the listing is `APPROVED` (message explains the alternatives)
- `400` the listing is `ARCHIVED`
- `400` `items` empty, over 20, or an entry under 3 chars
- `404` property not found

---

### Resubmission

**A partner editing a `CHANGES_REQUESTED` listing resubmits it.** `PATCH
/api/properties/:id` sets `publishStatus` back to `PENDING_APPROVAL` and clears
the whole checklist:

```json
{
  "success": true,
  "message": "Changes saved and resubmitted for review",
  "data": { "property": { "publishStatus": "PENDING_APPROVAL", "requestedChanges": [] }, "changeRequest": null }
}
```

There is no separate resubmit endpoint: acting on the feedback *is* the
resubmission. Without this the listing would sit in `CHANGES_REQUESTED`
indefinitely — invisible to buyers and absent from the admin's pending queue.

Note this is the opposite of the live-listing path in the same endpoint: an
edit to an `APPROVED` listing is held as a `changeRequest` and the listing is
untouched, whereas an edit to a `CHANGES_REQUESTED` listing applies
immediately, because there is nothing published to protect.

---

---

---

---


---


## Commission (docs 3.12-3.17, B12.2)

The money record is a **lead's negotiated commission lines**, not a rate
card. Terms are agreed per deal and legitimately differ from any default —
urgency, how hard the property is to move, what the seller wants. A rate
card is only a **template** used to pre-fill those lines; editing or
deleting a card never touches an already-locked lead.

**Core rule (backend-gaps-frontend-integration.md #1, 2026-10-05 — reverses
the earlier 826a73c decision): the platform's cut is cost recovery, not
margin, and it is never admin-entered.** Admin sets every partner line
(`LISTING_AGENT` / `CLOSING_AGENT` as a `pct` of the fee, optionally
`ADVISOR`) — there is no `PLATFORM` payee line at all any more. The
platform's retained amount, **R**, is computed independently, from the real
Razorpay/RazorpayX charges this fee actually incurs:

```
B (the fee)      = dealPrice × feePct
R (platform cut) = (collection charge + payout transfer charge) on B, + GST on both
                    — unless GST is claimed as input credit, in which case it's excluded
Pi (partner i)    = B × line.pct               (admin-set, per line)
headroom          = B − R − ΣPi                  (returned on every read)
seller gets         dealPrice − B               (derived — never affected by how B is split)
```

**Refused outright if ΣPi + R > B** — partner lines that would leave no
room for the platform's real, calculated cost. There is no sum-to-100
check any more: lines don't need to add up to anything in particular, they
just need to fit inside the headroom once R is accounted for. A deal's
unused headroom is just that — headroom, not platform income; margin is
explicitly deferred, not built here.

**R's rate is config-driven, switchable without a code change** (same
mechanism as GST/TDS on the escrow side), all defaulting to 0 — a safe
no-op — until the real schedule is supplied:

| Config key | Meaning | Default |
| --- | --- | --- |
| `commission_gateway_collection_pct` | Razorpay collection charge, % of B | `0` |
| `commission_gateway_payout_pct` | RazorpayX payout/transfer charge, % of B | `0` |
| `commission_gateway_gst_pct` | GST %, applied to the two charges above | `0` |
| `commission_gateway_gst_input_credit` | `"true"`/`"false"` — whether that GST is claimed as input credit (so excluded from R). Open with the accountant. | `"false"` |

Edit via the existing generic config endpoint: `PUT /api/admin/config/:key`.

**Platform-level pre-fill defaults, also config-driven, with no hardcoded
fallback number at all** — "Admin sets every percentage" means nothing is
ever silently guessed by code. If neither a rate card nor these exist,
there's nothing to pre-fill:

| Config key | Meaning |
| --- | --- |
| `default_fee_pct` | The brokerage fee %, used only when no rate card resolves |
| `default_partner_share_pct` | The default `CLOSING_AGENT` pct in that same fallback case |

**`ADVISOR` is paid a flat amount, not a percentage** (business decision,
2026-10-04, unaffected by the above) — reflecting that an advisor's
compensation is for services rendered, unrelated to the deal's size. Each
advisor has a standard rate (`User.advisorStandardFeePaise`), used
automatically when they're added to a lead with no amount specified; admin
can override the amount for a specific deal. The flat amount is converted
to its equivalent % of *that lead's* fee for storage, so the line still
participates in the normal ΣPi + R ≤ B check — but the API always shows
you the real flat figure, never a rounded-back-out approximation of it.

---

### GET /api/admin/rate-cards

Templates, filterable by `sellerType`, `city`, `propertyId`, `isActive`.

**Auth:** ADMIN

---

### POST /api/admin/rate-cards

**Auth:** ADMIN

**Request Body:**

```json
{
  "city": "Pune",
  "sellerType": "AGENT",
  "feePct": 2,
  "payer": "SELLER",
  "lines": [
    { "payeeRole": "CLOSING_AGENT", "pct": 45 }
  ]
}
```

Provide a `propertyId` or a `city` (property-level cards take precedence
over city-level ones for the same `sellerType`). **`lines` accepts only
`LISTING_AGENT` / `CLOSING_AGENT`** — `ADVISOR` is deal-specific and not
knowable at template-design time, and there is no `PLATFORM` line at all
(same rule as lead terms, above).

**Response `201`:** the card, with `lines` exactly as submitted — nothing
appended.

**Errors:**
- `400` a `payeeRole` other than `LISTING_AGENT`/`CLOSING_AGENT`
- `400` lines sum to over 100% of the fee (a template that obviously can't
  fit, caught before it's ever applied to a real lead)
- `400` neither `propertyId` nor `city` given

---

### PATCH /api/admin/rate-cards/:id · DELETE /api/admin/rate-cards/:id

Update bumps `version` (so a lead that pre-filled from an older version keeps
a record of which one). Delete deactivates (`isActive: false`) rather than
removing the row — leads that pre-filled from it reference that history.

**Auth:** ADMIN

---

### GET /api/admin/commission-overrides · POST ... · DELETE .../:id

A **partner override** changes only the named partner's *total* share of
the fee (`partnerSharePct`) — never R, never the seller's price. Scoped
`ALL` (every property) or `SELECTED` (`propertyIds`). `validUntil` is
optional (never expires if omitted).

**Auth:** ADMIN

Rescaling preserves the relative split between that partner's own
`LISTING_AGENT`/`CLOSING_AGENT` lines. **An existing `ADVISOR` line on the
lead is left untouched by an override** — the override is about the
assigned partner's share, never a separate advisor's flat, deal-specific
fee. A smaller partner total just means a bigger headroom now — nothing
absorbs the difference.

---

### GET /api/admin/leads/:id/commission/preview

What the lead's terms **would be** if pre-filled right now — resolved
through property card → city card → platform default, with any active
partner override applied. Writes nothing.

**Auth:** ADMIN

**Response `200`:**

```json
{
  "leadId": "...", "sellerType": "AGENT", "selfListed": false, "feePct": 2,
  "lines": [{ "payeeRole": "CLOSING_AGENT", "pct": 45 }],
  "dealPrice": 7500000, "feeAmount": 150000,
  "platformRetained": 4425, "platformShareOfFee": 2.95, "headroom": 78075,
  "resolvedFrom": "CITY", "rateCardId": "...", "rateCardVersion": 3,
  "referredByAdvisorId": null
}
```

`resolvedFrom` is `PROPERTY`, `CITY`, `PLATFORM_DEFAULT`, or
`PARTNER_OVERRIDE` when an override applied on top. `platformRetained` (R),
`platformShareOfFee` (R/B, **derived, not an input**) and `headroom`
(B − R − Σ`lines` amounts) are computed from the config rates above — shown
here too, not just after saving, so admin sees whether these lines even fit
before committing to them. All three are `null`/`0` when `feeAmount` isn't
known yet (no deal price resolved). When `default_fee_pct`/
`default_partner_share_pct` aren't configured and no rate card matches,
`feePct` comes back `null` and `lines` comes back `[]` — nothing is
guessed.

**R29 — `referredByAdvisorId` is set when this lead's buyer phone number
matches an `ACTIVE` advisor referral** (see **Advisor Referrals** below),
and an `ADVISOR` line for that advisor is appended to `lines` automatically
(no `pct` — resolved from their `advisorStandardFeePaise` the same way a
manually-added advisor line without a rate already is). An `ADVISOR` line
already present for a *different* advisor, named explicitly for this deal,
always wins over the referral.

**R21 — `sellerType` resolves to `OWNER` (not the partner's actual
registered type) when the listing partner is an AGENT who is self-listing**
(same fact as the checklist's `selfListedByAgent` — an in-force mandate
names their own PAN as the owner's). `selfListed` reports that directly.
There's no genuinely separate listing agent earning a cut on top of the
platform fee in that case, so this resolves against the OWNER rate
card/template rather than AGENT's.

**If the lead is also currently *assigned* to that same self-listing
partner**, the `LISTING_AGENT`/`CLOSING_AGENT` line that would otherwise
default to them is dropped outright — paying them is always refused
(`OWN_PROPERTY_COMMISSION`, 3.17), so the preview doesn't offer a line that
could only ever be rejected. Nothing absorbs the dropped share; `lines`
just comes back empty (or `ADVISOR`-only, if a referral applies):

```json
{
  "leadId": "...", "sellerType": "OWNER", "selfListed": true, "feePct": 2,
  "lines": [],
  "dealPrice": 9000000, "feeAmount": 180000,
  "platformRetained": 5310, "platformShareOfFee": 2.95, "headroom": 174690,
  "resolvedFrom": "PLATFORM_DEFAULT", "rateCardId": null, "rateCardVersion": null
}
```

A *different* partner assigned to close the same self-listed deal is
unaffected — they're a genuine third party, so their `CLOSING_AGENT` line is
offered normally.

---

### POST /api/admin/leads/:id/commission/prefill

Resolves the same preview and **saves** it as the lead's current (unlocked)
terms in one call.

**Auth:** ADMIN

**R21 — refused when the preview's only line was dropped** because the
lead is assigned to the property's own self-listing partner (see the preview
endpoint above). Assign a different partner to close the deal first, then
prefill or set terms manually.

**Errors:**
- `400` already locked — revise with `PUT .../commission` instead
- `400` `SELF_LISTED_NO_PARTNER_ASSIGNED` — self-listed, no genuine partner assigned to pay

---

### PUT /api/admin/leads/:id/commission

Sets (or revises) a lead's negotiated lines directly.

**Auth:** ADMIN

**Request Body:**

```json
{
  "feePct": 2,
  "dealPrice": 7500000,
  "lines": [
    { "payeeRole": "CLOSING_AGENT", "pct": 50 },
    { "payeeRole": "ADVISOR", "payeeUserId": "6a...", "flatAmountPaise": 5000000 }
  ],
  "note": "Urgent sale, seller agreed a higher partner share"
}
```

| Field | Rule |
| --- | --- |
| `LISTING_AGENT` / `CLOSING_AGENT` | `pct` only. Defaults `payeeUserId` to the lead's assigned partner if omitted. |
| `ADVISOR` | Requires `payeeUserId` (always a different person — never defaults). At most one of `pct` / `flatAmountPaise`. **Give neither to use that advisor's standard rate** (`User.advisorStandardFeePaise`); explicit `flatAmountPaise` always overrides it for this deal only. |
| `PLATFORM` | **Does not exist as a payee role.** There is nothing to submit for it. |

**Before lock**, calling this again replaces the current version in place.
**After lock**, it writes a new version (`commissionVersion + 1`); the old
version's rows are kept as history, not edited.

**Response `200`:** the lead's full terms —

```json
{
  "id": "...", "feePct": 2, "dealPriceAtLock": 7500000, "commissionVersion": 1,
  "platformCommissionPct": 2.95, "commissionAmountPaise": 442500,
  "locked": false,
  "lines": [
    { "payeeRole": "CLOSING_AGENT", "pct": 50, "payeeUserId": "6a...", "flatAmountPaise": null },
    { "payeeRole": "ADVISOR", "pct": 6.67, "payeeUserId": "6a...", "flatAmountPaise": 5000000 }
  ],
  "amounts": {
    "dealPrice": 7500000, "feeAmount": 150000, "sellerNet": 7350000,
    "platformRetained": 4425, "platformShareOfFee": 2.95,
    "partnerTotal": 125000, "headroom": 20575,
    "byPayee": [
      { "payeeRole": "CLOSING_AGENT", "pct": 50, "amount": 75000, "flatAmountPaise": null },
      { "payeeRole": "ADVISOR", "pct": 6.67, "amount": 50000, "flatAmountPaise": 5000000 }
    ]
  }
}
```

`platformCommissionPct` is R/B (`amounts.platformShareOfFee`, the same
number) — **derived, never an input** — snapshotted at the moment terms
are set/revised, from whatever the gateway-cost config rates are at that
instant. `commissionAmountPaise` is R itself, in paise. `amounts.headroom`
is `feeAmount − platformRetained − partnerTotal`; `byPayee[].amount` for
`ADVISOR` is always the exact flat figure (`flatAmountPaise / 100`), never a
rounded recomputation from `pct`.

**Errors:**
- `400` a role other than `LISTING_AGENT`/`CLOSING_AGENT`/`ADVISOR`, or a duplicate role
- `400` `LISTING_AGENT`/`CLOSING_AGENT` missing `pct`, or given a `flatAmountPaise`
- `400` `ADVISOR` missing `payeeUserId`, or given both `pct` and `flatAmountPaise`
- `400` **ΣPi + R > B** — partner shares plus the platform's calculated cost-recovery amount exceed the fee itself (`LINES_EXCEED_HEADROOM`)
- `400` an `ADVISOR` flat amount with no fee amount known yet (set `feePct` and a deal price first), or exceeding the fee itself
- `400` the named advisor has no standard rate on file and none was given for this deal (`ADVISOR_RATE_REQUIRED`)
- `400` a partner would be paid commission on a property they themselves own (3.17)

---

### POST /api/admin/leads/:id/commission/lock

Freezes the current version. A locked lead's terms never change silently —
`PUT .../commission` after lock writes a new version instead of editing.

**Auth:** ADMIN

**R32 — every named partner payee** (`LISTING_AGENT`/`CLOSING_AGENT`/
`ADVISOR` lines with a `payeeUserId`) **is notified of their locked
commission** (`COMMISSION_LOCKED`, under the new `FEES` category — see
`GET /api/notifications`). Fired on lock specifically, not on every
prefill/revision before it, since terms can still churn while unlocked and
a figure that isn't final yet isn't worth notifying about.

**Errors:** `400` already locked · `400` no lines set yet.

---

### POST /api/admin/leads/:id/commission/invoice

R26 — the owner's success-fee payment record, step 1: generates a simple
payment receipt (confirms the fee amount; **not** a GST tax invoice — no
GSTIN/HSN/CGST-SGST split) and moves `Lead.commissionStatus` from `PENDING`
to `INVOICED`. Requires terms to be locked first — invoicing an amount that
could still change isn't meaningful.

"The owner" here is `Property.partnerId` — the real owner for an `OWNER`
listing, and, after R21, also correctly the self-listing agent rather than a
third party that doesn't exist. Notified (`COMMISSION_INVOICED`, `FEES`
category) with a link straight to the receipt PDF.

**Auth:** ADMIN

**Response `200`:** the lead's terms, `commissionStatus: "INVOICED"`,
`invoiceUrl` set to the receipt PDF, `invoicedAt` set.

**Errors:**
- `400` `COMMISSION_NOT_LOCKED` — lock terms first
- `400` `INVALID_COMMISSION_STATUS` — not currently `PENDING`

---

### POST /api/admin/leads/:id/commission/collect

R26 — step 2: records that the invoiced fee was actually paid.
`INVOICED` → `COLLECTED`, `collectedAt` set. Notifies the owner
(`COMMISSION_COLLECTED`, `FEES` category).

**Auth:** ADMIN

**Response `200`:** the lead's terms, `commissionStatus: "COLLECTED"`.

**Errors:** `400` `INVALID_COMMISSION_STATUS` — not currently `INVOICED`.

---

### POST /api/admin/leads/:id/commission/dispute

R26 — the owner disputes the fee. `PENDING` or `INVOICED` → `DISPUTED`; the
reason is appended to `Lead.adminNotes` (no separate dispute-reason field).
Refused once `COLLECTED` (a settled payment needs a human decision to
reverse, not a status flip) or already `DISPUTED` (the existing one gets
resolved, not replaced).

**Auth:** ADMIN

**Request Body:** `{ "reason": "Owner disputes the deal price used" }` — required, 5–500 chars.

**Response `200`:** the lead's terms, `commissionStatus: "DISPUTED"`.

**Errors:** `400` `INVALID_COMMISSION_STATUS` — currently `COLLECTED` or already `DISPUTED`.

---

### GET /api/admin/leads/:id/commission/history

Every version ever written for this lead, newest first.

**Auth:** ADMIN

---

### GET /api/partner/rate-cards

The partner's own view: their active override (if any) and, per assigned
lead, **only their own lines** — `partnerSharePct` is their total share,
computed from rows whose `payeeUserId` is literally them. A separate
`ADVISOR` line for someone else on the same lead is never folded into this
figure. The platform's cut is not their business and is not returned.

**Auth:** PARTNER

---

## Advisor Referrals (R29)

Attaches an advisor to a buyer so the `ADVISOR` commission line (already
modelled — see rate cards/overrides above) pre-fills automatically on every
lead that buyer generates, instead of admin re-naming the same advisor by
hand each time.

Keyed by **phone**, not an account: an advisor typically refers someone
*before* they have a RealtyDoor account (the same reason `Lead.buyerId` is
optional). `buyerId` is filled in opportunistically for display if a
matching account already exists; the actual commission match in
`GET .../commission/preview` always compares phone numbers, which both
sides are guaranteed to have.

One phone number has **at most one `ACTIVE` referral at a time, across every
advisor** — a second attempt is refused (`409`), naming whether it's a
retry (already yours) or a conflict with a different advisor's referral
(ask admin to revoke it first).

### POST /api/partner/referrals

Self-service: a KYC'd partner refers a client. Refused unless the caller's
`partnerSubType` is `ADVISOR`.

**Auth:** PARTNER + KYC verified

**Request Body:**

```json
{ "buyerName": "Priya Sharma", "buyerPhone": "9876543210", "buyerEmail": "priya@example.com", "note": "Met at a property expo" }
```

| Field | Required | Notes |
|-------|----------|-------|
| `buyerName` | Yes | 2–100 chars |
| `buyerPhone` | Yes | 5–20 chars |
| `buyerEmail` | No | |
| `note` | No | Up to 500 chars |

**Response `201`:** the referral row, `status: "ACTIVE"`, `buyerId` set only
if an existing `USER`-role account already has this phone number.

**Errors:**
- `400` caller is not an `ADVISOR`-persona partner
- `409` `REFERRAL_ALREADY_ACTIVE` — this phone already has an active referral

---

### GET /api/partner/referrals

The advisor's own referrals.

**Auth:** PARTNER + KYC verified

**Query Parameters:** `status` (`ACTIVE`/`REVOKED`), `page`, `limit`

---

### PATCH /api/partner/referrals/:id/revoke

An advisor revoking their own referral (e.g. the client is no longer being
worked with). Self-revoke doesn't notify anyone — only an admin revocation
(below) does, since that's the side that needs explaining.

**Auth:** PARTNER + KYC verified

**Request Body:** `{ "reason": "No longer in touch with this buyer" }` — required, 5–500 chars.

**Response `200`:** the referral, `status: "REVOKED"`.

**Errors:** `400` already revoked · `403` not your referral · `404` not found.

---

### GET /api/admin/advisor-referrals

Every referral, any advisor — oversight, not creation (creation is
self-service above).

**Auth:** ADMIN

**Query Parameters:** `advisorId`, `buyerPhone`, `status`, `page`, `limit`

**Response `200`:** each row includes `advisor: { id, name, companyName }`.

---

### PATCH /api/admin/advisor-referrals/:id/revoke

Admin revoking a referral on the advisor's behalf — e.g. resolving the
"different advisor already has an active referral for this phone" conflict
from the create endpoint above. Notifies the advisor (`ADVISOR_REFERRAL_REVOKED`,
under the `FEES` category) with the reason.

**Auth:** ADMIN

**Request Body:** `{ "reason": "..." }` — required, 5–500 chars.

**Errors:** `400` already revoked · `404` not found.

---

## Projects (docs 4.10 / 4.11, R22 / R23)

A developer-led **multi-unit project** (a tower, a township) — distinct from
a single-unit `Property` listing. A `BUILDER` partner's inventory lives
here, not as individual partner-owned `Property` rows: a project can hold
hundreds of units, which is unit **tracking** (count, type, price, status),
not hundreds of standalone listings each needing its own photos and
approval.

Reuses `PublishStatus` — the same lifecycle (submit → approve / request
changes / reject) that `Property` already has, including resubmission after
`CHANGES_REQUESTED`.

**4.11 — "all units go live together".** There is no per-unit approval.
Every `AVAILABLE` unit becomes publicly visible the instant the *project's*
`publishStatus` flips to `APPROVED`, and none before — gated entirely at the
project level in every public read.

**"Commercials" (4.10) are derived, not stored.** `priceFrom`/`priceTo`/unit
counts are computed from the `AVAILABLE` units at read time, so they can
never go stale the way a separately-maintained summary field would after a
unit sells.

**Inventory management is independent of project approval status.** A
builder's compliance documents are vetted once, at project approval; adding
a unit, correcting a price, or marking one `SOLD` afterward is routine
inventory upkeep, not a fresh compliance event — none of it touches
`publishStatus`.

---

### GET /api/projects

Public. Approved projects only.

**Query:** `city` · `page` · `limit`

**Response `200`:**

```json
{
  "success": true, "message": "Success",
  "data": {
    "data": [{
      "id": "...", "title": "Skyline Towers", "slug": "skyline-towers-...",
      "city": "Pune", "locality": "Hinjewadi", "publishStatus": "APPROVED",
      "commercials": { "totalUnits": 40, "availableUnits": 22, "bookedUnits": 10, "soldUnits": 8, "priceFrom": 4500000, "priceTo": 9500000 }
    }],
    "total": 1, "page": 1, "limit": 20, "totalPages": 1
  }
}
```

---

### GET /api/projects/:slug

Public. Returns `404` for anything not currently `APPROVED` — same as a
`Property` reached by an unapproved slug.

**Response `200`:** the project plus `units` (only `AVAILABLE` ones,
`BOOKED`/`SOLD`/`ON_HOLD` are never shown publicly) and `commercials`.

**Errors:** `404` not found or not approved.

---

### POST /api/partner/projects

Builder submits a new project. Lands `PENDING_APPROVAL`, invisible publicly.

**Auth:** PARTNER + KYC verified

**Request Body:**

```json
{
  "title": "Skyline Towers", "description": "...",
  "address": "Survey 45, NH-4", "locality": "Hinjewadi", "city": "Pune", "state": "Maharashtra", "pincode": "411057",
  "reraProjectNumber": "P52100012345",
  "approvedPlanUrl": "https://...", "commencementCertificateUrl": "https://...", "landTitleDocUrl": "https://...",
  "designatedAccountBankName": "HDFC Bank", "designatedAccountNumber": "...", "designatedAccountIfsc": "HDFC0000634"
}
```

All the approval-document fields are optional — a project can be submitted
with some still pending; the admin review screen shows exactly which.

**Response `201`:** the created project.

---

### GET /api/partner/projects · GET /api/partner/projects/:id

The builder's own projects (list) / one project with its full unit list and
`commercials` (detail, their own only — `403` otherwise).

**Auth:** PARTNER + KYC verified

---

### PATCH /api/partner/projects/:id

**Auth:** PARTNER + KYC verified (must own the project)

**Request Body:** any subset of the create fields.

**If the project is currently `APPROVED`**, editing reverts it to
`PENDING_APPROVAL` for re-review — a conscious simplification, not Property's
change-request machinery duplicated: a project's compliance fields rarely
change post-approval, and when they do, the whole project goes back to
review rather than holding a separate diff. Units are unaffected by this —
inventory changes never touch `publishStatus` (see above).

**If the project is `CHANGES_REQUESTED`**, editing resubmits it
(`PENDING_APPROVAL`, checklist cleared) — same as `Property`.

**Errors:** `403` not your project · `404` not found.

---

### POST /api/partner/projects/:id/units

Add one unit.

**Auth:** PARTNER + KYC verified (must own the project)

**Request Body:**

```json
{ "unitNumber": "A-101", "bhk": 2, "carpetArea": 650, "builtUpArea": 780, "price": 4500000, "floorNumber": 1 }
```

Only `unitNumber` is required. `unitType` (same enum as `Property.propertyType`),
`bhk`, `carpetArea`, `builtUpArea`, `price`, `floorNumber` are all optional.

**Errors:** `409` a unit with this `unitNumber` already exists in this project.

---

### POST /api/partner/projects/:id/units/bulk

Add many units in one call — a real project can have hundreds, and builders
enter inventory in batches, not one row at a time.

**Auth:** PARTNER + KYC verified

**Request Body:** `{ "units": [ { "unitNumber": "A-101", ... }, { "unitNumber": "A-102", ... } ] }` — 1 to 500 entries.

**Response `201`:**

```json
{
  "success": true, "message": "2 unit(s) added, 1 failed",
  "data": {
    "createdCount": 2, "failedCount": 1,
    "created": ["...the 2 created rows..."],
    "failed": [{ "unitNumber": "A-101", "reason": "duplicate unit number" }]
  }
}
```

**One bad row never drops the rest of the batch.** Each unit is attempted
independently; both lists are returned so nothing from a large upload is
silently lost.

---

### PATCH /api/partner/projects/:id/units/:unitId

Edit a unit's details (any subset of the add-unit fields, including
`unitNumber` itself).

**Auth:** PARTNER + KYC verified

---

### PATCH /api/partner/projects/:id/units/:unitId/status

**Auth:** PARTNER + KYC verified

**Request Body:** `{ "status": "SOLD" }` — one of `AVAILABLE`, `BOOKED`, `SOLD`, `ON_HOLD`.

---

### DELETE /api/partner/projects/:id/units/:unitId

**Auth:** PARTNER + KYC verified

**Only an `AVAILABLE` unit can be deleted** — a `BOOKED`/`SOLD`/`ON_HOLD` unit
represents a real transaction or a deliberate hold; removing that record
rather than correcting its status would lose history. Set it back to
`AVAILABLE` first if it was entered in error.

**Errors:** `400` unit is not `AVAILABLE` · `404` not found.

---

### GET /api/admin/projects

Review queue. Defaults to `PENDING_APPROVAL`; `?status=ALL` for every
project.

**Auth:** ADMIN

**Query:** `status` · `city` · `builderId` · `page` · `limit`

---

### GET /api/admin/projects/:id

Full detail — every field, every unit regardless of status, `commercials`.

**Auth:** ADMIN

---

### PATCH /api/admin/projects/:id/approve

**All units go live together** the instant this is called — see above.

**Auth:** ADMIN

**Request Body:** none.

**Response `200`:** the project, `publishStatus: "APPROVED"`.

---

### PATCH /api/admin/projects/:id/reject

**Auth:** ADMIN

**Request Body:** `{ "note": "Land title documentation incomplete" }` — required, 5–500 chars.

---

### PATCH /api/admin/projects/:id/request-changes

Same pattern as `Property`'s 4.15 — ask for specific fixes without
rejecting.

**Auth:** ADMIN

**Request Body:** `{ "items": ["RERA number format looks wrong"], "note": "..." }`

**Refused on a currently-`APPROVED` project** — pulling a live project (and
every one of its units) out of public view as a side effect of asking for
one fix is rarely the intent. Edit it directly, or reject it to take it
down deliberately.

**Errors:** `400` the project is live.

---

### PATCH /api/admin/projects/:id/approvals/:item

Per-document approval review — the admin screen needs to accept or reject
each compliance document independently, not just the project as a whole.

**Auth:** ADMIN

**Path:** `:item` is one of `approvedPlan`, `commencement`, `landTitle`.

**Request Body:** `{ "status": "APPROVED" }` or `{ "status": "REJECTED" }`.

**Errors:** `400` unknown `:item`.

---

### PATCH /api/admin/projects/:id/brokerage

R28 — sets the brokerage rate RealtyDoor charges this builder per unit
sold. Admin-only on purpose: a builder setting their own fee would be the
same conflict of interest 3.17 already guards against on the Lead-commission
side. Nullable until set — `POST .../builder-invoices` falls back to a
platform default (`default_builder_brokerage_pct` config, 2% out of the
box) rather than blocking invoicing.

**Auth:** ADMIN

**Request Body:** `{ "brokeragePct": 3.5 }` — 0–100.

---

## Builder Invoices (R28)

Brokerage RealtyDoor charges a builder per unit sold through a Project
(4.10/4.11). Separate from the Lead-based owner success fee (R26): a
Project/`ProjectUnit` sale has no `Lead` at all — `setUnitStatus` just flips
the unit to `SOLD`, builder-side, with nothing else tracking the sale. This
is the only record of money owed on it.

**Admin-created, not auto-generated when a builder marks their own unit
SOLD** — `setUnitStatus` is self-service, and a self-interested builder
choosing when to declare a sale isn't a fact the platform should invoice
itself on without a human checking it first.

A simple payment receipt, same as R26 (no GST breakup). No `PENDING` state:
unlike Lead commission, there's no negotiation phase — the rate is already
known at creation time — so an invoice starts at `INVOICED` directly. One
invoice per unit, enforced at the database level.

### POST /api/admin/builder-invoices

Confirms a unit sold and issues the invoice in one step.

**Auth:** ADMIN

**Request Body:** `{ "unitId": "..." }`

**Response `201`:**

```json
{
  "success": true, "message": "Invoice issued",
  "data": {
    "id": "...", "projectId": "...", "unitId": "...", "builderId": "...",
    "unitPrice": 6500000, "brokeragePct": 2, "amount": 130000,
    "status": "INVOICED",
    "invoiceUrl": "https://realtydoor-production.s3.ap-south-2.amazonaws.com/receipts/....pdf",
    "invoicedAt": "2026-10-04T16:13:34.939Z", "collectedAt": null
  }
}
```

**Errors:**
- `400` `UNIT_NOT_SOLD` — unit isn't `SOLD` yet
- `400` `UNIT_PRICE_MISSING` — unit has no price set
- `409` `INVOICE_ALREADY_EXISTS` — this unit already has one

---

### POST /api/admin/builder-invoices/:id/collect

Marks the invoice paid. `INVOICED` → `COLLECTED`, `collectedAt` set.
Notifies the builder (`BUILDER_INVOICE_COLLECTED`, `FEES` category).

**Auth:** ADMIN

**Errors:** `400` `INVALID_INVOICE_STATUS` — not currently `INVOICED`.

---

### POST /api/admin/builder-invoices/:id/dispute

The builder disputes the invoice. `INVOICED` → `DISPUTED`, reason stored on
`disputeNote`. Refused once `COLLECTED` (a settled payment needs a human
decision to reverse, not a status flip) or already `DISPUTED`.

**Auth:** ADMIN

**Request Body:** `{ "reason": "Builder disputes the unit price used" }` — required, 5–500 chars.

**Errors:** `400` `INVALID_INVOICE_STATUS` — currently `COLLECTED` or already `DISPUTED`.

---

### GET /api/admin/builder-invoices

Every builder invoice, any project — oversight, not creation.

**Auth:** ADMIN

**Query Parameters:** `builderId`, `projectId`, `status`, `page`, `limit`

**Response `200`:** each row includes `project: { id, title }`,
`unit: { id, unitNumber }`, `builder: { id, name, companyName }`.

---

### GET /api/partner/builder-invoices

The builder's own invoices, across all their projects.

**Auth:** PARTNER + KYC verified

**Query Parameters:** `status`, `page`, `limit`

---

### PATCH /api/admin/partners/:id/payout-account/status

Admin side of the payout-account clarification flow — `createPayoutAccount`
soft-fails the Razorpay penny-drop validation (it can't run in Razorpay test
mode, and is itself async) and lands a new account as `NEEDS_CLARIFICATION`
rather than blocking the partner or silently claiming it's good. An admin
resolves it here after checking Razorpay directly.

**Auth:** ADMIN

**Request Body:**

```json
{ "status": "ACTIVE", "note": "Verified against Razorpay dashboard" }
```

| Field | Required | Notes |
|-------|----------|-------|
| `status` | Yes | One of `ACTIVE`, `PENDING_VALIDATION`, `NEEDS_CLARIFICATION`, `SUSPENDED` |
| `note` | Conditional | Required unless `status` is `ACTIVE` |

**Response `200`:** `{ "success": true, "message": "Payout account marked ACTIVE", "data": { ...masked payout fields } }`

**Errors:** `400` missing note for a non-`ACTIVE` status.

---

### GET /api/admin/payout-accounts

R14 — every partner's payout account in one view, rather than only a
one-at-a-time status-setter with nothing to list from. Same field set and
masking (`bankAccountNo`/`panNumber` tail-masked) as the partner's own
`GET /api/partner/payout-account`.

**Auth:** ADMIN

**Query Parameters:**

| Param | Notes |
|-------|-------|
| `page`, `limit` | Pagination |
| `status` | One of `ACTIVE`, `PENDING_VALIDATION`, `NEEDS_CLARIFICATION`, `SUSPENDED`, or `NOT_SET_UP` (partner has never submitted a payout account at all — a missing field, not a null one) |

**Response `200`:**

```json
{
  "success": true, "message": "Success",
  "data": {
    "data": [
      {
        "id": "...", "name": "Ravi Kumar", "companyName": "Sharma Realty",
        "email": "ravi@example.com",
        "payoutAccountStatus": "ACTIVE", "payoutAccountNote": null,
        "payoutValidatedAt": "2026-09-01T10:00:00.000Z",
        "razorpayContactId": "cont_...", "razorpayFundAccountId": "fa_...",
        "bankName": "HDFC Bank", "bankIfsc": "HDFC0000634",
        "bankHolderName": "Ravi Kumar", "bankAccountNo": "XXXXXXXXXX6280",
        "bankLinkedAt": "2026-08-30T09:00:00.000Z", "panNumber": "XXXXXX234C",
        "balanceHeld": 250000
      }
    ],
    "pagination": { "page": 1, "limit": 20, "total": 16, "pages": 1 }
  }
}
```

`balanceHeld` (₹) is the sum of this partner's `HELD` escrow transactions — how much is currently sitting in escrow waiting to be released to them, the same figure `GET /api/partner/finance` computes for a partner's own view. Computed from `Lead.assignedPartnerId` (there's no direct partner FK on `EscrowTransaction`), batched per page rather than per row.

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
        "createdAt": "2024-01-01T00:00:00.000Z",
        "panVerificationStatus": "NOT_CONFIGURED", "panVerifiedName": null,
        "gstinVerificationStatus": "NOT_CONFIGURED", "gstinVerifiedName": null,
        "reraVerificationStatus": "NOT_CONFIGURED", "reraVerifiedName": null
      }
    ],
    "pagination": { "total": 5, "page": 1, "limit": 20, "totalPages": 1, "hasNext": false, "hasPrev": false }
  }
}
```

**5.x — the `*VerificationStatus`/`*VerifiedName` fields are the automated
PAN/GSTIN/RERA registry check, advisory input into the manual
approve/reject decision below — never a replacement for it, and this
endpoint's own behavior is completely unchanged.** `NOT_CONFIGURED` is what
every partner shows in any environment that hasn't set
`KYC_VERIFICATION_API_KEY` — which is every environment today; see
`lib/kycVerification.js`'s own comment for why (no vendor credentials were
available to build and test this live, unlike everything else in this
API). Other values: `NOT_FOUND`, `VERIFIED`, `NAME_MISMATCH` (registry name
doesn't loosely match what the partner's profile has on file), `FAILED`
(the vendor call itself errored).

---

### PATCH /api/admin/kyc/:userId/verify

Approve or reject partner KYC.

**Auth:** ADMIN + `KYC` permission

**Request Body:**

```json
{ "action": "APPROVE", "note": "Documents verified." }
```

`action`: `"APPROVE"` or `"REJECT"`. `note` required when rejecting.

**Response `200`:** `{ "success": true, "message": "KYC approved", "data": null }`

---

### POST /api/admin/kyc/:userId/auto-verify

5.x — re-runs the automated PAN/GSTIN/RERA check on demand (e.g. it wasn't
configured at submission time, or the partner corrected a number
afterward). Checks whichever of `panNumber`/`gstin`/`reraNumber` the
partner actually has on file; skips any that are empty.

Fired automatically, fire-and-forget, every time a partner calls
`POST /api/partner/kyc` too — this endpoint is for re-triggering it, not
the only way it runs.

**Auth:** ADMIN + `KYC` permission

**Response `200`:**

```json
{
  "success": true, "message": "Automated verification re-run",
  "data": {
    "panVerificationStatus": "NOT_CONFIGURED", "panVerifiedName": null, "panVerifiedAt": "2026-10-04T18:39:51.549Z",
    "gstinVerificationStatus": "NOT_CONFIGURED", "gstinVerifiedName": null, "gstinVerifiedAt": "2026-10-04T18:39:51.549Z",
    "reraVerificationStatus": "NOT_CONFIGURED", "reraVerifiedName": null, "reraVerifiedAt": "2026-10-04T18:39:51.549Z"
  }
}
```

If the partner has none of `panNumber`/`gstin`/`reraNumber` on file,
`data` is `null` and the message reads "No PAN/GSTIN/RERA on file to check" —
there's nothing to run.

**Not live-verified against a real vendor** — see the prominent comment at
the top of `src/lib/kycVerification.js` before this is ever enabled against
a real account. Everything else about this endpoint (the route, the
auth/permission gate, the no-op path, writing results back to the User
row) was verified live.

---

### POST /api/admin/kyc/:userId/request-documents

Ask for specific additional or corrected documents instead of a flat reject
(R9). Distinct from `REJECT`: this is a submission still in progress, not a
refusal.

**Auth:** ADMIN

**Request Body:**

```json
{
  "items": ["PAN card is blurry, reupload", "Missing latest bank statement"],
  "note": "Resend once these are fixed and it goes straight back into review",
  "dueInDays": 3
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `items` | yes | 1–20 entries, each 3–300 chars. |
| `note` | no | Max 1000 chars. |
| `dueInDays` | no | 1–90. **Informational only — nothing auto-rejects when it passes.** |

**Response `200`:**

```json
{ "success": true, "message": "Requested 2 document(s)", "data": { "id": "...", "name": "...", "kycStatus": "DOCUMENTS_REQUESTED", "kycRequestedDocuments": ["PAN card is blurry, reupload", "Missing latest bank statement"], "kycRequestedDueAt": "2026-10-07T12:00:00.000Z" } }
```

**`kycStatus` can now be `DOCUMENTS_REQUESTED`.** This is a new value
alongside `NOT_SUBMITTED` / `PENDING_REVIEW` / `VERIFIED` / `REJECTED` — update
any client-side status switch that assumes only those four.

**A due date that passes does not change anything server-side.** There is no
scheduled job. A UI that wants to show "overdue" should compare
`kycRequestedDueAt` against now itself; the backend never derives or exposes
a separate overdue flag for this (unlike the listing checklist's
`OwnerConfirmation`, which does expose a derived `TIMED_OUT`, because that one
has an endpoint to read it through — this is read straight off the user
record, so there's nothing to derive it on behalf of).

**Resubmitting clears the checklist.** `POST /partner/kyc` (existing endpoint)
sets `kycStatus` back to `PENDING_REVIEW` and clears
`kycRequestedDocuments` / `kycRequestedNote` / `kycRequestedDueAt` — the
partner acted on the request, so it goes back to a normal review rather than
sitting in `DOCUMENTS_REQUESTED` indefinitely.

**Errors:** `400` already `VERIFIED` · `400` `items` empty/too long/too short
· `404` user not found.

---

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
    "kycRequestedDocuments": [],
    "kycRequestedNote": null,
    "kycRequestedAt": null,
    "kycRequestedDueAt": null,
    "partnerSubType": "AGENT",
    "companyName": "RealtyPro Solutions",
    "panNumber": "ABCDE1234F", "panVerificationStatus": "NOT_CONFIGURED", "panVerifiedName": null, "panVerifiedAt": null,
    "gstin": null, "gstinVerificationStatus": "NOT_CONFIGURED", "gstinVerifiedName": null, "gstinVerifiedAt": null,
    "reraNumber": null, "reraVerificationStatus": "NOT_CONFIGURED", "reraVerifiedName": null, "reraVerifiedAt": null,
    "createdAt": "2024-01-01T00:00:00.000Z"
  }
}
```

`kycRequestedDocuments`/`kycRequestedNote`/`kycRequestedAt`/`kycRequestedDueAt` (see `POST .../request-documents` above) and the PAN/GSTIN/RERA automated-check fields (5.x) were already on the list view (`GET /api/admin/kyc`) but missing from this detail endpoint — now included here too.

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

Performance metrics for all KYC-verified partners (paginated).

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
        "companyName": "RealtyPro Solutions",
        "partnerSubType": "AGENT",
        "isSuspended": false,
        "totalLeads": 12,
        "closedLeads": 3,
        "totalListings": 8,
        "activeListings": 6
      }
    ],
    "pagination": { "total": 16, "page": 1, "limit": 20, "totalPages": 1, "hasNext": false, "hasPrev": false }
  }
}
```

---

### GET /api/admin/partners/:id

Full partner profile drill-down, including bank/payout fields, up to 10 most recent leads and listings each, and lead/listing counts.

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
    "phone": "+919876543210",
    "companyName": "RealtyPro Solutions",
    "partnerSubType": "AGENT",
    "bio": "...", "profileImageUrl": "...", "websiteUrl": "...",
    "kycStatus": "VERIFIED",
    "kycRejectionNote": null, "kycVerifiedAt": "2024-02-01T00:00:00.000Z", "kycConsentAt": "...",
    "isPremiumPartner": false, "premiumValidUntil": null,
    "reraNumber": "...", "gstin": "...", "coverageAreas": ["Pune", "Mumbai"], "address": "...",
    "partnerTermsVersion": "1.0", "partnerTermsAcceptedAt": "...",
    "payoutAccountStatus": "ACTIVE", "payoutAccountNote": null, "payoutValidatedAt": "...",
    "razorpayContactId": "cont_...", "razorpayFundAccountId": "fa_...",
    "bankName": "HDFC Bank", "bankIfsc": "HDFC0000634", "bankHolderName": "Ravi Kumar",
    "bankAccountNo": "XXXXXXXXXX6280", "bankLinkedAt": "...", "panNumber": "XXXXXX234C",
    "isSuspended": false, "suspendedAt": null, "suspendReason": null,
    "createdAt": "2024-01-01T00:00:00.000Z",
    "assignedLeads": [
      { "id": "64lead...", "status": "CLOSED", "buyerName": "Suresh Mehta", "createdAt": "...", "property": { "title": "...", "slug": "..." } }
    ],
    "properties": [
      { "id": "64prop...", "title": "...", "slug": "...", "publishStatus": "APPROVED", "price": 8500000, "city": "Pune", "createdAt": "..." }
    ],
    "metrics": { "totalLeads": 12, "closedLeads": 3, "droppedLeads": 1, "totalListings": 8, "activeListings": 6 }
  }
}
```

`bankAccountNo`/`panNumber` are tail-masked (same `maskPayout` helper `GET /api/admin/payout-accounts` uses, reused rather than a second copy of the masking rule). `assignedLeads`/`properties` are capped at 10, newest first — not the full history.

**Errors:** `404` partner not found.

---

### PATCH /api/admin/escrow/:id/release

Release a HELD escrow. `sellerDetails` gets a RazorpayX Payout for the escrow amount net of `partnerShare`/`platformFee` (direct bank transfer — no seller Razorpay onboarding required); `partnerDetails` additionally pays `partnerShare` out as a second payout. `platformFee` is never paid out anywhere — it's simply the portion held back in the RazorpayX account. Requires `HELD` status + captured payment.

**backend-work-still-open.md #1 — `platformFee` (R) is no longer an
accepted request field.** It is always the calculated cost-recovery
figure — `heldAmount * platformFeePct / 100`, where `platformFeePct`
comes from the `escrow_platform_fee_pct` platform-config key (default
1, i.e. 1%; switchable via `GET/PUT /api/admin/config/:key`, same
mechanism as GST/TDS below) — never an admin-typed rupee amount. Any
`platformFee` sent in the request body is silently ignored (stripped by
the request schema).

`partnerShare` is unchanged — still an optional, explicit amount. It is
**not** defaulted to the calculated Pi figure here: whether a partner
payout is actually attempted this release stays opt-in, exactly as
before, so a partner who hasn't finished payout-account onboarding
never blocks releasing escrow for a lead assigned to them. `GET
.../release-plan` below shows the calculated Pi for display/headroom
purposes regardless of whether this release actually pays it.

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
  "note": "Release approved."
}
```

Either `sellerDetails` (a real RazorpayX payout is made to that bank account, for `amount - partnerShare - platformFee`) **or** `manualTransferConfirmed: true` with a required `note` (the payout was made outside Razorpay — e.g. bank transfer) must be provided. Previously this was silently optional with no alternative, meaning an escrow could be marked `RELEASED` with no real transfer of any kind and no record of why. **`partnerShare + platformFee` must be less than the escrow amount (ΣPi + R > B is refused)** — now a real, meaningful gate since platformFee can no longer be typed down to dodge it.

`partnerDetails` is optional and independent of `sellerDetails` — if omitted, `partnerShare` is still recorded on the escrow (held back from the seller's payout) but no automated payout is made for it, same as before; provide `partnerDetails` (with a positive `partnerShare`) to also pay the partner directly via RazorpayX.

The release is atomic: if two requests for the same escrow race, only one succeeds — the other gets `400 "This escrow was already released or refunded"` before any Razorpay call is made, so a double-click or retry can never trigger two payouts. Each payout also passes the escrowId as its `reference_id`, which RazorpayX itself treats as an idempotency key — including across the seller and partner payouts separately. If either payout call fails, the escrow is rolled back to `HELD` (not left stuck `RELEASED` with no money moved) and the error is returned; a retry after a partial failure safely skips re-paying whichever leg already succeeded.

**Response `200`:**

```json
{
  "success": true,
  "message": "Escrow released",
  "data": { "id": "64esc...", "status": "RELEASED", "releasedAt": "...", "adminNote": "...", "netAmount": 320000, "platformFeePct": 1, "platformFeeAmount": 5000, "partnerShareAmount": 5000 }
}
```

**R30 — `netAmount` is `amount - partnerShare - platformFee`**: what the
seller actually netted, stored on the escrow itself so the "released"
screen doesn't have to re-derive it from `adminNote`'s free text. `null`
until release happens — see `GET .../release-plan` below for the pre-release
projection. `platformFeePct`/`platformFeeAmount`/`partnerShareAmount` are
not persisted on the escrow row itself — they're echoed back from this
release's own calculation (and recorded in the audit log) for the
response, not re-derivable from a later read of the escrow alone.

**Errors:** `400` not HELD · `400` payment not captured · `400` already released/refunded (race) · `400` neither `sellerDetails` nor `manualTransferConfirmed` provided · `400` `partnerShare + platformFee >= escrow amount`.

---

### GET /api/admin/escrow/:id/release-plan

What release conditions are met, the per-payee fee entitlement (gross,
GST, TDS, net), and whether the held amount even covers the fee — computed
fresh on every call, writes nothing.

**Auth:** ADMIN

**Response `200`:**

```json
{
  "escrowId": "...", "leadRef": "RD-L-000123", "heldAmount": 500000,
  "dealPrice": 9000000, "feePct": 2, "feeEntitlement": 180000, "coversFee": true,
  "shortfall": null,
  "netAmount": 320000,
  "deductions": { "gstPct": 0, "tdsPct": 0 },
  "platformFeePct": 1, "partnerSharePct": 2,
  "platformFeeAmount": 5000, "partnerShareAmount": 10000,
  "platformShareOfB": 0.01,
  "headroom": 485000,
  "entitlements": [{ "payeeRole": "CLOSING_AGENT", "payeeUserId": "...", "pctOfFee": 50, "gross": 90000, "gst": 0, "tds": 0, "net": 90000 }],
  "conditions": [{ "key": "ESCROW_HELD", "blocking": true, "ok": true, "detail": "status HELD, payment captured" }],
  "unmetBlocking": [],
  "readyToRelease": true
}
```

**R30 — `netAmount` here is a *projection*** (`heldAmount - feeEntitlement`,
clamped at 0): what the seller would net if released right now with the
fee taken in full out of the held escrow amount. It is **not** the same
figure that ends up stored on the escrow at release — an explicit
`partnerShare` override on the release request can differ from
`feeEntitlement`'s computed split. `shortfall` is non-null (and `coversFee`
false) when the held amount can't cover the computed fee at all; business
decides how that's settled, so it's surfaced rather than silently
pro-rated.

**backend-work-still-open.md #1 — a second, independent calculation on
the same held amount (B), unrelated to `feeEntitlement`/`netAmount`
above** (which claim against the *deal price*, routinely bigger than
B). This one answers "how much of the held amount itself does the
platform retain for payment-gateway cost recovery, and how much is
reserved for the partner, before the seller is ever paid":
- `platformFeeAmount` (R) = `heldAmount * platformFeePct / 100` —
  always calculated, never an admin input (see `PATCH .../release`
  above).
- `partnerShareAmount` (Pi) = `heldAmount * partnerSharePct / 100` if
  the lead has an assigned partner, else `0` — shown here for
  display/headroom purposes; whether a release actually pays this
  amount out is a separate, still-opt-in choice (see `PATCH
  .../release`).
- `platformShareOfB` = `platformFeeAmount / heldAmount` — R expressed
  as a fraction of B, for display. Derived, not an input; at the
  default rate this just equals `platformFeePct` itself.
- `headroom` = `heldAmount - platformFeeAmount - partnerShareAmount` —
  what's left over for the seller once both are accounted for.
  `PATCH .../release` refuses outright if `partnerShare + platformFee`
  (as actually requested) reaches or exceeds `heldAmount`.

**Errors:** `404` escrow or its lead not found.

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

### POST /api/admin/escrow/:id/freeze

Freeze a HELD escrow for a dispute (R10). Blocks `release` and `refund` — both
already reject anything that is not `HELD`, so setting the escrow to `FROZEN`
blocks both for free, the same way the existing `HELD_PAYOUT_FAILED` status
blocks the retry path.

**Auth:** ADMIN

**Request Body:** `{ "reason": "Buyer disputes the deal terms, pending admin review" }` —
required, 5–500 chars.

**Response `200`:** the escrow, `status: "FROZEN"`.

**Errors:** `400` escrow is not currently `HELD` (names its actual status) ·
`404` not found.

---

### POST /api/admin/escrow/:id/unfreeze

**Auth:** ADMIN

**Request Body:** none.

**Response `200`:** the escrow, `status: "HELD"` — unfreezing always restores
`HELD`, since that is the only status `FROZEN` is ever entered from.

**Errors:** `400` escrow is not currently `FROZEN` · `404` not found.

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

R31 — every row also carries `sellerPayoutStatus`/`sellerPayoutUtr` and
`partnerPayoutStatus`/`partnerPayoutUtr` (omitted above for brevity), mirroring
RazorpayX's own payout status values (`processing`/`processed`/`failed`/
`reversed`/...), kept current by the `payout.processed`/`payout.failed`/
`payout.reversed` webhooks. `null` until a payout for that leg is ever
attempted.

R30 — every row also carries `netAmount` (the "released" screen's figure) —
`null` until the escrow is actually released, at which point it's
`amount - partnerShare - platformFee`. The pre-release projection of the
same figure is `GET .../release-plan`'s `netAmount`, not this field.

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

### GET /api/admin/escrow/fees-due

Owner success fees (R26) that have been invoiced but not yet collected — the "chase these for payment" list.

**Auth:** ADMIN

**Query Parameters:** `page`, `limit` — standard pagination.

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "items": [
      {
        "id": "64lead...",
        "refCode": "RD-0042",
        "buyerName": "Asha Rao",
        "commissionStatus": "INVOICED",
        "feePct": 2.5,
        "dealPriceAtLock": 8500000,
        "commissionAmountPaise": 21250000,
        "invoiceUrl": "https://...",
        "invoicedAt": "...",
        "property": { "id": "64prop...", "title": "...", "partnerId": "64ptr...", "partner": { "name": "...", "companyName": "..." } },
        "feeReminders": [{ "id": "64rem...", "sentByAdminId": "64adm...", "createdAt": "..." }]
      }
    ],
    "total": 1, "page": 1, "limit": 20
  }
}
```

Ordered oldest-invoiced-first. `feeReminders` is the full reminder history for that lead, newest first — not just whether one was ever sent.

---

### POST /api/admin/escrow/fees-due/:id/remind

Send a payment reminder to the property owner for a lead's invoiced success fee. `:id` is the lead ID.

**Auth:** ADMIN

**Response `201`:**

```json
{
  "success": true,
  "message": "Reminder sent",
  "data": { "id": "64rem...", "leadId": "64lead...", "sentByAdminId": "64adm...", "createdAt": "..." }
}
```

Notifies the property owner (category `FEES`). **Errors:** `404` lead not found · `400` commission status isn't `INVOICED` (nothing to chase) or the lead has no resolvable property owner.

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
| `vendorId` | string | Filter by dispatched vendor (7.1/7.2) |
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
        "subscription": { "id": "64sub...", "amountPaid": 4999, "service": { "name": "Maintenance Premium", "price": 5000 } },
        "vendor": { "id": "64vnd...", "name": "Quick Fix Plumbers", "category": "PLUMBING" },
        "slaDeadline": "2024-02-02T00:00:00.000Z", "slaBreached": false, "over12h": false
      }
    ],
    "pagination": { "total": 15, "page": 1, "limit": 20, "totalPages": 1, "hasNext": false, "hasPrev": false }
  }
}
```

**7.3 — `slaDeadline`/`slaBreached`/`over12h` are computed on every read, never
stored** (the same reasoning as `ExclusiveMandate.effectiveStatus` elsewhere
in this codebase — a stored flag would need a scheduled job and would be
wrong in the window before it next ran). `slaDeadline` is `createdAt` plus a
priority-tiered duration (`ticket_sla_hours_urgent`/`_high`/`_normal` config
keys, defaulting to 12/24/72 hours); `slaBreached` is `false` for any
terminal ticket (`RESOLVED`/`VERIFIED_BY_USER`) regardless of deadline.
`over12h` is a flat, priority-independent "has this been open 12+ hours"
signal, distinct from the tiered SLA.

---

### GET /api/admin/tickets/stats

The stat cards on the admin tickets page — computed over the full table, not the currently-loaded page.

**Auth:** ADMIN

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "unassigned": 3, "inProgress": 5, "resolvedThisWeek": 2, "avgResolutionDays": 1.8,
    "unassignedSlaBreached": 1, "over12hCount": 2,
    "avgVendorRating": 4.3, "firstTimeVerifyRatePct": 82.5
  }
}
```

`unassigned` counts tickets with no `vendorName` set. `resolvedThisWeek`
counts by `resolvedAt` falling in the current week (Sunday–Saturday),
regardless of current status.

**7.3 — `unassignedSlaBreached`** is the "needs eyes on it right now" count:
unassigned, non-terminal tickets whose SLA deadline has already passed.
**`over12hCount`** is the same but using the flat 12-hour threshold instead
of the priority-tiered SLA, and isn't limited to unassigned tickets.

**7.6 — `avgVendorRating`** averages `vendorRating` across every rated
ticket (most are never rated, so this is over however many are).
**`firstTimeVerifyRatePct`** is the % of `VERIFIED_BY_USER` tickets that
were never reopened first — `null` if none have been verified yet.

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
    "adminNotes": "Replaced washer, fixed leak",
    "vendorId": "64vnd...", "vendorName": "Quick Fix Plumbers", "vendorPhone": "+919800100200",
    "scheduledSlot": "2024-01-15T10:00:00.000Z",
    "tenantContactName": "Site Caretaker", "tenantContactPhone": "+919800100299",
    "quotedChargeAmount": 1500,
    "resolutionUrls": ["https://.../after-photo-1.jpg"],
    "visitCharge": 500, "partsCharge": 1000, "totalCharge": 1500,
    "invoiceUrl": "https://realtydoor-production.s3.ap-south-2.amazonaws.com/receipts/....pdf",
    "leadId": null,
    "resolvedAt": "2024-01-15T00:00:00.000Z",
    "createdAt": "2024-01-13T00:00:00.000Z",
    "slaDeadline": "2024-01-14T00:00:00.000Z", "slaBreached": false, "over12h": false,
    "user": { "id": "64user...", "name": "Suresh Mehta", "email": "suresh@example.com", "phone": "+919000000003" },
    "subscription": { "service": { "name": "Maintenance Premium", "category": "MAINTENANCE", "price": 5000, "features": ["24/7 support"] } },
    "vendor": { "id": "64vnd...", "name": "Quick Fix Plumbers", "phone": "+919800100200", "category": "PLUMBING" },
    "lead": null
  }
}
```

**7.7 — `subscription.service.price`/`features` were on the `Service` model
all along; nothing selected them before this.** **7.8 — `subscription.amountPaid`
is "revenue amount" for this ticket's purchase** (already present via the
existing `subscription` include, not a new field); `leadId`/`lead` link the
ticket to the deal it traces back to, when set (see `.../link-deal` below).

**Errors:** `404` ticket not found.

---

### PATCH /api/admin/tickets/:id

Quick manual edit: status and/or free-text vendor name/phone, with no real
vendor link. Enforces the same transition machine as everywhere else:
`OPEN → IN_PROGRESS → RESOLVED → (reopen) → IN_PROGRESS`.

**Auth:** ADMIN

**Request Body:** `{ "status": "IN_PROGRESS" | "RESOLVED" }` and/or `{ "vendorName": "...", "vendorPhone": "..." }`

**Response `200`:** `{ "success": true, "message": "Ticket updated", "data": { ... } }`

**For a real vendor dispatch** (vendor FK, scheduling, tenant contact,
quoted charge) **or to resolve with a charge breakdown and receipt, use the
dedicated endpoints below instead** — this one is left as a lightweight
fallback for a bare status flip or a quick name/phone correction.

**Errors:** `400` invalid transition · `404` ticket not found.

---

### PATCH /api/admin/tickets/:id/dispatch

7.2 — dispatches a real `Vendor` (not free text) with a scheduled slot,
an on-site contact override, and a quoted charge. Auto-transitions a still-
`OPEN` ticket to `IN_PROGRESS` (dispatching a vendor is when work actually
starts); leaves status untouched if the ticket is already `IN_PROGRESS` or
bounced back from `RESOLVED`.

**7.9 — also the reassign action.** Calling this again on the same ticket
with a different `vendorId` reassigns it — distinguished in the audit log
and in which notification fires, not by a separate endpoint.

**Auth:** ADMIN

**Request Body:**

```json
{
  "vendorId": "64vnd...",
  "scheduledSlot": "2026-10-10T10:00:00.000Z",
  "tenantContactName": "Site Caretaker",
  "tenantContactPhone": "9876543210",
  "quotedChargeAmount": 1500
}
```

Only `vendorId` is required. `tenantContactName`/`Phone` are for when
whoever the vendor needs to meet on site isn't the ticket-raiser themselves.

**Response `200`:** the ticket, `vendorId`/`vendorName`/`vendorPhone` set
from the chosen vendor (the free-text fields are a denormalized display
cache, same pattern as `Lead.buyerName` alongside `buyerId`).

**Errors:** `400` ticket is `RESOLVED`/`VERIFIED_BY_USER` · `400` vendor not active · `404` ticket or vendor not found.

---

### PATCH /api/admin/tickets/:id/resolve

7.4 / 7.5 — resolves with an itemised charge breakdown and the vendor/
admin's "after" evidence, instead of the bare status flip above. A
non-zero total generates a simple payment receipt (visit charge + parts,
no GST breakup — same scope decision as the commission/builder-invoice
receipts) uploaded to S3; a zero-charge resolution (most tickets, covered
by the subscription) has nothing to issue a receipt for, so `invoiceUrl`
stays `null`.

**Auth:** ADMIN

**Request Body:**

```json
{
  "resolutionUrls": ["https://.../after-photo-1.jpg"],
  "visitCharge": 500,
  "partsCharge": 1000,
  "note": "Replaced washer, fixed leak"
}
```

All fields optional — omit `visitCharge`/`partsCharge` (or pass `0`) for a
no-charge resolution. `resolutionUrls` is the "after" half of 7.4's
before/after split; `photos` (set when the ticket was raised) is "before".

**Response `200`:** the ticket, `status: "RESOLVED"`, `totalCharge` =
`visitCharge + partsCharge`, `invoiceUrl` set only when `totalCharge > 0`.

**Errors:** `400` ticket's current status can't transition to `RESOLVED` (same transition machine as above) · `404` ticket not found.

---

### PATCH /api/admin/tickets/:id/link-deal

7.8 — links a post-purchase ticket back to the `Lead` (deal) it traces to.
A user can also set this at raise time (`POST /api/user/tickets`'s optional
`leadId`); this is for admin to set or correct it afterward.

**Auth:** ADMIN

**Request Body:** `{ "leadId": "64lead..." }`

**Errors:** `404` ticket or lead not found.

---

### GET /api/admin/tickets/:id/comments

Admin side of the same comment thread the user sees on `GET /api/user/tickets/:id/comments` — one thread, two sides, not a parallel admin-only thread. No ownership scope: admin can read any ticket's thread.

**Auth:** ADMIN

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

**Errors:** `404` ticket not found.

---

### POST /api/admin/tickets/:id/comments

Reply on a ticket's thread as admin.

**Auth:** ADMIN

**Request Body:** same shape as the user-facing version — `{ "text": "...", "photos": [] }`.

**Response `201`:**

```json
{
  "success": true,
  "message": "Comment posted",
  "data": { "id": "64cmt...", "ticketId": "64tkt...", "authorId": "64adm...", "authorRole": "ADMIN", "text": "...", "photos": [], "createdAt": "..." }
}
```

Notifies the ticket's owner (category `SERVICES`). **Errors:** `404` ticket not found.

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

**Note — `tenureMonths` here is the ADMIN-set (sanctioned) tenure,
separate from the user's original request** (`tenureMonthsRequested`,
set at `POST /user/loan`). Setting this never overwrites the other.

**Response `200`:**

```json
{
  "success": true,
  "message": "Loan status updated",
  "data": {
    "id": "64loan...", "status": "SANCTIONED", "sanctionedAt": "...", "disbursedAt": null,
    "interestRatePct": 8.5, "tenureMonths": 240, "tenureMonthsRequested": 240, "emiPaise": 4500000,
    "sanctionLetterUrl": "https://cdn.realtydoor.in/loans/sanction-64loan.pdf",
    "statusHistory": [
      { "status": "DOCUMENTS_VERIFIED", "at": "2026-10-01T10:00:00.000Z", "note": "All docs checked out" },
      { "status": "SANCTIONED", "at": "2026-10-08T10:00:00.000Z", "note": "Sanctioned by HDFC. Ref: HDFC2024012345." }
    ]
  }
}
```

**Added 2026-10-08 — `statusHistory` now actually gets written, as
`Json[]` objects (not `String[]` of JSON-encoded strings — the field
type changed too; no `JSON.parse` needed on the read side).** Previously
the field existed on the model but nothing ever appended to it, so a
dated step timeline had no data to show. One `{status, at, note}` entry
per status change, appended on every call — `note` is that specific
transition's `adminNote` (`null` when none given), not the lead-level
`adminNote` it may fall back to for display. The first entry
(`DOCUMENTS_PENDING`) is seeded automatically when the application is
created (`POST /user/loan`), so the array is never empty.

`emiPaise`/`sanctionedAmountPaise` (not shown above, accepted but not
yet set in this example) are `Float`, not `Int`, as of 2026-10-08 — see
`POST /user/loan`'s note on `loanAmountRequestedPaise`.

Notification `linkUrl` (`LOAN_STATUS_UPDATE`) is
`/user/loans/sanctioned?id=:loanId` when `status` is `SANCTIONED`, else
`/user/loans` — corrected from the previous `/dashboard/loan/:id`, which
doesn't exist in the frontend. The status-update email's link follows
the same rule.

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

## Staff Directory / Permission Matrix (16.x)

Internal RealtyDoor staff — every `ADMIN`-role `User`, with a `staffRole`
label and the `adminPermissions` scopes that actually get checked. Distinct
from the public-facing **Team roster** (`TeamMember`, the About-page
listing, no auth implications) and from **Vendors** (external contractors).

**The permission scopes:** `LEADS`, `LISTINGS`, `KYC`, `FINANCE`,
`COMMISSION`, `TICKETS`, `USERS`, `CONTENT`, `STAFF`.

**The staff roles (presets, not what's actually checked):** `SUPER_ADMIN`
(bypasses the permission check entirely), `SUPPORT`, `FINANCE_STAFF`,
`CONTENT_MANAGER`.

**Backward compatibility is the load-bearing design decision here.** Every
admin account that existed before this feature shipped has `staffRole`
unset (`null`) — not an empty permission set. `requirePermission` treats a
`null` `staffRole` as full access, exactly like before this feature
existed. Only once an admin is explicitly given a `staffRole` (via
`POST .../staff/:id` below) does `adminPermissions` start being checked at
all. This is deliberate: an empty `adminPermissions` array can mean either
"never configured" or "deliberately granted nothing," and on MongoDB a
List field reads back as `[]` either way (unlike a nullable scalar, which
can distinguish missing from set) — so `staffRole`, a plain nullable
string, is the actual gate, not the array.

**Only a small, selective set of existing routes are gated by a
permission** in this pass — not a retrofit across every admin endpoint in
the app. Gated so far: `PATCH /admin/kyc/:userId/verify` (`KYC`),
`PATCH`/`POST /admin/escrow/:id/release`/`refund` (`FINANCE`),
`POST /admin/leads/:id/commission/lock` (`COMMISSION`),
`POST .../commission/invoice`/`collect` (`FINANCE`), and the staff
directory routes below (`STAFF`). Every other admin route is unchanged,
still only gated by the existing blanket `requireAdmin`.

### GET /api/admin/staff

The directory: every `ADMIN`-role user (paginated).

**Auth:** ADMIN + `STAFF` permission

**Response `200`:**

```json
{
  "success": true, "message": "Success",
  "data": {
    "data": [
      {
        "id": "64admin...", "name": "Priya Support", "email": "priya@realtydoor.com", "phone": "+919000000010",
        "staffRole": "SUPPORT", "adminPermissions": ["LEADS", "LISTINGS", "KYC", "TICKETS"],
        "isSuspended": false, "createdAt": "2026-01-10T00:00:00.000Z"
      }
    ],
    "pagination": { "total": 6, "page": 1, "limit": 20, "totalPages": 1, "hasNext": false, "hasPrev": false }
  }
}
```

`staffRole: null` rows are legacy/unscoped admins with full access.

---

### POST /api/admin/staff/:id

Promotes an existing account (any role) to staff. Flips `role` to `ADMIN`
first if it wasn't already (reusing `PATCH /admin/users/:id/role`'s own
Clerk-sync logic), then sets `staffRole`/`adminPermissions`.

**Auth:** ADMIN + `STAFF` permission

**Request Body:**

```json
{ "staffRole": "SUPPORT", "permissions": ["LEADS", "TICKETS"] }
```

`staffRole` is required — one of the four listed above. `permissions` is
optional; omitted, it falls back to a sensible default set per `staffRole`
(e.g. `SUPPORT` defaults to `LEADS`/`LISTINGS`/`KYC`/`TICKETS`).
`SUPER_ADMIN` bypasses the check regardless of what's stored here.

**Response `201`:** the user, `role: "ADMIN"`, `staffRole`/`adminPermissions` set.

**Errors:** `400` invalid `staffRole` or an unknown permission scope · `404` user not found.

---

### PATCH /api/admin/staff/:id

Updates an existing staff member's role label and/or permissions.

**Auth:** ADMIN + `STAFF` permission

**Request Body:** `{ "staffRole": "FINANCE_STAFF" }` and/or `{ "permissions": ["FINANCE", "COMMISSION"] }` — at least one required.

**Response `200`:** the user with updated `staffRole`/`adminPermissions`.

**Errors:** `400` invalid `staffRole`/permission, or neither field given · `400` target is not a staff member (not `ADMIN`-role) · `404` not found.

---

### DELETE /api/admin/staff/:id

Offboards a staff member back to a plain `USER` account — `staffRole` and
`adminPermissions` are cleared. Distinct from
`PATCH /admin/users/:id/suspend`, which still refuses to touch an `ADMIN`
account at all (unrelated to this feature, left as-is); this is the
staff-directory-specific removal path.

**Auth:** ADMIN + `STAFF` permission

**Errors:** `400` cannot remove yourself · `400` target is not a staff member · `404` not found.

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

**Fixed 2026-10-07 — this used to 500 once an orphaned row aged onto a
page.** `UserDocument.user` is a required relation, but Mongo doesn't
enforce it — a row can outlive the account it points to (e.g. a deleted
user). The previous implementation used `include: { user }`, and Prisma
throws on the whole query the moment one such row is in the result set
("Field user is required to return data, got `null` instead"), not just
that row. Users are now loaded separately and merged in; a row whose user
no longer exists comes back with `"user": null` instead of breaking the
page.

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
| `nearPropertyId` | string | Compute each vendor's `distanceMetres` from this property's coordinates |
| `nearLat`, `nearLng` | number | Compute distance from an arbitrary point instead (ignored if `nearPropertyId` is also given and resolves) |
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
        "latitude": 18.5204, "longitude": 73.8567,
        "notes": "Available 7 days, handles burst pipes.",
        "isActive": true,
        "createdAt": "2024-01-01T00:00:00.000Z",
        "jobsCount": 12,
        "rating": 4.3,
        "availableSlots": [{ "id": "64slot...", "dayOfWeek": 1, "startTime": "09:00", "endTime": "18:00" }],
        "distanceMetres": 3053
      }
    ],
    "pagination": { "total": 8, "page": 1, "limit": 20, "totalPages": 1, "hasNext": false, "hasPrev": false }
  }
}
```

**7.1 — `jobsCount`/`rating` are aggregated from `ServiceTicket` now that
`.../dispatch` links a real `vendorId`** (previously `vendorName` was free
text, so there was nothing to aggregate against). `jobsCount` is every
ticket ever dispatched to this vendor; `rating` averages `vendorRating`
across whichever of those were actually rated (`null` if none have been).

**`availableSlots`** is the vendor's recurring weekly availability (see
`.../availability` below) — a general "usually free these hours" window,
distinct from `ServiceTicket.scheduledSlot` (a specific booked appointment
for one ticket).

**`distanceMetres`** is only computed when a reference point is given
(`nearPropertyId` or `nearLat`/`nearLng`) — `null` otherwise, not a guess.
Reuses `lib/mapLink.js`'s great-circle `distanceMetres`, the same utility
Property's own location-mismatch check uses.

---

### GET /api/admin/vendors/:id

Single vendor with the same `jobsCount`/`rating`/`availableSlots`/`distanceMetres` as the list above.

**Auth:** ADMIN

**Query Parameters:** `nearPropertyId`, or `nearLat`/`nearLng` — same as the list endpoint.

**Errors:** `404` vendor not found.

---

### GET /api/admin/vendors/:id/availability

A vendor's recurring weekly availability windows.

**Auth:** ADMIN

**Response `200`:** `[{ "id": "64slot...", "dayOfWeek": 1, "startTime": "09:00", "endTime": "13:00" }, ...]`, ordered by day then start time.

---

### POST /api/admin/vendors/:id/availability

Adds one recurring weekly window. No overlap check — a vendor having split
hours in a day (e.g. `09:00–13:00` and `15:00–19:00`) is normal, not a
duplicate.

**Auth:** ADMIN

**Request Body:** `{ "dayOfWeek": 1, "startTime": "09:00", "endTime": "18:00" }`

`dayOfWeek` is `0` (Sunday) through `6` (Saturday), matching JS
`Date#getDay()`. `startTime`/`endTime` are `"HH:mm"`, 24-hour.

**Response `201`:** the created slot.

**Errors:** `400` `endTime` not after `startTime`, or not `HH:mm` · `404` vendor not found.

---

### DELETE /api/admin/vendors/:id/availability/:slotId

**Auth:** ADMIN

**Errors:** `404` slot not found for this vendor.

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
  "notes":    "Available 7 days, handles burst pipes.",
  "latitude":  18.5204,
  "longitude": 73.8567
}
```

`name`, `phone`, and `category` are required. `category`: `PLUMBING` · `ELECTRICAL` · `PAINTING` · `GENERAL` · `CARPENTRY` · `OTHER`.
`latitude`/`longitude` (7.1) are the vendor's base location, for the directory's `distanceMetres` — both optional, same `PATCH` support on update.

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
