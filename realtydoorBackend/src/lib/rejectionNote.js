// B122 — the reject dialog sends a canned reason and a free-text note; they were
// concatenated with no separator ("Incomplete documentsPlease re-upload"). Joined
// here, once, so what the partner reads in the app and in the email is the same.
function joinRejection(reason, note) {
  const parts = [reason, note].map((p) => (typeof p === 'string' ? p.trim() : '')).filter(Boolean);
  if (parts.length === 2) {
    const first = /[.!?]$/.test(parts[0]) ? parts[0] : `${parts[0]}.`;
    return `${first} ${parts[1]}`;
  }
  return parts[0] || '';
}

module.exports = { joinRejection };
