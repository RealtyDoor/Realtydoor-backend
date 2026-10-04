const { success } = require('../../utils/ApiResponse');
const service = require('./location.service');
const { updateLocationSchema } = require('./location.validator');

// 4.6 — every coordinate source for one listing, how far apart they are, and
// what is wrong with them. Read-only.
async function locationCheck(req, res, next) {
  try {
    success(res, await service.getLocationCheck(req.params.id));
  } catch (err) { next(err); }
}

// 4.7 — set the canonical location, with a mandatory reason, audited.
async function updateLocation(req, res, next) {
  try {
    const data = updateLocationSchema.parse(req.body);
    const result = await service.updateLocation(
      req.params.id, data, { adminId: req.user.id, adminName: req.user.name }, req.ip,
    );
    success(res, result, result.confirmedOnly
      ? 'Location confirmed; nothing changed'
      : `Location updated (${result.changedFields.length} field(s))`);
  } catch (err) { next(err); }
}

module.exports = { locationCheck, updateLocation };
