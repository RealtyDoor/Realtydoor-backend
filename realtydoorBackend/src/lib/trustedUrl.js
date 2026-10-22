'use strict';

// Where the server is willing to fetch from, or send a visitor to, on the strength of a URL stored on a listing.
// A partner controls those URLs, so without this a listing could make the server request an internal address (the cloud
// metadata service, a database port) or bounce visitors to a phishing page from a Realtydoor link. Only https URLs on our own
// storage bucket, or on a host named in TRUSTED_MEDIA_HOSTS (comma separated), are trusted.
function trustedHosts(env = process.env) {
  const hosts = new Set();
  if (env.AWS_S3_BUCKET && env.AWS_REGION) hosts.add(`${env.AWS_S3_BUCKET}.s3.${env.AWS_REGION}.amazonaws.com`.toLowerCase());
  for (const h of String(env.TRUSTED_MEDIA_HOSTS || '').split(',')) {
    const host = h.trim().toLowerCase();
    if (host) hosts.add(host);
  }
  return hosts;
}

function isTrustedMediaUrl(url, env = process.env) {
  if (typeof url !== 'string' || url.length > 2048) return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password) return false; // https://trusted.host@evil.example/ style tricks
  if (u.port && u.port !== '443') return false;
  return trustedHosts(env).has(u.hostname.toLowerCase());
}

module.exports = { isTrustedMediaUrl, trustedHosts };
