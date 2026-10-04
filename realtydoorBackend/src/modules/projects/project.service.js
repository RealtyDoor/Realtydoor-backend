const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');

const BASE_PROJECT_FIELDS = [
  'title', 'description', 'address', 'locality', 'city', 'state', 'pincode',
  'latitude', 'longitude', 'reraProjectNumber', 'approvedPlanUrl', 'commencementCertificateUrl',
  'landTitleDocUrl', 'designatedAccountBankName', 'designatedAccountNumber', 'designatedAccountIfsc',
];

function slugify(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + '-' + Date.now();
}

// 4.10 — a BUILDER partner submits their own project. Lands PENDING_APPROVAL,
// same as a Property listing. Units are added separately (addUnit /
// bulkAddUnits) — a project can be created before any unit exists, since the
// compliance documents are what admin actually reviews first.
async function createProject(data, builderId) {
  const slug = slugify(data.title);
  return prisma.project.create({
    data: { ...data, slug, builderId, publishStatus: 'PENDING_APPROVAL' },
  });
}

async function getProject(id) {
  const project = await prisma.project.findUnique({
    where: { id },
    include: { units: { orderBy: { unitNumber: 'asc' } }, builder: { select: { id: true, name: true, companyName: true } } },
  });
  if (!project) throw new ApiError(404, 'Project not found');
  return { ...project, commercials: commercialsSummary(project.units) };
}

// 4.10's "commercials" — derived from the units themselves at read time
// rather than a separately stored, easily-stale figure. Only AVAILABLE units
// count toward what a buyer could actually still buy.
function commercialsSummary(units) {
  const available = units.filter((u) => u.status === 'AVAILABLE' && u.price != null);
  const prices = available.map((u) => u.price);
  return {
    totalUnits: units.length,
    availableUnits: available.length,
    bookedUnits: units.filter((u) => u.status === 'BOOKED').length,
    soldUnits: units.filter((u) => u.status === 'SOLD').length,
    priceFrom: prices.length ? Math.min(...prices) : null,
    priceTo: prices.length ? Math.max(...prices) : null,
  };
}

async function getMyProject(id, builderId) {
  const project = await getProject(id);
  if (project.builderId !== builderId) throw new ApiError(403, 'Not your project');
  return project;
}

async function listProjectsAdmin(query, skip, limit) {
  const where = {};
  where.publishStatus = query.status || 'PENDING_APPROVAL';
  if (query.status === 'ALL') delete where.publishStatus;
  if (query.city) where.city = { equals: query.city, mode: 'insensitive' };
  if (query.builderId) where.builderId = query.builderId;

  const [data, total] = await Promise.all([
    prisma.project.findMany({
      where, skip, take: limit, orderBy: { createdAt: 'asc' },
      include: { builder: { select: { id: true, name: true, companyName: true } }, _count: { select: { units: true } } },
    }),
    prisma.project.count({ where }),
  ]);
  return { data, total };
}

async function listMyProjects(builderId, skip, limit) {
  const [data, total] = await Promise.all([
    prisma.project.findMany({
      where: { builderId }, skip, take: limit, orderBy: { createdAt: 'desc' },
      include: { _count: { select: { units: true } } },
    }),
    prisma.project.count({ where: { builderId } }),
  ]);
  return { data, total };
}

// Public — approved projects only, with at least one AVAILABLE unit so an
// empty or fully sold-out project doesn't clutter search.
async function searchProjects(query, skip, limit) {
  const where = { publishStatus: 'APPROVED' };
  if (query.city) where.city = { equals: query.city, mode: 'insensitive' };

  const [projects, total] = await Promise.all([
    prisma.project.findMany({
      where, skip, take: limit, orderBy: { createdAt: 'desc' },
      include: { units: { where: { status: 'AVAILABLE' }, select: { status: true, price: true, bhk: true, unitType: true } } },
    }),
    prisma.project.count({ where }),
  ]);
  return {
    data: projects.map(({ units, ...p }) => ({ ...p, commercials: commercialsSummary(units) })),
    total,
  };
}

async function getProjectBySlug(slug) {
  const project = await prisma.project.findUnique({
    where: { slug },
    include: {
      units: { where: { status: 'AVAILABLE' }, orderBy: { unitNumber: 'asc' } },
      builder: { select: { id: true, name: true, companyName: true } },
    },
  });
  if (!project || project.publishStatus !== 'APPROVED') throw new ApiError(404, 'Project not found');
  return { ...project, commercials: commercialsSummary(project.units) };
}

// Partner edit. A project that is live stays live while edited — the same
// reasoning as Property's change-request flow, but not the full parallel
// machinery: a project's compliance fields rarely change post-approval, and
// when they do, re-review happens by moving it back to PENDING_APPROVAL
// rather than holding a separate diff. This is a conscious simplification,
// not an oversight — building a full change-request system for projects too
// is future work if it turns out projects get edited often after approval.
async function updateProject(id, builderId, data) {
  const project = await prisma.project.findUnique({ where: { id } });
  if (!project) throw new ApiError(404, 'Project not found');
  if (project.builderId !== builderId) throw new ApiError(403, 'Not your project');

  const patch = Object.fromEntries(
    Object.entries(data).filter(([k]) => BASE_PROJECT_FIELDS.includes(k)),
  );

  if (project.publishStatus === 'APPROVED' && Object.keys(patch).length) {
    patch.publishStatus = 'PENDING_APPROVAL';
    patch.rejectionNote = null;
  }

  // Acting on an admin's requested fixes resubmits the project, same as
  // Property's own CHANGES_REQUESTED → PENDING_APPROVAL resubmission.
  if (project.publishStatus === 'CHANGES_REQUESTED' && Object.keys(patch).length) {
    patch.publishStatus = 'PENDING_APPROVAL';
    patch.requestedChanges = [];
    patch.requestedChangesNote = null;
    patch.changesRequestedAt = null;
    patch.changesRequestedByAdminId = null;
  }

  return prisma.project.update({ where: { id }, data: patch });
}

module.exports = {
  createProject, getProject, getMyProject, listProjectsAdmin, listMyProjects,
  searchProjects, getProjectBySlug, updateProject, commercialsSummary,
  BASE_PROJECT_FIELDS,
};
