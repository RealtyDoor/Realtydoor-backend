'use strict';

// Money model, Revision 3 (22 Oct 2026) — pure functions, no database.
// Everything here works in integer PAISE; rupee floats are for display only.
// Every rate, threshold and label is passed in (read from PlatformConfig by
// moneyConfig.js), so a CA or lawyer decision changes a setting, not code.
// See admin-nextjs/docs/PRICING_REFUNDS_AND_MARGINS.md (Revision 3 box, 2.1,
// 2.2, 2.5, 2.6, 18) and MONEY_LEDGER_SPEC_DRAFT.md.

const PAISE = 100;
const toPaise = (rupees) => Math.round(Number(rupees) * PAISE);
const toRupees = (paise) => paise / PAISE;
const pctOf = (paise, pct) => Math.round((paise * pct) / 100);

// ─── Buyer payment processing fee (T55/T56) ──────────────────────────────────
// The buyer pays G = token / (1 - gateway% x (1 + GST%)), rounded UP to the
// next rupee so the fee never under-recovers. Standard Razorpay: 2% + 18% GST
// on that fee = 2.36%, so G = token / 0.9764 (50,000 -> 51,209).
function gatewayDivisor({ gatewayPct, gatewayGstPct }) {
  return 1 - (gatewayPct * (1 + gatewayGstPct / 100)) / 100;
}

function processingFee(tokenPaise, s) {
  if (!Number.isInteger(tokenPaise) || tokenPaise <= 0) throw new Error('tokenPaise must be a positive integer');
  if (!s.enabled) return { tokenPaise, feePaise: 0, totalPaise: tokenPaise, feeGstPaise: 0, divisor: 1 };
  const divisor = gatewayDivisor(s);
  if (!(divisor > 0 && divisor <= 1)) throw new Error('Gateway rate settings leave nothing to divide by');
  // Round the exact figure to the nearest paise first so a value like
  // 5120852.0000001 does not tip a whole extra rupee, then up to the rupee.
  const exact = Math.round((tokenPaise / divisor) * 1e6) / 1e6;
  const totalPaise = Math.ceil(exact / PAISE) * PAISE;
  const feePaise = totalPaise - tokenPaise;
  // GST inside the fee, for the tax invoice: fee is GST-inclusive.
  const feeGstPaise = s.feeGstPct > 0 ? feePaise - Math.round(feePaise / (1 + s.feeGstPct / 100)) : 0;
  return { tokenPaise, feePaise, totalPaise, feeGstPaise, divisor };
}

// ─── Commission rate: who wins (2.5) ─────────────────────────────────────────
// deal terms > partner override > project > property > city > platform default.
// `candidates` holds what exists; the first present one in that order wins.
// Each is { partnerRatePct, platformFeePct, reason?, ref? }.
const RATE_ORDER = ['DEAL', 'PARTNER_OVERRIDE', 'PROJECT', 'PROPERTY', 'CITY', 'PLATFORM_DEFAULT'];

function resolveCommissionRate(candidates, platformDefault) {
  const all = { ...candidates, PLATFORM_DEFAULT: platformDefault };
  for (const source of RATE_ORDER) {
    const c = all[source];
    if (c && Number.isFinite(c.partnerRatePct) && c.partnerRatePct >= 0) {
      const platformFeePct = Number.isFinite(c.platformFeePct) ? c.platformFeePct : platformDefault.platformFeePct;
      const isCustom = source === 'PLATFORM_DEFAULT'
        ? false
        : c.partnerRatePct !== platformDefault.partnerRatePct || platformFeePct !== platformDefault.platformFeePct;
      return {
        source,
        partnerRatePct: c.partnerRatePct,
        platformFeePct,
        totalFeePct: round6(c.partnerRatePct + platformFeePct),
        isCustom,
        reason: c.reason ?? null,
        ref: c.ref ?? null,
      };
    }
  }
  throw new Error('No platform default commission rate');
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;

// Partner commission = rate x FINAL deal price (not the token), in paise.
function partnerCommissionPaise(dealPricePaise, partnerRatePct) {
  return pctOf(dealPricePaise, partnerRatePct);
}

// Seller / developer invoice = partner rate + platform fee, + GST on the whole.
function sellerInvoice(dealPricePaise, { partnerRatePct, platformFeePct, gstPct }) {
  const partnerPaise = pctOf(dealPricePaise, partnerRatePct);
  const platformPaise = pctOf(dealPricePaise, platformFeePct);
  const subtotalPaise = partnerPaise + platformPaise;
  const gstPaise = pctOf(subtotalPaise, gstPct);
  return { partnerPaise, platformPaise, subtotalPaise, gstPaise, totalPaise: subtotalPaise + gstPaise };
}

// ─── Financial year helpers (India: 1 April to 31 March) ─────────────────────
function financialYearOf(date) {
  const d = new Date(date);
  // Asia/Kolkata is UTC+5:30 with no DST: shift, then read UTC parts.
  const ist = new Date(d.getTime() + 5.5 * 3600 * 1000);
  const m = ist.getUTCMonth(); // 0 = Jan
  const y = ist.getUTCFullYear();
  const startYear = m >= 3 ? y : y - 1;
  const quarter = m >= 3 && m <= 5 ? 1 : m >= 6 && m <= 8 ? 2 : m >= 9 && m <= 11 ? 3 : 4;
  return {
    financialYear: `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`,
    quarter,
    startYear,
  };
}

// Deposit due: 7th of the next month; for a March deduction, 30 April.
function tdsDepositDueDate(date) {
  const ist = new Date(new Date(date).getTime() + 5.5 * 3600 * 1000);
  const m = ist.getUTCMonth();
  const y = ist.getUTCFullYear();
  const dueUtc = m === 2 ? Date.UTC(y, 3, 30) : Date.UTC(y, m + 1, 7);
  // 23:59 IST on the due day.
  return new Date(dueUtc + (23 * 3600 + 59 * 60) * 1000 - 5.5 * 3600 * 1000);
}

// ─── TDS on partner commission (T61/T64) ─────────────────────────────────────
const PAN_FORMAT = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const isValidPan = (pan) => typeof pan === 'string' && PAN_FORMAT.test(pan.trim().toUpperCase());

// Deducts once the partner's commission credited in the financial year
// exceeds the threshold. The payout that crosses it is taxed on everything
// credited so far that has not been taxed yet (catch-up), so the total TDS
// for the year is rate x total commission. No PAN: the higher rate applies
// (or the payout is blocked, per setting). GST is never part of the base.
//   ytdBasePaise     = commission credited earlier this FY
//   taxedBasePaise   = part of that base TDS has already been taken on
function computeTds({ commissionPaise, ytdBasePaise = 0, taxedBasePaise = 0, pan, settings }) {
  const { ratePct, noPanRatePct, thresholdPaise, missingPanAction } = settings;
  const hasPan = isValidPan(pan);
  if (!hasPan && missingPanAction === 'BLOCK') {
    return { blocked: true, reason: 'NO_PAN', hasPan, tdsPaise: 0, netPaise: commissionPaise };
  }
  const cumulative = ytdBasePaise + commissionPaise;
  const thresholdReached = cumulative > thresholdPaise;
  const applied = hasPan ? ratePct : Math.max(noPanRatePct, ratePct);
  if (!thresholdReached) {
    return {
      blocked: false, hasPan, thresholdReached, ratePct: applied, rateReason: 'BELOW_THRESHOLD',
      baseTaxedPaise: 0, tdsPaise: 0, netPaise: commissionPaise,
    };
  }
  const baseTaxedPaise = cumulative - taxedBasePaise;
  const tdsPaise = Math.min(commissionPaise, pctOf(baseTaxedPaise, applied));
  return {
    blocked: false, hasPan, thresholdReached, ratePct: applied,
    rateReason: hasPan ? 'STANDARD' : 'NO_PAN',
    baseTaxedPaise, tdsPaise, netPaise: commissionPaise - tdsPaise,
  };
}

// ─── Partner payout statement for one deal (2.6a) ────────────────────────────
// GST is added only for a GST-registered partner, and is held back (paid once
// the partner's tax invoice shows in our GSTR-2B), so it is not in `payNowPaise`.
function partnerPayout({ commissionPaise, tds, gstRegistered, gstPct }) {
  const gstPaise = gstRegistered ? pctOf(commissionPaise, gstPct) : 0;
  return {
    commissionPaise,
    tdsPaise: tds.tdsPaise,
    gstPaise,
    gstPendingPaise: gstPaise,
    payNowPaise: commissionPaise - tds.tdsPaise,
    totalWithGstPaise: commissionPaise - tds.tdsPaise + gstPaise,
    documentType: gstRegistered ? 'TAX_INVOICE' : 'COMMISSION_VOUCHER',
  };
}

// ─── Refunds (2.2) ───────────────────────────────────────────────────────────
// reason decides the money:
//   BUYER_CANCEL  -> inside the window: token back, fee kept.
//                    after the window, letter not verified: token - charge, fee kept.
//                    letter verified: not refundable by the platform (dispute).
//   SELLER_BACKOUT | LISTING_WRONG | OUR_FAULT -> token + fee, no charge, any time
//                    before release.
//   ADMIN_TOKEN_ONLY -> token only, no charge (the pre-existing admin refund).
const FAULT_REASONS = ['SELLER_BACKOUT', 'LISTING_WRONG', 'OUR_FAULT'];
const REFUND_REASONS = ['BUYER_CANCEL', ...FAULT_REASONS, 'ADMIN_TOKEN_ONLY'];

function refundQuote({ reason, tokenPaise, feePaise = 0, paidAt, now = new Date(), letterVerified = false, settings }) {
  if (!REFUND_REASONS.includes(reason)) throw new Error(`Unknown refund reason "${reason}"`);
  // When the free refund period ends: counted from the moment the token was held, never from the moment of the request.
  const freeRefundEndsAt = paidAt && settings ? new Date(new Date(paidAt).getTime() + settings.freeWindowHours * 3600 * 1000) : null;
  const base = {
    reason, tokenPaise, feePaise, refundable: true, cancellationChargePaise: 0,
    refundPaise: tokenPaise, feeReturned: false, stage: null, freeRefundEndsAt,
  };
  if (FAULT_REASONS.includes(reason)) {
    return { ...base, stage: 'FAULT', refundPaise: tokenPaise + feePaise, feeReturned: feePaise > 0 };
  }
  if (reason === 'ADMIN_TOKEN_ONLY') return { ...base, stage: 'ADMIN' };

  // Once the admin has verified the allocation letter the deal is done, so a buyer cancel is refused even inside the free window
  // (BUG-040: the window used to be checked first and the verified letter was ignored).
  if (letterVerified) return { ...base, stage: 'AFTER_VERIFICATION', refundable: false, refundPaise: 0 };

  const heldMs = paidAt ? new Date(now).getTime() - new Date(paidAt).getTime() : 0;
  const withinWindow = paidAt != null && heldMs < settings.freeWindowHours * 3600 * 1000;
  if (withinWindow) return { ...base, stage: 'WITHIN_WINDOW' };
  const split = splitCancellationCharge(Math.min(settings.cancellationChargePaise, tokenPaise), settings);
  return {
    ...base,
    stage: 'AFTER_WINDOW',
    cancellationChargePaise: split.chargePaise,
    cancellationSplit: split,
    refundPaise: tokenPaise - split.chargePaise,
  };
}

// The split of the charge between the seller and Realtydoor, and the GST on
// Realtydoor's part, are open (CA / lawyer): both are settings. The GST is
// treated as included in Realtydoor's part.
function splitCancellationCharge(chargePaise, { realtydoorSharePct, gstPct }) {
  const realtydoorPaise = pctOf(chargePaise, realtydoorSharePct);
  const sellerPaise = chargePaise - realtydoorPaise;
  const gstPaise = gstPct > 0 ? realtydoorPaise - Math.round(realtydoorPaise / (1 + gstPct / 100)) : 0;
  return { chargePaise, realtydoorPaise, sellerPaise, gstOnRealtydoorPaise: gstPaise };
}

// ─── Commission from the locked lines ────────────────────────────────────────
// The assigned partner's own LISTING_AGENT / CLOSING_AGENT lines (fee x line %,
// i.e. rate x deal price). A line with no payee belongs to the assigned partner.
function partnerLinesCommissionPaise(lines, feeRupees, assignedPartnerId) {
  if (!assignedPartnerId || feeRupees == null) return 0;
  return (lines || [])
    .filter((l) => (l.payeeUserId ?? assignedPartnerId) === assignedPartnerId
      && ['LISTING_AGENT', 'CLOSING_AGENT'].includes(l.payeeRole))
    .reduce((sum, l) => sum + toPaise(Math.round(((feeRupees * l.pct) / 100) * 100) / 100), 0);
}

// ─── Partner tax invoice check (GST-registered partner) ──────────────────────
const GSTIN_FORMAT = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;
const normGstin = (g) => String(g || '').trim().toUpperCase();

// Returns a list of problems; empty = the invoice matches the deal. The amounts
// must equal the commission on the locked terms, and the GST must be the right
// split (CGST + SGST inside the state, IGST outside).
function validateTaxInvoice(inv, { commissionPaise, partnerGstin, settings, now = new Date() }) {
  const errors = [];
  const add = (code, message) => errors.push({ code, message });
  if (!commissionPaise) add('NO_COMMISSION', 'This deal has no locked commission for you yet.');
  if (!partnerGstin) add('PARTNER_NOT_REGISTERED', 'Your profile has no GSTIN; a tax invoice is only for GST-registered partners.');
  const supplier = normGstin(inv.supplierGstin);
  if (!GSTIN_FORMAT.test(supplier)) add('BAD_SUPPLIER_GSTIN', 'Supplier GSTIN is not a valid GSTIN.');
  else if (partnerGstin && supplier !== normGstin(partnerGstin)) add('SUPPLIER_GSTIN_MISMATCH', 'Supplier GSTIN must be the GSTIN on your profile.');
  const recipient = normGstin(inv.recipientGstin);
  if (!GSTIN_FORMAT.test(recipient)) add('BAD_RECIPIENT_GSTIN', 'Our GSTIN is not valid.');
  else if (settings.company.gstin && recipient !== settings.company.gstin) add('RECIPIENT_GSTIN_MISMATCH', 'The invoice must be addressed to Realtydoor\'s GSTIN.');
  if (!String(inv.invoiceNumber || '').trim()) add('NO_INVOICE_NUMBER', 'Invoice number is required.');
  if (!String(inv.placeOfSupply || '').trim()) add('NO_PLACE_OF_SUPPLY', 'Place of supply is required.');
  if (!String(inv.sacCode || '').trim()) add('NO_SAC', 'SAC code is required.');
  else if (settings.company.sacCode && String(inv.sacCode).trim() !== settings.company.sacCode) add('SAC_MISMATCH', `SAC code must be ${settings.company.sacCode}.`);
  const date = new Date(inv.invoiceDate);
  if (Number.isNaN(date.getTime())) add('BAD_DATE', 'Invoice date is not a valid date.');
  else if (date.getTime() > now.getTime() + 24 * 3600e3) add('FUTURE_DATE', 'Invoice date is in the future.');

  const taxable = inv.taxableValuePaise;
  if (commissionPaise && taxable !== commissionPaise) add('TAXABLE_MISMATCH', `Taxable value must equal your commission for this deal (${(commissionPaise / 100).toFixed(2)}).`);
  const expectedGst = pctOf(commissionPaise || taxable || 0, settings.commission.gstPct);
  const { cgstPaise = 0, sgstPaise = 0, igstPaise = 0 } = inv;
  const inter = igstPaise > 0;
  const intra = cgstPaise > 0 || sgstPaise > 0;
  if (inter && intra) add('GST_SPLIT', 'Use either IGST or CGST + SGST, not both.');
  else if (inter && igstPaise !== expectedGst) add('GST_AMOUNT', `IGST must be ${settings.commission.gstPct}% of the taxable value (${(expectedGst / 100).toFixed(2)}).`);
  else if (intra && (cgstPaise + sgstPaise !== expectedGst || Math.abs(cgstPaise - sgstPaise) > 1)) add('GST_AMOUNT', `CGST + SGST must be ${settings.commission.gstPct}% of the taxable value, split equally.`);
  else if (!inter && !intra) add('NO_GST', 'GST amount is missing.');
  if (inv.totalPaise !== taxable + cgstPaise + sgstPaise + igstPaise) add('TOTAL_MISMATCH', 'Total must equal taxable value plus GST.');
  return errors;
}

module.exports = {
  partnerLinesCommissionPaise, validateTaxInvoice, GSTIN_FORMAT, normGstin,
  toPaise, toRupees, pctOf,
  gatewayDivisor, processingFee,
  RATE_ORDER, resolveCommissionRate, partnerCommissionPaise, sellerInvoice,
  financialYearOf, tdsDepositDueDate,
  isValidPan, computeTds, partnerPayout,
  FAULT_REASONS, REFUND_REASONS, refundQuote, splitCancellationCharge,
};
