const axios = require('axios');
const logger = require('./logger');

// 5.x — KYC automation: automated PAN/GSTIN/RERA registry checks, built
// against Karza Technologies' (now part of Perfios) commonly documented
// REST conventions — a single API-key header, one POST endpoint per
// document type, JSON in/out. Chosen because it's a well-known Indian
// KYC-verification aggregator that covers exactly this bundle (PAN, GSTIN,
// RERA search, and Aadhaar eKYC for later).
//
// IMPORTANT — unlike everything else in this codebase, this was never
// tested against a real vendor account: no API credentials were available
// to verify it live. The exact endpoint paths and response field names
// below are a best-effort reconstruction from Karza's commonly documented
// API shape, not a confirmed integration. Check them against Karza's
// actual current API docs before this is ever enabled against a real
// account.
//
// Safe by construction: every function below returns NOT_CONFIGURED and
// makes no network call at all unless KYC_VERIFICATION_API_KEY is set.
// Nothing about today's fully-manual KYC review changes until that env var
// is deliberately added — this is advisory input into the admin's manual
// decision (User.kycStatus), never a replacement for it; nothing here
// auto-approves or auto-rejects a partner.
//
// Swapping to a different vendor later only means rewriting this file's
// request/response shapes — callers (partners.service.js's
// runAutomatedKycChecks) never see the vendor-specific payload.

const BASE_URL = process.env.KYC_VERIFICATION_BASE_URL || 'https://api.karza.in';
const API_KEY = process.env.KYC_VERIFICATION_API_KEY;

function isConfigured() {
  return !!API_KEY;
}

async function callVendor(path, body) {
  const res = await axios.post(`${BASE_URL}${path}`, body, {
    headers: { 'x-karza-key': API_KEY, 'Content-Type': 'application/json' },
    timeout: 15000,
  });
  return res.data;
}

// A registry name routinely differs from what a partner typed by spacing,
// case, or word order (e.g. a middle initial) — exact string equality
// would flag almost every real match as a mismatch.
function looseNameMatch(a, b) {
  if (!a || !b) return false;
  const norm = (s) => s.toLowerCase().replace(/[^a-z\s]/g, '').trim().split(/\s+/).filter(Boolean).sort().join(' ');
  return norm(a) === norm(b);
}

async function verifyPan(panNumber, nameToMatch) {
  if (!isConfigured()) return { status: 'NOT_CONFIGURED', verifiedName: null };
  try {
    const data = await callVendor('/v3/pan/basicplus', { pan: panNumber });
    const registryName = data?.result?.user_full_name || data?.name || null;
    if (!registryName) return { status: 'NOT_FOUND', verifiedName: null };
    const status = nameToMatch && !looseNameMatch(registryName, nameToMatch) ? 'NAME_MISMATCH' : 'VERIFIED';
    return { status, verifiedName: registryName };
  } catch (err) {
    logger.warn('[KYC] PAN verification call failed', { error: err.message });
    return { status: 'FAILED', verifiedName: null };
  }
}

async function verifyGstin(gstin) {
  if (!isConfigured()) return { status: 'NOT_CONFIGURED', verifiedName: null };
  try {
    const data = await callVendor('/v2/gstin-advanced', { gstin });
    const legalName = data?.result?.lgnm || data?.legalName || null;
    if (!legalName) return { status: 'NOT_FOUND', verifiedName: null };
    return { status: 'VERIFIED', verifiedName: legalName };
  } catch (err) {
    logger.warn('[KYC] GSTIN verification call failed', { error: err.message });
    return { status: 'FAILED', verifiedName: null };
  }
}

async function verifyRera(reraNumber, state) {
  if (!isConfigured()) return { status: 'NOT_CONFIGURED', verifiedName: null };
  try {
    const data = await callVendor('/v1/rera/search', { reraNumber, state });
    const entityName = data?.result?.promoterName || data?.entityName || null;
    if (!entityName) return { status: 'NOT_FOUND', verifiedName: null };
    return { status: 'VERIFIED', verifiedName: entityName };
  } catch (err) {
    logger.warn('[KYC] RERA verification call failed', { error: err.message });
    return { status: 'FAILED', verifiedName: null };
  }
}

module.exports = { isConfigured, verifyPan, verifyGstin, verifyRera };
