const email = require('./email');
const logger = require('./logger');

// Internal alerts to the people who run the platform, by email. The in-app notice to every admin already exists;
// this is for things nobody should find out about only by opening the console (a failed payout, a new dispute, leads
// past the SLA). ADMIN_ALERT_EMAILS is a comma-separated list; unset means nothing is sent, so a test run never emails
// the real team by accident. Never throws: an alert must not break the action that caused it.
function recipients(env = process.env) {
  return String(env.ADMIN_ALERT_EMAILS || '').split(',').map((t) => t.trim()).filter(Boolean);
}

async function alertStaff(subject, html, env = process.env) {
  const to = recipients(env);
  if (to.length === 0) return 0;
  let sent = 0;
  for (const address of to) {
    try {
      await email.send({ to: address, subject: `[Realtydoor] ${subject}`, html, category: 'TRANSACTIONAL' });
      sent += 1;
    } catch (err) {
      logger.warn('[StaffAlert] email failed', { subject, error: err.message });
    }
  }
  return sent;
}

module.exports = { alertStaff, recipients };
