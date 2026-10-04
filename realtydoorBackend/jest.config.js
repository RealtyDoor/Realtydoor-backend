// Unit tests only, for now — pure functions with no database access
// (commission math, geo/distance, the permission matrix, PDF generation,
// the KYC-verification no-op path). None of these import anything that
// issues a Prisma query, so no test database is needed or set up here.
// A real DB-integration suite (actually hitting MongoDB) is a separate,
// bigger decision — mocking Prisma vs. a dedicated test database vs.
// running against a disposable Atlas cluster — deliberately not made here.
module.exports = {
  testEnvironment: 'node',
  setupFiles: ['dotenv/config'],
  testMatch: ['**/tests/**/*.test.js'],
  testPathIgnorePatterns: ['/node_modules/'],
  clearMocks: true,
};
