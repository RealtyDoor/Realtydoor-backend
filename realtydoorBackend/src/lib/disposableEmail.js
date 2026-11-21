'use strict';

// Temporary ("temp mail") email domains, blocked when a NEW account row is created (never for an existing account), so a throwaway
// inbox cannot be used to make accounts. Clerk's own "Block disposable email addresses" setting is the first layer; this is the second,
// and it does not depend on that setting. OFF unless BLOCK_DISPOSABLE_EMAILS=true. Extend without a deploy of code through
// DISPOSABLE_EMAIL_EXTRA_DOMAINS (comma separated). Matching is on the domain and its subdomains (x@a.mailinator.com is blocked too).
// A phone number verified over WhatsApp is still the real gate for anything that matters (inquiries, visits, payments).

const BUILTIN = [
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'guerrillamail.biz', 'guerrillamail.de', 'guerrillamailblock.com',
  'sharklasers.com', 'grr.la', 'spam4.me', '10minutemail.com', '10minutemail.net', '10minutemail.org', 'temp-mail.org', 'temp-mail.io', 'tempmail.com',
  'tempmail.net', 'tempmailo.com', 'tempmailaddress.com', 'tempmailer.com', 'tempail.com', 'tempinbox.com', 'tempr.email', 'tmpmail.org', 'tmpmail.net',
  'yopmail.com', 'yopmail.fr', 'yopmail.net', 'throwawaymail.com', 'trashmail.com', 'trashmail.net', 'trashmail.de', 'getnada.com', 'nada.email',
  'maildrop.cc', 'dispostable.com', 'fakeinbox.com', 'mailnesia.com', 'moakt.com', 'mohmal.com', 'emailondeck.com', 'mintemail.com', 'mytemp.email',
  'burnermail.io', 'anonbox.net', 'spamgourmet.com', 'mailcatch.com', 'mail-temp.com', 'discard.email', 'discardmail.com', 'jetable.org',
  'mailforspam.com', 'harakirimail.com', 'inboxbear.com', 'emailfake.com', 'fakemail.net', 'fake-mail.net', '1secmail.com', '1secmail.org',
  '1secmail.net', 'esiix.com', 'wwjmp.com', 'xojxe.com', 'yoggm.com', 'vjuum.com', 'laafd.com', 'txcct.com', 'dropmail.me', 'mailtemp.net',
  'emltmp.com', 'gmailnator.com', 'smailpro.com', 'mail.tm', 'tempmail.us.com', 'mailpoof.com', 'spambox.us', 'trashmail.io', 'mytrashmail.com',
  'throwam.com', 'getairmail.com', 'maildax.me', 'tmail.ws', 'fexpost.com', 'bugmenot.com', 'luxusmail.org', 'rmqkr.net', 'zeroe.ml',
];

function domainSet(env = process.env) {
  const extra = String(env.DISPOSABLE_EMAIL_EXTRA_DOMAINS || '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
  return new Set([...BUILTIN, ...extra]);
}

const isBlockingEnabled = (env = process.env) => env.BLOCK_DISPOSABLE_EMAILS === 'true';

// True when the address's domain, or a parent of it, is on the list. Garbage in (no @, empty) is not "disposable": other checks reject it.
function isDisposableEmail(email, env = process.env) {
  const at = String(email || '').lastIndexOf('@');
  if (at < 1) return false;
  const parts = String(email).slice(at + 1).trim().toLowerCase().split('.').filter(Boolean);
  if (parts.length < 2) return false;
  const set = domainSet(env);
  for (let i = 0; i <= parts.length - 2; i += 1) if (set.has(parts.slice(i).join('.'))) return true;
  return false;
}

module.exports = { BUILTIN, isDisposableEmail, isBlockingEnabled };
