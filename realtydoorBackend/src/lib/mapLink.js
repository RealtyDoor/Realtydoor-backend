// Coordinate handling for the 4.6 location check.
//
// Deliberately contains NO network calls and no third-party geocoding. Pulling
// coordinates out of a map URL is pure string parsing, so it works offline,
// costs nothing and cannot fail at request time. Turning a street ADDRESS into
// coordinates is a different problem that does need a provider, and no
// provider has been chosen — so this module does not pretend to do it.

const EARTH_RADIUS_M = 6_371_000;

// Rejects values that are syntactically numbers but not positions on Earth,
// and the (0, 0) pair, which in practice means "nothing was set" rather than a
// point in the Gulf of Guinea.
function isValidLatLng(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
  if (lat === 0 && lng === 0) return false;
  return true;
}

// Ordered most-specific first. A Google place URL contains both a /@lat,lng
// view centre and often a q= or !3d!4d pair; the !3d!4d pair is the actual
// place, the /@ centre is just where the camera was, so it wins.
const PATTERNS = [
  // .../data=!3d18.5204!4d73.8567 — the resolved place coordinates
  { name: 'data-3d4d', re: /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/ },
  // ?q=18.5204,73.8567 or ?query=... or ?ll=... or ?destination=...
  { name: 'query-param', re: /[?&](?:q|query|ll|sll|destination|center)=(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i },
  // /@18.5204,73.8567,17z — the map view centre
  { name: 'at-centre', re: /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/ },
  // A bare "lat,lng" pasted without a URL around it
  { name: 'bare-pair', re: /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/ },
];

// Shortened links carry no coordinates at all — the position only exists after
// following the redirect, which would mean a network call. Detected explicitly
// so the caller can say "paste the full link" instead of reporting a vague
// parse failure.
const SHORTENER_HOSTS = ['maps.app.goo.gl', 'goo.gl', 'g.co', 'bit.ly', 'tinyurl.com'];

function isShortenedLink(link) {
  return SHORTENER_HOSTS.some((h) => link.includes(h));
}

/**
 * Extracts coordinates from a pasted map link or a bare "lat,lng" string.
 *
 * Returns { latitude, longitude, pattern } on success, or
 * { latitude: null, longitude: null, reason } explaining why not — the reason
 * is surfaced to the admin screen, so it has to be actionable.
 */
function parseMapLink(link) {
  if (!link || typeof link !== 'string') {
    return { latitude: null, longitude: null, reason: 'No map link provided' };
  }
  const trimmed = link.trim();

  for (const { name, re } of PATTERNS) {
    const m = trimmed.match(re);
    if (!m) continue;
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    if (!isValidLatLng(lat, lng)) continue;
    return { latitude: lat, longitude: lng, pattern: name };
  }

  if (isShortenedLink(trimmed)) {
    return {
      latitude: null,
      longitude: null,
      reason: 'Shortened map links do not contain coordinates. Open the link and paste the full URL from the address bar.',
    };
  }

  return {
    latitude: null,
    longitude: null,
    reason: 'No coordinates found in this link. Paste a Google Maps URL containing @lat,lng or ?q=lat,lng.',
  };
}

/**
 * Great-circle distance in metres. Returns null when either point is missing,
 * so a caller can tell "they are far apart" from "there is nothing to compare".
 */
function distanceMetres(a, b) {
  if (!a || !b) return null;
  if (!isValidLatLng(a.latitude, a.longitude) || !isValidLatLng(b.latitude, b.longitude)) return null;

  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);

  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h))));
}

module.exports = { parseMapLink, distanceMetres, isValidLatLng, isShortenedLink };
