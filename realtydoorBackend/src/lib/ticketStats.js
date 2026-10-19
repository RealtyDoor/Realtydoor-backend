// B39 — "Avg resolution" showed -20 days because a few tickets (seeded/legacy
// rows) have resolvedAt earlier than createdAt. Those rows carry no usable
// duration, so they are left out of the average rather than dragging it
// negative.
function averageResolutionDays(tickets) {
  const durations = tickets
    .filter((t) => t.resolvedAt && t.createdAt && t.resolvedAt >= t.createdAt)
    .map((t) => (t.resolvedAt - t.createdAt) / 86_400_000);
  if (!durations.length) return 0;
  return durations.reduce((a, b) => a + b, 0) / durations.length;
}

module.exports = { averageResolutionDays };
