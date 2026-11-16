const prisma = require('../../lib/prisma');
const escrowTotals = require('../../lib/escrowTotals');
const ApiError = require('../../utils/ApiError');
const { PAYABLE_PARTNER_SELECT, partnerPayoutBlocker } = require('../../lib/partnerStanding');
const { razorpay, createEscrowOrder, createPayoutContact, createPayoutFundAccount, createPayout, validateFundAccountOrWarn, refundPayment, findPayoutByReference } = require('../../lib/razorpay');
const { createAuditLog } = require('../../lib/auditLog');
const { createNotification, notifyAdmins } = require('../../lib/notifications');
const { notifyUser } = require('../../lib/wati');
const { sendEscrowRefunded, sendEscrowHeld, sendPartnerTaxInvoiceNeeded } = require('../../lib/email');
const { getConfigNumber } = require('../config/config.service');
const { isEscrowLeadUniqueViolation } = require('../../lib/escrowUtils');
const { buildEscrowReceiptPdf, buildFeeTaxInvoicePdf, buildRefundReceiptPdf } = require('../../lib/pdfReceipt');
const { splitGstInclusive, financialYear, formatInvoiceNo } = require('../../lib/gstInvoice');
const logger = require('../../lib/logger');
const { withKeyLock } = require('../../lib/keyLock');
const money = require('../../lib/moneyModel');
const { getMoneySettings } = require('../money/moneyConfig');
const ledger = require('../money/ledger.service');
const partnerTax = require('../money/partnerTax.service');
const { razorpayErrorText, isClearRefusal, isLowBalance, refundFailure, recordRefundFailure } = require('../../lib/refundFailure');

const DEFAULT_MIN_ESCROW_AMOUNT = 50000;
const DEFAULT_MAX_ESCROW_PCT = 10;

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
      processingFeePaise: true, chargedPaise: true, cancellationChargePaise: true, refundReason: true,
    },
  });
  if (!escrow || escrow.buyerId !== buyerId) throw new ApiError(404, 'Escrow not found');
  const { buyerId: _buyerId, ...safe } = escrow;
  return safe;
}

// Dev feedback, 2026-10-08 — the buyer's token-payment receipt had no
// backend endpoint; pdfReceipt.js already covered commission/builder-
// invoice/ticket receipts but not this one. Generated fresh on each
// request (same read-only data every time) rather than generated once
// and stored — there's no "has this already been issued" state to track
// the way an invoice has, so nothing is gained by persisting it.
async function getReceipt(escrowId, buyerId) {
  const escrow = await prisma.escrowTransaction.findFirst({
    where: { id: escrowId, buyerId },
    include: {
      lead: {
        select: {
          refCode: true, buyerName: true,
          property: { select: { title: true } },
          propertyInterest: true,
        },
      },
    },
  });
  if (!escrow) throw new ApiError(404, 'Escrow not found');
  if (!['HELD', 'HELD_PAYOUT_FAILED', 'RELEASED', 'REFUNDED', 'FROZEN'].includes(escrow.status)) {
    throw new ApiError(400, 'No receipt yet — payment has not been captured for this escrow');
  }

  const { company } = await getMoneySettings();
  return buildEscrowReceiptPdf({
    company,
    refCode: escrow.lead?.refCode,
    propertyTitle: escrow.lead?.property?.title || escrow.lead?.propertyInterest,
    buyerName: escrow.lead?.buyerName,
    amount: escrow.amount,
    processingFeePaise: escrow.processingFeePaise,
    chargedPaise: escrow.chargedPaise,
    razorpayPaymentId: escrow.razorpayPaymentId,
    paidAt: escrow.heldAt,
  });
}

// BUG-M11 — the buyer's refund receipt: what came back, what was kept, the refund reference. Only for a refunded payment.
async function getRefundReceipt(escrowId, buyerId) {
  const escrow = await prisma.escrowTransaction.findFirst({
    where: { id: escrowId, buyerId },
    include: { lead: { select: { refCode: true, buyerName: true, property: { select: { title: true } }, propertyInterest: true } } },
  });
  if (!escrow) throw new ApiError(404, 'Escrow not found');
  if (escrow.status !== 'REFUNDED') throw new ApiError(400, 'No refund receipt — this payment has not been refunded');
  const { company } = await getMoneySettings();
  return buildRefundReceiptPdf({
    company,
    refCode: escrow.lead?.refCode,
    propertyTitle: escrow.lead?.property?.title || escrow.lead?.propertyInterest,
    buyerName: escrow.lead?.buyerName,
    tokenPaise: Math.round((escrow.amount || 0) * 100),
    feePaise: escrow.processingFeePaise,
    refundedPaise: escrow.refundedAmountPaise > 0 ? escrow.refundedAmountPaise : Math.round((escrow.amount || 0) * 100),
    chargePaise: escrow.cancellationChargePaise || 0,
    razorpayRefundId: escrow.razorpayRefundId,
    refundedAt: escrow.refundedAt,
  });
}

// T62 — the GST tax invoice for the processing fee. The token is not our supply, so it is not on this invoice; only the fee is.
// It takes the next number in its financial-year series the first time it is asked for and keeps it (so the number never
// changes and is never reused), and it needs the company GSTIN to be set: without one there is no tax invoice to issue.
// BUG-033: tax invoice numbers must be consecutive. The next number is taken only by the one request that holds a lock on this
// payment, and only after it has re-read the payment and found it still without a number; any other request waits and shows the
// winner's number. (Before, every overlapping request took a number from the series and only one kept it, leaving gaps.)
async function issueFeeInvoiceNumber(escrowId) {
  const read = () => prisma.escrowTransaction.findUnique({ where: { id: escrowId }, select: { feeInvoiceNo: true, feeInvoiceAt: true } });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const out = await withKeyLock(`feeInvoiceNo:${escrowId}`, async () => {
      const fresh = await read();
      if (fresh?.feeInvoiceNo) return { feeInvoiceNo: fresh.feeInvoiceNo, feeInvoiceAt: fresh.feeInvoiceAt };
      const at = new Date();
      const fy = financialYear(at);
      const counter = await prisma.counter.upsert({
        where: { id: `feeInvoice-${fy}` },
        update: { seq: { increment: 1 } },
        create: { id: `feeInvoice-${fy}`, seq: 1 },
      });
      const no = formatInvoiceNo(fy, counter.seq);
      await prisma.escrowTransaction.updateMany({
        where: { id: escrowId, OR: [{ feeInvoiceNo: null }, { feeInvoiceNo: { isSet: false } }] },
        data: { feeInvoiceNo: no, feeInvoiceAt: at },
      });
      return { feeInvoiceNo: no, feeInvoiceAt: at };
    });
    if (!out.busy) return out.value;
    // Someone else is issuing it right now: wait a moment, then use theirs.
    await new Promise((r) => setTimeout(r, 50));
    const again = await read();
    if (again?.feeInvoiceNo) return { feeInvoiceNo: again.feeInvoiceNo, feeInvoiceAt: again.feeInvoiceAt };
  }
  throw new ApiError(503, 'The invoice is being prepared. Please try again in a moment.', { code: 'FEE_INVOICE_BUSY' });
}

async function getFeeInvoice(escrowId, buyerId) {
  const escrow = await prisma.escrowTransaction.findFirst({
    where: { id: escrowId, buyerId },
    include: { lead: { select: { refCode: true, buyerName: true } } },
  });
  if (!escrow) throw new ApiError(404, 'Escrow not found');
  if (!['HELD', 'HELD_PAYOUT_FAILED', 'RELEASED', 'REFUNDED', 'FROZEN'].includes(escrow.status)) {
    throw new ApiError(400, 'No invoice yet: payment has not been captured for this escrow');
  }
  const feePaise = escrow.processingFeePaise > 0 ? escrow.processingFeePaise : 0;
  if (!feePaise) throw new ApiError(400, 'No processing fee was charged on this payment', { code: 'NO_PROCESSING_FEE' });

  const settings = await getMoneySettings();
  if (!settings.company.gstin) {
    throw new ApiError(409, 'The tax invoice for the processing fee is not available yet', { code: 'FEE_INVOICE_UNAVAILABLE' });
  }

  let { feeInvoiceNo, feeInvoiceAt } = escrow;
  if (!feeInvoiceNo) ({ feeInvoiceNo, feeInvoiceAt } = await issueFeeInvoiceNumber(escrowId));

  const gstPct = settings.processingFee.feeGstPct;
  return buildFeeTaxInvoicePdf({
    company: settings.company,
    invoiceNo: feeInvoiceNo,
    invoiceDate: feeInvoiceAt,
    buyerName: escrow.lead?.buyerName,
    refCode: escrow.lead?.refCode,
    razorpayPaymentId: escrow.razorpayPaymentId,
    split: splitGstInclusive(feePaise, gstPct),
    gstPct,
    sacCode: settings.processingFee.sacCode,
  });
}

// What the buyer is shown from the first price screen to the receipt: the
// token, the separate payment processing fee, the total charged, and the
// refund terms, all from settings (money model Rev 3, T55/T56). Same numbers
// everywhere: the Razorpay order is for totalPaise.
// 7 Nov 2026: an NRI buyer may pay with a foreign card (Razorpay 3% + GST, not 2% + GST), so the fee is sized with the NRI rate for them.
function checkoutBreakdown(tokenPaise, settings, { nri = false } = {}) {
  const gatewayPct = nri ? settings.processingFee.gatewayPctNri : settings.processingFee.gatewayPct;
  const fee = money.processingFee(tokenPaise, { ...settings.processingFee, gatewayPct });
  const r = settings.refund;
  return {
    tokenPaise,
    processingFeePaise: fee.feePaise,
    processingFeeGstPaise: fee.feeGstPaise,
    totalPaise: fee.totalPaise,
    processingFeeEnabled: settings.processingFee.enabled,
    nri,
    gatewayPct,
    gatewayGstPct: settings.processingFee.gatewayGstPct,
    refundWindowHours: r.freeWindowHours,
    cancellationChargePaise: Math.min(r.cancellationChargePaise, tokenPaise),
    holdDays: r.holdDays,
  };
}

// Public quote for the listing page and checkout ("Booking this plot: token X
// + payment processing fee Y"). Reads settings only; moves no money.
const MAX_QUOTE_RUPEES = 1_000_000_000; // Rs. 100 crore

async function getCheckoutQuote(amountInRupees, { nri = false } = {}) {
  const tokenPaise = money.toPaise(amountInRupees);
  if (!Number.isInteger(tokenPaise) || tokenPaise <= 0) throw new ApiError(400, 'amount must be a positive number');
  // This price check is public. A token can never be anywhere near this, and a huge number would only produce nonsense arithmetic.
  if (!Number.isSafeInteger(tokenPaise) || amountInRupees > MAX_QUOTE_RUPEES) throw new ApiError(400, 'amount is too large');
  return checkoutBreakdown(tokenPaise, await getMoneySettings(), { nri });
}

async function createOrder(leadId, buyerId, amountInRupees) {
  // Scoped to buyerId, not just id — previously any authenticated user could
  // create (and pay into) an escrow order for *any* lead by guessing/reusing
  // a leadId, since the lookup had no ownership check at all.
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, buyerId },
    include: { property: { select: { price: true } } },
  });
  if (!lead) throw new ApiError(404, 'Lead not found');
  // The fee is sized from the buyer's own NRI flag in the database, never from anything the browser sends. Read only when a price is needed.
  const isNri = async () => !!(await prisma.user.findUnique({ where: { id: buyerId }, select: { isNRI: true } }))?.isNRI;
  // A cancelled or closed inquiry can never be paid again; say why and what to do, not the generic visit message.
  if (lead.status === 'DROPPED') {
    throw new ApiError(400, 'This inquiry was cancelled, so a token cannot be paid on it. Send a new inquiry for the property to continue.', { code: 'LEAD_DROPPED' });
  }
  if (lead.status === 'CLOSED') {
    throw new ApiError(400, 'This deal is already complete, so there is nothing left to pay.', { code: 'LEAD_CLOSED' });
  }
  if (lead.status !== 'SITE_VISIT_DONE') {
    throw new ApiError(400, 'Escrow can only be created after the site visit is done');
  }

  // Dev feedback, 2026-10-08 — only a floor existed; nothing stopped a
  // token amount disproportionate to the deal itself. Capped at a %
  // (admin-configurable, default 10) of the deal's own price —
  // dealPriceAtLock when the commission terms are already set, falling
  // back to the live listing price otherwise. Skipped (not refused) when
  // neither is known yet — a free-text lead with no resolvable price has
  // nothing to cap against, same "can't validate without data" pattern
  // used elsewhere (e.g. an ADVISOR flat amount needing a known fee).
  const dealPrice = lead.dealPriceAtLock ?? lead.property?.price ?? null;
  if (dealPrice) {
    const maxPct = await getConfigNumber('escrow_max_token_pct', DEFAULT_MAX_ESCROW_PCT);
    const maxAmount = round2((dealPrice * maxPct) / 100);
    if (amountInRupees > maxAmount) {
      throw new ApiError(400, `Maximum escrow amount is ₹${maxAmount.toLocaleString('en-IN')} (${maxPct}% of the deal price)`, { code: 'ESCROW_AMOUNT_ABOVE_MAX', max: maxAmount }); // BE-21
    }
  }

  // Dev feedback, 2026-10-08 — the frontend hardcodes "Refund protection
  // fee: Free" with no backend figure behind it at all. Config-driven,
  // default 0 (a genuine "it's free today," not a placeholder) — returned
  // on every createOrder response so the frontend can show the real
  // number instead of a hardcoded claim, the moment this is ever non-zero.
  const refundProtectionFeePct = await getConfigNumber('escrow_refund_protection_fee_pct', 0);

  const existing = await prisma.escrowTransaction.findFirst({
    // Any token that still holds money blocks a new order, not only HELD: a frozen (disputed) or part-refunded token still holds the buyer's money.
    where: { leadId, status: { in: ['HELD', 'PAYMENT_PENDING', 'HELD_PAYOUT_FAILED', 'FROZEN', 'PARTIALLY_REFUNDED'] } },
  });
  if (existing) {
    if (existing.status !== 'PAYMENT_PENDING') {
      // BE-21 — 409 (not 400): this isn't a bad request, it's a real
      // conflict with existing state, and escrowId lets the FE route
      // straight to the existing order instead of just showing an error.
      throw new ApiError(409, 'An active escrow order already exists for this lead', { code: 'ESCROW_ALREADY_ACTIVE', escrowId: existing.id });
    }
    // An earlier Checkout attempt was abandoned before any payment was made
    // (closed tab, bad network, came back later) — there's no payment.failed
    // webhook for that, since no payment was ever attempted, so without this
    // the buyer would be stuck forever: this check would keep rejecting every
    // retry, refund()/release() both require a captured payment that was
    // never made, and the only way out was dropping the whole lead. Razorpay
    // orders don't expire, so just resume the same order_id instead of erroring.
    // Audit Nov 2026 (F9). A Razorpay outage while resuming is a 502 the buyer can retry, not a 500.
    let razorpayOrder;
    try { razorpayOrder = await razorpay.orders.fetch(existing.razorpayOrderId); } catch (err) {
      throw new ApiError(502, `Could not fetch the existing Razorpay order: ${razorpayErrorText(err)}`, { code: 'RAZORPAY_ERROR' });
    }
    const resumedBreakdown = checkoutBreakdown(Math.round(existing.amount * 100), await getMoneySettings(), { nri: await isNri() });

    if (razorpayOrder.status === 'paid') {
      // The payment actually went through already — most likely the
      // payment.captured webhook for it was delayed or dropped, which is
      // exactly what the buyer re-opening this screen would surface. Self-heal
      // here rather than reopening a Checkout Razorpay would refuse a second
      // payment against anyway.
      let payments;
      try { payments = await razorpay.orders.fetchPayments(existing.razorpayOrderId); } catch (err) {
        throw new ApiError(502, `Could not check the payment with Razorpay: ${razorpayErrorText(err)}`, { code: 'RAZORPAY_ERROR' });
      }
      const capturedPayment = payments.items?.find((p) => p.status === 'captured');
      if (capturedPayment) {
        const healed = await confirmPayment(existing.razorpayOrderId, capturedPayment.id, buyerId);
        return { escrow: healed, razorpayOrder, key: process.env.RAZORPAY_KEY_ID, refundProtectionFeePct, breakdown: resumedBreakdown, resumed: true, alreadyPaid: true };
      }
    }

    return { escrow: existing, razorpayOrder, key: process.env.RAZORPAY_KEY_ID, refundProtectionFeePct, breakdown: resumedBreakdown, resumed: true };
  }

  // snake_case to match every other seeded key. The old camelCase
  // 'escrowMinAmountRupees' was never seeded, so this always fell through to
  // the default and the admin-editable value did nothing.
  const minAmount = await getConfigNumber('escrow_min_amount_rupees', DEFAULT_MIN_ESCROW_AMOUNT);
  if (amountInRupees < minAmount) {
    throw new ApiError(400, `Minimum escrow amount is ₹${minAmount.toLocaleString('en-IN')}`, { code: 'ESCROW_AMOUNT_BELOW_MIN', min: minAmount }); // BE-21
  }

  const amountInPaise = Math.round(amountInRupees * 100);
  // Money model Rev 3 — the order is for token + processing fee; `amount`
  // stays the token alone (see schema comment on EscrowTransaction).
  const breakdown = checkoutBreakdown(amountInPaise, await getMoneySettings(), { nri: await isNri() });
  // Live-tested finding — Razorpay rejects a bad/expired key pair with a
  // plain {statusCode, error} throw (not an Error instance), which
  // previously fell through to the generic 500 INTERNAL_ERROR instead of
  // a proper 502 — same wrapping already applied to release()/refund()/
  // confirmPayment() elsewhere in this file.
  let order;
  try {
    order = await createEscrowOrder(breakdown.totalPaise, `escrow_${leadId}`);
  } catch (err) {
    throw new ApiError(502, `Could not create the Razorpay order: ${razorpayErrorText(err)}`, { code: 'RAZORPAY_ERROR' });
  }

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
        amountPaise: amountInPaise, // BE-9
        processingFeePaise: breakdown.processingFeePaise,
        chargedPaise: breakdown.totalPaise,
        status: 'PAYMENT_PENDING',
      },
    });
  } catch (err) {
    if (isEscrowLeadUniqueViolation(err)) {
      // Audit Nov 2026 (F9). The loser of a double click gets the same 409 and code as the pre-check, with the winner's id.
      const winner = await prisma.escrowTransaction.findFirst({ where: { leadId, status: { in: ['HELD', 'PAYMENT_PENDING', 'HELD_PAYOUT_FAILED', 'FROZEN', 'PARTIALLY_REFUNDED'] } }, select: { id: true } }).catch(() => null);
      throw new ApiError(409, 'An active escrow order already exists for this lead', { code: 'ESCROW_ALREADY_ACTIVE', ...(winner && { escrowId: winner.id }) });
    }
    throw err;
  }

  // Dev feedback, 2026-10-08 — razorpay.key_id (the PUBLIC checkout key,
  // not RAZORPAY_KEY_SECRET) was never returned here, so the frontend's
  // Razorpay Checkout widget had nothing to open with except its own
  // NEXT_PUBLIC_RAZORPAY_KEY_ID fallback — unset locally, breaking the Pay
  // button entirely. The backend already has the one true key_id in its
  // own env; no reason to make the frontend keep a second copy in sync.
  return { escrow, razorpayOrder: order, key: process.env.RAZORPAY_KEY_ID, refundProtectionFeePct, breakdown };
}

// Duplicate or late payment (7 Nov 2026, owner's decision). Razorpay only auto-refunds a duplicate on the SAME order, and only while it is still
// authorized; a captured payment on another order of the same lead stays with us. So the extra payment is refunded in full (token and fee) here:
// claim the row first (only one delivery wins), call Razorpay, put the row back and alert admins if Razorpay refuses. Never throws.
async function refundDuplicatePayment(escrow, razorpayPaymentId) {
  const paise = escrow.chargedPaise ?? Math.round(escrow.amount * 100);
  try {
    const claim = await prisma.escrowTransaction.updateMany({
      where: { razorpayOrderId: escrow.razorpayOrderId, status: { in: ['PAYMENT_PENDING', 'FAILED'] } },
      data: { status: 'REFUNDED', razorpayPaymentId, refundReason: 'DUPLICATE_PAYMENT', refundedAmountPaise: paise, refundedAt: new Date() },
    });
    if (claim.count === 0) return; // another delivery already handled it
    let refundResult;
    try {
      refundResult = await refundPayment(razorpayPaymentId, paise);
    } catch (err) {
      await prisma.escrowTransaction.updateMany({
        where: { razorpayOrderId: escrow.razorpayOrderId, status: 'REFUNDED', refundReason: 'DUPLICATE_PAYMENT' },
        data: { status: escrow.status, refundedAmountPaise: 0, refundedAt: null, refundReason: null },
      });
      logger.error('[Escrow] Refund of a duplicate payment failed', { escrowId: escrow.id, razorpayPaymentId, statusCode: err?.statusCode, razorpayError: err?.error || err?.message });
      await notifyAdmins({
        title: 'Duplicate payment: refund by hand',
        message: isLowBalance(err)
          ? `The buyer paid twice for one deal and the automatic refund of ₹${money.toRupees(paise).toLocaleString('en-IN')} (payment ${razorpayPaymentId}) failed because the Razorpay payments balance is too low (Razorpay said: ${razorpayErrorText(err)}). Top up the balance, then refund it by hand in Razorpay.`
          : `The buyer paid twice for one deal and Razorpay refused the automatic refund of ₹${money.toRupees(paise).toLocaleString('en-IN')} (payment ${razorpayPaymentId}): ${razorpayErrorText(err)}. Refund it by hand in Razorpay.`,
        type: 'ESCROW_REFUNDED', linkUrl: '/admin/escrow',
      }).catch(() => {});
      return;
    }
    await prisma.escrowTransaction.updateMany({ where: { razorpayOrderId: escrow.razorpayOrderId }, data: { razorpayRefundId: refundResult.id, refundIds: { push: refundResult.id } } });
    const updated = { ...escrow, razorpayPaymentId, status: 'REFUNDED' };
    const feeSettings = await getMoneySettings();
    await ledger.onPaymentCaptured(updated, { feeGstPct: feeSettings.processingFee.feeGstPct });
    await ledger.onRefund(updated, { refundPaise: paise, reason: 'DUPLICATE_PAYMENT', feeReturned: true, cancellationChargePaise: 0, stage: 'DUPLICATE_PAYMENT' }, { refundId: refundResult.id, actor: { createdByType: 'SYSTEM', createdById: null } });
    await createAuditLog({
      adminId: null, actorRole: 'SYSTEM', action: 'ESCROW_DUPLICATE_REFUNDED', targetType: 'EscrowTransaction', targetId: escrow.id,
      reason: 'Captured payment on an order whose lead already had an active token',
      after: { status: 'REFUNDED', reason: 'DUPLICATE_PAYMENT', refundPaise: paise, razorpayPaymentId, razorpayRefundId: refundResult.id },
    });
    await createNotification({
      userId: escrow.buyerId, title: 'Extra payment refunded',
      message: `You had already paid the token for this deal, so the extra payment of ₹${money.toRupees(paise).toLocaleString('en-IN')} is being refunded to your original payment method.`,
      type: 'ESCROW_REFUNDED',
    }).catch(() => {});
    await notifyAdmins({ title: 'Duplicate payment refunded', message: `An extra payment of ₹${money.toRupees(paise).toLocaleString('en-IN')} on one deal was refunded automatically (payment ${razorpayPaymentId}).`, type: 'ESCROW_REFUNDED', linkUrl: '/admin/escrow' }).catch(() => {});
  } catch (err) {
    logger.error('[Escrow] Could not process a duplicate payment — refund it by hand', { razorpayPaymentId, error: err.message });
  }
}

// buyerId is only passed by the buyer-facing verify-payment controller — the
// Razorpay webhook calls this with no buyerId (it's already authenticated by
// the HMAC signature, not a caller identity). A forged signature can't pass
// verifyPaymentSignature(), so this check is defense-in-depth rather than the
// primary guard: it stops an authenticated user from confirming an order ID
// that isn't theirs, which a valid signature alone wouldn't prevent since
// signatures aren't scoped to the account making the HTTP request.
async function confirmPayment(razorpayOrderId, razorpayPaymentId, buyerId = null, webhookPayment = null) {
  const escrow = await prisma.escrowTransaction.findUnique({ where: { razorpayOrderId } });
  if (!escrow || (buyerId && escrow.buyerId !== buyerId)) throw new ApiError(404, 'Escrow order not found');
  // Only ever transition out of PAYMENT_PENDING (or FAILED, see below) — covers
  // both the already-HELD idempotent case and any other terminal status
  // (CANCELLED/etc.): a captured-payment event for an escrow that isn't awaiting
  // payment is either a redelivered webhook or a stale/out-of-order one, and
  // must never blindly flip a resolved escrow back to HELD.
  //
  // FAILED is recoverable: Razorpay Checkout lets the buyer retry on the SAME
  // order after a failed attempt, so an order marked FAILED by an earlier
  // payment.failed (older rows, or a failure notice that raced the retry) can
  // still be paid. A payment that is verified as captured, for this order and
  // the right amount, is real money and must be recorded — never ignored.
  if (!['PAYMENT_PENDING', 'FAILED'].includes(escrow.status)) return escrow;

  // BE-10 — verify path only (buyerId is only ever passed by the
  // buyer-facing controller, never by the webhook — see the comment above
  // this function). The HMAC signature checked before this is called only
  // proves the (orderId, paymentId, signature) triplet is authentic, not
  // that the payment actually captured — with auto-capture off, a merely
  // "authorized" payment could otherwise get marked HELD here. The webhook
  // path doesn't need this: payment.captured itself only ever fires once
  // Razorpay has actually captured the payment.
  if (buyerId) {
    let payment;
    try {
      payment = await razorpay.payments.fetch(razorpayPaymentId);
    } catch (err) {
      throw new ApiError(502, 'Could not verify the payment with Razorpay. Please try again.', { code: 'RAZORPAY_ERROR' }); // BE-16
    }
    if (payment.order_id !== razorpayOrderId) {
      throw new ApiError(400, 'This payment does not belong to this order.');
    }
    if (payment.status !== 'captured') {
      // Left PAYMENT_PENDING — the webhook (once it actually captures) or
      // paymentReconcile.js (BE-5) will finish this, same as any other
      // not-yet-paid order.
      throw new ApiError(409, `Payment has not been captured yet (status: ${payment.status}).`, { code: 'PAYMENT_NOT_CAPTURED' });
    }
    const expectedPaise = escrow.chargedPaise ?? Math.round(escrow.amount * 100);
    if (payment.amount !== expectedPaise || payment.currency !== 'INR') {
      throw new ApiError(400, "This payment's amount or currency does not match the order.", { code: 'AMOUNT_MISMATCH' });
    }
  }

  // Audit Nov 2026 (F6). The webhook and the reconcile job carry the payment's own amount and currency: check them too, so no caller
  // can mark a token paid for a different amount. A mismatch is never confirmed; admins are told and the order stays as it is.
  if (!buyerId && webhookPayment && typeof webhookPayment.amount === 'number') {
    const expected = escrow.chargedPaise ?? Math.round(escrow.amount * 100);
    if (webhookPayment.amount !== expected || webhookPayment.currency !== 'INR') {
      logger.error('[Escrow] A captured payment does not match its order; not confirmed', { escrowId: escrow.id, razorpayOrderId, razorpayPaymentId, paid: webhookPayment.amount, expected });
      await notifyAdmins({
        title: 'A payment does not match its token order',
        message: `Razorpay captured ${webhookPayment.amount}${webhookPayment.currency ? ` ${webhookPayment.currency}` : ''} (paise) for an order of ${expected}. The token was NOT marked paid. Check payment ${razorpayPaymentId} in Razorpay.`,
        type: 'ESCROW_AMOUNT_MISMATCH', linkUrl: '/admin/escrow',
      }).catch(() => null);
      return escrow;
    }
  }

  // Atomic claim, same shape as release()/refund(): this can race a webhook
  // delivery against the createOrder() resume-path self-heal hitting the same
  // order at nearly the same time — only the winner transitions the row and
  // sends the one-time notification below; the loser just returns the
  // already-updated escrow instead of re-confirming (and re-notifying).
  let claim;
  try {
    claim = await prisma.escrowTransaction.updateMany({
      where: { razorpayOrderId, status: { in: ['PAYMENT_PENDING', 'FAILED'] } },
      data: { razorpayPaymentId, status: 'HELD', heldAt: new Date(), failedAt: null },
    });
  } catch (err) {
    // A newer order for the same lead is already active, so this older one can't also become HELD.
    // The buyer has paid, so surface it loudly for the admin to resolve by hand instead of losing it.
    if (isEscrowLeadUniqueViolation(err)) {
      logger.error('[Escrow] Captured payment for an old order but the lead already has an active escrow — refunding the extra payment', { razorpayOrderId, razorpayPaymentId });
      await refundDuplicatePayment(escrow, razorpayPaymentId);
      throw new ApiError(409, 'You already have a token payment for this deal, so this extra payment is being refunded to your original payment method. No action is needed.', { code: 'ESCROW_DUPLICATE_PAYMENT' });
    }
    throw err;
  }
  if (claim.count === 0) {
    return prisma.escrowTransaction.findUnique({ where: { razorpayOrderId } });
  }
  const updated = await prisma.escrowTransaction.findUnique({ where: { razorpayOrderId } });
  // Money ledger: token held and processing fee received (idempotent, never throws).
  const feeSettings = await getMoneySettings();
  await ledger.onPaymentCaptured(updated, { feeGstPct: feeSettings.processingFee.feeGstPct });

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
    const heldLead = await prisma.lead.findUnique({ where: { id: updated.leadId }, select: { refCode: true, assignedPartnerId: true, property: { select: { id: true, title: true, partnerId: true } }, propertyInterest: true } });
    // The assigned partner is told first: their lead now has money held (found on 25 Oct 2026: nobody but the buyer was told).
    const tokenRupees = updated.amount.toLocaleString('en-IN');
    const leadRef = heldLead?.refCode || 'a lead';
    if (heldLead?.assignedPartnerId) {
      await createNotification({
        userId: heldLead.assignedPartnerId,
        title: 'Token received on your lead',
        message: `${leadRef}: the buyer's token advance of ₹${tokenRupees} is held in escrow. It is released after the allocation letter is verified.`,
        type: 'ESCROW_HELD',
        linkUrl: `/partners/leads/${updated.leadId}`,
      });
      notifyUser(heldLead.assignedPartnerId, 'partner_token_held', {
        partner_name: '$userName', lead_ref: leadRef, amount: tokenRupees,
        property_title: heldLead?.property?.title || heldLead?.propertyInterest || 'the property',
      }, { leadId: updated.leadId });
    }
    await notifyAdmins({
      title: 'Token received',
      message: `${leadRef}: a buyer's token advance of ₹${tokenRupees} is held in escrow${heldLead?.property?.title ? ` for ${heldLead.property.title}` : ''}.`,
      type: 'ESCROW_HELD',
      linkUrl: '/admin/escrow',
    });
    // The partner who owns the listing is told too (no buyer details): a token in escrow on their listing is news to them.
    const ownerId = heldLead?.property?.partnerId;
    if (ownerId && ownerId !== heldLead?.assignedPartnerId) {
      await createNotification({
        userId: ownerId,
        title: 'Token received on your listing',
        message: `A buyer's token advance of ₹${updated.amount.toLocaleString('en-IN')} was received for ${heldLead.property.title || 'your listing'}. It stays in escrow until admin releases it.`,
        type: 'ESCROW_HELD',
        linkUrl: `/partners/listings/${heldLead.property.id}`,
      });
    }
    notifyUser(updated.buyerId, 'escrow_token_received', {
      name: '$userName', amount: updated.amount.toLocaleString('en-IN'),
      property_title: heldLead?.property?.title || heldLead?.propertyInterest || 'your property',
      payment_id: updated.razorpayPaymentId || updated.razorpayOrderId,
    });
    const buyer = await prisma.user.findUnique({ where: { id: updated.buyerId }, select: { email: true } });
    if (buyer) await sendEscrowHeld(buyer.email, updated.amount, updated.processingFeePaise);
  })().catch((err) => logger.warn('[Escrow] Post-confirmation notification/email failed', { escrowId: updated.id, error: err.message }));

  return updated;
}

// A release creates its RazorpayX payouts first and writes the books (seller payout line, partner commission, TDS entry,
// voucher) afterwards. If that second step failed, the escrow is RELEASED and the money is out, but the books are missing.
// This re-runs the missing steps (all of them are idempotent: ledger rows by key, TdsEntry and voucher by escrow) and
// returns the real error if it fails again, so the cause is visible instead of silent. Admin, FINANCE permission.
async function repairReleaseBookkeeping(escrowId, adminId, ip) {
  const escrow = await prisma.escrowTransaction.findUnique({ where: { id: escrowId } });
  if (!escrow) throw new ApiError(404, 'Escrow not found');
  if (!['RELEASED', 'HELD_PAYOUT_FAILED'].includes(escrow.status)) {
    throw new ApiError(400, `Nothing to repair: the escrow is ${escrow.status}, not released`, { code: 'NOTHING_TO_REPAIR' });
  }
  const plan = await getReleasePlan(escrowId);
  const c = plan.partnerPayout;
  const sellerAmountPaise = escrow.netAmountPaise ?? Math.round((escrow.netAmount ?? escrow.amount) * 100);
  const done = [];
  try {
    // F20: no seller line for a seller payout that failed and has no payout on file; the retry writes it.
    const manualSeller = !escrow.razorpayPayoutId && !escrow.sellerPayoutStatus && escrow.status === 'RELEASED';
    if (escrow.razorpayPayoutId || manualSeller) {
      await ledger.onSellerPayout(escrow, { sellerAmountPaise, payoutId: escrow.razorpayPayoutId, status: escrow.sellerPayoutStatus, manual: manualSeller });
      done.push('seller payout line');
    }
    if (escrow.partnerPaidFromCompany && escrow.partnerGrossPaise && escrow.partnerPayoutStatus !== 'deferred') {
      if (!c) throw new Error('the partner commission can no longer be worked out from the locked terms');
      if (c.commissionPaise !== escrow.partnerGrossPaise) {
        throw new ApiError(409, `The commission now works out to ₹${money.toRupees(c.commissionPaise)}, but ₹${money.toRupees(escrow.partnerGrossPaise)} was paid; fix the terms or book it by hand.`, { code: 'COMMISSION_MISMATCH' });
      }
      await recordPartnerCredit(escrow, c, { payoutId: escrow.razorpayPartnerPayoutId, payoutStatus: escrow.partnerPayoutStatus, adminId });
      done.push('partner commission, TDS entry and voucher');
    }
  } catch (err) {
    logger.error('[Escrow] Repair of the release bookkeeping failed', { escrowId, error: err.message, stack: err.stack });
    if (err instanceof ApiError) throw err;
    throw new ApiError(500, `Bookkeeping repair failed: ${err.message}`, { code: 'REPAIR_FAILED' });
  }
  if (!escrow.adminNote) {
    await prisma.escrowTransaction.update({ where: { id: escrowId }, data: { adminNote: 'Release bookkeeping repaired after an earlier failure' } });
  }
  await createAuditLog({ adminId, action: 'ESCROW_BOOKKEEPING_REPAIRED', targetType: 'EscrowTransaction', targetId: escrowId, after: { done }, ipAddress: ip });
  return { escrowId, repaired: done };
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

// backend-work-still-open.md #1 — the platform's own cost-recovery retained
// share (R) and the partner's payout share (Pi) OF THE HELD AMOUNT (B)
// itself, a release-time split entirely separate from the commission
// fee/GST/TDS entitlement above (which is a claim against the DEAL PRICE,
// often bigger than B). Switchable like GST/TDS above, via the same
// PlatformConfig mechanism (GET/PUT /admin/config/:key) — not hardcoded,
// since these are business-decided rates, not fixed law. R itself is
// never an admin-typed amount (see release() below); only the *rate* is
// admin-configurable.
// Money model Rev 3 (22 Oct 2026): the partner's commission is 1% of the final
// deal price (a setting / per-project rate), paid when the token is released
// and NOT taken out of the token; the platform fee is on the seller invoice,
// not on the token. The old escrow_platform_fee_pct (1% of token) and
// escrow_partner_share_pct (2% of token) are no longer read; the token-level
// platform fee is escrow_token_platform_fee_pct, default 0.

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Commission for the lead's assigned partner: the sum of their locked
// LISTING_AGENT / CLOSING_AGENT lines (fee x line %, i.e. rate x deal price),
// less TDS, as the partner statement will show. Returns null when there is
// nothing to pay (no assigned partner, no locked lines, price unknown).
async function partnerPayoutFor(lead, lines, feeEntitlement, settings, now = new Date()) {
  if (!lead.assignedPartnerId || !lines.length || feeEntitlement == null) return null;
  const mine = lines.filter((l) => (l.payeeUserId ?? lead.assignedPartnerId) === lead.assignedPartnerId
    && ['LISTING_AGENT', 'CLOSING_AGENT'].includes(l.payeeRole));
  if (!mine.length) return null;
  const commissionPaise = mine.reduce((sum, l) => sum + money.toPaise(round2((feeEntitlement * l.pct) / 100)), 0);
  if (commissionPaise <= 0) return null;

  const partner = await prisma.user.findUnique({
    where: { id: lead.assignedPartnerId },
    select: { id: true, name: true, panNumber: true, gstin: true },
  });
  const { financialYear } = money.financialYearOf(now);
  const earlier = await prisma.tdsEntry.findMany({
    where: { partnerId: lead.assignedPartnerId, financialYear },
    select: { commissionBasePaise: true, taxedBasePaise: true },
  });
  const ytdBasePaise = earlier.reduce((sum, e) => sum + e.commissionBasePaise, 0);
  const taxedBasePaise = earlier.reduce((sum, e) => sum + e.taxedBasePaise, 0);

  const tds = money.computeTds({
    commissionPaise, ytdBasePaise, taxedBasePaise, pan: partner?.panNumber,
    settings: settings.tds,
  });
  const gstRegistered = !!partner?.gstin?.trim();
  const payout = money.partnerPayout({
    commissionPaise, tds, gstRegistered, gstPct: settings.commission.gstPct,
  });
  // A GST-registered partner is paid nothing on a deal until their tax invoice
  // for it has been uploaded and accepted by admin (no override).
  let taxInvoiceStatus = null;
  if (gstRegistered) {
    const inv = await prisma.partnerTaxInvoice.findFirst({
      where: { leadId: lead.id, partnerId: lead.assignedPartnerId, status: { not: 'REJECTED' } }, orderBy: { createdAt: 'desc' },
    });
    taxInvoiceStatus = inv?.status ?? 'NOT_UPLOADED';
  }
  const invoiceOk = !gstRegistered || ['ACCEPTED', 'MATCHED'].includes(taxInvoiceStatus);
  return {
    partnerId: lead.assignedPartnerId,
    partnerName: partner?.name ?? null,
    taxInvoiceStatus,
    payoutBlockedReason: invoiceOk ? null : 'TAX_INVOICE_REQUIRED',
    panOnFile: money.isValidPan(partner?.panNumber),
    gstRegistered,
    financialYear,
    ytdBeforePaise: ytdBasePaise,
    thresholdPaise: settings.tds.thresholdPaise,
    thresholdReached: !!tds.thresholdReached,
    tdsSection: settings.tds.sectionLabel,
    tdsRatePct: tds.ratePct ?? null,
    tdsRateReason: tds.blocked ? 'NO_PAN' : tds.rateReason,
    taxedBasePaise: tds.baseTaxedPaise ?? 0,
    blocked: !!tds.blocked,
    blockReason: tds.blocked ? 'PAN_REQUIRED' : null,
    ...payout,
  };
}

async function getReleasePlan(escrowId) {
  const escrow = await prisma.escrowTransaction.findUnique({ where: { id: escrowId } });
  if (!escrow) throw new ApiError(404, 'Escrow not found');

  const lead = await prisma.lead.findUnique({
    where: { id: escrow.leadId },
    select: {
      id: true, refCode: true, feePct: true, dealPriceAtLock: true,
      commissionLockedAt: true, commissionVersion: true,
      allocationLetterUrl: true, allocationLetterVerifiedAt: true, buyerFeedbackStatus: true, status: true,
      assignedPartnerId: true,
      property: { select: { price: true } },
      assignedPartner: { select: { name: true, ...PAYABLE_PARTNER_SELECT } },
    },
  });
  if (!lead) throw new ApiError(404, 'Lead not found for this escrow');

  const lines = lead.commissionLockedAt
    ? await prisma.leadCommissionLine.findMany({
        where: { leadId: lead.id, version: lead.commissionVersion },
        orderBy: { payeeRole: 'asc' },
      })
    : [];

  // GST and TDS rates now come from the money settings (GST 18, TDS 2 /
  // 20 without PAN, ₹20,000 a year threshold); the old commission_tds_pct
  // key (0) is no longer read. All settings, none hard-coded.
  const settings = await getMoneySettings();
  const gstPct = settings.commission.gstPct;
  const tdsPct = settings.tds.ratePct;
  const platformFeePct = settings.tokenPlatformFeePct;

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
  // The partner's commission comes from the locked lines on the DEAL PRICE,
  // with TDS inside (see partnerPayoutFor), and is not taken from the token.
  const partnerPayout = await partnerPayoutFor(lead, lines, feeEntitlement, settings);
  const partnerShareAmount = partnerPayout ? money.toRupees(partnerPayout.payNowPaise) : 0;
  const headroom = round2(heldAmount - platformFeeAmount);

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
      // BUG-049: on file is not enough; the admin must have marked it verified before the token can be released.
      ok: !!lead.allocationLetterUrl && !!lead.allocationLetterVerifiedAt,
      detail: !lead.allocationLetterUrl ? 'not uploaded' : lead.allocationLetterVerifiedAt ? 'on file and verified' : 'on file, not yet marked verified',
    },
    {
      key: 'BUYER_CONFIRMED', blocking: false,
      ok: ['VERIFIED_CLOSED'].includes(lead.buyerFeedbackStatus),
      detail: `buyer feedback: ${lead.buyerFeedbackStatus || 'none'}`,
    },
    ...(partnerPayout?.gstRegistered ? [{
      // Not overridable: the partner's commission is held, the seller release is not.
      key: 'PARTNER_TAX_INVOICE', blocking: false,
      ok: !partnerPayout.payoutBlockedReason,
      detail: partnerPayout.payoutBlockedReason
        ? `GST-registered partner: tax invoice ${partnerPayout.taxInvoiceStatus.toLowerCase().replace('_', ' ')}. The partner payout is held until an accepted invoice.`
        : `tax invoice ${partnerPayout.taxInvoiceStatus.toLowerCase()}`,
    }] : []),
    {
      key: 'PARTNER_PAYOUT_ACCOUNT', blocking: false,
      ok: !partnerPayoutBlocker(lead.assignedPartner),
      detail: partnerPayoutBlocker(lead.assignedPartner)?.message || 'payout account: ACTIVE',
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
    platformFeePct, partnerSharePct: null,
    partnerPayout,
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
  const { sellerDetails, partnerDetails, payPartner, manualTransferConfirmed, partnerShare: partnerShareOverride, note } = releaseData ?? {};

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

  // platformFee is the token-level fee from settings (0 under money model
  // Rev 3, where Realtydoor's fee is on the seller invoice); no admin input.
  const platformFee = plan.platformFeeAmount;

  // Money model Rev 3: the partner's commission is rate x DEAL PRICE, paid
  // from Realtydoor's account when the token is released, with TDS taken
  // inside the payout. It is not deducted from the token, so the seller gets
  // the token whole (less any token-level platform fee). Leads with no locked
  // commission lines keep the old behaviour: an explicit partnerShare taken
  // out of the token.
  const commissionPayout = plan.partnerPayout;
  const newModel = !!commissionPayout;
  if (newModel && commissionPayout.blocked) {
    throw new ApiError(400,
      'The assigned partner has no valid PAN on file and settings say to block the payout. Add their PAN first.',
      { code: 'PARTNER_PAN_REQUIRED', partnerId: commissionPayout.partnerId });
  }
  if (newModel && partnerShareOverride) {
    logger.warn('[Escrow] partnerShare ignored: commission is computed from the locked lines', { escrowId, partnerShareOverride });
  }
  if (!newModel && partnerDetails && !(partnerShareOverride > 0)) {
    throw new ApiError(400, 'partnerShare is required (and must be positive) when partnerDetails is provided and the lead has no locked commission for the assigned partner', { code: 'PARTNER_SHARE_REQUIRED' });
  }
  // New model pays the partner by default; admin can set payPartner false to
  // pay it later. A GST-registered partner with no accepted tax invoice is NOT
  // paid at all on this deal (the seller release goes ahead; the commission is
  // held, nothing is credited or withheld yet): pay it later with
  // POST /admin/escrow/:id/partner-payout once the invoice is accepted.
  const invoiceBlocked = newModel && commissionPayout.payoutBlockedReason === 'TAX_INVOICE_REQUIRED';
  const wantPartnerPaid = newModel ? (payPartner !== false && !invoiceBlocked) : payPartner === true;
  const partnerDeferred = newModel && !wantPartnerPaid;
  const partnerShare = newModel ? (partnerDeferred ? 0 : money.toRupees(commissionPayout.payNowPaise)) : (partnerShareOverride || 0);

  const heldBack = platformFee + (newModel ? 0 : partnerShare);
  if (heldBack >= escrow.amount) {
    throw new ApiError(400, 'partnerShare + platformFee must be less than the escrow amount');
  }
  const sellerAmount = round2(escrow.amount - heldBack);

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
  if (partnerShare > 0 && !partnerDetails && wantPartnerPaid) {
    const lead = await prisma.lead.findUnique({
      where: { id: escrow.leadId },
      select: { assignedPartnerId: true },
    });
    const partner = lead?.assignedPartnerId
      ? await prisma.user.findUnique({
          where: { id: lead.assignedPartnerId },
          select: PAYABLE_PARTNER_SELECT,
        })
      : null;

    if (!partner?.razorpayFundAccountId) {
      throw new ApiError(400, 'The assigned partner has no payout account yet. Ask them to add one, or pass partnerDetails to pay a different account.', { code: 'PARTNER_PAYOUT_ACCOUNT_MISSING' });
    }
    // The status exists precisely to stop money going to an account that
    // failed its check — falling back to ad-hoc creation here would walk
    // straight around the clarification gate. Audit Nov 2026 (P2): the same
    // gate now also refuses a suspended, deleted or KYC-unverified partner.
    const payBlocker = partnerPayoutBlocker(partner);
    if (payBlocker) throw new ApiError(400, payBlocker.message, { code: payBlocker.code });
    storedPartnerFundAccountId = partner.razorpayFundAccountId;
  }

  // Atomic claim: the write is conditioned on status still being HELD, so of
  // two concurrent release() calls for the same escrow, only one can affect
  // a row — the loser's updateMany affects 0 rows and bails out below,
  // *before* ever calling RazorpayX. Without this, both could pass the
  // findUnique check above and both create a payout, paying the seller twice.
  //
  // H1 fix — netAmount/partnerShareAmount (+ paise/pct) are written HERE,
  // not only in the final post-payout update below. They're fully known
  // before any Razorpay call is made, and BE-2's retryPayout() reads them
  // to know how much to retry with — if release() throws before reaching
  // the final update (any payout failure), those fields were previously
  // never persisted at all, so a retry failed with "No {leg} amount is on
  // file" even though the amount was known the whole time.
  const claim = await prisma.escrowTransaction.updateMany({
    where: { id: escrowId, status: 'HELD' },
    data: {
      status: 'RELEASED', releasedAt: new Date(), releasedByAdminId: adminId,
      netAmount: sellerAmount, netAmountPaise: Math.round(sellerAmount * 100),
      platformFeePaise: Math.round(platformFee * 100), platformFeePct: plan.platformFeePct,
      ...(partnerShare > 0 && { partnerShareAmount: partnerShare, partnerSharePaise: Math.round(partnerShare * 100) }),
      ...(newModel && {
        partnerPaidFromCompany: true,
        ...(partnerDeferred
          ? { partnerPayoutStatus: 'deferred' }
          : {
            partnerGrossPaise: commissionPayout.commissionPaise,
            partnerTdsPaise: commissionPayout.tdsPaise,
            partnerGstPendingPaise: commissionPayout.gstPendingPaise,
          }),
      }),
    },
  });
  if (claim.count === 0) throw new ApiError(400, 'This escrow was already released or refunded');

  // BE-1 — idempotency key now includes the amount and attempt number, not
  // just the escrowId: a retry with the SAME amount/attempt dedupes against
  // RazorpayX (safe no-op), but BE-2's retry route bumping payoutAttempt (or
  // admin passing a different amount) gets a genuinely new key instead of
  // being silently deduped against a failed/different earlier attempt.
  // escrowId (24 hex) + suffix stays well under Razorpay's 40-char
  // reference_id limit. payoutAttempt is read once, before either leg runs,
  // so both legs of the same release() call share one attempt number.
  const attempt = escrow.payoutAttempt || 0;

  let sellerPayoutId = null;
  let sellerPayoutStatusVal = null;
  let partnerPayoutId = null;
  let partnerPayoutStatusVal = null;
  let sellerError = null;
  let partnerError = null;

  // Seller and partner legs are independent recipients, so they run
  // concurrently rather than back-to-back — each leg's fund-account
  // validation (validateFundAccountOrWarn) can add a few seconds of polling,
  // and this admin request shouldn't pay that cost twice when both legs
  // are requested. Each leg persists its own payout id to the DB the moment
  // createPayout resolves, not after both settle, so a leg that already
  // paid out is never lost if the OTHER leg is what fails.
  //
  // H2 fix — Promise.allSettled, not Promise.all. Promise.all rejects (and
  // the surrounding code moves on) the INSTANT the first leg throws, while
  // the other leg can still be in flight — reading sellerPayoutId/
  // partnerPayoutId at that moment could see the in-flight leg as "not
  // paid yet" and revert the escrow to HELD, even though that leg's
  // payout.id write lands moments later onto the now-reverted row. Each
  // leg below catches its own error into sellerError/partnerError instead
  // of letting it propagate, so allSettled always waits for BOTH legs to
  // fully finish before any decision is made.
  const legs = [];
  let sellerPayoutRequested = false; let partnerPayoutRequested = false;
  let sellerUnknown = false; let partnerUnknown = false;
  if (sellerDetails) {
    legs.push((async () => {
      try {
        const contact = await createPayoutContact(sellerDetails.name, sellerDetails.email, sellerDetails.phone);
        const fundAccount = await createPayoutFundAccount(contact.id, sellerDetails.name, sellerDetails.ifsc, sellerDetails.accountNumber);
        await validateFundAccountOrWarn(fundAccount.id, 'seller');
        const sellerAmountPaise = Math.round(sellerAmount * 100);
        sellerPayoutRequested = true;
        const payout = await createPayout(
          fundAccount.id, sellerAmountPaise, `esc_s_${escrowId}_a${attempt}`,
          `seller:${escrowId}:${fundAccount.id}:${sellerAmountPaise}:${attempt}`,
        );
        sellerPayoutId = payout.id;
        sellerPayoutStatusVal = payout.status;
        await prisma.escrowTransaction.update({
          where: { id: escrowId },
          data: { razorpayPayoutId: sellerPayoutId, sellerPayoutStatus: sellerPayoutStatusVal },
        });
      } catch (err) {
        sellerError = err;
        // F1: the create call went out and nobody refused it, so the payout may exist at RazorpayX.
        if (sellerPayoutRequested && !sellerPayoutId && !isClearRefusal(err)) sellerUnknown = true;
      }
    })());
  }
  if (partnerShare > 0 && (partnerDetails || storedPartnerFundAccountId)) {
    legs.push((async () => {
      try {
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
        const partnerSharePaise = Math.round(partnerShare * 100);
        partnerPayoutRequested = true;
        const payout = await createPayout(
          fundAccountId, partnerSharePaise, `esc_p_${escrowId}_a${attempt}`,
          `partner:${escrowId}:${fundAccountId}:${partnerSharePaise}:${attempt}`,
        );
        partnerPayoutId = payout.id;
        partnerPayoutStatusVal = payout.status;
        await prisma.escrowTransaction.update({
          where: { id: escrowId },
          data: { razorpayPartnerPayoutId: partnerPayoutId, partnerPayoutStatus: partnerPayoutStatusVal },
        });
      } catch (err) {
        partnerError = err;
        if (partnerPayoutRequested && !partnerPayoutId && !isClearRefusal(err)) partnerUnknown = true;
      }
    })());
  }
  await Promise.allSettled(legs);

  // TDS is deducted when the commission is credited to the partner, so the
  // TdsEntry, the voucher and the ledger lines are written in the same step as
  // the payout decision, even if a payout leg then fails. Skipped when nothing
  // was paid and the release rolls back to HELD below, and when the partner
  // payout is deferred (it is credited later, by payDeferredPartnerCommission).
  const recordTds = async () => {
    // F20: the seller row is written only for a real RazorpayX payout or a transfer the admin confirmed was made by hand.
    // A seller leg that failed (or whose result is unknown) gets no row here; the retry or the recovery writes it.
    if (sellerPayoutId || (!sellerDetails && manualTransferConfirmed)) {
      await ledger.onSellerPayout(escrow, {
        sellerAmountPaise: Math.round(sellerAmount * 100), payoutId: sellerPayoutId, status: sellerPayoutStatusVal,
        manual: !sellerPayoutId,
      });
    }
    if (!newModel || partnerDeferred) return;
    await recordPartnerCredit(escrow, commissionPayout, { payoutId: partnerPayoutId, payoutStatus: partnerPayoutStatusVal, adminId });
  };
  // The payouts are already created at this point, so a failure while writing the books must never abort the rest
  // of the release (release note, audit, notifications) — that left a RELEASED escrow with payouts out and no TDS or
  // commission records. Remember the failure instead; the admin can re-run it with repairReleaseBookkeeping().
  let bookkeepingError = null;
  const recordBooks = async () => {
    try {
      await recordTds();
    } catch (err) {
      bookkeepingError = err;
      logger.error('[Escrow] Release bookkeeping failed after the payouts were created — needs repair', { escrowId, error: err.message, stack: err.stack });
    }
  };

  if (sellerError || partnerError) {
    // BE-16 — RazorpayX throws a plain {statusCode, error} object (or a bare
    // network Error), never an ApiError — .message is undefined on the
    // former, and re-throwing it as-is would hit errorHandler.js's generic
    // 500 INTERNAL_ERROR path instead of a proper 502 RAZORPAYX_ERROR.
    const err = sellerError || partnerError;
    const providerMessage = razorpayErrorText(err, 'Unknown RazorpayX error');
    // At least one RazorpayX payout failed. Reverting to HELD is only safe
    // when NEITHER leg actually paid out — if one did (sellerPayoutId/
    // partnerPayoutId set, and already persisted above), reverting would
    // let an admin "retry" straight into a second payment via refund(), or
    // re-release looking like nothing happened. HELD_PAYOUT_FAILED instead
    // blocks both and routes to BE-2's payout tools, which already know
    // which leg succeeded.
    const anyLegPaidOut = !!(sellerPayoutId || partnerPayoutId);
    // F1 (audit Nov 2026): a leg whose create call got no clear answer (timeout, dropped connection, 5xx) may exist at
    // RazorpayX. Going back to HELD would let the token be refunded or released again while that payout lands, so it
    // goes to HELD_PAYOUT_FAILED with the leg marked "unconfirmed". The payout tools and the reconcile job look the
    // payout up by its reference id before anything else may happen.
    const anyUnknown = sellerUnknown || partnerUnknown;
    if (anyLegPaidOut || anyUnknown) {
      if (anyLegPaidOut) await recordBooks();
      const failedLeg = sellerError ? 'seller' : 'partner';
      const unknownNote = 'RazorpayX did not answer; the payout may or may not exist. Use "Retry payout" or wait for the automatic check (every 15 minutes): both look it up at RazorpayX first.';
      await prisma.escrowTransaction.update({
        where: { id: escrowId },
        data: {
          status: 'HELD_PAYOUT_FAILED',
          adminNote: anyUnknown
            ? `Payout result unknown (${[sellerUnknown && 'seller', partnerUnknown && 'partner'].filter(Boolean).join(' and ')}): ${providerMessage}. ${unknownNote}`
            : `${failedLeg} payout failed after the other leg already paid out: ${providerMessage}`,
          ...(sellerUnknown ? { sellerPayoutStatus: 'unconfirmed', sellerPayoutFailureReason: unknownNote } : (sellerError && !sellerPayoutId ? { sellerPayoutStatus: 'failed', sellerPayoutFailureReason: razorpayErrorText(sellerError) } : {})),
          ...(partnerUnknown ? { partnerPayoutStatus: 'unconfirmed', partnerPayoutFailureReason: unknownNote } : (partnerError && !partnerPayoutId ? { partnerPayoutStatus: 'failed', partnerPayoutFailureReason: razorpayErrorText(partnerError) } : {})),
        },
      });
    } else {
      await prisma.escrowTransaction.update({
        where: { id: escrowId },
        // Audit Nov 2026 (F12). Back to HELD means the release never happened, so the split saved by the claim goes too.
        data: {
          status: 'HELD', releasedAt: null, releasedByAdminId: null,
          netAmount: null, netAmountPaise: null, platformFeePaise: null, platformFeePct: null,
          partnerShareAmount: null, partnerSharePaise: null,
          partnerPaidFromCompany: null, partnerPayoutStatus: null, partnerGrossPaise: null, partnerTdsPaise: null, partnerGstPendingPaise: null,
        },
      });
    }
    throw new ApiError(502, `RazorpayX error: ${providerMessage}`, { code: 'RAZORPAYX_ERROR' });
  }

  await recordBooks();

  const parts = [];
  if (bookkeepingError) parts.push(`BOOKKEEPING INCOMPLETE (${String(bookkeepingError.message).slice(0, 120)}): payouts were created; run "Repair bookkeeping" on this escrow`);
  if (sellerPayoutId)  parts.push(`Seller payout ${sellerPayoutId}: ₹${sellerAmount.toLocaleString('en-IN')}`);
  if (partnerPayoutId) parts.push(`Partner payout ${partnerPayoutId}: ₹${partnerShare.toLocaleString('en-IN')}`);
  if (partnerDeferred) {
    parts.push(invoiceBlocked
      ? 'Partner payout HELD: GST-registered partner has no accepted tax invoice for this deal'
      : 'Partner payout deferred at admin request');
    // The partner was never told their payout was waiting on their invoice (found on 28 Oct 2026). Fire-and-forget:
    // the release has already happened and must not fail because a message could not be sent.
    if (invoiceBlocked) {
      (async () => {
        const held = await prisma.lead.findUnique({ where: { id: escrow.leadId }, select: { refCode: true, assignedPartnerId: true } });
        if (!held?.assignedPartnerId) return;
        const leadRef = held.refCode || 'your lead';
        await createNotification({
          userId: held.assignedPartnerId, title: 'Upload your tax invoice to get paid',
          message: `${leadRef}: the deal is closed and your commission is waiting for your GST tax invoice. Upload it from Payouts & paperwork.`,
          type: 'TAX_INVOICE_NEEDED', linkUrl: '/partners/finance/payouts',
        });
        notifyUser(held.assignedPartnerId, 'partner_tax_invoice_needed', { partner_name: '$userName', lead_ref: leadRef }, { leadId: escrow.leadId });
        const partnerUser = await prisma.user.findUnique({ where: { id: held.assignedPartnerId }, select: { email: true } });
        if (partnerUser) await sendPartnerTaxInvoiceNeeded(partnerUser.email, { leadRef });
      })().catch((err) => logger.warn('[Escrow] tax-invoice-needed notice failed', { escrowId, error: err.message }));
    }
  } else if (newModel) {
    const c = commissionPayout;
    parts.push(`Partner commission ₹${money.toRupees(c.commissionPaise).toLocaleString('en-IN')} on the deal price, TDS ₹${money.toRupees(c.tdsPaise).toLocaleString('en-IN')} (${c.tdsSection}), net ₹${partnerShare.toLocaleString('en-IN')}${partnerPayoutId ? '' : ' awaiting payout'}${c.gstPendingPaise ? `, GST ₹${money.toRupees(c.gstPendingPaise).toLocaleString('en-IN')} held until the partner's tax invoice is matched` : ''}`);
  } else if (partnerShare > 0 && !partnerPayoutId) parts.push(`Partner share: ₹${partnerShare}`);
  parts.push(`Platform fee (${plan.platformFeePct}% of held amount, calculated): ₹${platformFee}`);
  // Only claim "no RazorpayX payout" when truly neither leg went through it —
  // manualTransferConfirmed covers the seller's share being paid outside
  // Razorpay, but partnerDetails can still trigger a real automated partner
  // payout in the same release, which this note must not contradict.
  if (!sellerDetails && !partnerPayoutId && manualTransferConfirmed) parts.push('Manual transfer — no RazorpayX payout initiated');
  if (note)                  parts.push(note);
  const adminNote = parts.join(' | ') || undefined;

  // netAmount/partnerShareAmount/paise/pct are already persisted by the
  // atomic claim above (H1 fix) — this only needs adminNote. The payout
  // ids were likewise already written per-leg; re-asserting them here is
  // harmless (same values) and keeps this update self-contained.
  const updated = await prisma.escrowTransaction.update({
    where: { id: escrowId },
    data: {
      adminNote,
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
      ...(partnerDeferred && { partnerPayoutDeferred: invoiceBlocked ? 'TAX_INVOICE_REQUIRED' : 'ADMIN' }),
      ...(newModel && !partnerDeferred && {
        partnerCommissionPaise: commissionPayout.commissionPaise, partnerTdsPaise: commissionPayout.tdsPaise,
        tdsRatePct: commissionPayout.tdsRatePct, tdsRateReason: commissionPayout.tdsRateReason,
        gstPendingPaise: commissionPayout.gstPendingPaise,
      }),
      sellerPayoutId, partnerPayoutId,
      manualTransferConfirmed: !!manualTransferConfirmed && !sellerDetails,
      ...(bookkeepingError && { bookkeepingIncomplete: true, bookkeepingError: String(bookkeepingError.message).slice(0, 300) }),
    },
    ipAddress: ip,
  });

  // B34 — neither the buyer nor the partner was told the deal's money had
  // moved. Fire-and-forget: the release is already durable and audited.
  (async () => {
    const lead = await prisma.lead.findUnique({
      where: { id: escrow.leadId },
      select: { refCode: true, assignedPartnerId: true, property: { select: { id: true, title: true, partnerId: true } } },
    });
    const dealLabel = lead?.property?.title || lead?.refCode || 'your deal';
    await createNotification({
      userId: escrow.buyerId,
      title: 'Escrow Released',
      message: `Your token advance for ${dealLabel} has been released to the seller. The deal is complete.`,
      type: 'ESCROW_RELEASED',
      linkUrl: `/user/inquiries/${escrow.leadId}`,
    });
    if (lead?.assignedPartnerId) {
      await createNotification({
        userId: lead.assignedPartnerId,
        title: 'Escrow Released',
        message: `The escrow for ${lead.refCode || dealLabel} has been released by admin.`,
        type: 'ESCROW_RELEASED',
        linkUrl: `/partners/leads/${escrow.leadId}`,
      });
    }
    // The other admins are told too (the one who pressed Release already knows).
    await notifyAdmins({
      title: 'Escrow released',
      message: `₹${Number(sellerAmount || 0).toLocaleString('en-IN')} released to the seller for ${lead?.refCode || dealLabel} (${dealLabel}).`,
      type: 'ESCROW_RELEASED',
      linkUrl: '/admin/escrow',
    });
    // The listing's owner, when that is a different partner, is told the token was released.
    const ownerId = lead?.property?.partnerId;
    if (ownerId && ownerId !== lead?.assignedPartnerId) {
      await createNotification({
        userId: ownerId,
        title: 'Token released on your listing',
        message: `The token advance for ${dealLabel} was released to the seller by admin. The deal is complete.`,
        type: 'ESCROW_RELEASED',
        linkUrl: `/partners/listings/${lead.property.id}`,
      });
    }
  })().catch((err) => logger.warn('[Escrow] Post-release notification failed', { escrowId, error: err.message }));

  return {
    ...updated, bookkeepingIncomplete: !!bookkeepingError, platformFeePct: plan.platformFeePct, platformFeeAmount: platformFee, partnerShareAmount: partnerShare,
    partnerPayoutDeferred: partnerDeferred ? (invoiceBlocked ? 'TAX_INVOICE_REQUIRED' : 'ADMIN') : null,
  };
}

// The partner's commission has been credited: TDS record, voucher (unregistered
// partner) or the link to the accepted tax invoice (registered), and the ledger
// lines. Safe to call twice (TdsEntry is unique on escrowId, the voucher on
// escrowId, ledger rows on their idempotency key).
async function recordPartnerCredit(escrow, c, { payoutId, payoutStatus, adminId }) {
  const deductedAt = new Date();
  const { financialYear, quarter } = money.financialYearOf(deductedAt);
  const partner = await prisma.user.findUnique({ where: { id: c.partnerId }, select: { panNumber: true, name: true } });
  // TdsEntry is append-only (the Prisma guard refuses upsert/update/delete), so "once per escrow" is a lookup and,
  // only if missing, a create. A second call, or a race on the unique escrowId, returns the existing row.
  const tdsData = {
    partnerId: c.partnerId, escrowId: escrow.id, leadId: escrow.leadId, financialYear, quarter,
    panAtDeduction: c.panOnFile ? partner.panNumber.trim().toUpperCase() : null,
    section: c.tdsSection, ratePct: c.tdsRatePct ?? 0, rateReason: c.tdsPaise > 0 ? c.tdsRateReason : 'BELOW_THRESHOLD',
    commissionBasePaise: c.commissionPaise, ytdBeforePaise: c.ytdBeforePaise, thresholdPaise: c.thresholdPaise,
    thresholdReached: c.thresholdReached, taxedBasePaise: c.taxedBasePaise, tdsPaise: c.tdsPaise,
    netPaise: c.commissionPaise - c.tdsPaise, deductedAt,
    depositDueDate: c.tdsPaise > 0 ? money.tdsDepositDueDate(deductedAt) : null,
  };
  let tdsEntry = await prisma.tdsEntry.findUnique({ where: { escrowId: escrow.id } });
  if (!tdsEntry) {
    try {
      tdsEntry = await prisma.tdsEntry.create({ data: tdsData });
    } catch (err) {
      if (err?.code !== 'P2002') throw err;
      tdsEntry = await prisma.tdsEntry.findUnique({ where: { escrowId: escrow.id } });
    }
  }
  let voucher = null; let invoice = null;
  try {
    if (c.gstRegistered) invoice = await partnerTax.getAcceptedInvoice(escrow.leadId, c.partnerId);
    else voucher = await partnerTax.createVoucher(escrow, c, { tdsRatePct: c.tdsRatePct, tdsSection: c.tdsSection, payoutId });
  } catch (err) {
    logger.error('[Escrow] could not create the commission voucher', { escrowId: escrow.id, error: err.message });
  }
  await ledger.onPartnerCredit(escrow, c, {
    tdsEntryId: tdsEntry.id, voucherId: voucher?.id, taxInvoiceId: invoice?.id, invoiceNumber: invoice?.invoiceNumber,
    payoutId, payoutStatus, partnerName: partner?.name,
  });
  await createAuditLog({
    adminId, actorRole: adminId ? 'ADMIN' : 'SYSTEM', action: 'PARTNER_COMMISSION_CREDITED', targetType: 'EscrowTransaction', targetId: escrow.id,
    after: {
      partnerId: c.partnerId, commissionPaise: c.commissionPaise, tdsPaise: c.tdsPaise, tdsRatePct: c.tdsRatePct, tdsRateReason: c.tdsRateReason,
      netPaise: c.commissionPaise - c.tdsPaise, gstPendingPaise: c.gstPendingPaise, payoutId: payoutId || null,
      document: c.gstRegistered ? { type: 'TAX_INVOICE', id: invoice?.id ?? null } : { type: 'COMMISSION_VOUCHER', id: voucher?.id ?? null },
    },
  }).catch((e) => logger.warn('[Escrow] audit of commission credit failed', { error: e.message }));
  if (voucher) {
    createNotification({
      userId: c.partnerId, title: 'Commission voucher ready',
      message: `Voucher ${voucher.voucherNumber} for your commission is ready. Accept it with the code sent to your phone.`,
      type: 'COMMISSION_VOUCHER_READY', linkUrl: '/partners/finance',
    }).catch(() => {});
  }
  return { tdsEntry, voucher, invoice };
}

// Pays a partner commission that release() held back: a GST-registered partner
// whose tax invoice has since been accepted, or a payout admin deferred.
async function payDeferredPartnerCommission(escrowId, adminId, ip) {
  const escrow = await prisma.escrowTransaction.findUnique({ where: { id: escrowId } });
  if (!escrow) throw new ApiError(404, 'Escrow not found');
  // 'unconfirmed' = an earlier attempt here got no answer from RazorpayX (F1); it is looked up before anything is created.
  if (escrow.status !== 'RELEASED' || !['deferred', 'unconfirmed'].includes(escrow.partnerPayoutStatus) || escrow.razorpayPartnerPayoutId) {
    throw new ApiError(409, 'There is no held partner payout on this escrow', { code: 'NO_DEFERRED_PAYOUT' });
  }
  const lead = await prisma.lead.findUnique({
    where: { id: escrow.leadId },
    select: { id: true, feePct: true, dealPriceAtLock: true, commissionLockedAt: true, commissionVersion: true, assignedPartnerId: true, property: { select: { price: true } } },
  });
  const settings = await getMoneySettings();
  const lines = await prisma.leadCommissionLine.findMany({ where: { leadId: lead.id, version: lead.commissionVersion } });
  const price = lead.dealPriceAtLock ?? lead.property?.price ?? null;
  const fee = price && lead.feePct ? round2((price * lead.feePct) / 100) : null;
  const c = await partnerPayoutFor(lead, lines, fee, settings);
  if (!c) throw new ApiError(400, 'No commission is owed to the assigned partner on this deal');
  if (c.blocked) throw new ApiError(400, 'The partner has no valid PAN on file and settings say to block the payout.', { code: 'PARTNER_PAN_REQUIRED' });
  if (c.payoutBlockedReason) {
    throw new ApiError(409, `No payout yet: this partner is GST-registered and the tax invoice is ${c.taxInvoiceStatus.toLowerCase().replace('_', ' ')}. Payout needs an uploaded and accepted tax invoice.`,
      { code: 'TAX_INVOICE_REQUIRED', taxInvoiceStatus: c.taxInvoiceStatus });
  }
  const partner = await prisma.user.findUnique({ where: { id: c.partnerId }, select: PAYABLE_PARTNER_SELECT });
  const payBlocker = partnerPayoutBlocker(partner);
  if (payBlocker) throw new ApiError(400, payBlocker.message, { code: payBlocker.code });

  const claim = await prisma.escrowTransaction.updateMany({ where: { id: escrowId, partnerPayoutStatus: escrow.partnerPayoutStatus }, data: { partnerPayoutStatus: 'claiming' } });
  if (claim.count === 0) throw new ApiError(409, 'This payout is already being processed');
  const netPaise = c.payNowPaise;
  const attempt = escrow.payoutAttempt || 0;
  const referenceId = `esc_p_${escrowId}_a${attempt}`;
  let payout = null;
  if (escrow.partnerPayoutStatus === 'unconfirmed') {
    try {
      payout = await findPayoutByReference(referenceId);
    } catch (err) {
      await prisma.escrowTransaction.update({ where: { id: escrowId }, data: { partnerPayoutStatus: 'unconfirmed' } });
      throw new ApiError(502, 'Could not reach RazorpayX to check whether the earlier payout exists. Nothing was paid now; try again in a few minutes.', { code: 'RAZORPAYX_ERROR' });
    }
    // A payout that exists but failed is not reused: a new one is created below (same idempotency key, so RazorpayX
    // itself still refuses a second live payout for this attempt).
    if (payout && ['failed', 'rejected', 'reversed', 'cancelled'].includes(payout.status)) payout = null;
  }
  if (!payout) {
    try {
      payout = await createPayout(partner.razorpayFundAccountId, netPaise, referenceId, `partner:${escrowId}:${partner.razorpayFundAccountId}:${netPaise}:${attempt}`);
    } catch (err) {
      // A clear refusal: nothing was created, back to "deferred". Anything else: we do not know, so it stays blocked as
      // "unconfirmed" and the next attempt looks it up first.
      const refused = isClearRefusal(err);
      await prisma.escrowTransaction.update({
        where: { id: escrowId },
        data: refused
          ? { partnerPayoutStatus: 'deferred' }
          : { partnerPayoutStatus: 'unconfirmed', partnerPayoutFailureReason: 'RazorpayX did not answer; the payout may or may not exist. "Pay partner" looks it up first.' },
      });
      throw new ApiError(502, `RazorpayX error: ${razorpayErrorText(err)}`, { code: refused ? 'RAZORPAYX_ERROR' : 'PAYOUT_UNCONFIRMED' });
    }
  }
  const updated = await prisma.escrowTransaction.update({
    where: { id: escrowId },
    data: {
      razorpayPartnerPayoutId: payout.id, partnerPayoutStatus: payout.status,
      partnerShareAmount: money.toRupees(netPaise), partnerSharePaise: netPaise,
      partnerGrossPaise: c.commissionPaise, partnerTdsPaise: c.tdsPaise, partnerGstPendingPaise: c.gstPendingPaise,
    },
  });
  await recordPartnerCredit(updated, c, { payoutId: payout.id, payoutStatus: payout.status, adminId });
  // A payout found again by its reference id can already be processed; its webhook came and went, so settle it here.
  if (payout.status === 'processed') await ledger.onPayoutStatus({ escrowId, payoutId: payout.id, status: 'processed', utr: payout.utr });
  await createAuditLog({
    adminId, actorRole: 'ADMIN', action: 'PARTNER_PAYOUT_RELEASED', targetType: 'EscrowTransaction', targetId: escrowId,
    after: { payoutId: payout.id, netPaise, commissionPaise: c.commissionPaise, tdsPaise: c.tdsPaise, taxInvoiceStatus: c.taxInvoiceStatus }, ipAddress: ip,
  });
  return updated;
}

// Money model Rev 3 refund rules (moneyModel.refundQuote):
//   BUYER_CANCEL within the free window  -> the token, processing fee kept
//   BUYER_CANCEL after it, letter not verified -> token minus the cancellation charge
//   BUYER_CANCEL after the allocation letter -> not refundable here (dispute route)
//   SELLER_BACKOUT / LISTING_WRONG / OUR_FAULT -> token + processing fee, no charge
//   ADMIN_TOKEN_ONLY (default for the admin button, as before) -> the token
// opts.reason picks the rule; opts.dryRun returns the quote without moving money.
async function refund(escrowId, adminId, ip, opts = {}) {
  const reason = opts.reason ?? 'ADMIN_TOKEN_ONLY';
  const escrow = await prisma.escrowTransaction.findUnique({ where: { id: escrowId } });
  if (!escrow) throw new ApiError(404, 'Escrow not found');
  if (escrow.status !== 'HELD') throw new ApiError(400, `Cannot refund escrow with status ${escrow.status}`);
  if (!escrow.razorpayPaymentId) throw new ApiError(400, 'Payment not yet captured');
  // BE-1 — a HELD escrow with a payout already on file means a previous
  // release() left money already paid out to the seller/partner (status was
  // rolled back to HELD only because no leg had a payout yet — see
  // release()'s catch block). Refunding the buyer on top of that is a
  // double payment; this can only be untangled through BE-2's payout
  // routes (retry/resolve/refund-remaining), never through a plain refund.
  if (escrow.razorpayPayoutId || escrow.razorpayPartnerPayoutId) {
    throw new ApiError(409, 'This escrow already has a payout on file — use the payout retry/resolve/refund-remaining actions instead.', { code: 'ESCROW_HAS_PAYOUTS' });
  }

  const [settings, lead] = await Promise.all([
    getMoneySettings(),
    prisma.lead.findUnique({ where: { id: escrow.leadId }, select: { allocationLetterUrl: true, allocationLetterVerifiedAt: true } }),
  ]);
  const quote = money.refundQuote({
    reason,
    tokenPaise: Math.round(escrow.amount * 100),
    feePaise: escrow.processingFeePaise ?? 0,
    paidAt: escrow.heldAt,
    now: opts.now ?? new Date(),
    letterVerified: !!lead?.allocationLetterVerifiedAt,
    settings: settings.refund,
  });
  if (opts.dryRun) return quote;
  if (!quote.refundable) {
    throw new ApiError(409,
      'The allocation letter has been verified, so this token can no longer be refunded here. Raise a dispute instead.',
      { code: 'NOT_REFUNDABLE_AFTER_VERIFICATION' });
  }

  // Audit Nov 2026 (F22). A refund of nothing (the cancellation charge eats the whole token) is never sent to Razorpay.
  if (!(quote.refundPaise > 0)) {
    throw new ApiError(409, 'There is nothing to refund on this token after the cancellation charge. Decide the next step (release or dispute) in Escrow.', { code: 'NOTHING_TO_REFUND' });
  }

  // Same atomic-claim pattern as release() — see comment there.
  const claim = await prisma.escrowTransaction.updateMany({
    where: { id: escrowId, status: 'HELD' },
    data: { status: 'REFUNDED', refundedAt: new Date() },
  });
  if (claim.count === 0) throw new ApiError(400, 'This escrow was already released or refunded');

  const amountInPaise = quote.refundPaise;
  let refundResult;
  try {
    refundResult = await refundPayment(escrow.razorpayPaymentId, amountInPaise);
  } catch (err) {
    await prisma.escrowTransaction.update({
      where: { id: escrowId },
      data: { status: 'HELD', refundedAt: null },
    });
    // BE-16 — Razorpay throws a plain {statusCode, error} object, not an ApiError.
    // The friendly text can be a bare "invalid request sent"; Razorpay's own code, description, field and reason are logged and kept in the
    // audit trail for whoever debugs it. A buyer's cancel and the automatic refund job have no admin on screen, so admins are told.
    const actorRole = opts.actorType === 'BUYER' ? 'USER' : (opts.actorType || 'ADMIN');
    await recordRefundFailure({ escrowId, actorId: adminId, actorRole, ip, amountPaise: amountInPaise, paymentId: escrow.razorpayPaymentId, route: 'refund', err });
    throw refundFailure(err, { forBuyer: actorRole === 'USER' });
  }

  // M1 fix — refundedAmountPaise/refundIds must be set here, not left for
  // the refund.created webhook to fill in. Without this, the webhook (for
  // this SAME refund — refundResult.id) found the escrow already REFUNDED
  // with no matching refundId on file, read it as an unexpected refund on
  // a non-held escrow, and broadcast a false "needs manual review" alarm
  // to every admin on every single ordinary refund. Pushing refundResult.id
  // into refundIds here means the webhook's own dedup check
  // (!escrow.refundIds.includes(refundId)) now recognizes it immediately
  // and skips reprocessing entirely — never reaching that branch at all.
  const updated = await prisma.escrowTransaction.update({
    where: { id: escrowId },
    data: {
      razorpayRefundId: refundResult.id,
      refundedAmountPaise: amountInPaise,
      refundIds: { push: refundResult.id },
      refundReason: reason,
      cancellationChargePaise: quote.cancellationChargePaise || null,
    },
  });

  const actor = { createdByType: opts.actorType || 'ADMIN', createdById: adminId || null };
  await ledger.onRefund(escrow, quote, { refundId: refundResult.id, actor });
  await createAuditLog({
    adminId, actorRole: opts.actorType === 'BUYER' ? 'USER' : (opts.actorType || 'ADMIN'),
    action: 'ESCROW_REFUNDED', targetType: 'EscrowTransaction', targetId: escrowId,
    reason: opts.autoReason || null,
    after: {
      status: 'REFUNDED', reason, stage: quote.stage,
      refundPaise: amountInPaise, feeReturned: quote.feeReturned,
      cancellationChargePaise: quote.cancellationChargePaise,
    },
    ipAddress: ip,
  });

  // Fire-and-forget, same reasoning as confirmPayment(): this is reached from
  // the buyer-facing cancelLead flow too, and the refund itself (Razorpay API
  // call + DB write above) already succeeded — a notification/email hiccup
  // here must not surface as a failed refund.
  (async () => {
    const refundRupees = money.toRupees(amountInPaise);
    const inr = (n) => `₹${n.toLocaleString('en-IN')}`;
    const chargeRupees = quote.cancellationChargePaise ? money.toRupees(quote.cancellationChargePaise) : 0;
    const feeNote = quote.feeReturned ? ' The processing fee is returned too.' : ' The processing fee is not returned.';
    await createNotification({
      userId: escrow.buyerId,
      title: 'Escrow Refunded',
      message: chargeRupees
        ? `${inr(refundRupees)} of your token advance is being refunded to your original payment method. A cancellation charge of ${inr(chargeRupees)} was kept, as shown at checkout.${feeNote}`
        : `${inr(refundRupees)} of your token advance has been refunded to your original payment method.${feeNote}`,
      type: 'ESCROW_REFUNDED',
    });
    // The assigned partner and the admins are told too (found on 25 Oct 2026: they saw nothing when a buyer cancelled).
    const refundedLead = await prisma.lead.findUnique({ where: { id: escrow.leadId }, select: { refCode: true, assignedPartnerId: true, property: { select: { title: true } } } });
    const leadRef = refundedLead?.refCode || 'a lead';
    const who = opts.actorType === 'BUYER' ? 'The buyer cancelled and' : 'The token was refunded:';
    const detail = `${inr(refundRupees)} was refunded${chargeRupees ? `, ${inr(chargeRupees)} cancellation charge kept` : ''}.`;
    if (refundedLead?.assignedPartnerId) {
      await createNotification({
        userId: refundedLead.assignedPartnerId,
        title: opts.actorType === 'BUYER' ? 'Buyer cancelled and was refunded' : 'Token refunded',
        message: `${leadRef}: ${who} ${detail}`,
        type: 'ESCROW_REFUNDED',
        linkUrl: `/partners/leads/${escrow.leadId}`,
      });
      if (opts.actorType === 'BUYER') {
        notifyUser(refundedLead.assignedPartnerId, 'partner_buyer_cancelled', {
          partner_name: '$userName', lead_ref: leadRef, property_title: refundedLead?.property?.title || 'the property',
        }, { leadId: escrow.leadId });
      }
    }
    notifyUser(escrow.buyerId, 'escrow_refunded', {
      name: '$userName', amount: refundRupees.toLocaleString('en-IN'), charge: chargeRupees.toLocaleString('en-IN'),
      property_title: refundedLead?.property?.title || 'your property',
    }, { leadId: escrow.leadId });
    await notifyAdmins({
      title: opts.actorType === 'BUYER' ? 'Buyer cancelled and was refunded' : 'Token refunded',
      message: `${leadRef}${refundedLead?.property?.title ? ` (${refundedLead.property.title})` : ''}: ${who} ${detail}`,
      type: 'ESCROW_REFUNDED',
      linkUrl: '/admin/escrow',
    });
    const buyer = await prisma.user.findUnique({ where: { id: escrow.buyerId }, select: { email: true } });
    if (buyer) await sendEscrowRefunded(buyer.email, refundRupees, { chargeRupees, feeReturned: !!quote.feeReturned, propertyTitle: refundedLead?.property?.title });
  })().catch((err) => logger.warn('[Escrow] Post-refund notification/email failed', { escrowId: updated.id, error: err.message }));

  return { ...updated, refundQuote: quote };
}

// Admin refund of an amount the admin picks ("Other amount"), for a part payment already made outside the standard rules
// or the rest of a PARTIALLY_REFUNDED escrow. Repeatable until the token is fully refunded; capped at the token still
// refundable (the processing fee is not returned here; the fee-returning cases are the standard reasons in refund()).
// The amount is reserved on the escrow BEFORE Razorpay is called (optimistic claim on the running total), so two admins
// pressing at once cannot refund more than is left; a Razorpay failure puts the escrow back exactly as it was.
async function refundPartial(escrowId, adminId, ip, { amountPaise, reason } = {}) {
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) throw new ApiError(400, 'Enter a refund amount greater than zero (whole paise).', { code: 'INVALID_AMOUNT' });
  const note = typeof reason === 'string' ? reason.trim() : '';
  if (note.length < 5 || note.length > 500) throw new ApiError(400, 'A reason of 5 to 500 characters is required.', { code: 'REASON_REQUIRED' });

  const escrow = await prisma.escrowTransaction.findUnique({ where: { id: escrowId } });
  if (!escrow) throw new ApiError(404, 'Escrow not found');
  if (!['HELD', 'PARTIALLY_REFUNDED'].includes(escrow.status)) throw new ApiError(400, `Cannot refund escrow with status ${escrow.status}`);
  if (!escrow.razorpayPaymentId) throw new ApiError(400, 'Payment not yet captured');
  if (escrow.razorpayPayoutId || escrow.razorpayPartnerPayoutId) {
    throw new ApiError(409, 'This escrow already has a payout on file — use the payout retry/resolve/refund-remaining actions instead.', { code: 'ESCROW_HAS_PAYOUTS' });
  }

  const tokenPaise = Math.round(escrow.amount * 100);
  const alreadyPaise = escrow.refundedAmountPaise || 0;
  const remainingPaise = tokenPaise - alreadyPaise;
  if (remainingPaise <= 0) throw new ApiError(400, 'The whole token has already been refunded.');
  if (amountPaise > remainingPaise) {
    throw new ApiError(400, `Only ₹${money.toRupees(remainingPaise).toLocaleString('en-IN')} is still refundable on this escrow.`, { code: 'AMOUNT_TOO_HIGH', remainingPaise });
  }

  const lead = await prisma.lead.findUnique({ where: { id: escrow.leadId }, select: { allocationLetterVerifiedAt: true } });
  if (lead?.allocationLetterVerifiedAt) {
    throw new ApiError(409, 'The allocation letter has been verified, so this token can no longer be refunded here. Raise a dispute instead.', { code: 'NOT_REFUNDABLE_AFTER_VERIFICATION' });
  }

  const totalPaise = alreadyPaise + amountPaise;
  const complete = totalPaise >= tokenPaise;
  const newStatus = complete ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
  const sameTotal = alreadyPaise === 0 ? { OR: [{ refundedAmountPaise: 0 }, { refundedAmountPaise: null }] } : { refundedAmountPaise: alreadyPaise };
  const claim = await prisma.escrowTransaction.updateMany({
    where: { id: escrowId, status: escrow.status, ...sameTotal },
    data: { status: newStatus, refundedAmountPaise: totalPaise, ...(complete ? { refundedAt: new Date() } : {}) },
  });
  if (claim.count === 0) throw new ApiError(409, 'This escrow was just changed by someone else. Reload and check it before refunding again.', { code: 'ESCROW_CHANGED' });

  let refundResult;
  try {
    refundResult = await refundPayment(escrow.razorpayPaymentId, amountPaise);
  } catch (err) {
    await prisma.escrowTransaction.updateMany({
      where: { id: escrowId, refundedAmountPaise: totalPaise },
      data: { status: escrow.status, refundedAmountPaise: alreadyPaise, refundedAt: null },
    });
    await recordRefundFailure({ escrowId, actorId: adminId, actorRole: 'ADMIN', ip, amountPaise, paymentId: escrow.razorpayPaymentId, route: 'refund-partial', err });
    throw refundFailure(err);
  }

  // Record the refund id so the refund.created webhook skips it. If the webhook already counted this refund (it beat us
  // here), our reservation made the total double, so set the total straight instead of pushing the id twice.
  const marked = await prisma.escrowTransaction.updateMany({
    where: { id: escrowId, NOT: { refundIds: { has: refundResult.id } } },
    data: { razorpayRefundId: refundResult.id, refundIds: { push: refundResult.id }, refundReason: 'ADMIN_PARTIAL' },
  });
  if (marked.count === 0) {
    await prisma.escrowTransaction.update({
      where: { id: escrowId },
      data: { refundedAmountPaise: totalPaise, status: newStatus, refundReason: 'ADMIN_PARTIAL', ...(complete ? { refundedAt: new Date() } : {}) },
    });
  }

  const quote = { refundPaise: amountPaise, reason: 'ADMIN_PARTIAL', feeReturned: false, cancellationChargePaise: 0, stage: 'ADMIN_PARTIAL' };
  await ledger.onRefund(escrow, quote, { refundId: refundResult.id, actor: { createdByType: 'ADMIN', createdById: adminId || null } });
  await createAuditLog({
    adminId, actorRole: 'ADMIN', action: 'ESCROW_REFUNDED', targetType: 'EscrowTransaction', targetId: escrowId,
    reason: note,
    after: { status: newStatus, reason: 'ADMIN_PARTIAL', refundPaise: amountPaise, totalRefundedPaise: totalPaise, remainingPaise: tokenPaise - totalPaise },
    ipAddress: ip,
  });

  (async () => {
    const refundRupees = money.toRupees(amountPaise);
    const inr = (n) => `₹${n.toLocaleString('en-IN')}`;
    const refundedLead = await prisma.lead.findUnique({ where: { id: escrow.leadId }, select: { refCode: true, property: { select: { title: true } } } });
    const leadRef = refundedLead?.refCode || 'a lead';
    await createNotification({
      userId: escrow.buyerId,
      title: complete ? 'Token Advance Refunded' : 'Partial Refund Issued',
      message: `${inr(refundRupees)} of your token advance has been refunded to your original payment method.${complete ? '' : ' The rest stays held until your deal is settled.'}`,
      type: 'ESCROW_REFUNDED',
    });
    notifyUser(escrow.buyerId, 'escrow_refunded', {
      name: '$userName', amount: refundRupees.toLocaleString('en-IN'), charge: '0', property_title: refundedLead?.property?.title || 'your property',
    }, { leadId: escrow.leadId });
    await notifyAdmins({
      title: 'Partial token refund',
      message: `${leadRef}: ${inr(refundRupees)} refunded (${inr(money.toRupees(totalPaise))} of ${inr(money.toRupees(tokenPaise))} so far). Reason: ${note}`,
      type: 'ESCROW_REFUNDED',
      linkUrl: '/admin/escrow',
    });
  })().catch((err) => logger.warn('[Escrow] Post-partial-refund notification failed', { escrowId, error: err.message }));

  return prisma.escrowTransaction.findUnique({ where: { id: escrowId } }).then((e) => e || { id: escrowId, status: newStatus, refundedAmountPaise: totalPaise });
}

async function getAllEscrow(filters, skip, limit) {
  const where = {};
  // BE-11 — status is now pre-validated (and comma-split into an array) by
  // the controller; a single value still works the same, multiple values
  // map to Prisma's `{ in: [...] }`.
  if (filters.status?.length) {
    where.status = filters.status.length === 1 ? filters.status[0] : { in: filters.status };
  }
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
  // BE-6 — razorpayRefundId is already a plain scalar on every row (no select
  // restricting it above); refundedAmount is the one derived rupee figure the
  // admin page needs on top of that, from the new refundedAmountPaise column.
  return { data: data.map((e) => ({ ...e, refundedAmount: round2((e.refundedAmountPaise || 0) / 100) })), total };
}

// Real DB-side aggregates over the full table — the admin Escrow page's stat
// cards and Platform Analytics' "Escrow GMV" previously sampled up to 50 rows
// per status with no aggregate query at all (FRONTEND_HANDOFF_SPEC.md §11.1).
// Audit Nov 2026 (F14). What was really sent back (the refunded paise), not the token amount: a refund after the free window keeps
// the cancellation charge, so the token overstates it. Rows written before refundedAmountPaise existed fall back to the token amount.
const refundedRupees = (agg) => (agg._sum.refundedAmountPaise ? agg._sum.refundedAmountPaise / 100 : (agg._sum.amount || 0));

async function getEscrowStats() {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [holdingRows, refundedAgg, releasedThisMonthAgg, releasedForAvg, payoutFailedCount, refundedThisMonthAgg, releasedThisMonthCount] = await Promise.all([
    // HELD_PAYOUT_FAILED money hasn't left the account either — it's still
    // "held", just stuck on a failed payout attempt — so it's counted here
    // too rather than disappearing from this total; payoutFailedCount below
    // is what actually surfaces that it needs attention.
    // 7 Nov 2026: frozen and part-refunded tokens hold money too, and a part-refunded one holds only what is left (see lib/escrowTotals).
    // Few rows are ever in these states at once, so they are read and added up in code rather than in the database.
    prisma.escrowTransaction.findMany({ where: { status: { in: escrowTotals.HOLDING_STATUSES } }, select: { status: true, amount: true, refundedAmountPaise: true } }),
    prisma.escrowTransaction.aggregate({ where: { status: 'REFUNDED' }, _sum: { amount: true, refundedAmountPaise: true } }),
    prisma.escrowTransaction.aggregate({
      where: { status: 'RELEASED', releasedAt: { gte: startOfMonth } },
      _sum: { amount: true },
    }),
    // Audit Nov 2026 (F14). The average hold is over the 500 most recent releases, not every release ever made.
    prisma.escrowTransaction.findMany({
      where: { status: 'RELEASED', releasedAt: { not: null } },
      orderBy: { releasedAt: 'desc' },
      take: 500,
      select: { createdAt: true, releasedAt: true },
    }),
    prisma.escrowTransaction.count({ where: { status: 'HELD_PAYOUT_FAILED' } }),
    // MTD splits + counts (admin docs 1.3 / partner B5.6 — the finance cards
    // show "held total and count", "released this month and count").
    prisma.escrowTransaction.aggregate({
      where: { status: 'REFUNDED', refundedAt: { gte: startOfMonth } },
      _sum: { amount: true, refundedAmountPaise: true },
    }),
    prisma.escrowTransaction.count({ where: { status: 'RELEASED', releasedAt: { gte: startOfMonth } } }),
  ]);

  const avgHoldDays = releasedForAvg.length
    ? releasedForAvg.reduce((sum, t) => sum + (t.releasedAt - t.createdAt) / 86_400_000, 0) / releasedForAvg.length
    : 0;

  return {
    heldSum: escrowTotals.sumHeld(holdingRows),
    refundedSum: Math.round((refundedRupees(refundedAgg) + escrowTotals.sumRefunded(holdingRows)) * 100) / 100,
    releasedSumThisMonth: releasedThisMonthAgg._sum.amount || 0,
    refundedSumThisMonth: refundedRupees(refundedThisMonthAgg),
    heldCount: holdingRows.length,
    releasedCountThisMonth: releasedThisMonthCount,
    avgHoldDays: Math.round(avgHoldDays * 10) / 10,
    payoutFailedCount,
  };
}

// Manual refund (7 Nov 2026). When Razorpay cannot pay a refund (payments balance too low) the admin pays the buyer by bank transfer and records
// it here with the bank reference and a reason. Razorpay is never called. The same status, cap, payout and verification rules apply, so the token
// can never be refunded twice (a later Razorpay refund is held to what is still refundable). One admin is enough; the reason and reference are
// stored in the audit log and the ledger, and the buyer is told in-app only (the WhatsApp text says "original payment method", which is wrong here).
async function refundManually(escrowId, adminId, ip, { amountPaise, reference, reason } = {}) {
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) throw new ApiError(400, 'Enter a refund amount greater than zero (whole paise).', { code: 'INVALID_AMOUNT' });
  const ref = typeof reference === 'string' ? reference.trim() : '';
  if (ref.length < 4 || ref.length > 100) throw new ApiError(400, 'The bank reference (UTR or transaction id) of 4 to 100 characters is required.', { code: 'REFERENCE_REQUIRED' });
  const note = typeof reason === 'string' ? reason.trim() : '';
  if (note.length < 5 || note.length > 500) throw new ApiError(400, 'A reason of 5 to 500 characters is required.', { code: 'REASON_REQUIRED' });

  const escrow = await prisma.escrowTransaction.findUnique({ where: { id: escrowId } });
  if (!escrow) throw new ApiError(404, 'Escrow not found');
  if (!['HELD', 'PARTIALLY_REFUNDED'].includes(escrow.status)) throw new ApiError(400, `Cannot refund escrow with status ${escrow.status}`);
  if (escrow.razorpayPayoutId || escrow.razorpayPartnerPayoutId) {
    throw new ApiError(409, 'This escrow already has a payout on file — use the payout retry/resolve/refund-remaining actions instead.', { code: 'ESCROW_HAS_PAYOUTS' });
  }

  const tokenPaise = Math.round(escrow.amount * 100);
  const alreadyPaise = escrow.refundedAmountPaise || 0;
  const remainingPaise = tokenPaise - alreadyPaise;
  if (remainingPaise <= 0) throw new ApiError(400, 'The whole token has already been refunded.');
  if (amountPaise > remainingPaise) {
    throw new ApiError(400, `Only ₹${money.toRupees(remainingPaise).toLocaleString('en-IN')} is still refundable on this escrow.`, { code: 'AMOUNT_TOO_HIGH', remainingPaise });
  }

  const lead = await prisma.lead.findUnique({ where: { id: escrow.leadId }, select: { allocationLetterVerifiedAt: true } });
  if (lead?.allocationLetterVerifiedAt) {
    throw new ApiError(409, 'The allocation letter has been verified, so this token can no longer be refunded here. Raise a dispute instead.', { code: 'NOT_REFUNDABLE_AFTER_VERIFICATION' });
  }

  const totalPaise = alreadyPaise + amountPaise;
  const complete = totalPaise >= tokenPaise;
  const newStatus = complete ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
  const manualId = `manual:${totalPaise}:${ref}`;
  const sameTotal = alreadyPaise === 0 ? { OR: [{ refundedAmountPaise: 0 }, { refundedAmountPaise: null }] } : { refundedAmountPaise: alreadyPaise };
  const claim = await prisma.escrowTransaction.updateMany({
    where: { id: escrowId, status: escrow.status, ...sameTotal },
    data: { status: newStatus, refundedAmountPaise: totalPaise, refundReason: 'ADMIN_MANUAL', refundIds: { push: manualId }, ...(complete ? { refundedAt: new Date() } : {}) },
  });
  if (claim.count === 0) throw new ApiError(409, 'This escrow was just changed by someone else. Reload and check it before refunding again.', { code: 'ESCROW_CHANGED' });

  const quote = { refundPaise: amountPaise, reason: 'ADMIN_MANUAL', feeReturned: false, cancellationChargePaise: 0, stage: 'ADMIN_MANUAL' };
  await ledger.onRefund(escrow, quote, { refundId: manualId, actor: { createdByType: 'ADMIN', createdById: adminId || null } });
  await createAuditLog({
    adminId, actorRole: 'ADMIN', action: 'ESCROW_REFUNDED_MANUALLY', targetType: 'EscrowTransaction', targetId: escrowId,
    reason: note,
    after: { status: newStatus, reason: 'ADMIN_MANUAL', reference: ref, refundPaise: amountPaise, totalRefundedPaise: totalPaise, remainingPaise: tokenPaise - totalPaise },
    ipAddress: ip,
  });

  (async () => {
    const refundRupees = money.toRupees(amountPaise);
    const inr = (n) => `₹${n.toLocaleString('en-IN')}`;
    const refundedLead = await prisma.lead.findUnique({ where: { id: escrow.leadId }, select: { refCode: true } });
    await createNotification({
      userId: escrow.buyerId,
      title: complete ? 'Token Advance Refunded' : 'Partial Refund Issued',
      message: `${inr(refundRupees)} of your token advance has been sent to your bank account by transfer. Reference: ${ref}.${complete ? '' : ' The rest stays held until your deal is settled.'}`,
      type: 'ESCROW_REFUNDED',
    });
    await notifyAdmins({
      title: 'Token refunded manually',
      message: `${refundedLead?.refCode || 'A lead'}: ${inr(refundRupees)} refunded by bank transfer (ref ${ref}). Reason: ${note}`,
      type: 'ESCROW_REFUNDED',
      linkUrl: '/admin/escrow',
    });
  })().catch((err) => logger.warn('[Escrow] Post-manual-refund notification failed', { escrowId, error: err.message }));

  return prisma.escrowTransaction.findUnique({ where: { id: escrowId } }).then((e) => e || { id: escrowId, status: newStatus, refundedAmountPaise: totalPaise });
}

// R10 — freeze a HELD escrow for a dispute. Blocks release() and refund()
// for free, since both already reject anything that is not HELD.
// The buyer and the assigned partner are told in the app (no WhatsApp: there is no approved template for it). The reason is not
// shown to them: whether it should be is a product decision that has not been made. Never fails the freeze or unfreeze itself.
async function notifyFreezeChange(escrow, frozen) {
  try {
    const lead = await prisma.lead.findUnique({ where: { id: escrow.leadId }, select: { refCode: true, assignedPartnerId: true, property: { select: { title: true } } } });
    const title = lead?.property?.title || 'your property';
    const ref = lead?.refCode || 'A lead';
    const type = frozen ? 'ESCROW_FROZEN' : 'ESCROW_UNFROZEN';
    await createNotification({
      userId: escrow.buyerId,
      title: frozen ? 'Your token is on hold' : 'The hold on your token is lifted',
      message: frozen
        ? `Your token for ${title} is on hold while our team reviews your deal. It stays safe in escrow, and we will update you here.`
        : `The hold on your token for ${title} has been lifted.`,
      type, linkUrl: `/user/inquiries/${escrow.leadId}`,
    });
    if (lead?.assignedPartnerId) {
      await createNotification({
        userId: lead.assignedPartnerId,
        title: frozen ? 'Token on hold' : 'Token hold lifted',
        message: frozen
          ? `${ref}: the buyer's token is on hold while our team reviews the deal.`
          : `${ref}: the hold on the buyer's token has been lifted.`,
        type, linkUrl: `/partners/leads/${escrow.leadId}`,
      });
    }
  } catch (err) {
    logger.warn('[Escrow] Freeze/unfreeze notice failed', { escrowId: escrow.id, error: err.message });
  }
}

// A HELD escrow, or a part-refunded one (the rest of its money can be frozen in a dispute too).
const FREEZABLE = ['HELD', 'PARTIALLY_REFUNDED'];

async function freeze(escrowId, reason, adminId, ip) {
  const escrow = await prisma.escrowTransaction.findUnique({ where: { id: escrowId } });
  if (!escrow) throw new ApiError(404, 'Escrow not found');
  if (!FREEZABLE.includes(escrow.status)) throw new ApiError(400, `Cannot freeze escrow with status ${escrow.status} — only a HELD or PARTIALLY_REFUNDED escrow can be frozen`);

  // BE-4 — same atomic-claim pattern as release()/refund(): a read-then-write
  // here could race a concurrent release() for the same escrow — whichever
  // of the two writes last would silently overwrite the other (FROZEN
  // clobbering a real RELEASED, or vice versa). The claim conditions on the
  // status this function itself just checked, so only one of two concurrent
  // calls can ever affect a row.
  const claim = await prisma.escrowTransaction.updateMany({
    where: { id: escrowId, status: { in: FREEZABLE } },
    data: { status: 'FROZEN', frozenAt: new Date(), frozenReason: reason, frozenByAdminId: adminId, unfrozenAt: null },
  });
  if (claim.count === 0) throw new ApiError(409, 'This escrow is no longer HELD — it may have just been released or refunded.', { code: 'ESCROW_STATE_CHANGED' });

  const updated = (await prisma.escrowTransaction.findUnique({ where: { id: escrowId } })) || { ...escrow, status: 'FROZEN' };

  await createAuditLog({
    adminId, action: 'ESCROW_FROZEN', targetType: 'EscrowTransaction', targetId: escrowId,
    before: { status: escrow.status }, after: { status: 'FROZEN', reason }, ipAddress: ip,
  });
  notifyFreezeChange(escrow, true);

  return updated;
}

// Restores the state it was frozen from: a part-refunded escrow (refundedAmountPaise above zero) goes back to PARTIALLY_REFUNDED, never
// to HELD, because a HELD escrow can be refunded for the whole token again.
async function unfreeze(escrowId, adminId, ip) {
  const escrow = await prisma.escrowTransaction.findUnique({ where: { id: escrowId } });
  if (!escrow) throw new ApiError(404, 'Escrow not found');
  if (escrow.status !== 'FROZEN') throw new ApiError(400, `Escrow is not frozen (status: ${escrow.status})`);
  const restoreTo = (escrow.refundedAmountPaise || 0) > 0 ? 'PARTIALLY_REFUNDED' : 'HELD';

  // BE-4 — same atomic claim as freeze() above.
  const claim = await prisma.escrowTransaction.updateMany({
    where: { id: escrowId, status: 'FROZEN' },
    data: { status: restoreTo, unfrozenAt: new Date() },
  });
  if (claim.count === 0) throw new ApiError(409, 'This escrow is no longer FROZEN.', { code: 'ESCROW_STATE_CHANGED' });

  const updated = (await prisma.escrowTransaction.findUnique({ where: { id: escrowId } })) || { ...escrow, status: restoreTo };

  await createAuditLog({
    adminId, action: 'ESCROW_UNFROZEN', targetType: 'EscrowTransaction', targetId: escrowId,
    before: { status: 'FROZEN' }, after: { status: restoreTo }, ipAddress: ip,
  });
  notifyFreezeChange(escrow, false);

  return updated;
}

module.exports = {
  refundManually, createOrder, getCheckoutQuote, checkoutBreakdown, getById, getReceipt, getRefundReceipt, getFeeInvoice, getReleasePlan, confirmPayment, release, refund, refundPartial, getAllEscrow, getEscrowStats,
  freeze, unfreeze, payDeferredPartnerCommission, recordPartnerCredit, repairReleaseBookkeeping,
};
