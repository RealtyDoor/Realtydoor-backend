const { parseIndiaDate, parsePhone, mapSource, mapStage, saysNotInterested, mapBuildeskRow, sortIntoGroup, planBulk, toLeadData } = require('../../src/lib/bulkLeads');
const { LIVE_LEADS, inPool, isInPool, liveSince, onlyLive } = require('../../src/lib/poolLeads');

const row = (o = {}) => ({ Ref_No: '1001', Lead_Date: '23/11/2026 14:05', Lead_Name: 'Test Buyer', Mobile_CC: '+91', Mobile: '9876543210', Email: 'A@B.com', Stage: 'OPEN', Source: 'FB', Executive: 'Old Exec', ...o });

describe('parsing', () => {
  test('dates are day first, India time', () => {
    expect(parseIndiaDate('23/11/2026 14:05').toISOString()).toBe('2026-11-23T08:35:00.000Z');
    expect(parseIndiaDate('01/02/2024').toISOString()).toBe('2024-01-31T18:30:00.000Z');
    expect(parseIndiaDate('31/13/2024')).toBeNull();
    expect(parseIndiaDate('')).toBeNull();
    expect(parseIndiaDate('nonsense')).toBeNull();
  });
  test('phones become E.164 or null', () => {
    expect(parsePhone('+91', '9876543210')).toBe('+919876543210');
    expect(parsePhone('', '09876543210')).toBe('+919876543210');
    expect(parsePhone('+91', '123')).toBeNull();
    expect(parsePhone('+91', '')).toBeNull();
  });
  test('IMS is hoarding calls; unknown sources stay OTHER with the raw value kept', () => {
    expect(mapSource('IMS').source).toBe('HOARDING');
    expect(mapSource('FB').source).toBe('FACEBOOK');
    expect(mapSource('IVR').source).toBe('PHONE');
    const ads = mapSource('IMS-ADS', 'x');
    expect(ads.source).toBe('OTHER');
    expect(ads.sourceDetail).toBe('IMS-ADS / x');
  });
  test('not interested / wrong number remarks are caught', () => {
    expect(saysNotInterested('Customer said Not Interested')).toBe(true);
    expect(saysNotInterested('wrong number')).toBe(true);
    expect(saysNotInterested('no answer, call again')).toBe(false);
  });
});

describe('stages', () => {
  test('open is new; followup is contacted with no follow-up date', () => {
    expect(mapStage('OPEN').salesStage).toBe('NEW');
    const f = mapBuildeskRow(row({ Stage: 'ON FOLLOWUP' }));
    expect(f.stage.salesStage).toBe('CONTACTED');
    expect(f.data.nextFollowUpAt).toBeUndefined();
  });
  test('booked and negotiation are qualified and hot', () => {
    for (const s of ['BOOKED', 'NEGOTIATION']) expect(mapStage(s)).toMatchObject({ salesStage: 'QUALIFIED', temperature: 'HOT' });
  });
  test('inactive, spam, irrelevant are dropped; location and budget issues are not qualified', () => {
    expect(mapStage('INACTIVE').dropped).toBe(true);
    expect(mapStage('OPEN', 'Spam').dropped).toBe(true);
    expect(mapStage('OPEN', 'Irrelevant ').dropped).toBe(true);
    expect(mapStage('OPEN', 'Location Issue')).toMatchObject({ salesStage: 'NOT_QUALIFIED', dropped: false });
    expect(mapStage('OPEN', 'Budget Issue').salesStage).toBe('NOT_QUALIFIED');
  });
});

describe('mapping and safety', () => {
  test('createdAt is never set; the old date is originalLeadAt; no live clocks are copied', () => {
    const m = mapBuildeskRow(row({ Campaign_Name: 'Green Park' }));
    expect(m.data.createdAt).toBeUndefined();
    expect(m.data.originalLeadAt.toISOString()).toBe('2026-11-23T08:35:00.000Z');
    for (const k of ['campaign', 'contactAttempts', 'assignedPartnerId', 'buyerConsentAt', 'ownerStaffId']) expect(m.data[k]).toBeUndefined();
    expect(m.data.status).toBe('UNASSIGNED');
    expect(m.data.buyerEmail).toBe('a@b.com');
    expect(m.data.intakeAnswers.buildesk_campaign).toBe('Green Park');
    expect(m.data.intakeAnswers.legacy_executive).toBe('Old Exec');
  });
  test('budget only when not zero; remarks become back-dated notes', () => {
    expect(mapBuildeskRow(row({ Min_Budget: 0, Max_Budget: 0 })).data.budget).toBeNull();
    expect(mapBuildeskRow(row({ Min_Budget: 5000000, Max_Budget: 7000000 })).data.budget).toBe('5000000 - 7000000');
    const m = mapBuildeskRow(row({ Remark: 'wants 2bhk', Last_Activity: 'called', Last_Activity_Date: '01/11/2026 10:00', Conducted_SiteVisit_Count: 2 }));
    expect(m.notes.map((n) => n.text)).toEqual(expect.arrayContaining(['Remark: wants 2bhk', 'Last activity: called', '2 site visits done in the old CRM.']));
  });
});

describe('groups', () => {
  const g = (o, ctx) => sortIntoGroup(mapBuildeskRow(row(o)), ctx);
  test('plain open lead is B', () => expect(g({}).group).toBe('B'));
  test('strong signals are A (hot, booked, repeat, site visit), with no age limit', () => {
    expect(g({ Category: 'HOT', Lead_Date: '01/01/2021 10:00' }).group).toBe('A');
    expect(g({ Stage: 'BOOKED' }).group).toBe('A');
    expect(g({ Returning: 'Yes' }).group).toBe('A');
    expect(g({ Conducted_SiteVisit_Count: 1 }).group).toBe('A');
  });
  test('not interested beats a strong signal; archive cases are C', () => {
    expect(g({ Stage: 'HOT', Last_Activity: 'Not interested now' }).group).toBe('C');
    expect(g({ Stage: 'INACTIVE' }).group).toBe('C');
    expect(g({ Mobile: '12' })).toMatchObject({ group: 'C', drop: { code: 'INVALID_NUMBER' } });
    expect(g({}, { doNotContact: new Set(['+919876543210']) }).group).toBe('C');
    expect(g({ Stage_Reason: 'Location Issue' }).group).toBe('C');
  });
});

describe('planBulk', () => {
  test('newest row of a phone is callable, older rows are archived duplicates', () => {
    const plan = planBulk([row({ Ref_No: '1', Lead_Date: '01/01/2024 10:00' }), row({ Ref_No: '2', Lead_Date: '01/01/2025 10:00' })], { batch: 'b' });
    const by = Object.fromEntries(plan.items.map((i) => [i.key, i]));
    expect(by['buildesk:2'].group).toBe('B');
    expect(by['buildesk:1']).toMatchObject({ group: 'C', reason: 'Older duplicate of the same phone number' });
  });
  test('a second run writes nothing (idempotent)', () => {
    const rows = [row({ Ref_No: '1' }), row({ Ref_No: '2', Mobile: '9876543211' })];
    const first = planBulk(rows, { batch: 'b' });
    const again = planBulk(rows, { batch: 'b', existingKeys: new Set(first.items.map((i) => i.key)) });
    expect(again.items).toHaveLength(0);
    expect(again.skipped).toHaveLength(2);
  });
  test('the written data carries the batch, group and a dropped status for archived junk', () => {
    const [it] = planBulk([row({ Stage: 'INACTIVE' })], { batch: 'b' }).items;
    const d = toLeadData(it, 'b');
    expect(d).toMatchObject({ poolBatch: 'b', poolGroup: 'C', status: 'DROPPED' });
    expect(d.poolReleasedAt).toBeUndefined();
    expect(d.createdAt).toBeUndefined();
  });
});

describe('pool helpers', () => {
  test('in the pool = batch set and not released', () => {
    expect(isInPool({ poolBatch: 'b' })).toBe(true);
    expect(isInPool({ poolBatch: 'b', poolReleasedAt: new Date() })).toBe(false);
    expect(isInPool({})).toBe(false);
  });
  test('live clocks start at release, else creation', () => {
    const rel = new Date('2026-11-25T00:00:00Z');
    expect(liveSince({ createdAt: new Date('2026-11-24T00:00:00Z'), poolReleasedAt: rel })).toEqual(rel);
    expect(liveSince({ createdAt: rel })).toEqual(rel);
  });
  test('onlyLive keeps the existing conditions', () => {
    expect(onlyLive({ status: 'UNASSIGNED' })).toEqual({ status: 'UNASSIGNED', AND: [LIVE_LEADS] });
    expect(onlyLive({ AND: [{ a: 1 }] }).AND).toHaveLength(2);
    expect(inPool({ batch: 'b', group: 'A' })).toEqual({ poolBatch: 'b', poolReleasedAt: { isSet: false }, poolGroup: 'A' });
  });
});

describe('a pool lead cannot be given to a partner', () => {
  jest.resetModules();
  test('assignLead and autoAssignLead refuse with IN_QUALIFICATION_POOL', async () => {
    jest.doMock('../../src/lib/prisma', () => ({ lead: { findUnique: jest.fn().mockResolvedValue({ id: 'l1', poolBatch: 'b', property: null, escrowTransactions: [] }) } }));
    const svc = require('../../src/modules/admin/admin.service');
    await expect(svc.assignLead('l1', 'p1', 'a1', '1.1.1.1')).rejects.toMatchObject({ statusCode: 409, data: { code: 'IN_QUALIFICATION_POOL' } });
    await expect(svc.autoAssignLead('l1', 'a1', '1.1.1.1')).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('plain contact lists (area lists)', () => {
  const { LIST_PRESET } = require('../../src/lib/bulkLeads');
  const preset = LIST_PRESET({ id: 'ec-2026-03', label: 'Electronic City list', fileDate: '2026-03-10' });
  const lrow = (o = {}) => ({ Name: 'V KUMAR SENTHIL', 'Contact Number': '9876543210', 'Email Id': 'A@B.COM', City: 'Banglore', Location: 'Electronic City', ...o });
  test('every valid new number is call first, with name, email, city and area kept', () => {
    const [it] = planBulk([lrow()], { preset, batch: 'ec' }).items;
    expect(it.group).toBe('B');
    expect(it.data).toMatchObject({ buyerName: 'V Kumar Senthil', buyerEmail: 'a@b.com', buyerPhone: '+919876543210', city: 'Bengaluru', propertyInterest: 'Electronic City', source: 'OTHER' });
    expect(it.data.intakeAnswers).toMatchObject({ list_name: 'Electronic City list', list_location: 'Electronic City' });
    expect(it.data.createdAt).toBeUndefined();
  });
  test('a number already in our CRM is kept but archived; a bad number is archived', () => {
    const known = planBulk([lrow()], { preset, batch: 'ec', knownPhones: new Set(['+919876543210']) }).items[0];
    expect(known).toMatchObject({ group: 'C', reason: expect.stringContaining('Already a lead') });
    expect(planBulk([lrow({ 'Contact Number': '123' })], { preset, batch: 'ec' }).items[0].group).toBe('C');
  });
  test('the same number twice in one file is imported once', () => {
    const plan = planBulk([lrow(), lrow({ Name: 'Other' })], { preset, batch: 'ec' });
    expect(plan.items).toHaveLength(1);
    expect(plan.skipped).toHaveLength(1);
  });
});
