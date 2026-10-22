const fs = require('fs');
const path = require('path');
const { SAMPLE_EMAILS } = require('../../scripts/removeSampleTeam');

describe('sample team members (T50)', () => {
  test('the seed no longer creates them', () => {
    const seed = fs.readFileSync(path.join(__dirname, '../../prisma/seed.js'), 'utf8');
    for (const email of SAMPLE_EMAILS) expect(seed.includes(email)).toBe(false);
    for (const name of ['Vikram Nair', 'Shreya Gupta', 'Arun Menon']) expect(seed.includes(name)).toBe(false);
  });
  test('the clean-up script names exactly the three sample emails', () => {
    expect(SAMPLE_EMAILS).toEqual(['vikram@realtydoor.com', 'shreya@realtydoor.com', 'arun@realtydoor.com']);
  });
});
