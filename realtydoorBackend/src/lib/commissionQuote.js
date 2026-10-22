'use strict';

const money = require('./moneyModel');

// What a partner is told about their commission on a lead: their % of the
// final deal price, where the rate came from, a Custom label with the reason
// when it differs from the platform default, and the estimated amount. Pure on
// the lead's own stored snapshot (set with the terms at assignment), so it
// never changes after the terms lock. Returns null until terms have been set.
function buildPartnerQuote(lead) {
  if (lead.partnerRatePct == null) return null;
  const price = lead.dealPriceAtLock ?? lead.property?.price ?? null;
  return {
    partnerRatePct: lead.partnerRatePct,
    source: lead.commissionRateSource ?? null,
    isCustom: !!lead.commissionRateCustom,
    label: lead.commissionRateCustom ? 'Custom' : null,
    reason: lead.commissionRateCustom ? (lead.commissionRateReason ?? null) : null,
    dealPrice: price,
    estimatedCommission: price != null
      ? money.toRupees(money.partnerCommissionPaise(money.toPaise(price), lead.partnerRatePct))
      : null,
    locked: !!lead.commissionLockedAt,
  };
}

module.exports = { buildPartnerQuote };
