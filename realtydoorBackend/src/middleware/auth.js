const { createClerkClient } = require('@clerk/clerk-sdk-node');
const prisma = require('../lib/prisma');
const ApiError = require('../utils/ApiError');
const { computeOnboardingComplete } = require('../lib/onboarding');
const authService = require('../modules/auth/auth.service');

const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

async function authenticate(req, res, next) {
  try {
    // Dev API-key bypass — never active in production
    if (
      process.env.NODE_ENV !== 'production' &&
      process.env.DEV_API_KEY &&
      req.headers['x-dev-api-key'] === process.env.DEV_API_KEY
    ) {
      const email = req.headers['x-dev-user-email'];
      const dbUser = await prisma.user.findUnique({ where: { email } });
      if (!dbUser) throw new ApiError(401, `Dev bypass: no user with email ${email}`);
      req.user = { ...dbUser, onboardingComplete: computeOnboardingComplete(dbUser) };
      return next();
    }

    const token = req.headers.authorization?.split(' ')[1];
    if (!token) throw new ApiError(401, 'No token provided');

    const payload = await clerk.verifyToken(token);
    const clerkId = payload.sub;

    let dbUser = await prisma.user.findUnique({ where: { clerkId } });

    if (!dbUser) {
      // Every authenticated request goes through here (the proxy, server-side
      // fetches, client fetches, Postman, any future mobile client) — so
      // creating the row here, on demand, with the exact same logic as
      // POST /auth/sync (collision checks, consent stamping, etc. — see
      // auth.service.js's syncUserByClerkId), covers all of them from one
      // place. Without this, every one of those call sites would need its
      // own 401-then-sync-then-retry handling, and a replayed POST/PATCH
      // body on retry risks a double-submit. This also means a
      // suspended/collided user's real error (EXISTING_USER, PHONE_IN_USE,
      // EMAIL_REQUIRED, a suspension 403) can now surface from whichever
      // route they hit first, not only from /auth/sync — the sync logic
      // already throws the same coded ApiErrors either way, so the response
      // shape doesn't change, only which endpoint the client happens to see
      // it from.
      //
      // Calls syncUserByClerkId (not syncUser) with the clerkId/payload
      // already verified two lines above — syncUser itself would re-verify
      // the same token from scratch, a redundant Clerk call on this path.
      const clerkUser = await clerk.users.getUser(clerkId);
      const synced = await authService.syncUserByClerkId(clerkId, clerkUser);
      req.user = { ...synced.user, role: synced.user.role, onboardingComplete: synced.onboardingComplete };
      return next();
    }

    // A row with deletedAt set is kept only so existing foreign keys
    // (properties, leads, tickets they owned) stay valid — it must never be
    // usable to authenticate again, same as if the row were actually gone.
    if (dbUser.deletedAt) throw new ApiError(401, 'Invalid token');
    if (dbUser.isSuspended) throw new ApiError(403, 'Your account has been suspended. Contact support@realtydoor.in');

    // Trust the DB role, never the token's — a Clerk JWT Template can embed
    // publicMetadata.role, but that snapshot only refreshes when the token
    // does. Relying on it meant a just-upgraded partner got 403s on partner
    // routes (and a just-demoted user kept partner access) until the old
    // token expired. The DB is the single source of truth for role.
    req.user = { ...dbUser, role: dbUser.role, onboardingComplete: computeOnboardingComplete(dbUser) };
    next();
  } catch (err) {
    next(err instanceof ApiError ? err : new ApiError(401, 'Invalid token'));
  }
}

module.exports = { authenticate };
