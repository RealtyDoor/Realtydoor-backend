const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const { createEscrowOrder, releaseEscrow, refundPayment } = require('../../lib/razorpay');
const { createAuditLog } = require('../../lib/auditLog');
const { createNotification } = require('../../lib/notifications');
const { sendEscrowRefunded } = require('../../lib/email');
const { getConfigNumber } = require('../config/config.service');
const { isEscrowLeadUniqueViolation } = require('../../lib/escrowUtils');

const DEFAULT_MIN_ESCROW_AMOUNT = 50000;

// Buyer-scoped lookup — for polling status right after a Checkout attempt,
// or refreshing later. Buyers previously had no way to check escrow status
// at all: not through this, and getMyLeads didn't include it either.
async function getById(escrowId, buyerId) {
  const escrow = await prisma.escrowTransaction.findUnique({
    where: { id: escrowId },
    select: {
      id: true, leadId: true, razorpayOrderId: true, amount: true, currency: true,
      status: true, heldAt: true, releasedAt: true, refundedAt: true, failedAt: true,
      createdAt: true, buyerId: true,
    },
  });
  if (!escrow || escrow.buyerId !== buyerId) throw new ApiError(404, 'Escrow not found');
  const { buyerId: _buyerId, ...safe } = escrow;
  return safe;
}

async function createOrder(leadId, buyerId, amountInRupees) {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) throw new ApiError(404, 'Lead not found');

  const existing = await prisma.escrowTransaction.findFirst({
    where: { leadId, status: { in: ['HELD', 'PAYMENT_PENDING'] } },
  });
  if (existing) throw new ApiError(400, 'An active escrow order already exists for this lead');

  const minAmount = await getConfigNumber('escrowMinAmountRupees', DEFAULT_MIN_ESCROW_AMOUNT);
  if (amountInRupees < minAmount) {
    throw new ApiError(400, `Minimum escrow amount is ₹${minAmount.toLocaleString('en-IN')}`);
  }

  const amountInPaise = Math.round(amountInRupees * 100);
  const order = await createEscrowOrder(amountInPaise, `escrow_${leadId}`);

  // The findFirst check above has the same TOCTOU race as every other
  // check-then-write in this codebase — two concurrent requests for the same
  // lead can both pass it before either writes. scripts/createEscrowLeadUniqueIndex.js's
  // partial unique index (one active escrow per lead) is the real backstop;
  // a request that loses the race gets the same clean error the pre-check
  // throws. The Razorpay order already created above for the losing request
  // is simply never paid — Razorpay has no order-cancel API, and an unpaid
  // order has no side effects, so there's nothing to roll back.
  let escrow;
  try {
    escrow = await prisma.escrowTransaction.create({
      data: {
        leadId,
        buyerId,
        razorpayOrderId: order.id,
        amount: amountInRupees,
        status: 'PAYMENT_PENDING',
      },
    });
  } catch (err) {
    if (isEscrowLeadUniqueViolation(err)) {
      throw new ApiError(400, 'An active escrow order already exists for this lead');
    }
    throw err;
  }

  return { escrow, razorpayOrder: order };
}

async function confirmPayment(razorpayOrderId, razorpayPaymentId) {
  const escrow = await prisma.escrowTransaction.findUnique({ where: { razorpayOrderId } });
  if (!escrow) throw new ApiError(404, 'Escrow order not found');
  if (escrow.status === 'HELD') return escrow;
  return prisma.escrowTransaction.update({
    where: { razorpayOrderId },
    data: { razorpayPaymentId, status: 'HELD', heldAt: new Date() },
  });
}

async function release(escrowId, adminId, releaseData, ip) {
  const { sellerAccountId, manualTransferConfirmed, partnerShare, platformFee, note } = releaseData ?? {};

  const escrow = await prisma.escrowTransaction.findUnique({ where: { id: escrowId } });
  if (!escrow) throw new ApiError(404, 'Escrow not found');
  if (escrow.status !== 'HELD') throw new ApiError(400, `Cannot release escrow with status ${escrow.status}`);
  if (!escrow.razorpayPaymentId) throw new ApiError(400, 'Payment not yet captured');

  // Atomic claim: the write is conditioned on status still being HELD, so of
  // two concurrent release() calls for the same escrow, only one can affect
  // a row — the loser's updateMany affects 0 rows and bails out below,
  // *before* ever calling Razorpay. Without this, both could pass the
  // findUnique check above and both call releaseEscrow(), transferring the
  // money twice.
  const claim = await prisma.escrowTransaction.updateMany({
    where: { id: escrowId, status: 'HELD' },
    data: { status: 'RELEASED', releasedAt: new Date(), releasedByAdminId: adminId },
  });
  if (claim.count === 0) throw new ApiError(400, 'This escrow was already released or refunded');

  const amountInPaise = Math.round(escrow.amount * 100);
  let transferId = null;
  try {
    if (sellerAccountId) {
      const transferResult = await releaseEscrow(escrow.razorpayPaymentId, sellerAccountId, amountInPaise);
      transferId = transferResult?.items?.[0]?.id ?? null;
    }
  } catch (err) {
    // The Razorpay transfer never happened — undo the claim so the escrow
    // is still HELD and can be retried, instead of being stuck RELEASED
    // with no money actually moved.
    await prisma.escrowTransaction.update({
      where: { id: escrowId },
      data: { status: 'HELD', releasedAt: null, releasedByAdminId: null },
    });
    throw err;
  }

  const parts = [];
  if (partnerShare != null) parts.push(`Partner share: ₹${partnerShare}`);
  if (platformFee   != null) parts.push(`Platform fee: ₹${platformFee}`);
  if (!sellerAccountId && manualTransferConfirmed) parts.push('Manual transfer — no Razorpay payout initiated');
  if (note)                  parts.push(note);
  const adminNote = parts.join(' | ') || undefined;

  const updated = await prisma.escrowTransaction.update({
    where: { id: escrowId },
    data: {
      adminNote,
      ...(transferId && { razorpayTransferId: transferId }),
    },
  });

  await createAuditLog({
    adminId, action: 'ESCROW_RELEASED', targetType: 'EscrowTransaction', targetId: escrowId,
    after: { status: 'RELEASED', partnerShare, platformFee, note, manualTransferConfirmed: !!manualTransferConfirmed && !sellerAccountId },
    ipAddress: ip,
  });

  return updated;
}

async function refund(escrowId, adminId, ip) {
  const escrow = await prisma.escrowTransaction.findUnique({ where: { id: escrowId } });
  if (!escrow) throw new ApiError(404, 'Escrow not found');
  if (escrow.status !== 'HELD') throw new ApiError(400, `Cannot refund escrow with status ${escrow.status}`);
  if (!escrow.razorpayPaymentId) throw new ApiError(400, 'Payment not yet captured');

  // Same atomic-claim pattern as release() — see comment there.
  const claim = await prisma.escrowTransaction.updateMany({
    where: { id: escrowId, status: 'HELD' },
    data: { status: 'REFUNDED', refundedAt: new Date() },
  });
  if (claim.count === 0) throw new ApiError(400, 'This escrow was already released or refunded');

  const amountInPaise = Math.round(escrow.amount * 100);
  let refundResult;
  try {
    refundResult = await refundPayment(escrow.razorpayPaymentId, amountInPaise);
  } catch (err) {
    await prisma.escrowTransaction.update({
      where: { id: escrowId },
      data: { status: 'HELD', refundedAt: null },
    });
    throw err;
  }

  const updated = await prisma.escrowTransaction.update({
    where: { id: escrowId },
    data: { razorpayRefundId: refundResult.id },
  });

  await createAuditLog({
    adminId, action: 'ESCROW_REFUNDED', targetType: 'EscrowTransaction', targetId: escrowId,
    after: { status: 'REFUNDED' }, ipAddress: ip,
  });

  await createNotification({
    userId: escrow.buyerId,
    title: 'Escrow Refunded',
    message: 'Your token advance has been refunded to your original payment method.',
    type: 'ESCROW_REFUNDED',
  });

  const buyer = await prisma.user.findUnique({ where: { id: escrow.buyerId }, select: { email: true } });
  if (buyer) sendEscrowRefunded(buyer.email, escrow.amount).catch(() => {});

  return updated;
}

async function getAllEscrow(filters, skip, limit) {
  const where = {};
  if (filters.status) where.status = filters.status;
  const [data, total] = await prisma.$transaction([
    prisma.escrowTransaction.findMany({
      where, skip, take: limit, orderBy: { createdAt: 'desc' },
      include: {
        lead: {
          select: {
            buyerName: true, buyerEmail: true,
            property: { select: { title: true, locality: true, city: true } },
            assignedPartner: { select: { name: true, companyName: true } },
          },
        },
      },
    }),
    prisma.escrowTransaction.count({ where }),
  ]);
  return { data, total };
}

// Real DB-side aggregates over the full table — the admin Escrow page's stat
// cards and Platform Analytics' "Escrow GMV" previously sampled up to 50 rows
// per status with no aggregate query at all (FRONTEND_HANDOFF_SPEC.md §11.1).
async function getEscrowStats() {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [heldAgg, refundedAgg, releasedThisMonthAgg, releasedForAvg] = await Promise.all([
    prisma.escrowTransaction.aggregate({ where: { status: 'HELD' }, _sum: { amount: true } }),
    prisma.escrowTransaction.aggregate({ where: { status: 'REFUNDED' }, _sum: { amount: true } }),
    prisma.escrowTransaction.aggregate({
      where: { status: 'RELEASED', releasedAt: { gte: startOfMonth } },
      _sum: { amount: true },
    }),
    prisma.escrowTransaction.findMany({
      where: { status: 'RELEASED', releasedAt: { not: null } },
      select: { createdAt: true, releasedAt: true },
    }),
  ]);

  const avgHoldDays = releasedForAvg.length
    ? releasedForAvg.reduce((sum, t) => sum + (t.releasedAt - t.createdAt) / 86_400_000, 0) / releasedForAvg.length
    : 0;

  return {
    heldSum: heldAgg._sum.amount || 0,
    refundedSum: refundedAgg._sum.amount || 0,
    releasedSumThisMonth: releasedThisMonthAgg._sum.amount || 0,
    avgHoldDays: Math.round(avgHoldDays * 10) / 10,
  };
}

module.exports = { createOrder, getById, confirmPayment, release, refund, getAllEscrow, getEscrowStats };
