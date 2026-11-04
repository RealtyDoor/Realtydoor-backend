// Who the automatic assignment may touch, and in what order.
//  - A lead a partner brought belongs to that partner: it is never handed to anyone else by the automatic picker (admin confirms
//    it, which assigns the adder when they are credited and verified, or decides by hand).
//  - Only campaign leads (the company logs them one by one with a campaign name) are assigned automatically, in rotation.
//    Website inquiries and everything else are assigned by hand.

/** True when a partner brought this lead (they added it, or it is marked as coming from a partner). */
function isPartnerBrought(lead) {
  return !!lead && (!!lead.addedByPartnerId || lead.source === 'PARTNER');
}

/** True when the company logged this lead for a named campaign. */
function isCampaignLead(lead) {
  return !!lead && typeof lead.campaign === 'string' && lead.campaign.trim().length > 0;
}

/**
 * Rotation order: whoever went longest without a campaign lead comes first; someone who never had one comes before anyone who did;
 * ties fall back to the id so the order is the same every time. `lastAt` maps partner id to the time of their latest campaign lead.
 */
function rotationOrder(candidates, lastAt = {}) {
  const stamp = (c) => (lastAt[c.id] ? new Date(lastAt[c.id]).getTime() : -Infinity);
  return [...candidates].sort((a, b) => {
    const sa = stamp(a);
    const sb = stamp(b);
    if (sa !== sb) return sa < sb ? -1 : 1;
    return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
  });
}

module.exports = { isPartnerBrought, isCampaignLead, rotationOrder };
