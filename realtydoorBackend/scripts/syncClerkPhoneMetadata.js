/**
 * B9 — one-time sync.
 *
 * Pushes phone into Clerk publicMetadata for every user who already has a
 * verified phone in our DB but predates this change (so Clerk's metadata
 * never got the phone written to it). Run once, after deploying:
 *
 *   node scripts/syncClerkPhoneMetadata.js
 *
 * Idempotent — re-running just re-sends the same value for already-synced users.
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { createClerkClient } = require('@clerk/clerk-sdk-node');

const prisma = new PrismaClient();
const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

async function main() {
  const users = await prisma.user.findMany({
    where: { phoneVerified: true, phone: { not: null } },
    select: { id: true, clerkId: true, phone: true },
  });

  let synced = 0;
  let failed = 0;

  for (const user of users) {
    try {
      await clerk.users.updateUserMetadata(user.clerkId, { publicMetadata: { phone: user.phone } });
      synced += 1;
    } catch (err) {
      failed += 1;
      console.error(`Failed for clerkId=${user.clerkId} (userId=${user.id}): ${err.message}`);
    }
  }

  console.log(`Synced ${synced} user(s) to Clerk. ${failed} failure(s).`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
