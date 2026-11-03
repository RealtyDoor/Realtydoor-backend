jest.mock('../../src/lib/prisma', () => ({
  onboardingRequest: { findUnique: jest.fn(), update: jest.fn() },
  user: { findFirst: jest.fn() },
}));
jest.mock('../../src/lib/auditLog', () => ({ createAuditLog: jest.fn().mockResolvedValue({}) }));
jest.mock('../../src/lib/notifications', () => ({ notifyAdmins: jest.fn() }));
jest.mock('../../src/lib/fileUpload', () => ({ deleteFile: jest.fn().mockResolvedValue(), copyFile: jest.fn() }));
jest.mock('../../src/modules/properties/properties.service', () => ({ createProperty: jest.fn() }));

const prisma = require('../../src/lib/prisma');
const { copyFile, deleteFile } = require('../../src/lib/fileUpload');
const { createProperty } = require('../../src/modules/properties/properties.service');
const { buildListing, bhkOf } = require('../../src/lib/onboardingToListing');
const service = require('../../src/modules/onboarding/onboarding.service');

const where = { addressLine: '12 Main Road', locality: 'Jigani', city: 'Bengaluru', state: 'Karnataka', pincode: '560105' };
const req = (propertyType, data, over = {}) => ({ id: 'r1', propertyType, title: null, status: 'READY', data, documents: [], ...over });
const doc = (key, name, id = key) => ({ id, key, name, s3Key: `onboarding/${id}-${name}`, url: `https://b/onboarding/${id}` });

describe('mapping answers to a listing', () => {
  test('a new project: price range, unit mix, project figures, dates and approvals', () => {
    const r = buildListing(req('NEW_PROJECT', {
      ...where, projectName: 'Green Park', developerName: 'Asha Builders', launchStatus: 'Under construction', possessionDate: '2027-12-31',
      reraNumber: 'PRM/KA/RERA/1251/1', landAreaValue: 12.5, landAreaUnit: 'Acres', openSpacePct: 40.4, totalUnits: 180,
      unitTypes: [{ kind: 'Apartment', config: '2 BHK', priceFrom: 6000000, priceTo: 7500000, count: 100, available: 40 }, { kind: 'Apartment', config: '3 BHK', priceFrom: 9000000, count: 80, available: 25 }],
      priceMax: 12000000, description: 'A gated community near the Jigani industrial belt.', highlights: 'Clubhouse\nMetro soon', amenities: ['Gym'], otherAmenities: 'Yoga deck, Library',
      loanBanks: ['SBI', 'HDFC'], hasLoan: 'no', negotiable: 'yes', companyName: 'Asha Builders Pvt', websiteLink: 'https://x.in',
    }));
    expect(r.problems).toEqual([]);
    expect(r.payload).toMatchObject({
      title: 'Green Park', propertyType: 'NEW_PROJECT', listingType: 'SALE', propertyStatus: 'UNDER_CONSTRUCTION', price: 6000000, priceMax: 12000000,
      developer: 'Asha Builders', landAreaValue: 12.5, landAreaUnit: 'acres', openSpacePct: 40, totalUnits: 180, unitsLeft: 65, priceNegotiable: true,
      unitConfigurations: ['2 BHK', '3 BHK'], bankApprovals: ['SBI', 'HDFC'], isMortgaged: false, reraNumber: 'PRM/KA/RERA/1251/1',
      amenities: ['Gym', 'Yoga deck', 'Library'], possessionDate: '2027-12-31T00:00:00.000Z',
    });
    expect(r.payload.description).toContain('Highlights:\n- Clubhouse\n- Metro soon');
    expect(r.payload.bhk).toBeUndefined();
    expect(r.notCopied).toEqual(['websiteLink']); // company name is about the sender, not the property
  });

  test('a flat: rooms, areas, floor, furnishing and a parsed BHK', () => {
    const r = buildListing(req('FLAT', { ...where, projectName: 'Sobha Dream Acres', bhk: '3 BHK', superBuiltUpArea: 1650, carpetArea: 1200, floorNumber: 7, totalFloors: 14, facing: 'East', furnishing: 'Semi-furnished', bathrooms: 3, balconies: 2, askingPrice: 9500000, possessionStatus: 'Resale – vacant', description: 'Bright east-facing flat with a clear view.' }));
    expect(r.problems).toEqual([]);
    expect(r.payload).toMatchObject({ bhk: 3, carpetArea: 1200, floorNumber: 7, totalFloors: 14, facing: 'East', furnishing: 'Semi-furnished', bathrooms: 3, balconies: 2, price: 9500000, propertyStatus: 'READY_TO_MOVE' });
    expect(r.notCopied).toEqual(['superBuiltUpArea']);
  });

  test('a layout of plots: no rooms, sizes become the unit configurations, cheapest plot is the starting price', () => {
    const r = buildListing(req('PLOT', { ...where, layoutName: 'Sunrise Layout', plotKind: 'A layout with many plots', totalUnits: 60, unitsLeft: 22, facings: ['East', 'North'], unitTypes: [{ config: '30×40', sqft: 1200, priceFrom: 3600000, available: 12 }, { config: '40×60', sqft: 2400, priceFrom: 7800000, available: 10 }], description: 'DTCP approved layout with all roads laid.', siteStatus: 'Ready for construction' }));
    expect(r.problems).toEqual([]);
    expect(r.payload).toMatchObject({ propertyType: 'PLOT', price: 3600000, totalUnits: 60, unitsLeft: 22, unitConfigurations: ['30×40', '40×60'], propertyStatus: 'READY_TO_MOVE' });
    expect(r.payload.facing).toBeUndefined(); // two facings on offer: not one value
    expect(r.payload.plotArea).toBeUndefined();
    expect(r.notCopied).toEqual(['plotKind', 'facings']); // two facings do not fit the single facing, so they are reported
  });

  test('a single plot keeps its own size', () => {
    const r = buildListing(req('PLOT', { ...where, layoutName: 'Corner plot', unitTypes: [{ config: '30×40', sqft: 1200, priceFrom: 3600000 }], description: 'A corner plot near the highway.' }));
    expect(r.payload.plotArea).toBe(1200);
  });

  test('a commercial unit offered for lease needs monthly rent, not a sale price', () => {
    const base = { ...where, projectName: 'Prestige Tech Park', dealKind: 'Lease / rent', builtUpArea: 2000, description: 'Furnished office floor in the tech park.' };
    const missing = buildListing(req('COMMERCIAL_OFFICE', base));
    expect(missing.payload.listingType).toBe('LEASE');
    expect(missing.problems.map((p) => p.field)).toEqual(['monthlyRent']);
    expect(buildListing(req('COMMERCIAL_OFFICE', { ...base, monthlyRent: 180000 })).problems).toEqual([]);
  });

  test('says exactly which answers to fill in, in the form\'s own words', () => {
    const r = buildListing(req('FLAT', { locality: 'Hebbal', description: 'short' }));
    const fields = r.problems.map((p) => p.field);
    expect(fields).toEqual(expect.arrayContaining(['title', 'description', 'address', 'city', 'state', 'pincode']));
    expect(r.problems.find((p) => p.field === 'pincode').label).toMatch(/Pincode/);
  });

  test('the request name wins over the project name', () => {
    expect(buildListing(req('FLAT', { ...where, projectName: 'Other' }, { title: 'Green Park, Chintamani' })).payload.title).toBe('Green Park, Chintamani');
  });

  test('bhk parsing', () => {
    expect([bhkOf('2 BHK'), bhkOf('1 RK / Studio'), bhkOf('5 BHK or more'), bhkOf('Penthouse'), bhkOf(undefined)]).toEqual([2, 1, 5, undefined, undefined]);
  });
});

describe('files', () => {
  test('photos go to pictures, the floor plan to its slot, everything else to documents; a PDF "photo" is a document', () => {
    const r = buildListing(req('FLAT', { ...where, projectName: 'Sobha Dream Acres', askingPrice: 9500000, description: 'Bright east-facing flat with a clear view.' }, {
      documents: [doc('photos', 'a.jpg', '1'), doc('photos', 'b.png', '2'), doc('photos', 'c.pdf', '3'), doc('floor_plan', 'plan.png', '4'), doc('sale_deed', 'deed.pdf', '5'), { id: '6', key: 'photos', name: 'x.jpg' }],
    }));
    expect(r.counts).toEqual({ photos: 2, documents: 3, floorPlan: true });
    expect(r.files.images.map((d) => d.id)).toEqual(['1', '2']);
    expect(r.files.floorPlan.id).toBe('4');
    expect(r.files.documents.map((d) => d.id)).toEqual(['3', '5']); // the one with no stored key is skipped
  });
});

describe('converting', () => {
  const ready = (over = {}) => req('FLAT', { ...where, projectName: 'Sobha Dream Acres', askingPrice: 9500000, description: 'Bright east-facing flat with a clear view.' }, { documents: [doc('photos', 'a.jpg', '1'), doc('sale_deed', 'deed.pdf', '2'), doc('floor_plan', 'p.png', '3')], ...over });
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.user.findFirst.mockResolvedValue({ id: 'p1', name: 'Dev One' });
    copyFile.mockImplementation(async (key, folder) => ({ url: `https://b/${folder}/${key.split('/').pop()}`, key: `${folder}/${key.split('/').pop()}` }));
    createProperty.mockResolvedValue({ id: 'prop1', slug: 'sobha-1' });
    prisma.onboardingRequest.update.mockResolvedValue({});
  });

  test('only a READY request can be converted, once', async () => {
    prisma.onboardingRequest.findUnique.mockResolvedValue(ready({ status: 'IN_DISCUSSION' }));
    await expect(service.convertToListing('a1', 'r1', { partnerId: 'p1' })).rejects.toMatchObject({ statusCode: 409, data: { code: 'NOT_READY' } });
    prisma.onboardingRequest.findUnique.mockResolvedValue(ready({ status: 'CONVERTED', convertedToId: 'prop0' }));
    await expect(service.convertToListing('a1', 'r1', { partnerId: 'p1' })).rejects.toMatchObject({ data: { code: 'ALREADY_CONVERTED' } });
    expect(createProperty).not.toHaveBeenCalled();
  });
  test('a request that already has a listing can never make another, even if its status was changed', async () => {
    prisma.onboardingRequest.findUnique.mockResolvedValue(ready({ status: 'READY', convertedToId: 'prop0' }));
    await expect(service.convertToListing('a1', 'r1', { partnerId: 'p1' })).rejects.toMatchObject({ data: { code: 'ALREADY_CONVERTED' } });
    expect(createProperty).not.toHaveBeenCalled();
  });
  test('needs a real partner account', async () => {
    prisma.onboardingRequest.findUnique.mockResolvedValue(ready());
    prisma.user.findFirst.mockResolvedValue(null);
    await expect(service.convertToListing('a1', 'r1', { partnerId: 'nobody' })).rejects.toMatchObject({ data: { code: 'PARTNER_REQUIRED' } });
    expect(prisma.user.findFirst.mock.calls[0][0].where).toMatchObject({ role: 'PARTNER' });
    expect(createProperty).not.toHaveBeenCalled();
  });
  test('incomplete details are refused with the list, before any file is copied', async () => {
    prisma.onboardingRequest.findUnique.mockResolvedValue(ready({ data: { locality: 'Hebbal' } }));
    const err = await service.convertToListing('a1', 'r1', { partnerId: 'p1' }).catch((e) => e);
    expect(err.data.code).toBe('CONVERT_INCOMPLETE');
    expect(err.data.problems.length).toBeGreaterThan(3);
    expect(copyFile).not.toHaveBeenCalled();
    expect(createProperty).not.toHaveBeenCalled();
  });
  test('copies photos to the public pictures, papers to private documents, creates the listing under the partner, and marks the request converted', async () => {
    prisma.onboardingRequest.findUnique.mockResolvedValue(ready());
    const out = await service.convertToListing('a1', 'r1', { partnerId: 'p1' }, '1.1.1.1');
    expect(out).toEqual({ propertyId: 'prop1', slug: 'sobha-1', partnerName: 'Dev One' });
    expect(copyFile.mock.calls.map((c) => c[1]).sort()).toEqual(['properties', 'properties', 'properties/documents']);
    const [data, partnerId] = createProperty.mock.calls[0];
    expect(partnerId).toBe('p1');
    expect(data.images).toEqual(['https://b/properties/1-a.jpg']);
    expect(data.documents).toEqual([expect.objectContaining({ name: 'deed.pdf', url: 'https://b/properties/documents/2-deed.pdf' })]);
    expect(data.floorPlanUrl).toBe('https://b/properties/3-p.png');
    expect(data.title).toBe('Sobha Dream Acres');
    expect(prisma.onboardingRequest.update.mock.calls[0][0].data).toMatchObject({ status: 'CONVERTED', convertedToType: 'PROPERTY', convertedToId: 'prop1' });
  });
  test('if the listing cannot be created the copies are removed and the request is untouched', async () => {
    prisma.onboardingRequest.findUnique.mockResolvedValue(ready());
    createProperty.mockRejectedValue(new Error('db down'));
    await expect(service.convertToListing('a1', 'r1', { partnerId: 'p1' })).rejects.toThrow('db down');
    expect(deleteFile).toHaveBeenCalledTimes(3);
    expect(prisma.onboardingRequest.update).not.toHaveBeenCalled();
  });
  test('preview never writes, and says whether it can be converted', async () => {
    prisma.onboardingRequest.findUnique.mockResolvedValue(ready());
    const p = await service.listingPreview('r1');
    expect(p).toMatchObject({ canConvert: true, problems: [], counts: { photos: 1, documents: 2 } });
    prisma.onboardingRequest.findUnique.mockResolvedValue(ready({ status: 'RECEIVED' }));
    expect((await service.listingPreview('r1')).canConvert).toBe(false);
    expect(createProperty).not.toHaveBeenCalled();
  });
});
