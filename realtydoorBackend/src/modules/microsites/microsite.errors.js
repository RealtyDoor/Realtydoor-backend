const ApiError = require('../../utils/ApiError');

// Maps a Prisma P2002 (unique constraint) error to the specific 409 the
// spec names, so a race between two admins choosing the same slug (or
// double-submitting a create for the same property) is caught by the DB's
// own unique index rather than only a read-then-write check, which has
// the same TOCTOU gap this codebase has hit before on other unique fields.
//
// Kept dependency-free (no prisma/cache/auditLog) so it can be unit-tested
// without dragging in a DB/Redis connection — see tests/unit/microsite.service.test.js.
function throwForDuplicateKey(err) {
  const target = Array.isArray(err.meta?.target) ? err.meta.target.join(',') : String(err.meta?.target || '');
  if (target.includes('slug')) {
    throw new ApiError(409, 'This slug is already taken.', { code: 'SLUG_TAKEN' });
  }
  if (target.includes('propertyId')) {
    throw new ApiError(409, 'This property already has a microsite.', { code: 'MICROSITE_EXISTS' });
  }
  throw new ApiError(409, 'This slug or property already has a microsite.');
}

module.exports = { throwForDuplicateKey };
