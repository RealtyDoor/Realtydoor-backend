const { PrismaClient } = require('@prisma/client');
const { extension: appendOnly } = require('./immutability');

const logLevels = ['warn', 'error'];
if (process.env.PRISMA_QUERY_LOG === 'true') logLevels.push('query');

// Audit and ledger rows can only be created (see lib/immutability.js).
const prisma = global.__prisma ?? new PrismaClient({ log: logLevels }).$extends(appendOnly);

if (process.env.NODE_ENV !== 'production') {
  global.__prisma = prisma;
}

module.exports = prisma;
