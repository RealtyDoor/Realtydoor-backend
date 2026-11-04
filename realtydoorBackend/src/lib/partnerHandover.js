const prisma = require('./prisma');
const logger = require('./logger');
const { createAuditLog } = require('./auditLog');
const { notifyAdmins } = require('./notifications');
const { reassignCheck } = require('./leadHygiene');

/**
 * A partner can no longer work their leads (suspended, or the account is being deleted). Every open lead they hold goes back to the
 * company pool as Unassigned, so the buyer is not left waiting, unless money is held or the buyer has already met them: those are
 * listed for an admin to settle by hand. A booked visit is cancelled. Admins are told, in the app, how many moved and which did not.
 * Returns { moved, stuck: [refCode] }.
 */
async function returnPartnerLeadsToPool(partnerId, adminId, ip, why) {
  const leads = await prisma.lead.findMany({
    where: { assignedPartnerId: partnerId, status: { notIn: ['CLOSED', 'DROPPED'] } },
    include: { escrowTransactions: { select: { status: true } } },
  });
  let moved = 0;
  const stuck = [];
  for (const l of leads) {
    const check = reassignCheck(l, l.escrowTransactions, `partner ${why}`);
    if (!check.ok) { stuck.push(l.refCode || l.id); continue; }
    await prisma.lead.update({
      where: { id: l.id },
      data: {
        assignedPartnerId: null, status: 'UNASSIGNED', assignedAt: null,
        ...(check.clearVisit && { siteVisitScheduledAt: null, siteVisitOTP: null, otpGeneratedAt: null, otpExpiresAt: null, otpAttempts: 0, otpLockedUntil: null }),
      },
    });
    await createAuditLog({
      adminId: adminId || null, actorRole: adminId ? 'ADMIN' : 'SYSTEM', action: 'LEAD_RETURNED_TO_POOL', targetType: 'Lead', targetId: l.id,
      before: { assignedPartnerId: partnerId, status: l.status }, after: { status: 'UNASSIGNED', why: `partner ${why}` }, ipAddress: ip,
    }).catch((err) => logger.warn('[partnerHandover] audit failed', { error: err.message }));
    moved += 1;
  }
  // Their registrations stop holding buyers too, at the same moment (not those with a token held or a verified visit: admin settles those).
  // An admin suspending is the approval. A deletion started by the partner is not: those registrations are left for an admin to release.
  const added = !adminId ? [] : await prisma.lead.findMany({
    where: { addedByPartnerId: partnerId, registrationLapsedAt: { isSet: false }, status: { notIn: ['CLOSED', 'DROPPED'] } },
    include: { escrowTransactions: { select: { status: true } } },
  });
  const now = new Date();
  for (const l of added) {
    if (l.isOtpVerified || reassignCheck(l, l.escrowTransactions, `partner ${why}`).ok === false) continue;
    await prisma.lead.update({ where: { id: l.id }, data: { registrationLapsedAt: now } });
    await createAuditLog({
      adminId: adminId || null, actorRole: adminId ? 'ADMIN' : 'SYSTEM', action: 'PARTNER_REGISTRATION_LAPSED', targetType: 'Lead', targetId: l.id,
      after: { registrationLapsedAt: now, why: `partner ${why}` }, ipAddress: ip,
    }).catch((err) => logger.warn('[partnerHandover] audit failed', { error: err.message }));
  }
  const openRegs = adminId ? 0 : await prisma.lead.count({ where: { addedByPartnerId: partnerId, registrationLapsedAt: { isSet: false }, status: { notIn: ['CLOSED', 'DROPPED'] } } });
  if (openRegs) {
    await notifyAdmins({ title: 'A closed partner still holds buyers', message: `Partner ${why}: ${openRegs} registration(s) still hold buyers. Open each lead and release the buyer if it should be free.`, type: 'LEAD_NEW', linkUrl: '/admin/leads/partner-added' }).catch(() => null);
  }
  if (moved || stuck.length) {
    await notifyAdmins({
      title: 'A partner\'s leads need attention',
      message: `Partner ${why}: ${moved} lead(s) went back to the pool.${stuck.length ? ` ${stuck.length} could not move (a token is held or the visit is done) and need a decision: ${stuck.slice(0, 8).join(', ')}.` : ''}`,
      type: 'LEAD_NEW',
      linkUrl: '/admin/leads',
    });
  }
  return { moved, stuck };
}

module.exports = { returnPartnerLeadsToPool };
