const { isLoanTransitionAllowed } = require('../../src/lib/loanTransitions');

describe('isLoanTransitionAllowed', () => {
  test('allows moving forward, including skipping stages', () => {
    expect(isLoanTransitionAllowed('DOCUMENTS_PENDING', 'DOCUMENTS_SUBMITTED')).toBe(true);
    expect(isLoanTransitionAllowed('DOCUMENTS_VERIFIED', 'SANCTIONED')).toBe(true);
    expect(isLoanTransitionAllowed('SANCTIONED', 'DISBURSED')).toBe(true);
  });

  test('allows stepping back before SANCTIONED (e.g. re-verify a bad document)', () => {
    expect(isLoanTransitionAllowed('SENT_TO_BANK', 'DOCUMENTS_PENDING')).toBe(true);
    expect(isLoanTransitionAllowed('AWAITING_SANCTION', 'DOCUMENTS_VERIFIED')).toBe(true);
  });

  test('refuses to move back once SANCTIONED or DISBURSED', () => {
    expect(isLoanTransitionAllowed('SANCTIONED', 'DOCUMENTS_PENDING')).toBe(false);
    expect(isLoanTransitionAllowed('SANCTIONED', 'SENT_TO_BANK')).toBe(false);
    expect(isLoanTransitionAllowed('DISBURSED', 'DOCUMENTS_PENDING')).toBe(false);
    expect(isLoanTransitionAllowed('DISBURSED', 'SANCTIONED')).toBe(false);
  });

  test('REJECTED is reachable from any open stage and is final', () => {
    expect(isLoanTransitionAllowed('DOCUMENTS_VERIFIED', 'REJECTED')).toBe(true);
    expect(isLoanTransitionAllowed('SANCTIONED', 'REJECTED')).toBe(true);
    expect(isLoanTransitionAllowed('REJECTED', 'DOCUMENTS_PENDING')).toBe(false);
    expect(isLoanTransitionAllowed('DISBURSED', 'REJECTED')).toBe(false);
  });

  test('refuses a no-op and unknown statuses', () => {
    expect(isLoanTransitionAllowed('SANCTIONED', 'SANCTIONED')).toBe(false);
    expect(isLoanTransitionAllowed('DOCUMENTS_PENDING', 'NOPE')).toBe(false);
    expect(isLoanTransitionAllowed('NOPE', 'SANCTIONED')).toBe(false);
  });
});
