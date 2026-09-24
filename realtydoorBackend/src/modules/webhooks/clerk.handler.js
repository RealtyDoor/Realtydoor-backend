const { Webhook } = require('svix');
const prisma = require('../../lib/prisma');
const logger = require('../../lib/logger');
const { setUserRole } = require('../../lib/clerkAdmin');

async function clerkWebhook(req, res) {
  const secret = process.env.CLERK_WEBHOOK_SECRET;
  if (!secret) {
    logger.error('[ClerkWebhook] CLERK_WEBHOOK_SECRET not set');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  const svixId        = req.headers['svix-id'];
  const svixTimestamp = req.headers['svix-timestamp'];
  const svixSignature = req.headers['svix-signature'];

  if (!svixId || !svixTimestamp || !svixSignature) {
    return res.status(400).json({ error: 'Missing svix headers' });
  }

  let evt;
  try {
    const wh = new Webhook(secret);
    evt = wh.verify(req.rawBody.toString(), {
      'svix-id':        svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': svixSignature,
    });
  } catch (err) {
    logger.warn('[ClerkWebhook] Invalid signature', { error: err.message });
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const { type, data } = evt;
  logger.info('[ClerkWebhook] Received event', { type, clerkId: data.id });

  try {
    if (type === 'user.created') {
      // Users created through our own signup service (B4) already have a DB
      // row by the time this webhook lands — this is just a metadata safety
      // net for them. Users created any other way (e.g. Google sign-in) get
      // synced by the extended POST /api/auth/sync on their first call, which
      // also runs the email-collision check — this handler does NOT create
      // rows itself, to avoid two independent writers racing on the same
      // clerkId/email.
      const existing = await prisma.user.findUnique({ where: { clerkId: data.id } });
      await setUserRole(data.id, existing?.role || 'USER').catch((err) =>
        logger.warn('[ClerkWebhook] setUserRole failed', { clerkId: data.id, error: err.message })
      );
      logger.info('[ClerkWebhook] user.created received', { clerkId: data.id, hadExistingRow: !!existing });
    }

    if (type === 'user.updated') {
      const existing = await prisma.user.findUnique({ where: { clerkId: data.id } });
      if (!existing) {
        logger.info('[ClerkWebhook] user.updated for unsynced clerkId — skipping', { clerkId: data.id });
      } else {
        const email = data.email_addresses?.[0]?.email_address;
        const name  = [data.first_name, data.last_name].filter(Boolean).join(' ') || email;
        const metadataPhone = data.public_metadata?.phone;
        const metadataRole  = data.public_metadata?.role;

        await prisma.user.update({
          where: { id: existing.id },
          data: {
            name,
            email,
            profileImageUrl: data.image_url || null,
            ...(metadataPhone ? { phone: metadataPhone } : {}),
            ...(metadataRole && metadataRole !== existing.role ? { role: metadataRole } : {}),
          },
        });
        logger.info('[ClerkWebhook] user.updated synced', { clerkId: data.id });
      }
    }

    if (type === 'user.deleted') {
      const user = await prisma.user.findUnique({ where: { clerkId: data.id } });
      if (user) {
        await prisma.user.delete({ where: { id: user.id } });
        logger.info('[ClerkWebhook] user.deleted synced', { clerkId: data.id });
      }
    }
  } catch (err) {
    logger.error('[ClerkWebhook] DB sync failed', { type, clerkId: data.id, error: err.message });
  }

  res.json({ status: 'ok' });
}

module.exports = { clerkWebhook };
