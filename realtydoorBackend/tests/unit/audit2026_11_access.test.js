// Audit of November 2026, phase 2 (access and security). Each test states the behaviour we want. They were test.failing while the
// finding was open and are plain tests now that the fixes are in. Finding numbers match
// admin-nextjs/docs/AUDIT_2026-11.md.

const fs = require('fs');
const path = require('path');

jest.mock('../../src/lib/prisma', () => ({
  project: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  property: { findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn() },
  user: { findUnique: jest.fn() },
  localityInsight: { findFirst: jest.fn() },
  propertyReview: { groupBy: jest.fn() },
}));

const prisma = require('../../src/lib/prisma');
const src = (p) => fs.readFileSync(path.join(__dirname, '../../src', p), 'utf8');
const routeLines = (p) => src(p).split('\n').filter((l) => /^router\.(get|post|put|patch|delete)\(/.test(l.trim()));

describe('A2: the public listing page gets public fields only', () => {
  const PRIVATE = ['documents', 'loanNocUrl', 'isMortgaged', 'mortgageLender', 'hasCoOwners', 'adminEditNote', 'rejectionNote',
    'requestedChangesNote', 'changesRequestedByAdminId', 'locationVerifiedByAdminId', 'commissionSplitOffer'];

  test('GET /properties/:slug does not return listing papers, loan details, admin notes or the B2B commission offer', async () => {
    prisma.property.findFirst.mockResolvedValue({
      id: 'p1', slug: 'flat-1', title: 'Flat', partnerId: 'u1', publishStatus: 'APPROVED', isB2BOnly: false, city: 'Bengaluru', locality: 'Whitefield',
      propertyType: 'APARTMENT', images: [], coverImageIndex: 0,
      documents: [{ name: 'Sale deed.pdf', url: 'https://bucket.s3.ap-south-2.amazonaws.com/properties/documents/x.pdf' }],
      loanNocUrl: 'https://bucket.s3.ap-south-2.amazonaws.com/properties/documents/noc.pdf', isMortgaged: true, mortgageLender: 'HDFC', hasCoOwners: true,
      adminEditNote: 'price looks wrong', rejectionNote: 'old note', requestedChangesNote: 'fix photos', changesRequestedByAdminId: 'a1',
      locationVerifiedByAdminId: 'a1', commissionSplitOffer: '50/50',
    });
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', name: 'Partner' });
    prisma.property.update.mockResolvedValue({});
    prisma.property.findMany.mockResolvedValue([]);
    prisma.localityInsight.findFirst.mockResolvedValue(null);
    prisma.propertyReview.groupBy.mockResolvedValue([]);

    const { getPropertyByIdOrSlug } = require('../../src/modules/properties/properties.service');
    const out = await getPropertyByIdOrSlug('flat-1');
    expect(PRIVATE.filter((k) => k in out)).toEqual([]);
    expect(out.title).toBe('Flat');
    expect(out.partner).toEqual({ id: 'u1', name: 'Partner' });
  });

  test('every column of Property is listed as public or private, so a new column cannot leak by default', () => {
    const { Prisma } = require('@prisma/client');
    const { PUBLIC_PROPERTY_FIELDS, PRIVATE_PROPERTY_FIELDS } = require('../../src/modules/properties/properties.service');
    const columns = Prisma.dmmf.datamodel.models.find((m) => m.name === 'Property').fields.filter((f) => f.kind !== 'object').map((f) => f.name);
    const listed = new Set([...PUBLIC_PROPERTY_FIELDS, ...PRIVATE_PROPERTY_FIELDS]);
    expect(columns.filter((c) => !listed.has(c))).toEqual([]);
    expect(PUBLIC_PROPERTY_FIELDS.filter((c) => PRIVATE_PROPERTY_FIELDS.includes(c))).toEqual([]);
  });

  test('the brochure route still reads the stored brochure, and does not count a page view', () => {
    expect(src('modules/properties/properties.controller.js')).toMatch(/getBrochure[\s\S]{0,200}includePrivate: true/);
  });
});

describe('A9: the public project endpoints get public fields only', () => {
  const row = {
    id: 'pr1', title: 'Green Park', slug: 'green-park', city: 'Bengaluru', publishStatus: 'APPROVED', approvedPlanStatus: 'APPROVED',
    approvedPlanUrl: 'https://b/properties/documents/plan.pdf', landTitleDocUrl: 'https://b/properties/documents/title.pdf',
    commencementCertificateUrl: 'https://b/properties/documents/cc.pdf', designatedAccountBankName: 'HDFC', designatedAccountNumber: '50100123456789',
    designatedAccountIfsc: 'HDFC0000001', brokeragePct: 2, rejectionNote: 'old', reviewedByAdminId: 'a1',
    units: [{ id: 'u1', status: 'AVAILABLE', price: 9000000, bhk: 3, unitType: 'APARTMENT' }], builder: { id: 'b1', name: 'Builder' },
  };
  const LEAKS = ['approvedPlanUrl', 'landTitleDocUrl', 'commencementCertificateUrl', 'designatedAccountNumber', 'designatedAccountIfsc', 'brokeragePct', 'rejectionNote', 'reviewedByAdminId'];

  test('GET /projects/:slug and the list keep papers, account number and notes back', async () => {
    const svc = require('../../src/modules/projects/project.service');
    prisma.project.findUnique.mockResolvedValue(row);
    const one = await svc.getProjectBySlug('green-park');
    expect(LEAKS.filter((k) => k in one)).toEqual([]);
    expect(one).toMatchObject({ title: 'Green Park', designatedAccountBankName: 'HDFC', builder: { id: 'b1' } });
    expect(one.units).toHaveLength(1);
    expect(one.commercials).toBeDefined();

    prisma.project.findMany.mockResolvedValue([row]);
    prisma.project.count.mockResolvedValue(1);
    const list = await svc.searchProjects({}, 0, 10);
    expect(LEAKS.filter((k) => k in list.data[0])).toEqual([]);
    expect(list.data[0].title).toBe('Green Park');
  });

  test('every column of Project is listed as public or private', () => {
    const { Prisma } = require('@prisma/client');
    const { PUBLIC_PROJECT_FIELDS, PRIVATE_PROJECT_FIELDS } = require('../../src/modules/projects/project.service');
    const columns = Prisma.dmmf.datamodel.models.find((m) => m.name === 'Project').fields.filter((f) => f.kind !== 'object').map((f) => f.name);
    const listed = new Set([...PUBLIC_PROJECT_FIELDS, ...PRIVATE_PROJECT_FIELDS]);
    expect(columns.filter((c) => !listed.has(c))).toEqual([]);
  });
});

describe('A1: private files are signed on every route', () => {
  test('signing and un-signing are mounted once, before any route', () => {
    const text = src('routes/index.js');
    const at = text.indexOf('router.use(signPrivateUrls, unsignRequestUrls)');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(text.indexOf("router.use('/auth'"));
  });
});

describe('A3: locality admin routes need a permission, not only the admin role', () => {
  test('every requireAdmin route in locality.routes.js also names a permission', () => {
    const adminLines = routeLines('modules/locality/locality.routes.js').filter((l) => l.includes('requireAdmin'));
    expect(adminLines.length).toBeGreaterThan(0);
    expect(adminLines.filter((l) => !l.includes('requirePermission('))).toEqual([]);
  });
});

describe('A5: webhooks carry their own rate limit', () => {
  test('the webhooks router uses webhookLimiter before any route', () => {
    const text = src('modules/webhooks/webhooks.routes.js');
    expect(text.indexOf('router.use(webhookLimiter)')).toBeGreaterThan(-1);
    expect(text.indexOf('router.use(webhookLimiter)')).toBeLessThan(text.indexOf('router.post('));
  });
});

describe('A4: uploads and payment starts are rate limited per user', () => {
  test('every upload route outside /admin carries uploadLimiter', () => {
    const files = ['modules/users/users.routes.js', 'modules/partners/partners.routes.js', 'modules/properties/properties.routes.js', 'modules/leads/leads.routes.js'];
    const open = files.flatMap((f) => {
      const text = src(f);
      // A route can span lines, so look at each statement up to its closing ");".
      return text.split(/;\s*\n/).filter((s) => /router\.(post|patch|put)\(/.test(s) && /Uploader\.(single|array|fields)\(/.test(s) && !/uploadLimiter/i.test(s))
        .map((s) => `${f}: ${s.trim().split('\n')[0].slice(0, 70)}`);
    });
    expect(open).toEqual([]);
  });

  test('create-order and verify-payment carry a limiter (F19)', () => {
    const lines = routeLines('modules/escrow/escrow.routes.js').filter((l) => /'\/(create-order|verify-payment)'/.test(l));
    expect(lines.length).toBe(2);
    expect(lines.filter((l) => !/Limiter/.test(l))).toEqual([]);
  });
});
