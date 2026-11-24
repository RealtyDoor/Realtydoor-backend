const ApiError = require('../utils/ApiError');
const { isLimitedStaff } = require('../lib/staffLockdown');

// A BDE (staff whose only permission is SALES) is still an admin account, and most admin reads were never gated by permission
// (dashboards, users, escrow lists and so on). So for them the whole admin API is closed except these lead routes, which are
// themselves scoped to the leads they own (see leadScope in lib/leadSales.js). Paths are relative to the /admin mount.
const ID = '[a-f\\d]{24}';
const ALLOWED = [
  ['GET', /^\/leads\/?$/],
  ['GET', /^\/leads\/sales-summary\/?$/],
  ['GET', /^\/leads\/owners\/?$/],
  ['GET', new RegExp(`^/leads/${ID}/?$`, 'i')],
  ['GET', new RegExp(`^/leads/${ID}/notes/?$`, 'i')],
  ['POST', new RegExp(`^/leads/${ID}/notes/?$`, 'i')],
  ['PATCH', new RegExp(`^/leads/${ID}/sales/?$`, 'i')],
  // The calling list for the qualification pool: take a batch, see it, tap an outcome (modules/admin/leadCalling.service.js).
  ['GET', /^\/leads\/pool\/my-batch\/?$/],
  ['POST', /^\/leads\/pool\/take\/?$/],
  ['POST', new RegExp(`^/leads/${ID}/pool/outcome/?$`, 'i')],
];

function restrictSalesOnly(req, res, next) {
  // Any limited staff (SALES and/or RECEPTION only) that reaches /admin gets only the BDE lead routes.
  if (!isLimitedStaff(req.user)) return next();
  if (ALLOWED.some(([method, re]) => method === req.method && re.test(req.path))) return next();
  return next(new ApiError(403, 'Not available for your role'));
}

module.exports = { restrictSalesOnly, ALLOWED };
