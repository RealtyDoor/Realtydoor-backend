const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const { razorpay, createEscrowOrder, createPayoutContact, createPayoutFundAccount, createPayout, validateFundAccountOrWarn, refundPayment } = require('../../lib/razorpay');
const { createAuditLog } = require('../../lib/auditLog');
const { createNotification } = require('../../lib/notifications');
const { sendEscrowRefunded, sendEscrowHeld } = require('../../lib/email');
const { getConfigNumber } = require('../config/config.service');
const { isEscrowLeadUniqueViolation } = require('../../lib/escrowUtils');
const logger = require('../../lib/logger');

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
  // Scoped to buyerId, not just id — previously any authenticated user could
  // create (and pay into) an escrow order for *any* lead by guessing/reusing
  // a leadId, since the lookup had no ownership check at all.
  const lead = await prisma.lead.findFirst({ where: { id: leadId, buyerId } });
  if (!lead) throw new ApiError(404, 'Lead not found');
  if (lead.status !== 'SITE_VISIT_DONE') {
    throw new ApiError(400, 'Escrow can only be created after the site visit is done');
  }

  const existing = await prisma.escrowTransaction.findFirst({
    where: { leadId, status: { in: ['HELD', 'PAYMENT_PENDING', 'HELD_PAYOUT_FAILED'] } },
  });
  if (existing) {
    if (existing.status !== 'PAYMENT_PENDING') {
      throw new ApiError(400, 'An active escrow order already exists for this lead');
    }
    // An earlier Checkout attempt was abandoned before any payment was made
    // (closed tab, bad network, came back later) — there's no payment.failed
    // webhook for that, since no payment was ever attempted, so without this
    // the buyer would be stuck forever: this check would keep rejecting every
    // retry, refund()/release() both require a captured payment that was
    // never made, and the only way out was dropping the whole lead. Razorpay
    // orders don't expire, so just resume the same order_id instead of erroring.
    const razorpayOrder = await razorpay.orders.fetch(existing.razorpayOrderId);

    if (razorpayOrder.status === 'paid') {
      // The payment actually went through already — most likely the
      // payment.captured webhook for it was delayed or dropped, which is
      // exactly what the buyer re-opening this screen would surface. Self-heal
      // here rather than reopening a Checkout Razorpay would refuse a second
      // payment against anyway.
      const payments = await razorpay.orders.fetchPayments(existing.razorpayOrderId);
      const capturedPayment = payments.items?.find((p) => p.status === 'captured');
      if (capturedPayment) {
        const healed = await confirmPayment(existing.razorpayOrderId, capturedPayment.id, buyerId);
        return { escrow: healed, razorpayOrder, resumed: true, alreadyPaid: true };
      }
    }

    return { escrow: existing, razorpayOrder, resumed: true };
  }

  // snake_case to match every other seeded key. The old camelCase
  // 'escrowMinAmountRupees' was never seeded, so this always fell through to
  // the default and the admin-editable value did nothing.
  const minAmount = await getConfigNumber('escrow_min_amount_rupees', DEFAULT_MIN_ESCROW_AMOUNT);
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

// buyerId is only passed by the buyer-facing verify-payment controller — the
// Razorpay webhook calls this with no buyerId (it's already authenticated by
// the HMAC signature, not a caller identity). A forged signature can't pass
// verifyPaymentSignature(), so this check is defense-in-depth rather than the
// primary guard: it stops an authenticated user from confirming an order ID
// that isn't theirs, which a valid signature alone wouldn't prevent since
// signatures aren't scoped to the account making the HTTP request.
async function confirmPayment(razorpayOrderId, razorpayPaymentId, buyerId = null) {
  const escrow = await prisma.escrowTransaction.findUnique({ where: { razorpayOrderId } });
  if (!escrow || (buyerId && escrow.buyerId !== buyerId)) throw new ApiError(404, 'Escrow order not found');
  // Only ever transition out of PAYMENT_PENDING — covers both the already-HELD
  // idempotent case and any other terminal status (FAILED/CANCELLED/etc.):
  // a captured-payment event for an escrow that isn't awaiting payment is
  // either a redelivered webhook or a stale/out-of-order one, and must never
  // blindly flip a resolved escrow back to HELD.
  if (escrow.status !== 'PAYMENT_PENDING') return escrow;

  // Atomic claim, same shape as release()/refund(): this can race a webhook
  // delivery against the createOrder() resume-path self-heal hitting the same
  // order at nearly the same time — only the winner transitions the row and
  // sends the one-time notification below; the loser just returns the
  // already-updated escrow instead of re-confirming (and re-notifying).
  const claim = await prisma.escrowTransaction.updateMany({
    where: { razorpayOrderId, status: 'PAYMENT_PENDING' },
    data: { razorpayPaymentId, status: 'HELD', heldAt: new Date() },
  });
  if (claim.count === 0) {
    return prisma.escrowTransaction.findUnique({ where: { razorpayOrderId } });
  }
  const updated = await prisma.escrowTransaction.findUnique({ where: { razorpayOrderId } });

  // The only escrow lifecycle event with no buyer-facing confirmation at all
  // before this — refunds and failures both notify, but a successful token
  // advance (arguably the one the buyer most needs confirmed) didn't. The
  // atomic claim above is what makes this reachable only once per escrow.
  // Run as one fire-and-forget block, not awaited into the critical path:
  // this is reached from the buyer-facing /verify-payment controller too,
  // and the escrow is already durably HELD at this point — nothing below
  // (notification write, buyer lookup, email) may surface as "payment
  // verification failed" to a buyer whose payment did succeed.
  (async () => {
    await createNotification({
      userId: updated.buyerId,
      title: 'Token Advance Received',
      message: `Your token advance of ₹${updated.amount.toLocaleString('en-IN')} has been received and is held securely.`,
      type: 'ESCROW_HELD',
      linkUrl: `/user/inquiries/${updated.leadId}`,
    });
    const buyer = await prisma.user.findUnique({ where: { id: updated.buyerId }, select: { email: true } });
    if (buyer) await sendEscrowHeld(buyer.email, updated.amount);
  })().catch((err) => logger.warn('[Escrow] Post-confirmation notification/email failed', { escrowId: updated.id, error: err.message }));

  return updated;
}

// ─── 2.8 / 2.9 — release plan and release conditions ─────────────────────────
//
// IMPORTANT, and unresolved by design: the commission fee is a % of the DEAL
// PRICE, while escrow holds only the TOKEN ADVANCE. On real data the fee
// routinely exceeds what is held (2% of 85L = 170k against a 50k token), so
// "pay the commission out of escrow" is not generally possible and this code
// deliberately does NOT invent an allocation rule for the shortfall.
//
// What it does instead: compute each payee's entitlement from the lead's
// LOCKED lines, state plainly whether the held amount covers it, and let
// admin see that before moving money. The actual payout amounts still come
// from the release request, and are validated against what is held.
const GST_PCT_KEY = 'commission_gst_pct';
const TDS_PCT_KEY = 'commission_tds_pct';

// backend-work-still-open.md #1 — the platform's own cost-recovery retained
// share (R) and the partner's payout share (Pi) OF THE HELD AMOUNT (B)
// itself, a release-time split entirely separate from the commission
// fee/GST/TDS entitlement above (which is a claim against the DEAL PRICE,
// often bigger than B). Switchable like GST/TDS above, via the same
// PlatformConfig mechanism (GET/PUT /admin/config/:key) — not hardcoded,
// since these are business-decided rates, not fixed law. R itself is
// never an admin-typed amount (see release() below); only the *rate* is
// admin-configurable.
const PLATFORM_FEE_PCT_KEY = 'escrow_platform_fee_pct';
const PARTNER_SHARE_PCT_KEY = 'escrow_partner_share_pct';
const DEFAULT_PLATFORM_FEE_PCT = 1;
const DEFAULT_PARTNER_SHARE_PCT = 2;

function round2(n) {
  return Math.round(n * 100) / 100;
}

async function getReleasePlan(escrowId) {
  const escrow = await prisma.escrowTransaction.findUnique({ where: { id: escrowId } });
  if (!escrow) throw new ApiError(404, 'Escrow not found');

  const lead = await prisma.lead.findUnique({
    where: { id: escrow.leadId },
    select: {
      id: true, refCode: true, feePct: true, dealPriceAtLock: true,
      commissionLockedAt: true, commissionVersion: true,
      allocationLetterUrl: true, buyerFeedbackStatus: true, status: true,
      assignedPartnerId: true,
      property: { select: { price: true } },
      assignedPartner: { select: { id: true, name: true, payoutAccountStatus: true, razorpayFundAccountId: true } },
    },
  });
  if (!lead) throw new ApiError(404, 'Lead not found for this escrow');

  const lines = lead.commissionLockedAt
    ? await prisma.leadCommissionLine.findMany({
        where: { leadId: lead.id, version: lead.commissionVersion },
        orderBy: { payeeRole: 'asc' },
      })
    : [];

  // GST and TDS default to 0 so nothing is ever silently withheld. Both are
  // statutory and rate-sensitive (TDS 194H on brokerage), so they stay
  // admin-configured rather than hardcoded. Pending business sign-off.
  const [gstPct, tdsPct, platformFeePct, partnerSharePct] = await Promise.all([
    getConfigNumber(GST_PCT_KEY, 0),
    getConfigNumber(TDS_PCT_KEY, 0),
    getConfigNumber(PLATFORM_FEE_PCT_KEY, DEFAULT_PLATFORM_FEE_PCT),
    getConfigNumber(PARTNER_SHARE_PCT_KEY, DEFAULT_PARTNER_SHARE_PCT),
  ]);

  const dealPrice = lead.dealPriceAtLock ?? lead.property?.price ?? null;
  const feeEntitlement = dealPrice && lead.feePct ? round2((dealPrice * lead.feePct) / 100) : null;

  const entitlements = lines.map((l) => {
    const gross = feeEntitlement ? round2((feeEntitlement * l.pct) / 100) : null;
    // Deductions apply to the payee's gross share, not to the whole fee.
    const gst = gross && gstPct ? round2((gross * gstPct) / 100) : 0;
    const tds = gross && tdsPct ? round2((gross * tdsPct) / 100) : 0;
    return {
      payeeRole: l.payeeRole,
      payeeUserId: l.payeeUserId ?? null,
      pctOfFee: l.pct,
      gross,
      gst,
      tds,
      net: gross != null ? round2(gross - tds) : null,
    };
  });

  const heldAmount = escrow.amount;
  const coversFee = feeEntitlement != null ? feeEntitlement <= heldAmount : null;

  // backend-work-still-open.md #1 — R and Pi, calculated from the
  // configured rates, not admin-typed (see release() below). headroom is
  // what release() will refuse to let ΣPi + R exceed.
  const platformFeeAmount = round2((heldAmount * platformFeePct) / 100);
  // No assigned partner means nothing to pay out as a partner leg at all —
  // partnerShareAmount is 0 in that case, not a figure with nowhere to go.
  const partnerShareAmount = lead.assignedPartnerId ? round2((heldAmount * partnerSharePct) / 100) : 0;
  const headroom = round2(heldAmount - platformFeeAmount - partnerShareAmount);

  // 2.9 — release conditions. `blocking` ones stop an automated release;
  // the rest are advisory so admin still sees them.
  const conditions = [
    {
      key: 'ESCROW_HELD', blocking: true,
      ok: escrow.status === 'HELD' && !!escrow.razorpayPaymentId,
      detail: `status ${escrow.status}, payment ${escrow.razorpayPaymentId ? 'captured' : 'not captured'}`,
    },
    {
      key: 'COMMISSION_LOCKED', blocking: true,
      ok: !!lead.commissionLockedAt,
      detail: lead.commissionLockedAt ? `locked v${lead.commissionVersion}` : 'terms not agreed/locked yet',
    },
    {
      key: 'ALLOCATION_LETTER', blocking: true,
      ok: !!lead.allocationLetterUrl,
      detail: lead.allocationLetterUrl ? 'on file' : 'not uploaded',
    },
    {
      key: 'BUYER_CONFIRMED', blocking: false,
      ok: ['VERIFIED_CLOSED'].includes(lead.buyerFeedbackStatus),
      detail: `buyer feedback: ${lead.buyerFeedbackStatus || 'none'}`,
    },
    {
      key: 'PARTNER_PAYOUT_ACCOUNT', blocking: false,
      ok: lead.assignedPartner?.payoutAccountStatus === 'ACTIVE' && !!lead.assignedPartner?.razorpayFundAccountId,
      detail: `payout account: ${lead.assignedPartner?.payoutAccountStatus || 'none'}`,
    },
  ];

  const unmetBlocking = conditions.filter((c) => c.blocking && !c.ok).map((c) => c.key);

  return {
    escrowId,
    leadRef: lead.refCode,
    heldAmount,
    dealPrice,
    feePct: lead.feePct,
    feeEntitlement,
    coversFee,
    // What the escrow cannot cover. Explicitly surfaced rather than silently
    // pro-rated, because how a shortfall is settled is a business decision.
    shortfall: feeEntitlement != null ? round2(Math.max(0, feeEntitlement - heldAmount)) : null,
    // R30 — projected net to the seller if released right now with the fee
    // taken in full out of the held escrow amount. A genuine projection, not
    // the actual release()-time figures (an explicit partnerShare override
    // can differ) — that's EscrowTransaction.netAmount, set only once
    // release() actually happens.
    netAmount: feeEntitlement != null ? round2(Math.max(0, heldAmount - feeEntitlement)) : null,
    deductions: { gstPct, tdsPct },
    // backend-work-still-open.md #1 — the gateway cost-recovery split OF B
    // itself (independent of the fee/GST/TDS entitlement above, which is a
    // claim against the deal price). platformFeeAmount is what release()
    // will actually retain; platformShareOfB is it expressed as a fraction
    // of B for display — derived, never an input.
    platformFeePct, partnerSharePct,
    platformFeeAmount, partnerShareAmount,
    platformShareOfB: heldAmount > 0 ? round2(platformFeeAmount / heldAmount) : null,
    headroom,
    entitlements,
    conditions,
    unmetBlocking,
    readyToRelease: unmetBlocking.length === 0,
  };
}

async function release(escrowId, adminId, releaseData, ip) {
  const { sellerDetails, partnerDetails, manualTransferConfirmed, partnerShare: partnerShareOverride, note } = releaseData ?? {};

  const escrow = await prisma.escrowTransaction.findUnique({ where: { id: escrowId } });
  if (!escrow) throw new ApiError(404, 'Escrow not found');
  if (escrow.status !== 'HELD') throw new ApiError(400, `Cannot release escrow with status ${escrow.status}`);
  if (!escrow.razorpayPaymentId) throw new ApiError(400, 'Payment not yet captured');

  // 2.9 — release conditions, checked before the atomic claim so an unmet
  // condition never leaves a half-claimed RELEASED behind.
  //
  // overrideConditions lets admin release anyway (a deal settled outside the
  // normal sequence still has to be closable), but it demands a reason and is
  // recorded in the audit log — it is not a silent bypass.
  const plan = await getReleasePlan(escrowId);
  if (!plan.readyToRelease) {
    if (!releaseData?.overrideConditions) {
      throw new ApiError(400, `Release conditions not met: ${plan.unmetBlocking.join(', ')}`, {
        code: 'RELEASE_CONDITIONS_UNMET',
        unmet: plan.unmetBlocking,
      });
    }
    if (!releaseData?.overrideReason) {
      throw new ApiError(400, 'overrideReason is required when overriding release conditions', {
        code: 'OVERRIDE_REASON_REQUIRED',
      });
    }
    logger.warn('[Escrow] Release conditions overridden by admin', {
      escrowId, adminId, unmet: plan.unmetBlocking, reason: releaseData.overrideReason,
    });
  }

  // backend-work-still-open.md #1 — platformFee (R) is ALWAYS the
  // calculated figure from plan; there is no admin input for it at all
  // (the release schema no longer even accepts one). partnerShare (Pi) is
  // shown on the plan for display/headroom purposes, but — deliberately —
  // defaults to 0 here rather than plan.partnerShareAmount: whether a
  // partner payout actually happens this release stays opt-in, exactly as
  // before, so a partner who hasn't finished payout-account onboarding
  // doesn't suddenly block every release of a lead assigned to them. Admin
  // still pays the calculated Pi explicitly the same way as any other
  // figure, by passing partnerShare (+ partnerDetails, if needed).
  const platformFee = plan.platformFeeAmount;
  const partnerShare = partnerShareOverride || 0;

  // The seller is paid the token advance net of whatever's held back for the
  // partner/platform — platformFee simply stays in the RazorpayX account
  // (no payout needed for it), and partnerShare is paid out below only if
  // partnerDetails was also given. Checked before the atomic claim so a bad
  // amount is rejected up front instead of claiming RELEASED and having to
  // roll it back for what's really a request-validation error.
  const heldBack = partnerShare + platformFee;
  if (heldBack >= escrow.amount) {
    throw new ApiError(400, 'partnerShare + platformFee must be less than the escrow amount');
  }
  const sellerAmount = escrow.amount - heldBack;

  // Resolve how the partner leg gets paid, BEFORE the atomic claim — same
  // reasoning as the amount check above: a request-validation problem must
  // not leave us having to roll back a claimed RELEASED.
  //
  // Preferred path is the partner's onboarded RazorpayX fund account
  // (POST /partner/payout-account), which is created and penny-drop-checked
  // once. Before this, every release rebuilt a contact + fund account from
  // details typed into the release request, which meant a new RazorpayX
  // contact per release and no way to know the account had ever been checked.
  //
  // Explicit partnerDetails still wins — an admin paying someone other than
  // the assigned partner needs that escape hatch.
  let storedPartnerFundAccountId = null;
  if (partnerShare > 0 && !partnerDetails) {
    const lead = await prisma.lead.findUnique({
      where: { id: escrow.leadId },
      select: { assignedPartnerId: true },
    });
    const partner = lead?.assignedPartnerId
      ? await prisma.user.findUnique({
          where: { id: lead.assignedPartnerId },
          select: { razorpayFundAccountId: true, payoutAccountStatus: true },
        })
      : null;

    if (!partner?.razorpayFundAccountId) {
      throw new ApiError(400, 'The assigned partner has no payout account yet. Ask them to add one, or pass partnerDetails to pay a different account.', { code: 'PARTNER_PAYOUT_ACCOUNT_MISSING' });
    }
    // The status exists precisely to stop money going to an account that
    // failed its check — falling back to ad-hoc creation here would walk
    // straight around the clarification gate.
    if (partner.payoutAccountStatus !== 'ACTIVE') {
      throw new ApiError(400, `The assigned partner's payout account is ${partner.payoutAccountStatus || 'not set up'} — resolve that before releasing their share.`, { code: 'PARTNER_PAYOUT_ACCOUNT_NOT_ACTIVE' });
    }
    storedPartnerFundAccountId = partner.razorpayFundAccountId;
  }

  // Atomic claim: the write is conditioned on status still being HELD, so of
  // two concurrent release() calls for the same escrow, only one can affect
  // a row — the loser's updateMany affects 0 rows and bails out below,
  // *before* ever calling RazorpayX. Without this, both could pass the
  // findUnique check above and both create a payout, paying the seller twice.
  const claim = await prisma.escrowTransaction.updateMany({
    where: { id: escrowId, status: 'HELD' },
    data: { status: 'RELEASED', releasedAt: new Date(), releasedByAdminId: adminId },
  });
  if (claim.count === 0) throw new ApiError(400, 'This escrow was already released or refunded');

  let sellerPayoutId = null;
  let sellerPayoutStatusVal = null;
  let partnerPayoutId = null;
  let partnerPayoutStatusVal = null;
  try {
    // Seller and partner legs are independent recipients, so they run
    // concurrently rather than back-to-back — each leg's fund-account
    // validation (validateFundAccountOrWarn) can add a few seconds of polling,
    // and this admin request shouldn't pay that cost twice when both legs
    // are requested. If either leg throws, Promise.all rejects and the catch
    // below rolls the whole release back the same as a single-leg failure.
    const legs = [];
    if (sellerDetails) {
      legs.push((async () => {
        const contact = await createPayoutContact(sellerDetails.name, sellerDetails.email, sellerDetails.phone);
        const fundAccount = await createPayoutFundAccount(contact.id, sellerDetails.name, sellerDetails.ifsc, sellerDetails.accountNumber);
        await validateFundAccountOrWarn(fundAccount.id, 'seller');
        // escrowId-derived idempotency key (see createPayout): a retried
        // payout call for the same escrow (client timeout/resubmit) is
        // deduped by RazorpayX itself, on top of the atomic DB claim above.
        const payout = await createPayout(fundAccount.id, Math.round(sellerAmount * 100), `escrow_seller_${escrowId}`);
        sellerPayoutId = payout.id;
        sellerPayoutStatusVal = payout.status;
      })());
    }
    if (partnerShare > 0 && (partnerDetails || storedPartnerFundAccountId)) {
      legs.push((async () => {
        let fundAccountId = storedPartnerFundAccountId;
        if (!fundAccountId) {
          const contact = await createPayoutContact(partnerDetails.name, partnerDetails.email, partnerDetails.phone);
          const fundAccount = await createPayoutFundAccount(contact.id, partnerDetails.name, partnerDetails.ifsc, partnerDetails.accountNumber);
          // Only ad-hoc accounts are validated here. A stored account was
          // already penny-drop-checked at onboarding, and re-checking on
          // every release would add seconds of polling and another penny
          // drop for an account we've already cleared.
          await validateFundAccountOrWarn(fundAccount.id, 'partner');
          fundAccountId = fundAccount.id;
        }
        const payout = await createPayout(fundAccountId, Math.round(partnerShare * 100), `escrow_partner_${escrowId}`);
        partnerPayoutId = payout.id;
        partnerPayoutStatusVal = payout.status;
      })());
    }
    await Promise.all(legs);
  } catch (err) {
    // At least one RazorpayX payout failed (or was never attempted) — undo
    // the claim so the escrow is still HELD and can be retried, instead of
    // being stuck RELEASED with money not fully moved. If the seller payout
    // above already succeeded, its reference_id makes the retry a safe no-op
    // on that leg instead of a second payment.
    await prisma.escrowTransaction.update({
      where: { id: escrowId },
      data: { status: 'HELD', releasedAt: null, releasedByAdminId: null },
    });
    throw err;
  }

  const parts = [];
  if (sellerPayoutId)  parts.push(`Seller payout ${sellerPayoutId}: ₹${sellerAmount.toLocaleString('en-IN')}`);
  if (partnerPayoutId) parts.push(`Partner payout ${partnerPayoutId}: ₹${partnerShare.toLocaleString('en-IN')}`);
  if (partnerShare > 0 && !partnerPayoutId) parts.push(`Partner share: ₹${partnerShare}`);
  parts.push(`Platform fee (${plan.platformFeePct}% of held amount, calculated): ₹${platformFee}`);
  // Only claim "no RazorpayX payout" when truly neither leg went through it —
  // manualTransferConfirmed covers the seller's share being paid outside
  // Razorpay, but partnerDetails can still trigger a real automated partner
  // payout in the same release, which this note must not contradict.
  if (!sellerDetails && !partnerPayoutId && manualTransferConfirmed) parts.push('Manual transfer — no RazorpayX payout initiated');
  if (note)                  parts.push(note);
  const adminNote = parts.join(' | ') || undefined;

  const updated = await prisma.escrowTransaction.update({
    where: { id: escrowId },
    data: {
      adminNote,
      netAmount: sellerAmount,
      ...(sellerPayoutId && { razorpayPayoutId: sellerPayoutId, sellerPayoutStatus: sellerPayoutStatusVal }),
      ...(partnerPayoutId && { razorpayPartnerPayoutId: partnerPayoutId, partnerPayoutStatus: partnerPayoutStatusVal }),
    },
  });

  await createAuditLog({
    adminId, action: 'ESCROW_RELEASED', targetType: 'EscrowTransaction', targetId: escrowId,
    before: plan.readyToRelease ? undefined : { unmetConditions: plan.unmetBlocking, overrideReason: releaseData?.overrideReason },
    after: {
      status: 'RELEASED', sellerAmount, partnerShare, platformFee,
      platformFeePct: plan.platformFeePct, note,
      sellerPayoutId, partnerPayoutId,
      manualTransferConfirmed: !!manualTransferConfirmed && !sellerDetails,
    },
    ipAddress: ip,
  });

  return { ...updated, platformFeePct: plan.platformFeePct, platformFeeAmount: platformFee, partnerShareAmount: partnerShare };
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

  // Fire-and-forget, same reasoning as confirmPayment(): this is reached from
  // the buyer-facing cancelLead flow too, and the refund itself (Razorpay API
  // call + DB write above) already succeeded — a notification/email hiccup
  // here must not surface as a failed refund.
  (async () => {
    await createNotification({
      userId: escrow.buyerId,
      title: 'Escrow Refunded',
      message: 'Your token advance has been refunded to your original payment method.',
      type: 'ESCROW_REFUNDED',
    });
    const buyer = await prisma.user.findUnique({ where: { id: escrow.buyerId }, select: { email: true } });
    if (buyer) await sendEscrowRefunded(buyer.email, escrow.amount);
  })().catch((err) => logger.warn('[Escrow] Post-refund notification/email failed', { escrowId: updated.id, error: err.message }));

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

  const [heldAgg, refundedAgg, releasedThisMonthAgg, releasedForAvg, payoutFailedCount, refundedThisMonthAgg, heldCount, releasedThisMonthCount] = await Promise.all([
    // HELD_PAYOUT_FAILED money hasn't left the account either — it's still
    // "held", just stuck on a failed payout attempt — so it's counted here
    // too rather than disappearing from this total; payoutFailedCount below
    // is what actually surfaces that it needs attention.
    prisma.escrowTransaction.aggregate({ where: { status: { in: ['HELD', 'HELD_PAYOUT_FAILED'] } }, _sum: { amount: true } }),
    prisma.escrowTransaction.aggregate({ where: { status: 'REFUNDED' }, _sum: { amount: true } }),
    prisma.escrowTransaction.aggregate({
      where: { status: 'RELEASED', releasedAt: { gte: startOfMonth } },
      _sum: { amount: true },
    }),
    prisma.escrowTransaction.findMany({
      where: { status: 'RELEASED', releasedAt: { not: null } },
      select: { createdAt: true, releasedAt: true },
    }),
    prisma.escrowTransaction.count({ where: { status: 'HELD_PAYOUT_FAILED' } }),
    // MTD splits + counts (admin docs 1.3 / partner B5.6 — the finance cards
    // show "held total and count", "released this month and count").
    prisma.escrowTransaction.aggregate({
      where: { status: 'REFUNDED', refundedAt: { gte: startOfMonth } },
      _sum: { amount: true },
    }),
    prisma.escrowTransaction.count({ where: { status: { in: ['HELD', 'HELD_PAYOUT_FAILED'] } } }),
    prisma.escrowTransaction.count({ where: { status: 'RELEASED', releasedAt: { gte: startOfMonth } } }),
  ]);

  const avgHoldDays = releasedForAvg.length
    ? releasedForAvg.reduce((sum, t) => sum + (t.releasedAt - t.createdAt) / 86_400_000, 0) / releasedForAvg.length
    : 0;

  return {
    heldSum: heldAgg._sum.amount || 0,
    refundedSum: refundedAgg._sum.amount || 0,
    releasedSumThisMonth: releasedThisMonthAgg._sum.amount || 0,
    refundedSumThisMonth: refundedThisMonthAgg._sum.amount || 0,
    heldCount,
    releasedCountThisMonth: releasedThisMonthCount,
    avgHoldDays: Math.round(avgHoldDays * 10) / 10,
    payoutFailedCount,
  };
}

// R10 — freeze a HELD escrow for a dispute. Blocks release() and refund()
// for free, since both already reject anything that is not HELD.
async function freeze(escrowId, reason, adminId, ip) {
  const escrow = await prisma.escrowTransaction.findUnique({ where: { id: escrowId } });
  if (!escrow) throw new ApiError(404, 'Escrow not found');
  if (escrow.status !== 'HELD') throw new ApiError(400, `Cannot freeze escrow with status ${escrow.status} — only a HELD escrow can be frozen`);

  const updated = await prisma.escrowTransaction.update({
    where: { id: escrowId },
    data: { status: 'FROZEN', frozenAt: new Date(), frozenReason: reason, frozenByAdminId: adminId, unfrozenAt: null },
  });

  await createAuditLog({
    adminId, action: 'ESCROW_FROZEN', targetType: 'EscrowTransaction', targetId: escrowId,
    before: { status: 'HELD' }, after: { status: 'FROZEN', reason }, ipAddress: ip,
  });

  return updated;
}

// Always restores HELD — FROZEN is only ever entered from HELD above, so
// there is nothing else to restore to.
async function unfreeze(escrowId, adminId, ip) {
  const escrow = await prisma.escrowTransaction.findUnique({ where: { id: escrowId } });
  if (!escrow) throw new ApiError(404, 'Escrow not found');
  if (escrow.status !== 'FROZEN') throw new ApiError(400, `Escrow is not frozen (status: ${escrow.status})`);

  const updated = await prisma.escrowTransaction.update({
    where: { id: escrowId },
    data: { status: 'HELD', unfrozenAt: new Date() },
  });

  await createAuditLog({
    adminId, action: 'ESCROW_UNFROZEN', targetType: 'EscrowTransaction', targetId: escrowId,
    before: { status: 'FROZEN' }, after: { status: 'HELD' }, ipAddress: ip,
  });

  return updated;
}

module.exports = {
  createOrder, getById, getReleasePlan, confirmPayment, release, refund, getAllEscrow, getEscrowStats,
  freeze, unfreeze,
};
