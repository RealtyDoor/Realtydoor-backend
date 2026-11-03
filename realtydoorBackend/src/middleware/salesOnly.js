const ApiError = require('../utils/ApiError');
const { isSalesOnly } = require('../lib/leadSales');

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
];

function restrictSalesOnly(req, res, next) {
  if (!isSalesOnly(req.user)) return next();
  if (ALLOWED.some(([method, re]) => method === req.method && re.test(req.path))) return next();
  return next(new ApiError(403, 'Not available for your role'));
}

module.exports = { restrictSalesOnly, ALLOWED };
