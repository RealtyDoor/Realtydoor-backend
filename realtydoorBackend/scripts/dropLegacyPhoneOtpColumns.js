/**
 * B9 — phase 2 (do NOT run right after this deploy).
 *
 * MongoDB is schemaless: removing phoneOtp/phoneOtpExpiresAt/phoneOtpAttempts/
 * phoneOtpLockedUntil from prisma/schema/user.prisma does not strip those
 * fields from existing documents. This script does that cleanup with $unset.
 *
 * Run only after:
 *   1. This deploy (PhoneOtp table + new auth endpoints) has been live and
 *      stable for a while — the columns are already unused by any code path.
 *   2. The four fields have been removed from prisma/schema/user.prisma in a
 *      follow-up change and `prisma generate` has been re-run.
 *
 *   node scripts/dropLegacyPhoneOtpColumns.js
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const result = await prisma.$runCommandRaw({
    update: 'User',
    updates: [
      {
        q: {},
        u: { $unset: { phoneOtp: '', phoneOtpExpiresAt: '', phoneOtpAttempts: '', phoneOtpLockedUntil: '' } },
        multi: true,
      },
    ],
  });

  console.log('Legacy phoneOtp* fields removed from User documents.', result);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
