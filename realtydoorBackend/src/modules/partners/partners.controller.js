const { success, created } = require('../../utils/ApiResponse');
const { parsePagination, paginate } = require('../../utils/pagination');
const service = require('./partners.service');
const {
  updateProfileSchema,
  updateSettingsSchema,
  updateBankAccountSchema,
  createSupportTicketSchema,
  acceptTermsSchema,
  createPayoutAccountSchema,
} = require('./partners.validator');
const ApiError = require('../../utils/ApiError');

const VALID_LISTING_STATUSES = ['PENDING_APPROVAL', 'APPROVED', 'REJECTED'];

async function acceptTerms(req, res, next) {
  try {
    const { version } = acceptTermsSchema.parse(req.body);
    const result = await service.acceptPartnerTerms(req.user.id, version, req.ip);
    success(res, result, 'Terms accepted');
  } catch (err) { next(err); }
}

async function recordKycConsent(req, res, next) {
  try {
    const result = await service.recordKycConsent(req.user.id);
    success(res, result, 'KYC consent recorded');
  } catch (err) { next(err); }
}

async function submitKyc(req, res, next) {
  try {
    const documentUrls = req.files?.map((f) => f.path) || [];
    const result = await service.submitKyc(req.user.id, documentUrls);
    success(res, result, 'KYC submitted for review. Usually verified within 24 hours.');
  } catch (err) { next(err); }
}

async function getProfile(req, res, next) {
  try {
    const profile = await service.getProfile(req.user.id);
    success(res, profile);
  } catch (err) { next(err); }
}

async function updateProfile(req, res, next) {
  try {
    const data = updateProfileSchema.parse(req.body);
    const profile = await service.updateProfile(req.user.id, data);
    success(res, profile, 'Profile updated');
  } catch (err) { next(err); }
}

async function uploadProfilePhoto(req, res, next) {
  try {
    if (!req.file) throw new ApiError(400, 'A photo file is required');
    const profile = await service.uploadProfilePhoto(req.user.id, req.file.path);
    success(res, profile, 'Profile photo updated');
  } catch (err) { next(err); }
}

async function getListing(req, res, next) {
  try {
    const listing = await service.getListing(req.user.id, req.params.id);
    success(res, listing);
  } catch (err) { next(err); }
}

async function getMyListings(req, res, next) {
  try {
    const { status } = req.query;
    if (status && !VALID_LISTING_STATUSES.includes(status)) {
      throw new ApiError(400, `Invalid status. Must be one of: ${VALID_LISTING_STATUSES.join(', ')}`);
    }
    const listings = await service.getMyListings(req.user.id, status);
    success(res, listings);
  } catch (err) { next(err); }
}

async function getFinanceSummary(req, res, next) {
  try {
    const summary = await service.getFinanceSummary(req.user.id);
    success(res, summary);
  } catch (err) { next(err); }
}

async function getRatings(req, res, next) {
  try {
    const ratings = await service.getRatings(req.user.id);
    success(res, ratings);
  } catch (err) { next(err); }
}

async function getAnalytics(req, res, next) {
  try {
    const analytics = await service.getPartnerAnalytics(req.user.id);
    success(res, analytics);
  } catch (err) { next(err); }
}

async function getSettings(req, res, next) {
  try {
    const settings = await service.getSettings(req.user.id);
    success(res, settings);
  } catch (err) { next(err); }
}

async function updateSettings(req, res, next) {
  try {
    const data     = updateSettingsSchema.parse(req.body);
    const settings = await service.updateSettings(req.user.id, data);
    success(res, settings, 'Settings saved');
  } catch (err) { next(err); }
}

async function getBankAccount(req, res, next) {
  try {
    const bank = await service.getBankAccount(req.user.id);
    success(res, bank);
  } catch (err) { next(err); }
}

async function updateBankAccount(req, res, next) {
  try {
    const data = updateBankAccountSchema.parse(req.body);
    const bank = await service.updateBankAccount(req.user.id, data);
    success(res, bank, 'Bank account updated');
  } catch (err) { next(err); }
}

async function getPayoutAccount(req, res, next) {
  try {
    success(res, await service.getPayoutAccount(req.user.id));
  } catch (err) { next(err); }
}

async function createPayoutAccount(req, res, next) {
  try {
    const data = createPayoutAccountSchema.parse(req.body);
    const result = await service.createPayoutAccount(req.user.id, data);
    created(res, result, result.payoutAccountStatus === 'ACTIVE'
      ? 'Payout account registered and verified'
      : 'Payout account registered — under review');
  } catch (err) { next(err); }
}

async function getSupportTickets(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { data, total } = await service.getSupportTickets(req.user.id, req.query, skip, limit);
    success(res, paginate(data, total, page, limit));
  } catch (err) { next(err); }
}

async function getSupportTicketById(req, res, next) {
  try {
    const ticket = await service.getSupportTicketById(req.user.id, req.params.id);
    success(res, ticket);
  } catch (err) { next(err); }
}

async function createSupportTicket(req, res, next) {
  try {
    const data   = createSupportTicketSchema.parse(req.body);
    const ticket = await service.createSupportTicket(req.user.id, data);
    created(res, ticket, 'Support ticket raised');
  } catch (err) { next(err); }
}

module.exports = {
  acceptTerms, recordKycConsent, submitKyc, getProfile, updateProfile, uploadProfilePhoto, getListing, getMyListings,
  getFinanceSummary, getAnalytics, getRatings,
  getSettings, updateSettings,
  getBankAccount, updateBankAccount,
  getPayoutAccount, createPayoutAccount,
  getSupportTickets, getSupportTicketById, createSupportTicket,
};
