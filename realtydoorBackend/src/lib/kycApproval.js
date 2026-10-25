const { isValidPan } = require('./moneyModel');

// Why a partner's KYC cannot be approved yet, or null when it can. A partner without a saved PAN number has their commission
// taxed at the higher no-PAN rate, so the PAN is checked at approval, not found out at release.
function kycApprovalBlocker(user) {
  if (!(user?.kycDocumentUrls?.length)) {
    return { code: 'KYC_NO_DOCUMENTS', message: 'Cannot verify KYC: this partner has not uploaded any documents' };
  }
  if (!isValidPan(user.panNumber)) {
    return { code: 'KYC_NO_PAN', message: 'Cannot verify KYC: this partner has no valid PAN number saved. Ask them to add it under Tax details first.' };
  }
  return null;
}

module.exports = { kycApprovalBlocker };
