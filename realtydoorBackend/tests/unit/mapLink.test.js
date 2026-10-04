const { parseMapLink, distanceMetres, isValidLatLng, isShortenedLink } = require('../../src/lib/mapLink');

describe('isValidLatLng', () => {
  test('accepts a real coordinate pair', () => {
    expect(isValidLatLng(12.9116, 77.6389)).toBe(true);
  });

  test('rejects (0, 0) as "nothing was set"', () => {
    expect(isValidLatLng(0, 0)).toBe(false);
  });

  test('rejects out-of-range values', () => {
    expect(isValidLatLng(91, 0.1)).toBe(false);
    expect(isValidLatLng(10, 181)).toBe(false);
  });

  test('rejects non-finite values', () => {
    expect(isValidLatLng(NaN, 77)).toBe(false);
    expect(isValidLatLng(undefined, 77)).toBe(false);
  });
});

describe('isShortenedLink', () => {
  test.each(['https://maps.app.goo.gl/abc123', 'https://goo.gl/xyz', 'https://g.co/maps/xyz'])(
    'flags %s as shortened',
    (link) => expect(isShortenedLink(link)).toBe(true),
  );

  test('a full Google Maps URL is not flagged as shortened', () => {
    expect(isShortenedLink('https://www.google.com/maps/@12.9116,77.6389,15z')).toBe(false);
  });
});

describe('parseMapLink', () => {
  test('extracts the resolved place from a !3d!4d pair, preferred over the view centre', () => {
    const link = 'https://www.google.com/maps/place/x/@12.0,77.0,15z/data=!4m5!3m4!1s0x0!8m2!3d18.5204!4d73.8567';
    const result = parseMapLink(link);
    expect(result).toEqual({ latitude: 18.5204, longitude: 73.8567, pattern: 'data-3d4d' });
  });

  test('extracts a ?q=lat,lng query param', () => {
    const result = parseMapLink('https://maps.google.com/maps?q=12.9116,77.6389');
    expect(result).toEqual({ latitude: 12.9116, longitude: 77.6389, pattern: 'query-param' });
  });

  test('extracts an @lat,lng view-centre pair when nothing more specific is present', () => {
    const result = parseMapLink('https://www.google.com/maps/@12.9352,77.6245,17z');
    expect(result).toEqual({ latitude: 12.9352, longitude: 77.6245, pattern: 'at-centre' });
  });

  test('accepts a bare "lat,lng" pasted with no URL around it', () => {
    const result = parseMapLink('12.9116, 77.6389');
    expect(result).toEqual({ latitude: 12.9116, longitude: 77.6389, pattern: 'bare-pair' });
  });

  test('reports a specific, actionable reason for a shortened link', () => {
    const result = parseMapLink('https://maps.app.goo.gl/abc123');
    expect(result.latitude).toBeNull();
    expect(result.reason).toMatch(/Shortened map links/);
  });

  test('reports a generic reason when no pattern matches at all', () => {
    const result = parseMapLink('not a map link at all');
    expect(result.latitude).toBeNull();
    expect(result.reason).toMatch(/No coordinates found/);
  });

  test('handles missing/non-string input without throwing', () => {
    expect(parseMapLink(null)).toEqual({ latitude: null, longitude: null, reason: 'No map link provided' });
    expect(parseMapLink(undefined)).toEqual({ latitude: null, longitude: null, reason: 'No map link provided' });
  });

  test('skips a matched-but-invalid (0,0) pair and falls through to "not found"', () => {
    const result = parseMapLink('https://maps.google.com/maps?q=0,0');
    expect(result.latitude).toBeNull();
  });
});

describe('distanceMetres', () => {
  test('returns null when either point is missing', () => {
    expect(distanceMetres(null, { latitude: 1, longitude: 1 })).toBeNull();
    expect(distanceMetres({ latitude: 1, longitude: 1 }, null)).toBeNull();
  });

  test('returns null when a point has invalid coordinates', () => {
    expect(distanceMetres({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 1 })).toBeNull();
  });

  test('returns 0 for the same point', () => {
    const p = { latitude: 12.9116, longitude: 77.6389 };
    expect(distanceMetres(p, p)).toBe(0);
  });

  test('computes a plausible real-world distance (HSR Layout to Koramangala, Bangalore)', () => {
    const hsr = { latitude: 12.9116, longitude: 77.6389 };
    const koramangala = { latitude: 12.9352, longitude: 77.6245 };
    const d = distanceMetres(hsr, koramangala);
    // ~3km as the crow flies — a wide but sanity-checking band, not pinned
    // to an exact metre that would make this brittle.
    expect(d).toBeGreaterThan(2000);
    expect(d).toBeLessThan(5000);
  });

  test('is symmetric', () => {
    const a = { latitude: 12.9116, longitude: 77.6389 };
    const b = { latitude: 13.0827, longitude: 80.2707 };
    expect(distanceMetres(a, b)).toBe(distanceMetres(b, a));
  });
});
