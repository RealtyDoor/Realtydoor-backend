const { z } = require('zod');

// 4.7 — an admin moving a listing on the map always has to say why. The reason
// is written into PropertyEditLog alongside the field diff and sent to the
// partner verbatim, so an empty one is useless to both.
const updateLocationSchema = z.object({
  reason:    z.string().min(5, 'A reason of at least 5 characters is required').max(500),
  // Pass null to clear the link.
  mapLink:   z.string().max(2000).nullable().optional(),
  latitude:  z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
}).refine(
  // A single coordinate is meaningless, and accepting one would silently pair
  // a new latitude with the old longitude.
  (d) => (d.latitude === undefined) === (d.longitude === undefined),
  { message: 'latitude and longitude must be provided together', path: ['longitude'] }
).refine(
  (d) => d.mapLink !== undefined || d.latitude !== undefined,
  { message: 'Provide a mapLink, or a latitude/longitude pair, or both', path: ['mapLink'] }
);

module.exports = { updateLocationSchema };
