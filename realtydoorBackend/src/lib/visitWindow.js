// B15 — the visit OTP was accepted ~29 hours before the booked slot, so a
// visit could be "logged" (and the buyer's phone revealed) long before it
// happened. Verification opens a configurable window before the slot; there
// is deliberately NO upper bound, so confirming a visit that already took
// place stays possible (API.md: verify-otp is not gated after the fact).
const DEFAULT_EARLY_WINDOW_HOURS = 2;

function isVisitTooEarly(scheduledAt, now = Date.now(), windowHours = DEFAULT_EARLY_WINDOW_HOURS) {
  if (!scheduledAt) return false;
  const slot = new Date(scheduledAt).getTime();
  if (Number.isNaN(slot)) return false;
  return now < slot - windowHours * 3_600_000;
}

module.exports = { isVisitTooEarly, DEFAULT_EARLY_WINDOW_HOURS };
