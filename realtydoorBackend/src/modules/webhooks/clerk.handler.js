const { Webhook } = require('svix');
const prisma = require('../../lib/prisma');
const logger = require('../../lib/logger');
const { setUserRole } = require('../../lib/clerkAdmin');
const { isPhoneUniqueViolation } = require('../../lib/phoneUtils');

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
        const metadataPhone = data.public_metadata?.phone;

        // Security fix, 2026-10-13 (B6) — pre-checked, same as
        // syncUserByClerkId's own email/phone collision checks, instead of
        // writing straight through and relying on the DB's unique indexes
        // to catch it after the fact (which then just got silently
        // swallowed by the catch below). A colliding field is skipped, not
        // retried — the collision won't resolve itself on a Clerk retry,
        // so failing the whole event would just retry forever for no
        // reason; the rest of the update (and future events) still apply.
        const data_ = {};
        if (email && email !== existing.email) {
          const emailOwner = await prisma.user.findFirst({
            where: { email, deletedAt: { isSet: false }, NOT: { id: existing.id } },
          });
          if (emailOwner) {
            logger.warn('[ClerkWebhook] user.updated email collision — skipped', { clerkId: data.id, email });
          } else {
            data_.email = email;
          }
        }
        if (metadataPhone && metadataPhone !== existing.phone) {
          const phoneOwner = await prisma.user.findFirst({ where: { phone: metadataPhone, NOT: { id: existing.id } } });
          if (phoneOwner) {
            logger.warn('[ClerkWebhook] user.updated phone collision — skipped', { clerkId: data.id });
          } else {
            data_.phone = metadataPhone;
          }
        }

        if (Object.keys(data_).length) {
          try {
            await prisma.user.update({
              where: { id: existing.id },
              data: data_,
              // name/profileImageUrl are owned by PATCH /user/profile once a
              // row exists — this handler only ever fires for an existing row
              // (see the `if (!existing)` branch above), so it must never
              // overwrite them, same rule as /auth/sync's syncUser.
              // role is DB-authoritative — this handler only ever touches an
              // existing row, so publicMetadata.role must never be applied
              // here at all (it only seeds a brand-new row, in syncUser).
            });
            logger.info('[ClerkWebhook] user.updated synced', { clerkId: data.id, fields: Object.keys(data_) });
          } catch (err) {
            // The TOCTOU race the pre-checks above can't fully close —
            // someone else claimed the email/phone between the check and
            // this write. Logged and treated the same as a detected
            // collision (skip, don't fail the whole event for a retry that
            // can't succeed), not re-thrown into the outer catch.
            if (isPhoneUniqueViolation(err) || err.code === 'P2002') {
              logger.warn('[ClerkWebhook] user.updated race lost to a concurrent write — skipped', { clerkId: data.id, error: err.message });
            } else {
              throw err;
            }
          }
        } else {
          logger.info('[ClerkWebhook] user.updated — nothing to apply', { clerkId: data.id });
        }
      }
    }

    if (type === 'user.deleted') {
      // Soft-delete, not a real delete — Property.partner, Notification.user,
      // and PartnerSupportTicket.partner are required relations with no
      // onDelete rule, so hard-deleting a user who owned any of those left a
      // dangling foreign key: every admin query that included the relation
      // 500'd ("Field partner is required ... got null"). The row stays, just
      // flagged, so every existing foreign key stays valid.
      const user = await prisma.user.findUnique({ where: { clerkId: data.id } });
      if (user && !user.deletedAt) {
        await prisma.user.update({ where: { id: user.id }, data: { deletedAt: new Date() } });
        logger.info('[ClerkWebhook] user.deleted synced (soft-deleted)', { clerkId: data.id });
      }
    }
  } catch (err) {
    logger.error('[ClerkWebhook] DB sync failed', { type, clerkId: data.id, error: err.message });
    // Security/reliability fix, 2026-10-13 (B6) — this used to always
    // respond 200 even here, so an unexpected failure (a DB blip, a bug)
    // silently never happened as far as Clerk's retry logic was concerned.
    // Clerk only retries on a non-2xx response; webhook handlers are
    // expected to be safe to replay (this one already re-derives
    // everything from `existing`/pre-checks rather than assuming prior
    // state), so a real 500 here is the correct way to get that retry.
    return res.status(500).json({ status: 'error' });
  }

  res.json({ status: 'ok' });
}

module.exports = { clerkWebhook };
