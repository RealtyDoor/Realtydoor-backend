const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { awsClientCredentials } = require('./awsCredentials');

// BUG-048 — private uploads (allocation letters and visit photos, KYC papers, buyer documents, listing papers, tax invoices,
// ticket evidence) are stored in the bucket under these folders, and the database keeps their plain bucket link. A plain link works
// for anyone who has it, so signed-in responses hand out a signed link that expires instead. (The bucket itself must also refuse
// public reads for these folders; this is the code half of that fix.)
//
// Audit Nov 2026 (A1). The rule is now the other way round, to match the bucket policy: a file is private unless its folder is in
// PUBLIC_PREFIXES, so receipts, video tours and any folder added later are signed without anyone remembering to list them.
// Keep this list the same as the "PublicReadSiteMediaOnly" statement of the bucket policy (docs/AUDIT_2026-11.md, A1 plan).
const PUBLIC_PREFIXES = ['properties/', 'blog/', 'admin-cms/', 'partners/profile-photos/', 'microsites/', 'realtydoor/properties/'];
// Private although they sit inside a public folder.
const PRIVATE_PREFIXES = ['properties/documents/'];
const isPrivateKey = (key) => PRIVATE_PREFIXES.some((p) => key.startsWith(p)) || !PUBLIC_PREFIXES.some((p) => key.startsWith(p));
const DEFAULT_EXPIRY_SECONDS = 15 * 60;

let client;
const s3 = () => {
  client = client || new S3Client({
    region: process.env.AWS_REGION,
    ...awsClientCredentials(),
  });
  return client;
};

const bucketHost = () => `${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com`;

function parsePrivate(value) {
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('https://')) return null;
  let u;
  try { u = new URL(value); } catch { return null; }
  if (u.host !== bucketHost() || u.search) return null; // other hosts, and links that are already signed, are left alone
  let key;
  try { key = decodeURIComponent(u.pathname.slice(1)); } catch { return null; }
  if (key.split('/').includes('..')) return null;
  return key && isPrivateKey(key) ? key : null;
}

const isPrivateUrl = (value) => parsePrivate(value) !== null;

// A recorded video tour is watched for longer than 15 minutes and the player asks for a new piece on every seek, so its link lasts 4 hours.
const LONG_EXPIRY = { 'video-tours/': 4 * 60 * 60 };
async function signUrl(value, expiresIn) {
  const key = parsePrivate(value);
  if (!key) return value;
  if (!expiresIn) expiresIn = Object.entries(LONG_EXPIRY).find(([p]) => key.startsWith(p))?.[1] || DEFAULT_EXPIRY_SECONDS;
  return getSignedUrl(s3(), new GetObjectCommand({
    Bucket: process.env.AWS_S3_BUCKET, Key: key, ResponseCacheControl: 'private, no-store',
  }), { expiresIn });
}

const isPlain = (v) => v !== null && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

// Returns a copy with every private link signed. Dates and other class instances are left as they are.
async function signDeep(value) {
  if (typeof value === 'string') return signUrl(value);
  if (Array.isArray(value)) return Promise.all(value.map(signDeep));
  if (isPlain(value)) {
    const entries = await Promise.all(Object.entries(value).map(async ([k, v]) => [k, await signDeep(v)]));
    return Object.fromEntries(entries);
  }
  return value;
}

// Express middleware: signs private links in every JSON body sent from here on. If signing fails the plain body is sent, so a
// signing problem never turns a working page into an error.
function signPrivateUrls(req, res, next) {
  const send = res.json.bind(res);
  res.json = (body) => {
    signDeep(body).then((signed) => send(signed), () => send(body));
    return res;
  };
  next();
}

// The other direction: a signed link of our own bucket that comes back in a request body (a form that re-saves what it was
// shown) is turned back into the plain link, so a link that expires in 15 minutes is never stored.
function unsignUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || !value.startsWith('https://') || !value.includes('X-Amz-')) return value;
  let u;
  try { u = new URL(value); } catch { return value; }
  if (u.host !== bucketHost() || !u.searchParams.has('X-Amz-Signature')) return value;
  return `${u.origin}${u.pathname}`;
}
function unsignDeep(value, depth = 0) {
  if (typeof value === 'string') return unsignUrl(value);
  if (depth > 12) return value;
  if (Array.isArray(value)) return value.map((v) => unsignDeep(v, depth + 1));
  if (isPlain(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unsignDeep(v, depth + 1)]));
  return value;
}
function unsignRequestUrls(req, res, next) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) req.body = unsignDeep(req.body);
  next();
}

module.exports = { PUBLIC_PREFIXES, PRIVATE_PREFIXES, isPrivateUrl, signUrl, signDeep, signPrivateUrls, unsignUrl, unsignDeep, unsignRequestUrls };
