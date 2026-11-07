const { createPropertySchema, missingPriceMessage } = require('../modules/properties/properties.validator');

// Turns a finished build-out form into the fields of a listing (Property). Pure: no database, no files. The form's own field keys
// are mapped here (the field list lives in the frontend's src/lib/onboardingForm.ts), so a new question is only copied across once
// it is added to this map; until then it stays on the request and is reported as "not copied".

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const int = (v) => (num(v) === undefined ? undefined : Math.round(v));
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const yes = (v) => (v === 'yes' ? true : v === 'no' ? false : undefined);
const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : []);
const lines = (v) => (str(v) ? str(v).split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean) : []);
const rows = (v) => (Array.isArray(v) ? v.filter((r) => r && typeof r === 'object') : []);

const IMAGE_KEYS = ['photos', 'site_photos', 'renders'];
const FLOOR_PLAN_KEYS = ['floor_plan', 'floor_plans'];
const isImageFile = (name) => /\.(jpe?g|png|webp)$/i.test(name || '');
const dayToIso = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d || '') ? `${d}T00:00:00.000Z` : undefined);

function bhkOf(label) {
  const m = /(\d+)/.exec(label || '');
  if (m) return Math.min(Math.max(Number(m[1]), 1), 10);
  return /rk|studio/i.test(label || '') ? 1 : undefined;
}

const AREA_UNIT = { Acres: 'acres', Guntas: 'guntas', 'Sq ft': 'sqft', 'Sq m': 'sqm' };

function statusOf(a) {
  const s = a.launchStatus || a.possessionStatus || a.siteStatus;
  if (!s) return undefined;
  if (/pre-launch/i.test(s)) return 'PRE_LAUNCH';
  if (/under construction|just launched|nearing|in progress/i.test(s)) return 'UNDER_CONSTRUCTION';
  if (/ready|resale|tenanted/i.test(s)) return 'READY_TO_MOVE';
  return undefined;
}

// What a missing or bad field is called in the form, so the admin is told which answer to fill in.
const FIELD_LABEL = {
  title: 'Name for the listing (the "Name for your list" box, or the project / layout name)',
  description: 'Describe it (at least 20 characters)',
  address: 'Address', locality: 'Locality / neighbourhood', city: 'City / town', state: 'State', pincode: 'Pincode (6 digits)',
  price: 'Price', monthlyRent: 'Monthly rent', propertyType: 'Property type', listingType: 'Sale or lease',
};

// Answer keys read below; anything else the sender filled in stays on the request.
const USED = new Set([
  'projectName', 'layoutName', 'description', 'highlights', 'addressLine', 'locality', 'city', 'state', 'pincode', 'landmark', 'nearby', 'mapLink',
  'askingPrice', 'priceMin', 'priceMax', 'negotiable', 'monthlyRent', 'dealKind', 'bhk', 'bathrooms', 'balconies', 'carpetArea', 'builtUpArea',
  'plotArea', 'floorNumber', 'totalFloors', 'floors', 'ageOfProperty', 'furnishing', 'facing', 'possessionDate', 'possessionStatus', 'launchStatus',
  'siteStatus', 'developerName', 'builderName', 'landAreaValue', 'landAreaUnit', 'openSpacePct', 'totalUnits', 'unitsLeft', 'unitTypes', 'reraNumber',
  'loanBanks', 'hasLoan', 'loanBank', 'amenities', 'otherAmenities', 'videoLink',
  // About the sender, not the property: kept on the request, never part of a listing, so not reported as "not copied".
  'companyName', 'alternatePhone', 'bestTime', 'languages', 'listWhen',
]);

function buildPayload(request) {
  const a = request.data || {};
  const type = request.propertyType;
  const leased = type !== 'NEW_PROJECT' && a.dealKind === 'Lease / rent';
  const unitRows = rows(a.unitTypes);
  const cheapest = unitRows.map((r) => num(r.priceFrom)).filter((n) => n !== undefined);

  const highlights = lines(a.highlights).filter((l) => l.length > 1);
  const description = [str(a.description), highlights.length ? `Highlights:\n${highlights.map((h) => `- ${h}`).join('\n')}` : null].filter(Boolean).join('\n\n');

  const configs = [...new Set(unitRows.map((r) => str(r.config) || str(r.kind)).filter(Boolean).map((c) => c.slice(0, 80)))].slice(0, 30);
  const available = unitRows.map((r) => num(r.available)).filter((n) => n !== undefined);

  const facings = list(a.facings);
  const p = {
    title: str(request.title) || str(a.projectName) || str(a.layoutName),
    description: description || undefined,
    propertyType: type,
    listingType: leased ? 'LEASE' : 'SALE',
    propertyStatus: statusOf(a),
    price: num(a.askingPrice) ?? num(a.priceMin) ?? (cheapest.length ? Math.min(...cheapest) : undefined),
    priceMax: num(a.priceMax) ?? (type === 'PLOT' ? num(a.priceMax) : undefined),
    monthlyRent: num(a.monthlyRent),
    priceNegotiable: yes(a.negotiable),
    bhk: bhkOf(a.bhk),
    bathrooms: int(a.bathrooms) || undefined,
    balconies: int(a.balconies),
    carpetArea: num(a.carpetArea) || undefined,
    builtUpArea: num(a.builtUpArea) || undefined,
    plotArea: num(a.plotArea) || (type === 'PLOT' && unitRows.length === 1 ? num(unitRows[0].sqft) : undefined) || undefined,
    floorNumber: int(a.floorNumber),
    totalFloors: int(a.totalFloors) || int(a.floors) || undefined,
    ageOfProperty: int(a.ageOfProperty),
    furnishing: str(a.furnishing),
    facing: str(a.facing) || (facings.length === 1 ? facings[0] : undefined),
    possessionDate: dayToIso(a.possessionDate),
    address: str(a.addressLine),
    locality: str(a.locality),
    city: str(a.city),
    state: str(a.state),
    pincode: str(a.pincode),
    nearbyLandmarks: [str(a.landmark), ...lines(a.nearby)].filter(Boolean).slice(0, 12).map((x) => x.slice(0, 100)),
    mapLink: str(a.mapLink)?.slice(0, 2000),
    reraNumber: str(a.reraNumber),
    bankApprovals: list(a.loanBanks),
    isMortgaged: yes(a.hasLoan),
    mortgageLender: str(a.loanBank)?.slice(0, 200),
    amenities: [...list(a.amenities), ...lines(a.otherAmenities)],
    developer: str(a.developerName) || str(a.builderName),
    landAreaValue: num(a.landAreaValue) || undefined,
    landAreaUnit: AREA_UNIT[a.landAreaUnit],
    openSpacePct: int(a.openSpacePct),
    totalUnits: int(a.totalUnits) || undefined,
    unitsLeft: int(a.unitsLeft) ?? (available.length ? Math.round(available.reduce((x, y) => x + y, 0)) : undefined),
    unitConfigurations: configs.length ? configs : undefined,
    videoUrl: /^https?:\/\//i.test(a.videoLink || '') ? a.videoLink.trim().slice(0, 2000) : undefined,
  };
  // A new-project or plot listing is described by its price range, not one unit's rooms: those fields do not apply to it.
  if (type === 'NEW_PROJECT' || type === 'PLOT') { delete p.bhk; delete p.bathrooms; delete p.balconies; }
  if (p.priceMax !== undefined && p.price !== undefined && p.priceMax < p.price) delete p.priceMax;
  return Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0)));
}

/** The files to carry across: photos go to the listing's pictures, a floor plan to its floor-plan slot, the rest to its documents. */
function planFiles(request) {
  const docs = Array.isArray(request.documents) ? request.documents : [];
  const images = []; const documents = []; let floorPlan = null;
  for (const d of docs) {
    if (!d || !d.s3Key) continue;
    if (IMAGE_KEYS.includes(d.key) && isImageFile(d.name)) images.push(d);
    else if (FLOOR_PLAN_KEYS.includes(d.key) && !floorPlan && isImageFile(d.name)) floorPlan = d;
    else documents.push(d);
  }
  return { images, floorPlan, documents };
}

// The form's document keys that become the builder project's three approvals (the model keeps one link for each).
const PROJECT_DOC_KEYS = { approved_plan: 'approvedPlanUrl', commencement_certificate: 'commencementCertificateUrl', land_title: 'landTitleDocUrl' };

/**
 * The builder's Project record a NEW_PROJECT request can also become. `fields` is everything except the three approval links, which
 * need the files copied first: `docs` says which form file feeds which link. No units are made: the form only has unit-type summary rows,
 * and a unit needs a real number (A-1203), so the project starts with none and units are added later. Never carries account
 * numbers or IFSC: only the name of the designated-account bank.
 */
function buildProject(request, listingPayload, files) {
  if (request.propertyType !== 'NEW_PROJECT') return { available: false, reason: 'Only a new project can also become a builder project record.' };
  const a = request.data || {};
  const fields = {
    title: listingPayload.title,
    description: listingPayload.description,
    address: listingPayload.address,
    locality: listingPayload.locality,
    city: listingPayload.city,
    state: listingPayload.state,
    pincode: listingPayload.pincode,
    reraProjectNumber: str(a.reraNumber),
    designatedAccountBankName: str(a.escrowBank)?.slice(0, 200),
  };
  const docs = {};
  for (const d of files.documents) {
    const field = PROJECT_DOC_KEYS[d.key];
    if (field && !docs[field]) docs[field] = d;
  }
  const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== ''));
  const complete = ['title', 'description', 'address', 'locality', 'city', 'state', 'pincode'].every((k) => clean[k]);
  return {
    available: true,
    fields: clean,
    docs,
    carries: {
      reraNumber: !!clean.reraProjectNumber, designatedAccountBank: !!clean.designatedAccountBankName,
      approvedPlan: !!docs.approvedPlanUrl, commencementCertificate: !!docs.commencementCertificateUrl, landTitle: !!docs.landTitleDocUrl,
    },
    canCreate: complete,
  };
}

/**
 * The listing a request would become, what is still missing, what is not copied, and how many files go across.
 * `problems` is empty only when the listing can be created as is.
 */
function buildListing(request) {
  const payload = buildPayload(request);
  const problems = [];
  const parsed = createPropertySchema.safeParse(payload);
  if (!parsed.success) {
    const seen = new Set();
    for (const issue of parsed.error.issues) {
      const field = String(issue.path[0] ?? 'form');
      if (seen.has(field)) continue;
      seen.add(field);
      problems.push({ field, label: FIELD_LABEL[field] || field, message: issue.message });
    }
  } else {
    const price = missingPriceMessage(parsed.data);
    if (price) problems.push({ field: payload.listingType === 'SALE' ? 'price' : 'monthlyRent', label: FIELD_LABEL[payload.listingType === 'SALE' ? 'price' : 'monthlyRent'], message: price });
  }
  const files = planFiles(request);
  const answers = request.data || {};
  const notCopied = Object.keys(answers).filter((k) => !USED.has(k));
  return {
    payload: parsed.success ? parsed.data : payload,
    problems,
    notCopied,
    counts: { photos: files.images.length, documents: files.documents.length + (files.floorPlan ? 1 : 0), floorPlan: !!files.floorPlan },
    files,
    project: buildProject(request, parsed.success ? parsed.data : payload, files),
  };
}

module.exports = { buildListing, buildPayload, buildProject, planFiles, bhkOf, FIELD_LABEL, PROJECT_DOC_KEYS };
