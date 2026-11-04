const prisma = require('../../lib/prisma');
const logger = require('../../lib/logger');
const ApiError = require('../../utils/ApiError');
const { nextRefCode } = require('../../lib/refCode');
const { notifyAdmins } = require('../../lib/notifications');
const { createAuditLog } = require('../../lib/auditLog');
const li = require('../../lib/leadIntake');

// Lead integrations: one intake path for every outside source (ad forms, WhatsApp, website, any webhook). See prisma/schema/lead_intake.prisma.

const ACTIVE = { notIn: ['CLOSED', 'DROPPED'] };
const publicIntegration = (i) => {
  const { secretHash, ...rest } = i; // the hash never leaves the server
  return rest;
};

async function createIntegration(data, adminId) {
  const secret = li.newSecret();
  const integration = await prisma.leadIntegration.create({
    data: {
      name: data.name, kind: data.kind || 'GENERIC', keyId: li.newKeyId(), secretHash: li.hashSecret(secret),
      defaultSource: data.defaultSource || 'OTHER', defaultCampaign: data.defaultCampaign || null,
      defaultProjectId: data.defaultProjectId || null, consentAssumed: data.consentAssumed ?? true, createdByAdminId: adminId,
    },
  });
  await createAuditLog({ adminId, action: 'LEAD_INTEGRATION_CREATED', targetType: 'LeadIntegration', targetId: integration.id, after: { name: integration.name, kind: integration.kind } }).catch(() => null);
  // The secret is shown once, here. Only its hash is kept.
  return { ...publicIntegration(integration), secret };
}

async function rotateSecret(id, adminId) {
  const exists = await prisma.leadIntegration.findUnique({ where: { id } });
  if (!exists) throw new ApiError(404, 'Integration not found');
  const secret = li.newSecret();
  await prisma.leadIntegration.update({ where: { id }, data: { secretHash: li.hashSecret(secret) } });
  await createAuditLog({ adminId, action: 'LEAD_INTEGRATION_KEY_ROTATED', targetType: 'LeadIntegration', targetId: id }).catch(() => null);
  return { secret };
}

async function listIntegrations() {
  const rows = await prisma.leadIntegration.findMany({ orderBy: { createdAt: 'desc' }, include: { mappings: { orderBy: { createdAt: 'asc' } } } });
  return rows.map(publicIntegration);
}

async function updateIntegration(id, data, adminId) {
  const allowed = {};
  for (const k of ['name', 'isActive', 'defaultSource', 'defaultCampaign', 'defaultProjectId', 'consentAssumed']) if (data[k] !== undefined) allowed[k] = data[k];
  const row = await prisma.leadIntegration.update({ where: { id }, data: allowed }).catch(() => null);
  if (!row) throw new ApiError(404, 'Integration not found');
  await createAuditLog({ adminId, action: 'LEAD_INTEGRATION_UPDATED', targetType: 'LeadIntegration', targetId: id, after: allowed }).catch(() => null);
  return publicIntegration(row);
}

async function addMapping(integrationId, data) {
  const exists = await prisma.leadIntegration.findUnique({ where: { id: integrationId }, select: { id: true } });
  if (!exists) throw new ApiError(404, 'Integration not found');
  return prisma.leadSourceMapping.create({
    data: {
      integrationId, matchField: data.matchField, matchValue: data.matchValue.trim(), projectId: data.projectId || null,
      propertyId: data.propertyId || null, campaignLabel: data.campaignLabel || null, source: data.source || null,
    },
  });
}

async function deleteMapping(integrationId, mappingId) {
  const r = await prisma.leadSourceMapping.deleteMany({ where: { id: mappingId, integrationId } });
  if (!r.count) throw new ApiError(404, 'Mapping not found');
  return { deleted: true };
}

async function listEvents(integrationId, limit = 30) {
  return prisma.leadIntakeEvent.findMany({ where: { integrationId }, orderBy: { createdAt: 'desc' }, take: Math.min(limit, 100) });
}

/** The webhook calls this: find the integration by its key and check the secret. A wrong key and a wrong secret look the same. */
async function authenticate(keyId, secret) {
  const integration = await prisma.leadIntegration.findUnique({ where: { keyId: String(keyId || '') }, include: { mappings: true } });
  if (!integration || !integration.isActive || !li.secretMatches(secret, integration.secretHash)) throw new ApiError(401, 'Invalid integration key');
  return integration;
}

async function finish(integration, eventId, status, extra = {}) {
  await prisma.leadIntakeEvent.update({ where: { id: eventId }, data: { status, ...extra } }).catch(() => null);
  const data = status === 'ERROR' ? { lastError: extra.reason || 'error', lastErrorAt: new Date() } : status === 'CREATED' ? { lastLeadAt: new Date(), leadCount: { increment: 1 }, lastError: null } : {};
  if (Object.keys(data).length) await prisma.leadIntegration.update({ where: { id: integration.id }, data }).catch(() => null);
}

async function note(leadId, text) {
  await prisma.leadNote.create({ data: { leadId, authorName: 'Lead intake', kind: 'NOTE', text } }).catch((e) => logger.warn('[leadIntake] note failed', { error: e.message }));
}

/**
 * One incoming lead from any source. Cleans the phone, ignores repeats, respects who already holds the buyer, maps the form or campaign to a
 * project, creates the lead in the sales queue (unassigned, marked with its source and campaign) and tells the admins. `dryRun` does everything
 * except write, so a new integration can be tested.
 */
async function ingest(integration, body, { dryRun = false } = {}) {
  const f = li.normalizeIncoming(body);
  const externalId = li.externalIdFor(f);
  const mapping = li.resolveMapping(integration.mappings || [], f);
  const source = mapping?.source || f.sourceWord || integration.defaultSource;
  const projectId = mapping?.projectId || integration.defaultProjectId || null;
  const propertyId = mapping?.propertyId || null;
  const campaign = mapping?.campaignLabel || f.campaign || integration.defaultCampaign || undefined;

  if (!f.phone) {
    if (!dryRun) await prisma.leadIntakeEvent.create({ data: { integrationId: integration.id, externalId, status: 'REJECTED', reason: 'No valid phone number', payload: body } }).catch(() => null);
    return { status: 'REJECTED', reason: 'A valid phone number is required' };
  }
  if (dryRun) return { status: 'DRY_RUN', would: { name: f.name, phone: f.phone, source, campaign: campaign || null, projectId, propertyId, mappingMatched: !!mapping } };

  // The same lead sent twice is one lead.
  let event;
  try {
    event = await prisma.leadIntakeEvent.create({ data: { integrationId: integration.id, externalId, status: 'RECEIVED', payload: body } });
  } catch (err) {
    if (err.code === 'P2002') {
      const prior = await prisma.leadIntakeEvent.findFirst({ where: { integrationId: integration.id, externalId } });
      return { status: 'DUPLICATE', leadId: prior?.leadId || null, reason: 'Already received' };
    }
    throw err;
  }

  try {
    const leadsService = require('../leads/leads.service');
    // Someone already holds this buyer: a partner's registration that is still valid. The platform's own earlier lead is fine; this is a repeat.
    const ownership = await leadsService.evaluateBuyerOwnership(f.phone, null);
    if (ownership.reason === 'OTHER_PARTNER') {
      const held = await prisma.lead.findFirst({ where: { buyerPhone: f.phone, addedByPartnerId: ownership.holderPartnerId, registrationLapsedAt: { isSet: false } }, orderBy: { createdAt: 'asc' } });
      if (held) await note(held.id, `The buyer enquired again through ${source}${campaign ? ` (${campaign})` : ''}. Not added as a new lead: this partner registration holds the buyer.`);
      await finish(integration, event.id, 'HELD_BY_PARTNER', { leadId: held?.id || null, reason: 'A partner registration holds this buyer' });
      return { status: 'HELD_BY_PARTNER', leadId: held?.id || null };
    }

    // An open lead for the same buyer and project or listing: add a note, do not create a second one.
    const open = await prisma.lead.findFirst({
      where: { buyerPhone: f.phone, status: ACTIVE, ...(propertyId ? { propertyId } : projectId ? { projectId } : {}) },
      orderBy: { createdAt: 'desc' },
    });
    if (open) {
      await note(open.id, `The buyer enquired again through ${source}${campaign ? ` (${campaign})` : ''}${f.message ? `: ${f.message}` : ''}.`);
      await finish(integration, event.id, 'DUPLICATE', { leadId: open.id, reason: 'Open lead for the same buyer and project' });
      return { status: 'DUPLICATE', leadId: open.id };
    }

    const project = projectId ? await prisma.project.findUnique({ where: { id: projectId }, select: { title: true, city: true } }).catch(() => null) : null;
    const earlier = await prisma.lead.findFirst({ where: { buyerPhone: f.phone }, orderBy: { createdAt: 'desc' }, select: { id: true } });
    const lead = await prisma.lead.create({
      data: {
        refCode: await nextRefCode('lead'),
        buyerName: f.name, buyerPhone: f.phone, buyerEmail: f.email || '', buyerMessage: f.message, budget: f.budget,
        propertyId, projectId, propertyInterest: propertyId ? undefined : (project?.title || f.projectWord || f.formName || undefined),
        city: propertyId ? null : (f.city || project?.city || null),
        source, campaign, sourceDetail: f.formName || f.formId || f.adName || undefined,
        utmSource: f.utmSource, utmMedium: f.utmMedium, utmCampaign: f.utmCampaign, utmContent: f.utmContent, utmTerm: f.utmTerm, adClickId: f.adClickId,
        intakeIntegrationId: integration.id,
        intakeAnswers: li.answersFrom(body),
        status: 'UNASSIGNED',
        ...((integration.consentAssumed || f.consent) && { buyerConsentAt: new Date() }),
        ...(earlier && { relatedLeadId: earlier.id }),
      },
    });
    await finish(integration, event.id, 'CREATED', { leadId: lead.id });
    await createAuditLog({ adminId: null, actorRole: 'SYSTEM', action: 'LEAD_CREATED', targetType: 'Lead', targetId: lead.id, after: { refCode: lead.refCode, source, integration: integration.name, campaign: campaign || null, projectId } }).catch(() => null);
    await notifyAdmins({
      title: `New lead from ${source.replace('_', ' ').toLowerCase()}`,
      message: `${lead.refCode} · ${lead.buyerName}${project ? ` for ${project.title}` : ''}${campaign ? ` · ${campaign}` : ''} arrived through ${integration.name}.`,
      type: 'LEAD_NEW', linkUrl: `/admin/leads/${lead.id}`,
    }).catch(() => null);
    return { status: 'CREATED', leadId: lead.id, refCode: lead.refCode };
  } catch (err) {
    logger.error('[leadIntake] failed', { integration: integration.name, error: err.message });
    await finish(integration, event.id, 'ERROR', { reason: String(err.message).slice(0, 300) });
    throw err;
  }
}

module.exports = { createIntegration, rotateSecret, listIntegrations, updateIntegration, addMapping, deleteMapping, listEvents, authenticate, ingest };
