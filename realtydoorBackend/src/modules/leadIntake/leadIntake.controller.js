const { z } = require('zod');
const { success, created } = require('../../utils/ApiResponse');
const service = require('./leadIntake.service');
const li = require('../../lib/leadIntake');

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
const SOURCES = ['WEBSITE', 'PHONE', 'WALK_IN', 'REFERRAL', 'EMAIL', 'PARTNER', 'OTHER', 'INSTAGRAM', 'FACEBOOK', 'GOOGLE_ADS', 'YOUTUBE', 'WHATSAPP'];
const KINDS = ['GENERIC', 'META', 'GOOGLE_ADS', 'WHATSAPP', 'WEBSITE'];

const createSchema = z.object({
  name: z.string().trim().min(2).max(80),
  kind: z.enum(KINDS).optional(),
  defaultSource: z.enum(SOURCES).optional(),
  defaultCampaign: z.string().trim().max(120).optional(),
  defaultProjectId: objectId.optional(),
  consentAssumed: z.boolean().optional(),
});
const updateSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  isActive: z.boolean().optional(),
  defaultSource: z.enum(SOURCES).optional(),
  defaultCampaign: z.string().trim().max(120).nullable().optional(),
  defaultProjectId: objectId.nullable().optional(),
  consentAssumed: z.boolean().optional(),
});
const mappingSchema = z.object({
  matchField: z.enum(['formId', 'campaign', 'utmCampaign', 'adName', 'project']),
  matchValue: z.string().trim().min(1).max(200),
  projectId: objectId.optional(),
  propertyId: objectId.optional(),
  campaignLabel: z.string().trim().max(120).optional(),
  source: z.enum(SOURCES).optional(),
}).refine((m) => m.projectId || m.propertyId || m.campaignLabel || m.source, { message: 'Say what this form or campaign means: a project, a listing, a campaign name or a source.' });

const wrap = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (err) { next(err); } };

const list = wrap(async (req, res) => success(res, await service.listIntegrations()));
const create = wrap(async (req, res) => created(res, await service.createIntegration(createSchema.parse(req.body), req.user.id), 'Integration created. Copy the secret now; it is shown only once.'));
const update = wrap(async (req, res) => success(res, await service.updateIntegration(req.params.id, updateSchema.parse(req.body), req.user.id)));
const rotate = wrap(async (req, res) => success(res, await service.rotateSecret(req.params.id, req.user.id), 'New secret created. Copy it now; the old one no longer works.'));
const addMapping = wrap(async (req, res) => created(res, await service.addMapping(req.params.id, mappingSchema.parse(req.body))));
const deleteMapping = wrap(async (req, res) => success(res, await service.deleteMapping(req.params.id, req.params.mappingId)));
const events = wrap(async (req, res) => success(res, await service.listEvents(req.params.id, Number(req.query.limit) || 30)));

// A test lead goes through the same cleaning and mapping, but nothing is written.
const test = wrap(async (req, res) => {
  const integrations = await service.listIntegrations();
  const integration = integrations.find((i) => String(i.id) === req.params.id);
  if (!integration) return success(res, { status: 'REJECTED', reason: 'Integration not found' });
  const sample = req.body && Object.keys(req.body).length ? req.body : { name: 'Test Buyer', phone: '9876543210', campaign: 'test' };
  success(res, await service.ingest(integration, sample, { dryRun: true }));
});

/**
 * POST /api/webhooks/leads/:keyId — the address every outside source posts to. The secret comes in the X-Integration-Secret header, as a
 * Bearer token, or as `google_key` / `secret` in the body (Google Ads lead forms can only send it in the body).
 */
async function webhook(req, res) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const secret = req.headers['x-integration-secret'] || bearer || body.google_key || body.secret;
  try {
    const integration = await service.authenticate(req.params.keyId, secret);
    const out = await service.ingest(integration, body);
    // Senders retry on anything but a 2xx, so a repeat or a held lead is a success, and only a lead we cannot use is a 422.
    return res.status(out.status === 'REJECTED' ? 422 : 200).json({ success: out.status !== 'REJECTED', ...out });
  } catch (err) {
    if (err.statusCode === 401) return res.status(401).json({ success: false, error: 'Invalid integration key' });
    return res.status(500).json({ success: false, error: 'Could not record the lead' });
  }
}

module.exports = { list, create, update, rotate, addMapping, deleteMapping, events, test, webhook, _schemas: { createSchema, mappingSchema, updateSchema }, _li: li };
