const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

// BUG-048 — private uploads (allocation letters and visit photos, KYC papers, buyer documents, listing papers, tax invoices,
// ticket evidence) are stored in the bucket under these folders, and the database keeps their plain bucket link. A plain link works
// for anyone who has it, so signed-in responses hand out a signed link that expires instead. (The bucket itself must also refuse
// public reads for these folders; this is the code half of that fix.)
const PRIVATE_PREFIXES = ['visits/', 'kyc/', 'documents/', 'properties/documents/', 'partners/tax-invoices/', 'tickets/'];
const DEFAULT_EXPIRY_SECONDS = 15 * 60;

let client;
const s3 = () => {
  client = client || new S3Client({
    region: process.env.AWS_REGION,
    credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY },
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
  return PRIVATE_PREFIXES.some((p) => key.startsWith(p)) ? key : null;
}

const isPrivateUrl = (value) => parsePrivate(value) !== null;

async function signUrl(value, expiresIn = DEFAULT_EXPIRY_SECONDS) {
  const key = parsePrivate(value);
  if (!key) return value;
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

module.exports = { PRIVATE_PREFIXES, isPrivateUrl, signUrl, signDeep, signPrivateUrls };
