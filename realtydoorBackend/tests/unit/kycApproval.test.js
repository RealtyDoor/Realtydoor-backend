// Found live on 25 Oct 2026: a partner was VERIFIED with no PAN number saved, so their commission was taxed at the 20% no-PAN rate.
const { kycApprovalBlocker } = require('../../src/lib/kycApproval');

const ok = { kycDocumentUrls: ['a.png'], panNumber: 'ABCDE1234F' };

describe('kycApprovalBlocker', () => {
  test('a partner with a document and a valid PAN can be approved', () => {
    expect(kycApprovalBlocker(ok)).toBeNull();
  });
  test('no documents blocks approval', () => {
    expect(kycApprovalBlocker({ ...ok, kycDocumentUrls: [] })).toMatchObject({ code: 'KYC_NO_DOCUMENTS' });
    expect(kycApprovalBlocker({ ...ok, kycDocumentUrls: undefined })).toMatchObject({ code: 'KYC_NO_DOCUMENTS' });
  });
  test('no PAN number blocks approval', () => {
    expect(kycApprovalBlocker({ ...ok, panNumber: null })).toMatchObject({ code: 'KYC_NO_PAN' });
    expect(kycApprovalBlocker({ ...ok, panNumber: '' })).toMatchObject({ code: 'KYC_NO_PAN' });
  });
  test('a PAN in the wrong format blocks approval', () => {
    expect(kycApprovalBlocker({ ...ok, panNumber: '12345' })).toMatchObject({ code: 'KYC_NO_PAN' });
  });
  test('a lower-case PAN with spaces is still accepted', () => {
    expect(kycApprovalBlocker({ ...ok, panNumber: ' abcde1234f ' })).toBeNull();
  });
  test('documents are reported first when both are missing', () => {
    expect(kycApprovalBlocker({ kycDocumentUrls: [], panNumber: null })).toMatchObject({ code: 'KYC_NO_DOCUMENTS' });
  });
});
