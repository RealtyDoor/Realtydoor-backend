'use strict';

// One support email for everyone (buyers, partners, admins), the same one the apps show. SUPPORT_EMAIL overrides it per deployment.
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'info@realtydoor.com';
const SUSPENDED_MESSAGE = `Your account has been suspended. Contact ${SUPPORT_EMAIL}`;

module.exports = { SUPPORT_EMAIL, SUSPENDED_MESSAGE };
