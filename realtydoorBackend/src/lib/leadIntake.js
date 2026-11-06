const crypto = require('crypto');
const { normalizePhone } = require('./phoneUtils');

// Pure rules for lead integrations (modules/leadIntake): turning whatever an ad platform or form sends into one shape, matching a form or
// campaign to a project, and the keys that protect each webhook. No database in here, so every rule is tested on its own.

const SOURCE_WORDS = {
  instagram: 'INSTAGRAM', ig: 'INSTAGRAM',
  facebook: 'FACEBOOK', fb: 'FACEBOOK', meta: 'FACEBOOK',
  google: 'GOOGLE_ADS', google_ads: 'GOOGLE_ADS', googleads: 'GOOGLE_ADS', adwords: 'GOOGLE_ADS',
  youtube: 'YOUTUBE', yt: 'YOUTUBE',
  whatsapp: 'WHATSAPP', wa: 'WHATSAPP',
  website: 'WEBSITE', web: 'WEBSITE', landing_page: 'WEBSITE',
};

const first = (obj, keys) => {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return undefined;
};

// Google Ads lead form webhooks send the answers as user_column_data: [{ column_id, column_value }].
function flattenGoogleColumns(body) {
  if (!Array.isArray(body.user_column_data)) return body;
  const out = { ...body };
  for (const c of body.user_column_data) {
    const id = String(c.column_id || c.column_name || '').toUpperCase();
    const v = c.column_value;
    if (id === 'FULL_NAME') out.name = v;
    else if (id === 'FIRST_NAME' && !out.name) out.name = v;
    else if (id === 'LAST_NAME' && out.name) out.name = `${out.name} ${v}`;
    else if (id === 'EMAIL') out.email = v;
    else if (id === 'PHONE_NUMBER') out.phone = v;
    else if (id === 'CITY') out.city = v;
    else if (id) out[id.toLowerCase()] = v;
  }
  if (out.gcl_id && !out.gclid) out.gclid = out.gcl_id;
  if (body.google_key !== undefined) delete out.google_key;
  return out;
}

// Meta (Facebook and Instagram) lead forms send the answers as field_data: [{ name, values: [..] }]; some tools send a plain { question: answer } object.
function flattenMetaFields(body) {
  const fd = body.field_data;
  if (!fd || typeof fd !== 'object') return body;
  const pairs = Array.isArray(fd)
    ? fd.map((f) => [f && f.name, f && (Array.isArray(f.values) ? f.values.join(', ') : f.value ?? f.values)])
    : Object.entries(fd);
  const out = { ...body };
  // Multiple-choice answers come as lists of slugs (["within_this_month"]); keep them readable: within this month.
  const readable = (v) => {
    const text = (Array.isArray(v) ? v.join(', ') : String(v ?? '')).trim();
    return /^[a-z0-9_, ]+$/.test(text) ? text.replace(/_/g, ' ') : text;
  };
  for (const [name, value] of pairs) {
    const key = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const text = readable(value);
    if (!key || !text) continue;
    if (out[key] === undefined) out[key] = text;
  }
  if (!out.name && !out.full_name && (out.first_name || out.last_name)) out.name = [out.first_name, out.last_name].filter(Boolean).join(' ');
  return out;
}

const flattenIncoming = (body) => flattenMetaFields(flattenGoogleColumns(body));

/** The flat, known fields of one incoming lead, from the many names senders use. Never throws; a missing phone is reported by the caller. */
function normalizeIncoming(rawBody) {
  const b = flattenIncoming(rawBody && typeof rawBody === 'object' ? rawBody : {});
  const phoneRaw = first(b, ['phone', 'mobile', 'phone_number', 'phoneNumber', 'mobile_number', 'whatsapp', 'contact', 'buyerPhone']);
  const srcWord = String(first(b, ['source', 'platform', 'channel']) || '').toLowerCase().replace(/[\s-]+/g, '_');
  const consent = b.consent ?? b.consent_given ?? b.optin;
  return {
    name: first(b, ['name', 'full_name', 'fullName', 'buyerName', 'first_name']) || 'Unknown',
    phone: phoneRaw ? normalizePhone(phoneRaw) : null,
    phoneRaw,
    email: first(b, ['email', 'email_address', 'buyerEmail']),
    message: first(b, ['message', 'note', 'comments', 'comment', 'enquiry', 'buyerMessage']),
    budget: first(b, ['budget', 'budget_range']),
    city: first(b, ['city', 'location']),
    sourceWord: SOURCE_WORDS[srcWord] || null,
    formId: first(b, ['formId', 'form_id', 'form']),
    formName: first(b, ['formName', 'form_name']),
    campaign: first(b, ['campaign', 'campaign_name', 'campaignName', 'utm_campaign']),
    campaignId: first(b, ['campaign_id', 'campaignId']),
    adName: first(b, ['adName', 'ad_name', 'ad']),
    projectWord: first(b, ['project', 'project_name', 'projectName', 'project_code']),
    utmSource: first(b, ['utm_source', 'utmSource']),
    utmMedium: first(b, ['utm_medium', 'utmMedium']),
    utmCampaign: first(b, ['utm_campaign', 'utmCampaign']),
    utmContent: first(b, ['utm_content', 'utmContent']),
    utmTerm: first(b, ['utm_term', 'utmTerm']),
    adClickId: first(b, ['gclid', 'fbclid', 'adClickId']),
    externalId: first(b, ['externalId', 'external_id', 'lead_id', 'leadId', 'id']),
    consent: consent === true || consent === 'true' || consent === 'yes' || consent === 1 || consent === '1',
  };
}

/** The mapping that applies to a lead: the first match by form id, campaign, UTM campaign, ad name, then the project word the form sends. */
function resolveMapping(mappings = [], f) {
  const order = [
    ['formId', f.formId], ['campaign', f.campaign], ['campaign', f.campaignId], ['utmCampaign', f.utmCampaign || f.campaign],
    ['adName', f.adName], ['project', f.projectWord],
  ];
  const lower = (v) => String(v || '').trim().toLowerCase();
  for (const [field, value] of order) {
    if (!value) continue;
    const hit = mappings.find((m) => m.matchField === field && lower(m.matchValue) === lower(value));
    if (hit) return hit;
  }
  // A keyword is matched inside the buyer's own words, for WhatsApp ("Hi, I'm interested in Lakeview").
  if (f.message) {
    const said = lower(f.message);
    const hit = mappings.find((m) => m.matchField === 'keyword' && lower(m.matchValue) && said.includes(lower(m.matchValue)));
    if (hit) return hit;
  }
  return null;
}

/** Everything the sender gave, as short question: answer pairs for the lead page. Secrets and keys are never kept. */
function answersFrom(rawBody) {
  const b = flattenIncoming(rawBody && typeof rawBody === 'object' ? rawBody : {});
  const out = {};
  for (const [k, v] of Object.entries(b)) {
    if (Object.keys(out).length >= 40) break;
    if (/secret|token|password|authorization|google_key|^key$/i.test(k) || k === 'user_column_data' || k === 'field_data') continue;
    if (v === null || v === undefined || v === '') continue;
    out[String(k).slice(0, 60)] = (typeof v === 'object' ? JSON.stringify(v) : String(v)).slice(0, 500);
  }
  return out;
}

/** Same lead sent twice must be one lead: the sender's own id when there is one, otherwise phone + campaign + day. */
function externalIdFor(f, now = new Date()) {
  if (f.externalId) return String(f.externalId);
  const day = now.toISOString().slice(0, 10);
  return `auto:${crypto.createHash('sha1').update(`${f.phone || f.phoneRaw || ''}|${f.formId || ''}|${f.campaign || ''}|${day}`).digest('hex').slice(0, 24)}`;
}

const hashSecret = (secret) => crypto.createHash('sha256').update(String(secret)).digest('hex');
const newKeyId = () => `lk_${crypto.randomBytes(8).toString('hex')}`;
const newSecret = () => `ls_${crypto.randomBytes(24).toString('hex')}`;

/** Constant-time check of the secret a webhook was sent with against the stored hash. */
function secretMatches(secret, storedHash) {
  if (!secret || !storedHash) return false;
  const a = Buffer.from(hashSecret(secret), 'hex');
  const b = Buffer.from(String(storedHash), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { SOURCE_WORDS, answersFrom, normalizeIncoming, resolveMapping, externalIdFor, hashSecret, newKeyId, newSecret, secretMatches };
