// The new-look WhatsApp templates take over only once Meta has approved them (listed in WATI_LIVE_TEMPLATES); until then the old ones keep sending.
const { TEMPLATE_UPGRADES, resolveTemplate, liveSet, LEAD_RULE_TEMPLATES } = require('../../src/lib/wati');

describe('resolveTemplate', () => {
  test('keeps the old template while the new one is not live', () => {
    const live = liveSet({ WATI_LIVE_TEMPLATES: 'visit_reminder_v2,escrow_released' });
    expect(resolveTemplate('visit_reminder_v2', live)).toBe('visit_reminder_v2');
    expect(resolveTemplate('escrow_released', live)).toBe('escrow_released');
  });
  test('switches to the new template as soon as it is listed as live', () => {
    const live = liveSet({ WATI_LIVE_TEMPLATES: 'visit_reminder_v2,visit_reminder_v3,escrow_released' });
    expect(resolveTemplate('visit_reminder_v2', live)).toBe('visit_reminder_v3');
    expect(resolveTemplate('escrow_released', live)).toBe('escrow_released');
  });
  test('the built-in live ones (lead assigned, feedback, contact reply, vendor) upgrade only when the new name is added', () => {
    expect(resolveTemplate('lead_assigned_notice', liveSet({}))).toBe('lead_assigned_notice');
    expect(resolveTemplate('lead_assigned_notice', liveSet({ WATI_LIVE_TEMPLATES: 'lead_assigned_notice_v2' }))).toBe('lead_assigned_notice_v2');
    expect(resolveTemplate('ticket_vendor_dispatched_v2', liveSet({ WATI_LIVE_TEMPLATES: 'ticket_vendor_dispatched_v3' }))).toBe('ticket_vendor_dispatched_v3');
  });
  test('codes (OTPs) and unknown names are never changed', () => {
    const live = liveSet({ WATI_LIVE_TEMPLATES: 'site_visit_otp_v2' });
    for (const n of ['site_visit_otp', 'phone_verification_otp', 'commission_voucher_code', 'something_else']) expect(resolveTemplate(n, live)).toBe(n);
  });
  test('every new name follows the old one and no name maps to itself', () => {
    for (const [from, to] of Object.entries(TEMPLATE_UPGRADES)) { expect(to).not.toBe(from); expect(to).toMatch(/_v\d+$/); }
  });
  test('the lead-rule names whose plain versions are approved map to their v2', () => {
    expect(TEMPLATE_UPGRADES.lead_registration_received).toBe('lead_registration_received_v2');
    expect(LEAD_RULE_TEMPLATES).toContain('lead_registration_received');
  });
});
