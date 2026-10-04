const router = require('express').Router();

const authRoutes = require('../modules/auth/auth.routes');
const propertiesRoutes = require('../modules/properties/properties.routes');
const leadsRoutes = require('../modules/leads/leads.routes');
const usersRoutes = require('../modules/users/users.routes');
const partnersRoutes = require('../modules/partners/partners.routes');
const adminRoutes = require('../modules/admin/admin.routes');
const escrowRoutes = require('../modules/escrow/escrow.routes');
const servicesRoutes = require('../modules/services/services.routes');
const cmsRoutes = require('../modules/cms/cms.routes');
const faqRoutes = require('../modules/faq/faq.routes');
const notificationsRoutes = require('../modules/notifications/notifications.routes');
const contactRoutes = require('../modules/contact/contact.routes');
const nriLeadsRoutes = require('../modules/nriLeads/nriLeads.routes');
const serviceRequestsRoutes = require('../modules/serviceRequests/serviceRequests.routes');
const localityRoutes = require('../modules/locality/locality.routes');
const b2bRoutes = require('../modules/b2b/b2b.routes');
const configRoutes = require('../modules/config/config.routes');
const projectRoutes = require('../modules/projects/project.routes');

// Auth (sync on login, profile)
router.use('/auth', authRoutes);

// Public
router.use('/properties', propertiesRoutes);
router.use('/projects', projectRoutes); // 4.10/4.11 — developer-led multi-unit projects
router.use('/services', servicesRoutes);
router.use('/blog', cmsRoutes);           // GET /api/blog and /api/blog/:slug
router.use('/faqs', faqRoutes);           // GET /api/faqs and /api/faqs/:slug (content pre-parsed)
router.use('/contact', contactRoutes);
router.use('/nri-leads', nriLeadsRoutes);
router.use('/service-requests', serviceRequestsRoutes);
router.use('/locality-insights', localityRoutes);
router.use('/partner/b2b', b2bRoutes);
router.use('/config', configRoutes);

// Authenticated
router.use('/leads', leadsRoutes);
router.use('/user', usersRoutes);
router.use('/partner', partnersRoutes);
router.use('/notifications', notificationsRoutes);
router.use('/escrow', escrowRoutes);

// Admin
router.use('/admin', adminRoutes);

module.exports = router;
