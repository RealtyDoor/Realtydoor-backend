'use strict';

// What the system needs from Clerk, written as code (audit Nov 2026, go-live). The dashboard cannot be edited from code, so this file is
// the one place that says what every Clerk instance (development "Realtydoor Live" and its production instance) must look like;
// `node scripts/printClerkChecklist.js` prints it as a checklist to apply and tick, and tests/unit/clerkManifest.test.js fails if the
// code and this file disagree (webhook events, roles, the fields our signup sends, the redirect paths).
// "source" says where a value comes from: CODE (the app depends on it), OBSERVED (read on the working "Realtydoor" development
// instance on 16 Nov 2026) or DECIDED (a branding or policy choice).

const application = { name: 'Realtydoor Live', type: 'Consumer (not B2B: B2B turns on Organizations)', plan: 'Pro (needed for branding removal, session lifetime, multi-factor)' };

// The webhook the backend serves: src/modules/webhooks/clerk.handler.js (svix signature, CLERK_WEBHOOK_SECRET).
const webhook = { path: '/api/webhooks/clerk', events: ['user.created', 'user.updated', 'user.deleted'] };

// Roles live in the database; Clerk's public metadata only mirrors them (the database is the authority).
const roles = ['USER', 'PARTNER', 'ADMIN'];

// What our own signup (auth.service.js createAccount) sends to Clerk's createUser. Clerk must accept every one of these.
const createUserFields = ['emailAddress', 'username', 'password', 'firstName', 'lastName', 'publicMetadata'];

// Frontend paths (admin-nextjs/.env.example) and where they are set in Clerk.
const paths = {
  NEXT_PUBLIC_CLERK_SIGN_IN_URL: '/sign-in',
  NEXT_PUBLIC_CLERK_SIGN_UP_URL: '/user/sign-up',
  NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL: '/user/dashboard',
  NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL: '/user/sso-callback',
};

const settings = [
  // User & authentication
  { area: 'User & authentication > Email', setting: 'Sign-up with email', value: 'off', source: 'OBSERVED', note: 'Our own screens create the account; the email is still stored on the user.' },
  { area: 'User & authentication > Email', setting: 'Sign-in with email', value: 'off', source: 'OBSERVED' },
  { area: 'User & authentication > Phone', setting: 'Sign-in with phone (with SMS verification code)', value: 'on', source: 'OBSERVED', note: 'Pro feature. Sign-up with phone stays off.' },
  { area: 'User & authentication > Username', setting: 'Username attribute', value: 'the instance must accept a username when our signup creates a user', source: 'CODE', risk: 'Our signup sends a generated username to createUser, but on the development instance both Username toggles (sign-up and sign-in) were off. If Clerk then refuses the field, phone signup fails. Prove with one test phone sign-up (audit A8); if refused, turn the Username attribute on here.' },
  { area: 'User & authentication > Password', setting: 'Sign-up with password', value: 'on', source: 'CODE', note: 'Our signup sends a generated strong password.' },
  { area: 'User & authentication > Password', setting: 'Add password to account', value: 'on', source: 'OBSERVED' },
  { area: 'User & authentication > Password', setting: 'Minimum length / reject compromised passwords / enforce strength', value: '8 characters / on / on', source: 'OBSERVED' },
  { area: 'User & authentication > Password', setting: 'Device Trust', value: 'enabled', source: 'OBSERVED' },
  { area: 'User & authentication > User model', setting: 'First and last name', value: 'on and required', source: 'OBSERVED', note: 'Signup sends firstName and lastName.' },
  { area: 'User & authentication > User model', setting: 'Allow users to delete their account / change their phone number', value: 'on / on', source: 'OBSERVED', note: 'Account deletion is also handled by our own 30-day process; Clerk deletion fires user.deleted.' },
  { area: 'User & authentication > SSO connections', setting: 'Google (social provider, used for sign-in)', value: 'on, with OUR OWN Google OAuth client in production', source: 'CODE', note: 'Shared credentials only work in development. Add the redirect URI Clerk shows (https://clerk.<domain>/v1/oauth_callback) to the Google client; a person pastes the client id and secret.' },
  { area: 'User & authentication > Multi-factor', setting: 'Authenticator app (TOTP)', value: 'on', source: 'DECIDED', note: 'The admin sign-in screen promises a code from an authenticator app. Pro feature. Not read on the development instance: confirm it.' },
  { area: 'User & authentication > Access mode', setting: 'Access mode', value: 'Open', source: 'OBSERVED' },
  // Sessions
  { area: 'Sessions', setting: 'Session lifetime', value: 'not set here', source: 'CODE', note: 'The 30-minute idle sign-out is done by the app (admin and partner screens). Not read on the development instance: confirm the Clerk lifetime is not shorter than a working day.' },
  // Account portal
  { area: 'Account Portal > Customization', setting: 'Color mode', value: 'Light', source: 'DECIDED' },
  { area: 'Account Portal > Customization', setting: 'Light mode primary color', value: '#2C2FEE', source: 'DECIDED', note: "The app's blue (--color-primary in globals.css)." },
  { area: 'Application settings > Branding', setting: 'Logo / favicon', value: 'public/pwa/icon-512.png / public/pwa/icon-192.png', source: 'DECIDED', note: 'The Realtydoor mark. Clerk takes png, jpeg, gif, webp (not svg).' },
  { area: 'Application settings > Branding', setting: 'Remove "Secured by Clerk" branding', value: 'on (Pro)', source: 'OBSERVED' },
  { area: 'Application settings > Application details', setting: 'Application name / support email', value: 'Realtydoor / support@realtydoor.com', source: 'OBSERVED' },
  // Webhooks
  { area: 'Developers > Webhooks', setting: `Endpoint https://<api host>${webhook.path}`, value: `events ${webhook.events.join(', ')}`, source: 'CODE', note: 'Copy the signing secret into CLERK_WEBHOOK_SECRET. Needs the public API host, so it comes after DNS and the server exist.' },
];

module.exports = { application, webhook, roles, createUserFields, paths, settings };
