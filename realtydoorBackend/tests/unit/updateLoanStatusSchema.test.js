const { updateLoanStatusSchema } = require('../../src/modules/admin/admin.validator');

describe('updateLoanStatusSchema (B61)', () => {
  it('accepts the sanction details an admin enters', () => {
    const r = updateLoanStatusSchema.parse({ status: 'SANCTIONED', sanctionedAmountPaise: 250000000, interestRatePct: 8.5, tenureMonths: 240, emiPaise: 2170000, sanctionLetterUrl: 'https://example.com/letter.pdf' });
    expect(r.sanctionedAmountPaise).toBe(250000000);
  });
  it('rejects a non-positive sanctioned amount', () => {
    expect(() => updateLoanStatusSchema.parse({ status: 'SANCTIONED', sanctionedAmountPaise: 0 })).toThrow();
  });
  it('still accepts a bare status change', () => {
    expect(updateLoanStatusSchema.parse({ status: 'REJECTED' }).status).toBe('REJECTED');
  });
});

const { releaseEscrowSchema } = require('../../src/modules/escrow/escrow.validator');

describe('releaseEscrowSchema payPartner (B32)', () => {
  const base = { sellerDetails: { name: 'Owner', email: 'o@example.com', phone: '+919876543210', ifsc: 'HDFC0001234', accountNumber: '50100987654321' } };
  it('accepts payPartner and treats it as opt-in', () => {
    expect(releaseEscrowSchema.parse({ ...base, partnerShare: 1000, payPartner: true }).payPartner).toBe(true);
    expect(releaseEscrowSchema.parse({ ...base, partnerShare: 1000 }).payPartner).toBeUndefined();
  });
});
