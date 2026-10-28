const prisma = require('./prisma');
const logger = require('./logger');
const { createNotification } = require('./notifications');
const { notifyUser } = require('./wati');
const { sendPartnerPayoutFailed } = require('./email');
const { alertStaff } = require('./staffAlerts');

// A RazorpayX payout failed, was rejected or was reversed after the release (webhook or the reconcile job).
// Staff get an email; if the failed leg is the partner's commission, the partner is told too (in the app, WhatsApp and
// email) without the bank's reason, which can contain account details. Fire-and-forget: never throws.
async function onPayoutFailed({ escrow, leg, status, reason }) {
  try {
    const lead = escrow.leadId
      ? await prisma.lead.findUnique({ where: { id: escrow.leadId }, select: { refCode: true, assignedPartnerId: true } })
      : null;
    const leadRef = lead?.refCode || 'a deal';
    await alertStaff(
      'Escrow payout failed',
      `<p>The <strong>${leg}</strong> payout for ${leadRef} (escrow of ₹${Number(escrow.amount).toLocaleString('en-IN')}) ${status === 'reversed' ? 'was reversed' : 'failed'}: ${String(reason || status).replace(/[<>&]/g, '')}.</p><p>It needs manual review: open Escrow in the admin console.</p>`,
    );
    if (leg === 'partner' && lead?.assignedPartnerId) {
      await createNotification({
        userId: lead.assignedPartnerId, title: 'Your payout could not be completed',
        message: `${leadRef}: we could not complete your commission payout. Our team is looking into it and will contact you if we need anything from you.`,
        type: 'PAYOUT_FAILED', linkUrl: '/partners/finance',
      }).catch(() => null);
      notifyUser(lead.assignedPartnerId, 'partner_payout_failed', { partner_name: '$userName', lead_ref: leadRef }, { leadId: escrow.leadId });
      const partner = await prisma.user.findUnique({ where: { id: lead.assignedPartnerId }, select: { email: true } });
      if (partner?.email) await sendPartnerPayoutFailed(partner.email, { leadRef });
    }
  } catch (err) {
    logger.warn('[PayoutAlerts] failed', { escrowId: escrow?.id, error: err.message });
  }
}

module.exports = { onPayoutFailed };
