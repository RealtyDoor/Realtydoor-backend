const { shouldRunJobs, JOB_MODULES } = require('../../src/jobs');

describe('RUN_JOBS flag (T54)', () => {
  it('runs jobs when unset or true', () => {
    expect(shouldRunJobs({})).toBe(true);
    expect(shouldRunJobs({ RUN_JOBS: 'true' })).toBe(true);
  });
  it.each(['false', 'FALSE', '0', 'no', 'off'])('skips jobs for %s', (v) => {
    expect(shouldRunJobs({ RUN_JOBS: v })).toBe(false);
  });
  it('every listed job exports start()', () => {
    JOB_MODULES.forEach((m) => expect(typeof require('../../src/jobs/' + m.slice(2)).start).toBe('function'));
  });
});
