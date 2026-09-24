const { createClerkClient } = require('@clerk/clerk-sdk-node');
const prisma = require('../lib/prisma');
const ApiError = require('../utils/ApiError');

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
      req.user = { ...dbUser, onboardingComplete: dbUser.phoneVerified === true };
      return next();
    }

    const token = req.headers.authorization?.split(' ')[1];
    if (!token) throw new ApiError(401, 'No token provided');

    // payload.role is populated when a Clerk JWT Template is configured:
    // Template body: { "role": "{{user.public_metadata.role}}" }
    // Without the template, role falls back to the DB value (safe default).
    const payload = await clerk.verifyToken(token);
    const clerkId = payload.sub;

    const dbUser = await prisma.user.findUnique({ where: { clerkId } });
    if (!dbUser) throw new ApiError(401, 'User not registered — call POST /api/auth/sync first');
    if (dbUser.isSuspended) throw new ApiError(403, 'Your account has been suspended. Contact support@realtydoor.in');

    // Verified phone, or still inside the pre-migration grace window (B9 backfill).
    const onboardingComplete = dbUser.phoneVerified === true
      || (!!dbUser.phoneVerifyDeadline && new Date() < new Date(dbUser.phoneVerifyDeadline));

    req.user = { ...dbUser, role: payload.role || dbUser.role, onboardingComplete };
    next();
  } catch (err) {
    next(err instanceof ApiError ? err : new ApiError(401, 'Invalid token'));
  }
}

module.exports = { authenticate };
