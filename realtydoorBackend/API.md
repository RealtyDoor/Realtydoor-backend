# RealtyDoor Backend — API Reference

---

## Overview

**Base URL:** `http://localhost:5000/api` (dev) · `https://api.realtydoor.in/api` (prod)

### Authentication

All protected routes require a Clerk JWT in the `Authorization` header:

```
Authorization: Bearer <clerk_session_token>
```

Roles: `USER` · `PARTNER` · `ADMIN`

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

Verifies Clerk JWT, upserts DB user record, returns profile.

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
    "phoneVerifiedAt": "2024-01-15T10:30:00.000Z",
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
    "updatedAt": "2024-01-15T10:30:00.000Z"
  }
}
```

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

`activeSubscription` is `null` if the user has no subscription.

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

**Errors:** `400` if role is not `"PARTNER"`.

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
| `propertyStatus` | string | `READY_TO_MOVE` · `UNDER_CONSTRUCTION` |
| `bhk` | number | Number of bedrooms |
| `minPrice` | number | Min price (₹) |
| `maxPrice` | number | Max price (₹) |
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
        "furnishing": "Semi-Furnished"
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
      "furnishing": "Fully Furnished"
    }
  ]
}
```

---

### GET /api/properties/:slug

Full property detail for a single approved listing.

**Auth:** Public

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "id": "64abc...",
    "title": "3 BHK Flat in Baner",
    "slug": "3-bhk-flat-in-baner-1700000000000",
    "description": "Spacious 3 BHK with great amenities...",
    "price": 8500000,
    "monthlyRent": null,
    "priceNegotiable": true,
    "propertyType": "FLAT",
    "listingType": "SALE",
    "propertyStatus": "READY_TO_MOVE",
    "publishStatus": "APPROVED",
    "isFeatured": false,
    "isVerified": true,
    "bhk": 3,
    "bathrooms": 2,
    "carpetArea": 1200,
    "builtUpArea": 1400,
    "plotArea": null,
    "floorNumber": 4,
    "totalFloors": 10,
    "ageOfProperty": 2,
    "furnishing": "Semi-Furnished",
    "facing": "East",
    "possessionDate": null,
    "address": "Plot 12, Baner Road",
    "locality": "Baner",
    "city": "Pune",
    "state": "Maharashtra",
    "pincode": "411045",
    "latitude": 18.5596,
    "longitude": 73.7769,
    "nearbyLandmarks": ["D-Mart", "Orchid School"],
    "reraNumber": "P52100012345",
    "bankApprovals": ["SBI", "HDFC"],
    "images": ["https://cdn.realtydoor.in/prop1.jpg"],
    "coverImageIndex": 0,
    "floorPlanUrl": null,
    "virtualTourUrl": null,
    "videoUrl": null,
    "amenities": ["Gym", "Swimming Pool", "24x7 Security"],
    "societyFeatures": ["Club House", "Children's Play Area"],
    "metaTitle": null,
    "metaDescription": null,
    "createdAt": "2024-01-10T00:00:00.000Z",
    "updatedAt": "2024-01-15T00:00:00.000Z",
    "partner": {
      "companyName": "RealtyPro Solutions",
      "partnerSubType": "AGENT"
    }
  }
}
```

**Errors:** `404` if not found or not approved.

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
  "reraNumber": "P52100012345"
}
```

Fields `publishStatus`, `isVerified`, `partnerId` are silently stripped.

`furnishing` and `facing` are optional — if omitted, they default to `"Unfurnished"` and `"East"` respectively.

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

**Response `200`:**

```json
{ "success": true, "message": "Listing updated", "data": { ... } }
```

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
  "buyerEmail": "suresh@example.com",
  "buyerPhone": "+919876543210",
  "buyerMessage": "Interested in a site visit this weekend."
}
```

`buyerMessage` is optional.

**Response `201`:**

```json
{
  "success": true,
  "message": "We'll reach out within 24 hours",
  "data": {
    "id": "64lead...",
    "buyerName": "Suresh Mehta",
    "buyerEmail": "suresh@example.com",
    "buyerPhone": "+919876543210",
    "propertyId": "64abc...",
    "status": "UNASSIGNED",
    "createdAt": "2024-01-15T10:00:00.000Z"
  }
}
```

---

### GET /api/leads/partner

All leads assigned to the authenticated partner. Phone is masked until OTP is verified.

**Auth:** PARTNER + KYC verified

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": [
    {
      "id": "64lead...",
      "buyerName": "Suresh Mehta",
      "buyerEmail": "suresh@example.com",
      "buyerPhone": "+91XXXXXX3210",
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
    "buyerName": "Suresh Mehta",
    "buyerPhone": "+91XXXXXX3210",
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

`buyerPhone` is unmasked once `isOtpVerified` is `true`.  
**Errors:** `404` not found or not assigned to this partner.

---

### POST /api/leads/partner/:id/schedule-visit

Schedule a site visit and send a 4-digit OTP to the buyer via WhatsApp.

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

### POST /api/leads/partner/:id/verify-otp

Verify the 4-digit site-visit OTP. Reveals buyer's full phone number on success.

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

**Response `200`:**

```json
{
  "success": true,
  "message": "Documentation uploaded",
  "data": {
    "id": "64lead...",
    "visitNotes": "Buyer was very interested.",
    "visitPhotoUrls": ["https://..."],
    "closureDocumentUrls": ["https://..."]
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

All `/api/user/*` routes require `authenticate` + `requireUser`.

### POST /api/user/verify-phone

Request a 4-digit phone verification OTP via WhatsApp.

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
  "data": { "message": "OTP sent via WhatsApp" }
}
```

**Errors:** `409` phone already registered to another account · `429` OTP locked.

---

### POST /api/user/verify-phone/otp

Verify the 4-digit OTP to confirm phone ownership.

**Auth:** USER (rate-limited)

**Request Body:**

```json
{ "otp": "7412" }
```

**Response `200`:**

```json
{
  "success": true,
  "message": "Phone number verified",
  "data": { "phoneVerified": true, "phone": "+919876543210" }
}
```

**Errors:** `400` OTP expired or wrong · `429` account locked 30 minutes.

---

### PATCH /api/user/profile

Update display name and NRI flag.

**Auth:** USER

**Request Body:**

```json
{ "name": "Suresh Mehta", "isNRI": false }
```

Both fields are optional. At least one must be provided.

**Response `200`:**

```json
{
  "success": true,
  "message": "Profile updated",
  "data": { "id": "64user...", "name": "Suresh Mehta", "isNRI": false }
}
```

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
      "buyerName": "Suresh Mehta",
      "status": "ASSIGNED",
      "createdAt": "2024-01-15T10:00:00.000Z",
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
| `documentType` | string | `PAN_CARD` · `AADHAR` · `SALARY_SLIP` · `FORM_16` · `BANK_STATEMENT` |

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
  "priority": "HIGH"
}
```

`category`: `PLUMBING` · `ELECTRICAL` · `PAINTING` · `GENERAL`  
`priority`: `NORMAL` (default) · `HIGH` · `URGENT`

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
    "createdAt": "2024-02-01T00:00:00.000Z"
  }
}
```

**Errors:** `404` subscription not found · `400` service not active.

---

### PATCH /api/user/tickets/:id/verify

Confirm service was completed. Moves ticket to `VERIFIED_BY_USER`.

**Auth:** USER

**Request Body:** _(none)_

**Response `200`:**

```json
{
  "success": true,
  "message": "Ticket verified and closed",
  "data": { "id": "64tkt...", "status": "VERIFIED_BY_USER", "verifiedAt": "..." }
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

### POST /api/partner/kyc

Submit KYC documents for admin review (up to 5 files).

**Auth:** PARTNER (KYC not required to submit)

**Request:** `multipart/form-data`, field name `documents`, up to 5 files.

**Response `200`:**

```json
{
  "success": true,
  "message": "KYC submitted for review. Usually verified within 24 hours.",
  "data": { "id": "64user...", "kycStatus": "PENDING_REVIEW", "kycDocumentUrls": ["..."] }
}
```

**Errors:** `400` KYC already VERIFIED.

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
    "createdAt": "2024-01-01T00:00:00.000Z"
  }
}
```

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

Create a Razorpay escrow order (token advance). Only one active escrow (`PAYMENT_PENDING` or `HELD`) per lead.

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
**Errors:** `404` lead not found · `400` active escrow already exists.

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

**Errors:** `400` invalid signature · `404` order not found.

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

### PATCH /api/notifications/:id/read

Mark a notification as read.

**Auth:** USER

**Response `200`:** `{ "success": true, "message": "Marked as read", "data": null }`

---

### PATCH /api/notifications/read-all

Mark all unread notifications as read.

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

`phone` optional. `name` min 2. `subject` min 3. `message` min 10 chars.

**Response `201`:**

```json
{
  "success": true,
  "message": "Message received. We will get back to you shortly.",
  "data": { "id": "64msg..." }
}
```

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
    "platform_name": "RealtyDoor"
  }
}
```

Returns a flat key → value object. Only keys with `isPublic: true` appear here.

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
        "buyerName": "Suresh Mehta",
        "buyerEmail": "suresh@example.com",
        "buyerPhone": "+919876543210",
        "status": "ASSIGNED",
        "isOtpVerified": false,
        "createdAt": "2024-01-15T10:00:00.000Z",
        "property": { "title": "3 BHK Flat in Baner", "slug": "...", "city": "Pune" },
        "assignedPartner": { "name": "Rajdeep Kumar", "email": "rajdeep@example.com" }
      }
    ],
    "pagination": { "total": 50, "page": 1, "limit": 20, "totalPages": 3, "hasNext": true, "hasPrev": false }
  }
}
```

---

### GET /api/admin/leads/:id

Full lead detail including property, assigned partner, and escrow transactions.

**Auth:** ADMIN

**Response `200`:**

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "id": "64lead...",
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

**Errors:** `404` lead not found · `400` partner not found or not KYC verified.

---

### GET /api/admin/properties

Properties with `PENDING_APPROVAL` status (paginated).

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

Release a HELD escrow to seller via Razorpay. Requires `HELD` status + captured payment.

**Auth:** ADMIN

**Request Body:**

```json
{
  "sellerAccountId": "acc_...",
  "partnerShare": 5000,
  "platformFee": 2000,
  "note": "Release approved."
}
```

All fields optional. Omitting `sellerAccountId` skips Razorpay transfer.

**Response `200`:**

```json
{
  "success": true,
  "message": "Escrow released",
  "data": { "id": "64esc...", "status": "RELEASED", "releasedAt": "...", "adminNote": "..." }
}
```

**Errors:** `400` not HELD · `400` payment not captured.

---

### POST /api/admin/escrow/:id/refund

Refund a HELD escrow to buyer. Sends buyer notification.

**Auth:** ADMIN

**Request Body:** _(none)_

**Response `200`:**

```json
{ "success": true, "message": "Escrow refunded", "data": { "id": "64esc...", "status": "REFUNDED", "refundedAt": "..." } }
```

**Errors:** `400` not HELD · `400` payment not captured.

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
        "amount": 50000,
        "currency": "INR",
        "status": "HELD",
        "heldAt": "2024-01-16T00:00:00.000Z",
        "createdAt": "2024-01-15T00:00:00.000Z"
      }
    ],
    "pagination": { "total": 20, "page": 1, "limit": 20, "totalPages": 1, "hasNext": false, "hasPrev": false }
  }
}
```

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
| `status` | string | `DOCUMENTS_PENDING` · `DOCUMENTS_SUBMITTED` · `DOCUMENTS_VERIFIED` · `SENT_TO_BANK` · `AWAITING_SANCTION` · `SANCTIONED` · `DISBURSED` · `REJECTED` |
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

Update loan status. Sets `sanctionedAt` on `SANCTIONED`, `disbursedAt` on `DISBURSED`.

**Auth:** ADMIN

**Request Body:**

```json
{ "status": "SANCTIONED", "adminNote": "Sanctioned by HDFC. Ref: HDFC2024012345." }
```

**Response `200`:**

```json
{
  "success": true,
  "message": "Loan status updated",
  "data": { "id": "64loan...", "status": "SANCTIONED", "sanctionedAt": "...", "disbursedAt": null }
}
```

**Errors:** `404` loan not found.

---

### GET /api/admin/users

All users (paginated). Filter by role or search.

**Auth:** ADMIN

**Query Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `role` | string | `USER` · `PARTNER` · `ADMIN` |
| `search` | string | Case-insensitive search on name or email |
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
`READY_TO_MOVE` · `UNDER_CONSTRUCTION` · `SOLD` · `RENTED`

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
