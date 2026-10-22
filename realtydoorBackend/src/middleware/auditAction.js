const { createAuditLog } = require('../lib/auditLog');
const logger = require('../lib/logger');

// B92 — records an audit-log row for an admin mutation that its service does not log itself (loan status,
// document review, platform config, CMS, services, team, vendors, NRI leads/tours, user role/suspension).
// Runs on response finish so only requests that actually succeeded are logged; the request body (minus long
// strings) is stored as `after`, and the target is the route param. Failure to log never affects the response.
// `action` may be a function of the request (T45: one PATCH route covers both deactivate and reactivate).
function auditAction(action, targetType, { idParam = 'id' } = {}) {
  return (req, res, next) => {
    res.on('finish', () => {
      if (res.statusCode >= 400 || !req.user?.id) return;
      const actionName = typeof action === 'function' ? action(req) : action;
      const body = {};
      for (const [k, v] of Object.entries(req.body || {})) {
        body[k] = typeof v === 'string' && v.length > 200 ? `${v.slice(0, 200)}…` : v;
      }
      createAuditLog({
        adminId: req.user.id,
        action: actionName,
        targetType,
        targetId: String(req.params[idParam] || 'new'),
        after: Object.keys(body).length ? body : null,
        ipAddress: req.ip,
      }).catch((err) => logger.warn('[audit] failed to record admin action', { action: actionName, error: err.message }));
    });
    next();
  };
}

module.exports = { auditAction };
