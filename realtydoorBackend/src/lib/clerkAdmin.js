const { createClerkClient } = require('@clerk/clerk-sdk-node');
const prisma = require('./prisma');
const logger = require('./logger');

const clerkAdmin = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

async function setUserRole(clerkId, role) {
  return clerkAdmin.users.updateUserMetadata(clerkId, { publicMetadata: { role } });
}

async function getClerkUser(clerkId) {
  return clerkAdmin.users.getUser(clerkId);
}

// Shared write path for profile edits and the phone-verification flow — keeps
// the DB row and Clerk's publicMetadata.phone in lockstep (B7). Clerk merges
// publicMetadata shallowly, so this never clobbers role or other keys.
async function syncUserFields(dbId, { name, email, phone } = {}) {
  const data = {};
  if (name !== undefined)  data.name = name;
  if (email !== undefined) data.email = email;
  if (phone !== undefined) data.phone = phone;

  const user = await prisma.user.update({ where: { id: dbId }, data });

  if (phone !== undefined) {
    await clerkAdmin.users.updateUserMetadata(user.clerkId, { publicMetadata: { phone } }).catch((err) => {
      logger.warn('[syncUserFields] Clerk metadata update failed', { clerkId: user.clerkId, error: err.message });
    });
  }

  return user;
}

module.exports = { clerkAdmin, setUserRole, getClerkUser, syncUserFields };
