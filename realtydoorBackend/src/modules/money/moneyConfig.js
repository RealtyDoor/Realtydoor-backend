'use strict';

// Money model Rev 3 settings. Every number the money model uses is a
// PlatformConfig key (editable under GET/PUT /admin/config) with the owner's
// 22 Oct 2026 decision as the default, so nothing is hard-coded and an open
// CA / lawyer item changes a setting, not code. One read for all keys.

const prisma = require('../../lib/prisma');

// key -> [default, description, type]
const DEFINITIONS = {
  // Commission (platform default; a project / property / city card or a
  // partner override beats it, see moneyModel.resolveCommissionRate).
  default_partner_rate_pct:  [1, 'Partner commission, % of the final deal price (same below and above 1 crore).'],
  default_platform_fee_pct:  [1, 'Realtydoor platform fee, % of the final deal price, charged to the seller or developer on top of the partner rate.'],
  commission_gst_pct:        [18, 'GST % on the seller / developer invoice (partner rate + platform fee) and on a registered partner commission.'],

  // Buyer processing fee (token / 0.9764 at the standard rate).
  processing_fee_enabled:    ['true', 'Charge the buyer a separate payment processing fee on the token. "true" or "false".'],
  processing_fee_gateway_pct: [2, 'Payment gateway charge % used to size the processing fee (Razorpay standard 2%). Confirm the account rate.'],
  processing_fee_gateway_gst_pct: [18, 'GST % the gateway adds on its own charge.'],
  processing_fee_gst_pct:    [18, 'GST % included in the processing fee, shown on its tax invoice. [CA: SAC code, input credit]'],

  // Refunds and cancellation
  escrow_refund_window_hours: [48, 'Hours after payment in which a buyer cancel returns the full token (processing fee not returned).'],
  cancellation_charge_rupees: [2999, 'Cancellation charge kept from the token when a buyer cancels after the free window and before the allocation letter is verified. Shown at checkout.'],
  cancellation_charge_realtydoor_share_pct: [100, 'Share of the cancellation charge that is Realtydoor income; the rest is the seller. [OPEN: CA and lawyer]'],
  cancellation_charge_gst_pct: [18, 'GST % treated as included in Realtydoor part of the cancellation charge. [OPEN: CA]'],
  escrow_hold_days:          [30, 'Days a token may be held before an automatic refund (job not built yet, T59).'],
  escrow_hold_auto_refund:   ['false', 'Refund tokens automatically at the hold limit (escrow_hold_days). "true" or "false". Off by default: with it off the daily job only alerts admins.'],
  escrow_token_platform_fee_pct: [0, 'Platform fee taken from the TOKEN at release. 0 under money model Rev 3 (the fee is on the seller invoice). Replaces the old escrow_platform_fee_pct, which is now ignored.'],

  // Partner-added leads: how long a partner keeps a buyer they registered (restarts on a site visit, token or closed deal).
  partner_lead_window_days:  [60, 'Days a partner keeps a buyer they registered, counted from the last activity on it (lead, site visit, token, closed deal). After that the buyer is free and a fresh registration is credited again.'],

  // TDS on partner commission (s.194H; section label under the Income-tax Act 2025 is open with the CA)
  tds_rate_pct:              [2, 'TDS % withheld from partner commission (excluding GST).'],
  tds_no_pan_rate_pct:       [20, 'TDS % when the partner has no valid PAN.'],
  tds_threshold_rupees:      [20000, 'Yearly commission per partner above which TDS is deducted.'],
  tds_missing_pan_action:    ['DEDUCT_HIGHER', 'Partner without a valid PAN: "DEDUCT_HIGHER" (withhold the no-PAN rate) or "BLOCK" (refuse the payout).'],
  // Company details printed on documents and checked on partner tax invoices.
  company_gstin:             ['', 'Realtydoor GSTIN. A partner tax invoice must be addressed to it. Empty = not checked yet.'],
  company_legal_name:        ['Realtydoor', 'Legal name printed on statements and vouchers.'],
  commission_sac_code:       ['', 'SAC code expected on a partner commission tax invoice. [OPEN: CA] Empty = not checked.'],
  tds_section_label:         ['194H', 'Section printed on TDS records and statements. [OPEN: CA, Income-tax Act 2025 numbering]'],
};

const KEYS = Object.keys(DEFINITIONS);

function parseSettings(rows) {
  const raw = new Map(rows.map((r) => [r.key, r.value]));
  const num = (k) => {
    const n = Number(raw.get(k));
    return raw.has(k) && Number.isFinite(n) ? n : DEFINITIONS[k][0];
  };
  const str = (k) => (raw.has(k) ? String(raw.get(k)) : DEFINITIONS[k][0]);
  return {
    commission: {
      partnerRatePct: num('default_partner_rate_pct'),
      platformFeePct: num('default_platform_fee_pct'),
      gstPct: num('commission_gst_pct'),
    },
    processingFee: {
      enabled: str('processing_fee_enabled') !== 'false',
      gatewayPct: num('processing_fee_gateway_pct'),
      gatewayGstPct: num('processing_fee_gateway_gst_pct'),
      feeGstPct: num('processing_fee_gst_pct'),
    },
    refund: {
      freeWindowHours: num('escrow_refund_window_hours'),
      cancellationChargePaise: Math.round(num('cancellation_charge_rupees') * 100),
      realtydoorSharePct: num('cancellation_charge_realtydoor_share_pct'),
      gstPct: num('cancellation_charge_gst_pct'),
      holdDays: num('escrow_hold_days'),
    },
    tokenPlatformFeePct: num('escrow_token_platform_fee_pct'),
    partnerLeadWindowDays: num('partner_lead_window_days'),
    company: {
      gstin: str('company_gstin').trim().toUpperCase(),
      legalName: str('company_legal_name'),
      sacCode: str('commission_sac_code').trim(),
    },
    tds: {
      ratePct: num('tds_rate_pct'),
      noPanRatePct: num('tds_no_pan_rate_pct'),
      thresholdPaise: Math.round(num('tds_threshold_rupees') * 100),
      missingPanAction: str('tds_missing_pan_action') === 'BLOCK' ? 'BLOCK' : 'DEDUCT_HIGHER',
      sectionLabel: str('tds_section_label'),
    },
  };
}

async function getMoneySettings() {
  const rows = await prisma.platformConfig.findMany({ where: { key: { in: KEYS } }, select: { key: true, value: true } });
  return parseSettings(rows);
}

// Keys whose change must carry a reason and be audited with old and new value:
// everything above plus the older money keys still in the table.
const MONEY_KEY_PATTERN = /^(default_fee_pct|default_partner_share_pct|platform_commission_pct|commission_[a-z_]+|escrow_[a-z_]+|processing_fee_[a-z_]+|cancellation_charge_[a-z_]+|tds_[a-z_]+|company_gstin|company_legal_name|default_builder_brokerage_pct)$/;
const isMoneyKey = (key) => KEYS.includes(key) || MONEY_KEY_PATTERN.test(key);

module.exports = { DEFINITIONS, KEYS, MONEY_KEY_PATTERN, isMoneyKey, parseSettings, getMoneySettings };
