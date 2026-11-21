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
  { area: 'User & authentication > Email', setting: 'Sign-up with email (Require email address, Verify at sign-up)', value: 'on, address required, verify on', source: 'CODE', note: 'PROVEN 16 Nov 2026 against the Clerk API: with the Email attribute off, createUser refuses `emailAddress` (422 form_param_unknown), so our phone signup cannot create an account. The working development instance had it off (read as "off" on 16 Nov), which means phone signup is broken there; fix by turning this on. Users created by our API are not asked to verify.' },
  { area: 'User & authentication > Email', setting: 'Sign-in with email', value: 'on', source: 'CODE', note: 'The admin console signs in with work email and password (and Google Workspace); the email identifier must exist.' },
  { area: 'User & authentication > Phone', setting: 'Sign-in with phone (with SMS verification code)', value: 'on', source: 'OBSERVED', note: 'Pro feature. Sign-up with phone stays off.' },
  { area: 'User & authentication > Username', setting: 'Username attribute', value: 'both toggles may stay off', source: 'CODE', note: 'PROVEN 16 Nov 2026 against the Clerk API on the working development instance: createUser with a generated username is accepted and stored while both Username toggles are off.' },
  { area: 'User & authentication > Password', setting: 'Sign-up with password', value: 'on', source: 'CODE', note: 'Our signup sends a generated strong password.' },
  { area: 'User & authentication > Password', setting: 'Add password to account', value: 'on', source: 'OBSERVED' },
  { area: 'User & authentication > Password', setting: 'Minimum length / reject compromised passwords / enforce strength', value: 'Clerk defaults: 10 characters / on / off', source: 'DECIDED', note: 'The old instance had 8 / on / on. Clerk itself recommends a longer minimum and no strength meter; our code creates passwords itself (long and random), so the stricter default is kept.' },
  { area: 'User & authentication > Password', setting: 'Device Trust', value: 'enabled', source: 'OBSERVED' },
  { area: 'User & authentication > User model', setting: 'First and last name', value: 'on and required', source: 'OBSERVED', note: 'Signup sends firstName and lastName.' },
  { area: 'User & authentication > User model', setting: 'Allow users to delete their account / change their phone number', value: 'on / on', source: 'OBSERVED', note: 'Account deletion is also handled by our own 30-day process; Clerk deletion fires user.deleted.' },
  { area: 'User & authentication > SSO connections', setting: 'Google (social provider, used for sign-in)', value: 'on, with OUR OWN Google OAuth client in production', source: 'CODE', note: 'Shared credentials only work in development. Add the redirect URI Clerk shows (https://clerk.<domain>/v1/oauth_callback) to the Google client; a person pastes the client id and secret.' },
  { area: 'User & authentication > Multi-factor', setting: 'Authenticator app (TOTP)', value: 'on ("Require multi-factor" stays off: it would force every user)', source: 'DECIDED', note: 'The admin sign-in screen promises a code from an authenticator app. Pro feature.' },
  { area: 'User & authentication > Access mode', setting: 'Access mode', value: 'Open', source: 'OBSERVED' },
  // Sessions
  { area: 'Sessions', setting: 'Session lifetime', value: 'not set here', source: 'CODE', note: 'The 30-minute idle sign-out is done by the app (admin and partner screens). Not read on the development instance: confirm the Clerk lifetime is not shorter than a working day.' },
  // Account portal
  { area: 'Account Portal > Customization', setting: 'Color mode', value: 'Light', source: 'DECIDED' },
  { area: 'Account Portal > Customization', setting: 'Light mode primary color', value: '#2C2FEE', source: 'DECIDED', note: "The app's blue (--color-primary in globals.css)." },
  { area: 'Application settings > Branding', setting: 'Logo / favicon', value: 'public/pwa/icon-512.png / public/pwa/icon-192.png', source: 'DECIDED', note: 'The Realtydoor mark. Clerk takes png, jpeg, gif, webp (not svg).' },
  { area: 'Application settings > Branding', setting: 'Remove "Secured by Clerk" branding', value: 'on (Pro)', source: 'OBSERVED' },
  { area: 'Application settings > Application details', setting: 'Application name / support email', value: 'Realtydoor Live while there are two applications (rename to Realtydoor once the old one is retired) / support@realtydoor.com', source: 'DECIDED' },
  // Webhooks
  { area: 'Developers > Webhooks', setting: `Endpoint https://<api host>${webhook.path}`, value: `events ${webhook.events.join(', ')}`, source: 'CODE', note: 'Copy the signing secret into CLERK_WEBHOOK_SECRET. Needs the public API host, so it comes after DNS and the server exist.' },
];

// What has been applied from this file, so the next person knows what is left. The settings that need a person or a later step stay open.
const applied = [
  { instance: 'Realtydoor Live, development (ins_3KxuPGjUlel9SZKFozrJynnqjha)', on: '2026-11-16', done: 'email sign-up (required, verified) and sign-in on, after first copying the old instance and finding that wrong; phone sign-in on with SMS code (sign-up off); first and last name required; authenticator app on; access mode open; account portal light mode and #2C2FEE; logo, favicon, support email; Secured-by-Clerk removed', notDone: 'session lifetime not read; production instance, own Google client and webhook (need DNS and the API host first)' },
];

module.exports = { applied, application, webhook, roles, createUserFields, paths, settings };
