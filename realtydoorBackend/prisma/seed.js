/**
 * RealtyDoor — Comprehensive Seed Script
 *
 * Run: node prisma/seed.js
 *
 * Creates enough data to exercise every GET endpoint in the API.
 *
 * IMPORTANT: Replace the CLERK_ID constants with real Clerk user IDs from your
 * Clerk dashboard before testing authenticated endpoints.
 *
 * Seed is fully idempotent — safe to run multiple times.
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ─── Clerk IDs — replace with real IDs from your Clerk dashboard ─────────────
const ADMIN_CLERK_ID    = 'user_seed_admin_001';
const PARTNER_CLERK_ID  = 'user_seed_partner_001';  // KYC: VERIFIED
const PARTNER2_CLERK_ID = 'user_seed_partner_002';  // KYC: PENDING_REVIEW
const USER_CLERK_ID     = 'user_seed_user_001';
const USER2_CLERK_ID    = 'user_seed_user_002';
// ─────────────────────────────────────────────────────────────────────────────

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

async function main() {
  console.log('🌱  Starting seed...\n');

  // ── 1. Users ──────────────────────────────────────────────────────────────

  const admin = await prisma.user.upsert({
    where:  { email: 'admin@realtydoor.com' },
    update: { clerkId: ADMIN_CLERK_ID, role: 'ADMIN' },
    create: {
      clerkId: ADMIN_CLERK_ID, name: 'Admin User',
      email: 'admin@realtydoor.com', phone: '+919000000001',
      phoneVerified: true, role: 'ADMIN',
    },
  });
  console.log(`✅  Admin    : ${admin.email}  (id: ${admin.id})`);

  // Partner 1 — KYC verified, active listings, settings + bank seeded
  const partner = await prisma.user.upsert({
    where:  { email: 'partner@realtydoor.com' },
    update: {
      clerkId: PARTNER_CLERK_ID,
      visitDays: ['Mon','Tue','Wed','Thu','Fri','Sat'],
      visitFromTime: '10:00', visitToTime: '19:00',
      notifNewLead: true, notifLeadExpiring: true,
      notifEscrowReleased: true, notifListingUpdate: true, notifWeeklyReport: false,
      leadAutoAccept: false, leadPauseOverloaded: true,
      leadPreferredLocalities: ['Baner', 'Kothrud', 'Aundh'],
      bankName: 'HDFC Bank', bankBranch: 'Baner Branch, Pune',
      bankAccountNo: '50100123456280', bankIfsc: 'HDFC0001234',
      bankHolderName: 'Rajdeep Kumar',
      razorpayRouteAccountId: 'acc_seed_partner_001',
      bankLinkedAt: new Date('2024-01-10'),
    },
    create: {
      clerkId: PARTNER_CLERK_ID, name: 'Rajdeep Kumar',
      email: 'partner@realtydoor.com', phone: '+919000000002',
      phoneVerified: true, role: 'PARTNER', partnerSubType: 'AGENT',
      companyName: 'RealtyPro Solutions',
      bio: '10 years of experience in Pune real estate market.',
      websiteUrl: 'https://realtypro.in',
      kycStatus: 'VERIFIED', kycVerifiedAt: new Date('2024-01-05'),
      kycDocumentUrls: ['https://example.com/kyc/pan.pdf', 'https://example.com/kyc/aadhar.pdf'],
      // Settings
      visitDays: ['Mon','Tue','Wed','Thu','Fri','Sat'],
      visitFromTime: '10:00', visitToTime: '19:00',
      notifNewLead: true, notifLeadExpiring: true,
      notifEscrowReleased: true, notifListingUpdate: true, notifWeeklyReport: false,
      leadAutoAccept: false, leadPauseOverloaded: true,
      leadPreferredLocalities: ['Baner', 'Kothrud', 'Aundh'],
      // Bank account
      bankName: 'HDFC Bank', bankBranch: 'Baner Branch, Pune',
      bankAccountNo: '50100123456280', bankIfsc: 'HDFC0001234',
      bankHolderName: 'Rajdeep Kumar',
      razorpayRouteAccountId: 'acc_seed_partner_001',
      bankLinkedAt: new Date('2024-01-10'),
    },
  });
  console.log(`✅  Partner1 : ${partner.email}  (id: ${partner.id})`);

  // Partner 2 — KYC pending (admin /kyc queue)
  const partner2 = await prisma.user.upsert({
    where:  { email: 'partner2@realtydoor.com' },
    update: { clerkId: PARTNER2_CLERK_ID },
    create: {
      clerkId: PARTNER2_CLERK_ID, name: 'Priya Sharma',
      email: 'partner2@realtydoor.com', phone: '+919000000004',
      phoneVerified: true, role: 'PARTNER', partnerSubType: 'BUILDER',
      companyName: 'Sharma Constructions',
      bio: 'RERA-registered builder with 50+ projects in Maharashtra.',
      kycStatus: 'PENDING_REVIEW',
      kycDocumentUrls: ['https://example.com/kyc/rera.pdf', 'https://example.com/kyc/gst.pdf'],
    },
  });
  console.log(`✅  Partner2 : ${partner2.email}  (id: ${partner2.id})`);

  // Buyer 1
  const user = await prisma.user.upsert({
    where:  { email: 'user@realtydoor.com' },
    update: { clerkId: USER_CLERK_ID },
    create: {
      clerkId: USER_CLERK_ID, name: 'Suresh Mehta',
      email: 'user@realtydoor.com', phone: '+919000000003',
      phoneVerified: true, role: 'USER',
    },
  });
  console.log(`✅  User1    : ${user.email}  (id: ${user.id})`);

  // Buyer 2
  const user2 = await prisma.user.upsert({
    where:  { email: 'user2@realtydoor.com' },
    update: { clerkId: USER2_CLERK_ID },
    create: {
      clerkId: USER2_CLERK_ID, name: 'Anita Joshi',
      email: 'user2@realtydoor.com', phone: '+919000000005',
      phoneVerified: true, role: 'USER',
    },
  });
  console.log(`✅  User2    : ${user2.email}  (id: ${user2.id})`);

  // ── 2. Services ───────────────────────────────────────────────────────────

  const serviceList = [
    {
      name: 'Maintenance Premium', shortDesc: 'Annual home maintenance package',
      description: 'Comprehensive AMC covering plumbing, electrical, carpentry, painting, and pest control. Includes 4 scheduled visits per year plus on-demand support.',
      price: 4999, category: 'MAINTENANCE', sortOrder: 1,
      features: ['4 Scheduled Visits/Year', 'Plumbing & Electrical', 'Carpentry & Painting', 'Pest Control', '24x7 Emergency Helpline'],
      imageUrl: 'https://cdn.realtydoor.in/services/maintenance.jpg',
    },
    {
      name: 'Legal Assistance', shortDesc: 'Property documentation and legal support',
      description: 'End-to-end legal support including agreement drafting, title verification, registration assistance, and due diligence.',
      price: 9999, category: 'LEGAL', sortOrder: 2,
      features: ['Agreement Drafting', 'Title Verification', 'Registration Assistance', 'Due Diligence Report', 'Dedicated Legal Expert'],
      imageUrl: 'https://cdn.realtydoor.in/services/legal.jpg',
    },
    {
      name: 'Home Loan Assistance', shortDesc: 'Dedicated loan processing support',
      description: 'Dedicated support from loan experts to compare offers from 10+ banks, prepare documents, and track your application.',
      price: 2999, category: 'LOAN', sortOrder: 3,
      features: ['10+ Bank Comparisons', 'Document Preparation', 'Application Tracking', 'Dedicated Loan Manager', 'Best Rate Guarantee'],
      imageUrl: 'https://cdn.realtydoor.in/services/loan.jpg',
    },
    {
      name: 'Interior Design Consultation', shortDesc: '1-on-1 interior design session',
      description: 'A 2-hour virtual consultation with an experienced interior designer. Get layout plans, material suggestions, and a budget estimate.',
      price: 1499, category: 'CONSTRUCTION', sortOrder: 4,
      features: ['2-Hour Virtual Session', 'Layout Plan', 'Material Suggestions', 'Budget Estimate', 'Follow-up Report'],
      imageUrl: 'https://cdn.realtydoor.in/services/interior.jpg',
    },
    {
      name: 'Property Valuation Report', shortDesc: 'Certified market valuation',
      description: 'Certified property valuation report by a RICS-accredited valuer. Includes comparable sales analysis, condition report, and official stamp.',
      price: 3499, category: 'VALUATION', sortOrder: 5,
      features: ['RICS-Accredited Valuer', 'Comparable Sales Analysis', 'Condition Report', 'Official Stamp', '5-Business-Day Delivery'],
      imageUrl: 'https://cdn.realtydoor.in/services/valuation.jpg',
    },
  ];

  const services = [];
  for (const svc of serviceList) {
    let s = await prisma.service.findFirst({ where: { name: svc.name } });
    if (!s) { s = await prisma.service.create({ data: svc }); console.log(`✅  Service  : ${svc.name}`); }
    else { console.log(`⏭   Service  : ${svc.name}`); }
    services.push(s);
  }

  // ── 3. Properties ─────────────────────────────────────────────────────────

  const propertyDefs = [
    // APPROVED — Baner 3BHK (primary test property)
    {
      slug: 'skyline-heights-3bhk-baner-seed',
      title: '3 BHK Flat in Baner',
      description: 'Spacious 3 BHK apartment in the heart of Baner with premium amenities, ample parking, and excellent connectivity to Hinjewadi IT Park. Ready to move in.',
      propertyType: 'FLAT', listingType: 'SALE', propertyStatus: 'READY_TO_MOVE', publishStatus: 'APPROVED',
      price: 8500000, priceNegotiable: true, bhk: 3, bathrooms: 2,
      carpetArea: 1200, builtUpArea: 1450, floorNumber: 4, totalFloors: 12,
      ageOfProperty: 2, furnishing: 'Semi-Furnished', facing: 'East',
      address: 'Skyline Heights, Plot 12, Baner Road',
      locality: 'Baner', city: 'Pune', state: 'Maharashtra', pincode: '411045',
      latitude: 18.5596, longitude: 73.7769,
      reraNumber: 'P52100012345', bankApprovals: ['SBI', 'HDFC', 'ICICI'],
      nearbyLandmarks: ['D-Mart Baner', 'Orchid School', 'Baner Metro Station'],
      images: [
        'https://images.unsplash.com/photo-1580587771525-78b9dba3b914?w=800',
        'https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=800',
        'https://images.unsplash.com/photo-1502005229762-cf1b2da7c5d6?w=800',
      ],
      amenities: ['Gymnasium', 'Swimming Pool', '24x7 Security', 'CCTV', 'Power Backup'],
      societyFeatures: ['Club House', "Children's Play Area", 'Jogging Track', 'Visitor Parking'],
      isFeatured: true, isVerified: true, partnerId: partner.id,
    },
    // APPROVED — Kothrud 2BHK rent
    {
      slug: 'green-valley-2bhk-kothrud-rent-seed',
      title: '2 BHK Flat for Rent in Kothrud',
      description: 'Well-maintained 2 BHK in a prime Kothrud location, close to major schools. Ideal for families or working professionals.',
      propertyType: 'FLAT', listingType: 'RENT', propertyStatus: 'READY_TO_MOVE', publishStatus: 'APPROVED',
      monthlyRent: 25000, bhk: 2, bathrooms: 2,
      carpetArea: 850, builtUpArea: 1050, floorNumber: 2, totalFloors: 6,
      ageOfProperty: 5, furnishing: 'Furnished', facing: 'West',
      address: 'Green Valley Apartments, Karve Road',
      locality: 'Kothrud', city: 'Pune', state: 'Maharashtra', pincode: '411038',
      nearbyLandmarks: ['Kothrud Bus Depot', 'Symbiosis College', 'D-Mart Kothrud'],
      images: [
        'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?w=800',
        'https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=800',
      ],
      amenities: ['Lift', '24x7 Security', 'Power Backup'],
      societyFeatures: ['Terrace Garden', 'Visitor Parking'],
      isVerified: true, partnerId: partner.id,
    },
    // APPROVED — Hinjewadi commercial
    {
      slug: 'hinjewadi-office-phase1-lease-seed',
      title: 'Commercial Office Space in Hinjewadi',
      description: 'Ready-to-use commercial office in Rajiv Gandhi IT Park Phase 1. High-speed fibre, modular workstations included.',
      propertyType: 'COMMERCIAL_OFFICE', listingType: 'LEASE', propertyStatus: 'READY_TO_MOVE', publishStatus: 'APPROVED',
      monthlyRent: 85000, carpetArea: 1500, builtUpArea: 1800,
      floorNumber: 7, totalFloors: 10, furnishing: 'Fully Furnished',
      address: 'Rajiv Gandhi IT Park, Phase 1',
      locality: 'Hinjewadi', city: 'Pune', state: 'Maharashtra', pincode: '411057',
      latitude: 18.5931, longitude: 73.7382,
      nearbyLandmarks: ['Infosys Campus', 'Wipro Gate', 'Hinjewadi Bridge'],
      images: [
        'https://images.unsplash.com/photo-1497366216548-37526070297c?w=800',
        'https://images.unsplash.com/photo-1497366811353-6870744d04b2?w=800',
      ],
      amenities: ['High-Speed Internet', 'Conference Room', 'Cafeteria', '24x7 Security', 'Power Backup', 'Parking'],
      isFeatured: true, partnerId: partner.id,
    },
    // APPROVED — Aundh 4BHK house
    {
      slug: 'independent-house-4bhk-aundh-seed',
      title: '4 BHK Independent House in Aundh',
      description: "Stunning 4 BHK bungalow in Aundh. Private garden, rooftop terrace, and 2-car garage.",
      propertyType: 'INDEPENDENT_HOUSE', listingType: 'SALE', propertyStatus: 'READY_TO_MOVE', publishStatus: 'APPROVED',
      price: 28000000, priceNegotiable: false, bhk: 4, bathrooms: 4,
      carpetArea: 3200, builtUpArea: 3800, plotArea: 5000,
      floorNumber: 0, totalFloors: 2, ageOfProperty: 3, furnishing: 'Semi-Furnished', facing: 'North',
      address: '15, Pashan-Sus Road, Aundh',
      locality: 'Aundh', city: 'Pune', state: 'Maharashtra', pincode: '411067',
      latitude: 18.5581, longitude: 73.8099,
      reraNumber: 'P52100054321', bankApprovals: ['HDFC', 'ICICI', 'Axis Bank'],
      nearbyLandmarks: ['Aundh Chest Hospital', 'DP Road', 'D-Mart Aundh'],
      images: [
        'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?w=800',
        'https://images.unsplash.com/photo-1600607687939-ce8a6c25118c?w=800',
        'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=800',
      ],
      amenities: ['Private Garden', 'Rooftop Terrace', '2-Car Garage', 'Solar Panels', 'Rainwater Harvesting'],
      societyFeatures: ['Gated Community', '24x7 Security'],
      isFeatured: true, isVerified: true, partnerId: partner.id,
    },
    // PENDING_APPROVAL — appears in GET /admin/properties queue
    {
      slug: 'wakad-2bhk-pending-seed',
      title: '2 BHK Flat in Wakad (Pending Approval)',
      description: 'New listing in Wakad, awaiting admin approval. Close to Wakad bridge and IT hubs.',
      propertyType: 'FLAT', listingType: 'SALE', propertyStatus: 'READY_TO_MOVE', publishStatus: 'PENDING_APPROVAL',
      price: 6500000, bhk: 2, bathrooms: 2,
      carpetArea: 900, builtUpArea: 1100, floorNumber: 3, totalFloors: 8,
      furnishing: 'Unfurnished', facing: 'South',
      address: 'Sunflower Heights, Wakad',
      locality: 'Wakad', city: 'Pune', state: 'Maharashtra', pincode: '411057',
      nearbyLandmarks: ['Wakad Bridge', 'D-Mart Wakad'],
      images: ['https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=800'],
      amenities: ['Lift', 'Parking'],
      partnerId: partner2.id,
    },
    // UNDER_CONSTRUCTION — for ConstructionUpdate timeline
    {
      slug: 'sunrise-towers-3bhk-underconstruction-seed',
      title: '3 BHK Flat in Sunrise Towers (Under Construction)',
      description: 'Premium under-construction project by Sharma Constructions in Wakad. RERA registered. Possession Q2 2026.',
      propertyType: 'FLAT', listingType: 'SALE', propertyStatus: 'UNDER_CONSTRUCTION', publishStatus: 'APPROVED',
      price: 7800000, priceNegotiable: false, bhk: 3, bathrooms: 2,
      carpetArea: 1100, builtUpArea: 1350, floorNumber: 8, totalFloors: 20,
      furnishing: 'Unfurnished', facing: 'East',
      address: 'Sunrise Towers, Wakad-Bhosari Road',
      locality: 'Wakad', city: 'Pune', state: 'Maharashtra', pincode: '411057',
      reraNumber: 'P52100099999', bankApprovals: ['SBI', 'HDFC'],
      possessionDate: new Date('2026-06-30'),
      nearbyLandmarks: ['Wakad Bridge', 'D-Mart Wakad', 'Hinjewadi Phase 2'],
      images: [
        'https://images.unsplash.com/photo-1486325212027-8081e485255e?w=800',
        'https://images.unsplash.com/photo-1503387762-592deb58ef4e?w=800',
      ],
      amenities: ['Swimming Pool', 'Gymnasium', 'Club House', '24x7 Security'],
      societyFeatures: ["Children's Play Area", 'Jogging Track'],
      isFeatured: false, isVerified: true, partnerId: partner2.id,
    },
    // REJECTED — admin visibility of rejections
    {
      slug: 'viman-nagar-plot-rejected-seed',
      title: 'Plot in Viman Nagar (Rejected)',
      description: 'Freehold residential plot near Viman Nagar. Listing was rejected due to missing RERA number.',
      propertyType: 'PLOT', listingType: 'SALE', propertyStatus: 'READY_TO_MOVE', publishStatus: 'REJECTED',
      price: 12000000, carpetArea: 2000,
      address: 'Viman Nagar Road, Near Airport',
      locality: 'Viman Nagar', city: 'Pune', state: 'Maharashtra', pincode: '411014',
      rejectionNote: 'RERA number missing. Please provide valid RERA registration before re-submitting.',
      nearbyLandmarks: ['Pune Airport', 'Phoenix Mall'],
      images: [], amenities: [],
      partnerId: partner.id,
    },
  ];

  const properties = [];
  for (const prop of propertyDefs) {
    const p = await prisma.property.upsert({
      where:  { slug: prop.slug },
      update: {},
      create: prop,
    });
    console.log(`✅  Property : [${p.publishStatus}] ${p.title}`);
    properties.push(p);
  }

  const [propBaner, propKothrud, propOffice, propAundh, propPending, propUnderConstruction, propRejected] = properties;

  // ── 4. Leads ──────────────────────────────────────────────────────────────

  const leadDefs = [
    // CLOSED — buyer confirmed, escrow released
    {
      buyerName: 'Suresh Mehta', buyerEmail: 'user@realtydoor.com', buyerPhone: '+919000000003',
      buyerId: user.id, propertyId: propBaner.id,
      status: 'CLOSED', assignedPartnerId: partner.id, assignedAt: daysAgo(10),
      isOtpVerified: true, otpVerifiedAt: daysAgo(8),
      buyerFeedbackStatus: 'VERIFIED_CLOSED', feedbackReceivedAt: daysAgo(6),
      whatsappSentAt: daysAgo(7),
      visitNotes: 'Site visit completed. Buyer very interested and ready to proceed.',
      platformCommissionPct: 2.0, commissionAmountPaise: 170000, commissionStatus: 'INVOICED',
    },
    // SITE_VISIT_DONE — escrow held, buyer still deciding
    {
      buyerName: 'Anita Joshi', buyerEmail: 'user2@realtydoor.com', buyerPhone: '+919000000005',
      buyerId: user2.id, propertyId: propBaner.id,
      status: 'SITE_VISIT_DONE', assignedPartnerId: partner.id, assignedAt: daysAgo(5),
      isOtpVerified: true, otpVerifiedAt: daysAgo(4),
      buyerFeedbackStatus: 'STILL_DECIDING', feedbackReceivedAt: daysAgo(3),
      whatsappSentAt: daysAgo(4),
    },
    // ASSIGNED — partner has phone, visit pending
    {
      buyerName: 'Vikram Singh', buyerEmail: 'vikram.singh@test.com', buyerPhone: '+919111222333',
      propertyId: propKothrud.id,
      status: 'ASSIGNED', assignedPartnerId: partner.id, assignedAt: daysAgo(2),
      buyerFeedbackStatus: 'PENDING',
    },
    // UNASSIGNED — fresh inquiry
    {
      buyerName: 'Meena Patel', buyerEmail: 'meena.patel@test.com', buyerPhone: '+919222333444',
      propertyId: propBaner.id,
      status: 'UNASSIGNED',
    },
    // DROPPED — two-tier drop completed
    {
      buyerName: 'Ravi Kapoor', buyerEmail: 'ravi.kapoor@test.com', buyerPhone: '+919333444555',
      propertyId: propKothrud.id,
      status: 'DROPPED', assignedPartnerId: partner.id, assignedAt: daysAgo(20),
      isOtpVerified: true, otpVerifiedAt: daysAgo(18),
      buyerFeedbackStatus: 'VERIFIED_DROPPED', feedbackReceivedAt: daysAgo(15),
      whatsappSentAt: daysAgo(16),
      dropRequestedByPartner: true, dropRequestNote: 'Buyer stopped responding after site visit.',
      dropRequestedAt: daysAgo(14), droppedAt: daysAgo(13), droppedByAdminId: admin.id,
      droppedReason: 'Buyer confirmed not interested via WhatsApp.',
    },
    // ── 10 fresh UNASSIGNED leads (admin queue) ───────────────────────────────
    {
      buyerName: 'Karan Mehta', buyerEmail: 'karan.mehta@test.com', buyerPhone: '+919600000001',
      propertyId: propBaner.id, status: 'UNASSIGNED', createdAt: daysAgo(1),
    },
    {
      buyerName: 'Deepa Nair', buyerEmail: 'deepa.nair@test.com', buyerPhone: '+919600000002',
      propertyId: propKothrud.id, status: 'UNASSIGNED', createdAt: daysAgo(2),
    },
    {
      buyerName: 'Amit Agarwal', buyerEmail: 'amit.agarwal@test.com', buyerPhone: '+919600000003',
      propertyId: propAundh.id, status: 'UNASSIGNED', createdAt: daysAgo(1),
    },
    {
      buyerName: 'Pooja Reddy', buyerEmail: 'pooja.reddy@test.com', buyerPhone: '+919600000004',
      propertyId: propBaner.id, status: 'UNASSIGNED', buyerId: user2.id, createdAt: daysAgo(3),
    },
    {
      buyerName: 'Rahul Desai', buyerEmail: 'rahul.desai@test.com', buyerPhone: '+919600000005',
      propertyId: propOffice.id, status: 'UNASSIGNED', createdAt: daysAgo(4),
    },
    {
      buyerName: 'Neha Kulkarni', buyerEmail: 'neha.kulkarni@test.com', buyerPhone: '+919600000006',
      propertyId: propAundh.id, status: 'UNASSIGNED', createdAt: daysAgo(2),
    },
    {
      buyerName: 'Sanjay Verma', buyerEmail: 'sanjay.verma@test.com', buyerPhone: '+919600000007',
      propertyId: propKothrud.id, status: 'UNASSIGNED', createdAt: daysAgo(5),
    },
    {
      buyerName: 'Preethi Iyer', buyerEmail: 'preethi.iyer@test.com', buyerPhone: '+919600000008',
      propertyId: propBaner.id, status: 'UNASSIGNED', createdAt: daysAgo(6),
    },
    {
      buyerName: 'Mohit Gupta', buyerEmail: 'mohit.gupta@test.com', buyerPhone: '+919600000009',
      propertyId: propOffice.id, status: 'UNASSIGNED', createdAt: daysAgo(3),
    },
    {
      buyerName: 'Shruti Jain', buyerEmail: 'shruti.jain@test.com', buyerPhone: '+919600000010',
      propertyId: propUnderConstruction.id, status: 'UNASSIGNED', createdAt: daysAgo(1),
    },
  ];

  const leads = [];
  for (const lData of leadDefs) {
    let lead = await prisma.lead.findFirst({
      where: { buyerEmail: lData.buyerEmail, propertyId: lData.propertyId },
    });
    if (!lead) {
      lead = await prisma.lead.create({ data: lData });
      console.log(`✅  Lead     : ${lData.buyerName} → [${lData.status}]`);
    } else {
      console.log(`⏭   Lead     : ${lData.buyerName} → [${lData.status}]`);
    }
    leads.push(lead);
  }

  const [leadClosed, leadSiteVisit] = leads;

  // ── 5. Escrow Transactions ────────────────────────────────────────────────

  // RELEASED — closed deal
  let escrow1 = await prisma.escrowTransaction.findFirst({
    where: { razorpayOrderId: 'order_seed_escrow_001' },
  });
  if (!escrow1) {
    escrow1 = await prisma.escrowTransaction.create({
      data: {
        leadId: leadClosed.id, buyerId: user.id,
        razorpayOrderId: 'order_seed_escrow_001',
        razorpayPaymentId: 'pay_seed_escrw_001',
        razorpayTransferId: 'trf_seed_001',
        amount: 85000, currency: 'INR',
        status: 'RELEASED',
        heldAt: daysAgo(9), releasedAt: daysAgo(6),
        releasedByAdminId: admin.id,
        adminNote: 'Deal confirmed by both parties. Token released to seller.',
      },
    });
    console.log(`✅  Escrow   : RELEASED ₹85,000`);
  } else {
    console.log(`⏭   Escrow   : RELEASED (already exists)`);
  }

  // HELD — site visit done, decision pending
  let escrow2 = await prisma.escrowTransaction.findFirst({
    where: { razorpayOrderId: 'order_seed_escrow_002' },
  });
  if (!escrow2) {
    escrow2 = await prisma.escrowTransaction.create({
      data: {
        leadId: leadSiteVisit.id, buyerId: user2.id,
        razorpayOrderId: 'order_seed_escrow_002',
        razorpayPaymentId: 'pay_seed_escrw_002',
        amount: 50000, currency: 'INR',
        status: 'HELD',
        heldAt: daysAgo(4),
      },
    });
    console.log(`✅  Escrow   : HELD ₹50,000`);
  } else {
    console.log(`⏭   Escrow   : HELD (already exists)`);
  }

  // ── 6. UserSubscription + ServiceTickets ──────────────────────────────────

  const maintenanceSvc = services[0];
  let sub = await prisma.userSubscription.findFirst({
    where: { razorpayOrderId: 'order_seed_sub_001' },
  });
  if (!sub) {
    sub = await prisma.userSubscription.create({
      data: {
        userId: user.id, serviceId: maintenanceSvc.id,
        razorpayOrderId: 'order_seed_sub_001',
        razorpayPaymentId: 'pay_seed_sub_001',
        paymentStatus: 'SUCCESS',
        amountPaid: 4999, currency: 'INR',
        startDate: daysAgo(30),
        endDate: new Date(Date.now() + 335 * 24 * 60 * 60 * 1000),
      },
    });
    console.log(`✅  Sub      : Maintenance Premium for ${user.name}`);
  } else {
    console.log(`⏭   Sub      : (already exists)`);
  }

  const ticketDefs = [
    {
      userId: user.id, subscriptionId: sub.id,
      subject: 'Leaking kitchen tap',
      description: 'Kitchen tap has been dripping for 2 days. Need urgent plumbing visit.',
      category: 'PLUMBING', status: 'RESOLVED', priority: 'HIGH',
      adminNotes: 'Vendor dispatched on 2024-01-15.',
      vendorName: 'Quick Fix Plumbers', vendorPhone: '+919800100200',
      resolvedAt: daysAgo(20),
    },
    {
      userId: user.id, subscriptionId: sub.id,
      subject: 'Electrical switchboard sparking',
      description: 'Living room switchboard making sparking noise. Urgent safety concern.',
      category: 'ELECTRICAL', status: 'IN_PROGRESS', priority: 'URGENT',
      adminNotes: 'Electrician scheduled for tomorrow.',
      vendorName: 'Safe Electric Co.', vendorPhone: '+919800200300',
    },
    {
      userId: user.id, subscriptionId: sub.id,
      subject: 'Annual painting service request',
      description: 'Requesting the annual interior painting service as per AMC.',
      category: 'PAINTING', status: 'OPEN', priority: 'NORMAL',
    },
  ];

  for (const tData of ticketDefs) {
    const existing = await prisma.serviceTicket.findFirst({
      where: { userId: tData.userId, subject: tData.subject },
    });
    if (!existing) {
      await prisma.serviceTicket.create({ data: tData });
      console.log(`✅  Ticket   : "${tData.subject}" [${tData.status}]`);
    } else {
      console.log(`⏭   Ticket   : "${tData.subject}"`);
    }
  }

  // ── 7. Loan Applications ──────────────────────────────────────────────────

  const loanDefs = [
    {
      userId: user.id, propertyId: propBaner.id,
      preferredBank: 'HDFC Bank',
      loanAmountRequestedPaise: 680000000, // ₹68 lakh (paise)
      status: 'AWAITING_SANCTION',
      adminNote: 'Documents verified. Sent to HDFC on 2024-01-20.',
      statusHistory: ['DOCUMENTS_PENDING', 'DOCUMENTS_SUBMITTED', 'DOCUMENTS_VERIFIED', 'SENT_TO_BANK', 'AWAITING_SANCTION'],
    },
    {
      userId: user2.id, propertyId: propKothrud.id,
      preferredBank: 'SBI',
      loanAmountRequestedPaise: 220000000, // ₹22 lakh (paise)
      status: 'DOCUMENTS_PENDING',
      statusHistory: ['DOCUMENTS_PENDING'],
    },
  ];

  for (const lData of loanDefs) {
    const existing = await prisma.loanApplication.findFirst({
      where: { userId: lData.userId, propertyId: lData.propertyId },
    });
    if (!existing) {
      await prisma.loanApplication.create({ data: lData });
      console.log(`✅  Loan     : [${lData.status}] ${lData.preferredBank}`);
    } else {
      console.log(`⏭   Loan     : (already exists)`);
    }
  }

  // ── 8. User Documents ─────────────────────────────────────────────────────

  const docDefs = [
    {
      userId: user.id, documentType: 'PAN_CARD',
      fileUrl: 'https://example.com/docs/suresh_pan.pdf', fileName: 'suresh_pan.pdf',
      status: 'APPROVED', isVerified: true,
      verifiedAt: daysAgo(5), verifiedByAdminId: admin.id,
    },
    {
      userId: user.id, documentType: 'SALARY_SLIP',
      fileUrl: 'https://example.com/docs/suresh_salary_jan.pdf', fileName: 'suresh_salary_jan.pdf',
      status: 'PENDING_REVIEW', isVerified: false,
    },
    {
      userId: user2.id, documentType: 'AADHAR',
      fileUrl: 'https://example.com/docs/anita_aadhar.pdf', fileName: 'anita_aadhar.pdf',
      status: 'PENDING_REVIEW', isVerified: false,
    },
    {
      userId: user2.id, documentType: 'BANK_STATEMENT',
      fileUrl: 'https://example.com/docs/anita_bank_3months.pdf', fileName: 'anita_bank_3months.pdf',
      status: 'PENDING_REVIEW', isVerified: false,
    },
  ];

  for (const dData of docDefs) {
    const existing = await prisma.userDocument.findFirst({
      where: { userId: dData.userId, documentType: dData.documentType },
    });
    if (!existing) {
      await prisma.userDocument.create({ data: dData });
      console.log(`✅  Document : ${dData.documentType} [${dData.status}]`);
    } else {
      console.log(`⏭   Document : ${dData.documentType}`);
    }
  }

  // ── 9. Contact Messages ───────────────────────────────────────────────────

  const contactDefs = [
    {
      name: 'Ranjit Verma', email: 'ranjit.verma@test.com', phone: '+919444555666',
      subject: 'Partnership Inquiry',
      message: 'I am a RERA-registered agent in Pune with 5 years experience. How do I become a RealtyDoor partner?',
      isRead: false,
    },
    {
      name: 'Sunita Rao', email: 'sunita.rao@test.com', phone: '+919555666777',
      subject: 'Property listing stuck in pending',
      message: 'I submitted my property listing 3 days ago but it is still pending approval. Please help.',
      userId: user.id, role: 'USER', isRead: true,
    },
    {
      name: 'Dev Enterprises', email: 'dev@testbiz.com', phone: '+912027001234',
      subject: 'NRI Investment Query',
      message: 'We represent a group of NRI investors looking for commercial properties in Pune IT corridor. Who is the right person to contact?',
      isRead: false,
    },
  ];

  for (const cData of contactDefs) {
    const existing = await prisma.contactMessage.findFirst({
      where: { email: cData.email, subject: cData.subject },
    });
    if (!existing) {
      await prisma.contactMessage.create({ data: cData });
      console.log(`✅  Contact  : "${cData.subject}" from ${cData.name}`);
    } else {
      console.log(`⏭   Contact  : "${cData.subject}"`);
    }
  }

  // ── 10. Team Members ──────────────────────────────────────────────────────

  const teamDefs = [
    {
      name: 'Vikram Nair', title: 'Founder & CEO', email: 'vikram@realtydoor.com',
      avatarUrl: 'https://images.unsplash.com/photo-1560250097-0b93528c311a?w=400',
      sortOrder: 1, isActive: true,
    },
    {
      name: 'Shreya Gupta', title: 'Head of Partnerships', email: 'shreya@realtydoor.com',
      avatarUrl: 'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=400',
      sortOrder: 2, isActive: true,
    },
    {
      name: 'Arun Menon', title: 'Lead Engineer', email: 'arun@realtydoor.com',
      avatarUrl: 'https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?w=400',
      sortOrder: 3, isActive: true,
    },
  ];

  for (const tData of teamDefs) {
    const existing = await prisma.teamMember.findFirst({ where: { email: tData.email } });
    if (!existing) {
      await prisma.teamMember.create({ data: tData });
      console.log(`✅  Team     : ${tData.name} — ${tData.title}`);
    } else {
      console.log(`⏭   Team     : ${tData.name}`);
    }
  }

  // ── 11. Locality Insights ─────────────────────────────────────────────────

  const localityDefs = [
    {
      city: 'Pune', locality: 'Baner', citySlug: 'pune', localitySlug: 'baner',
      avgPricePerSqftPaise: 850000, minPricePerSqftPaise: 700000, maxPricePerSqftPaise: 1050000,
      avgRentPerMonthPaise: 2800000, priceChangeLastMonthPct: 2.3,
      nearbyInfra: ['D-Mart', 'Orchid School', 'Baner Metro Station', 'Aditya Birla Hospital'],
      dataAsOfDate: new Date('2024-01-01'), updatedByAdminId: admin.id,
    },
    {
      city: 'Pune', locality: 'Kothrud', citySlug: 'pune', localitySlug: 'kothrud',
      avgPricePerSqftPaise: 720000, minPricePerSqftPaise: 600000, maxPricePerSqftPaise: 900000,
      avgRentPerMonthPaise: 2200000, priceChangeLastMonthPct: 1.8,
      nearbyInfra: ['Kothrud Bus Depot', 'Symbiosis College', 'Chandni Chowk'],
      dataAsOfDate: new Date('2024-01-01'), updatedByAdminId: admin.id,
    },
    {
      city: 'Pune', locality: 'Hinjewadi', citySlug: 'pune', localitySlug: 'hinjewadi',
      avgPricePerSqftPaise: 650000, minPricePerSqftPaise: 520000, maxPricePerSqftPaise: 820000,
      avgRentPerMonthPaise: 2000000, priceChangeLastMonthPct: 3.1,
      nearbyInfra: ['Rajiv Gandhi IT Park', 'Infosys BPO', 'Hinjewadi Bus Stop'],
      dataAsOfDate: new Date('2024-01-01'), updatedByAdminId: admin.id,
    },
    {
      city: 'Pune', locality: 'Aundh', citySlug: 'pune', localitySlug: 'aundh',
      avgPricePerSqftPaise: 920000, minPricePerSqftPaise: 750000, maxPricePerSqftPaise: 1200000,
      avgRentPerMonthPaise: 3200000, priceChangeLastMonthPct: 1.5,
      nearbyInfra: ['Aundh Chest Hospital', 'DP Road Market', 'Westend Mall'],
      dataAsOfDate: new Date('2024-01-01'), updatedByAdminId: admin.id,
    },
  ];

  for (const loc of localityDefs) {
    await prisma.localityInsight.upsert({
      where:  { city_locality: { city: loc.city, locality: loc.locality } },
      update: loc,
      create: loc,
    });
    console.log(`✅  Locality : ${loc.city} / ${loc.locality}`);
  }

  // ── 12. CMS Content Blocks ────────────────────────────────────────────────

  const contentDefs = [
    {
      type: 'BLOG', title: 'Top 5 Neighbourhoods to Buy Property in Pune (2024)',
      slug: 'top-5-pune-neighbourhoods-2024',
      content: "<h2>1. Baner</h2><p>Baner has emerged as one of Pune's most sought-after hubs owing to its proximity to Hinjewadi IT Park...</p><h2>2. Kothrud</h2><p>Well-established locality with excellent connectivity...</p><h2>3. Aundh</h2><p>Premium residential area with wide roads...</p><h2>4. Hinjewadi</h2><p>Fastest-growing micro-market driven by the IT sector...</p><h2>5. Wakad</h2><p>Emerging hub with affordable pricing...</p>",
      excerpt: 'Thinking about buying a home in Pune? Here are the top 5 neighbourhoods offering the best combination of price appreciation and quality of life.',
      imageUrl: 'https://images.unsplash.com/photo-1570168007204-dfb528c6958f?w=1200',
      author: 'RealtyDoor Research',
      tags: ['Pune', 'Investment', 'Residential', '2024', 'Neighbourhood Guide'],
      isPublished: true, publishedAt: new Date('2024-01-10'),
      seoTitle: 'Top 5 Pune Neighbourhoods to Buy Property in 2024 | RealtyDoor',
      seoDesc: 'Discover the best areas to invest in Pune real estate — Baner, Kothrud, Aundh, Hinjewadi & Wakad compared.',
    },
    {
      type: 'BLOG', title: 'RERA Explained: What Every Pune Homebuyer Must Know',
      slug: 'rera-guide-pune-homebuyer',
      content: '<h2>What is RERA?</h2><p>The Real Estate (Regulation and Development) Act, 2016 protects homebuyers and boosts investments in the sector...</p><h2>How to Verify</h2><p>Visit maharera.mahaonline.gov.in to verify any registered project...</p><h2>Key Protections</h2><p>Developers must deposit 70% of collected funds in a separate bank account...</p>',
      excerpt: 'RERA has transformed Indian real estate. Here is everything a Pune homebuyer needs to know before signing.',
      imageUrl: 'https://images.unsplash.com/photo-1450101499163-c8848c66ca85?w=1200',
      author: 'RealtyDoor Legal Team',
      tags: ['RERA', 'Legal', 'Homebuyer Guide', 'MahaRERA', 'Pune'],
      isPublished: true, publishedAt: new Date('2024-01-20'),
      seoTitle: 'RERA Guide for Pune Homebuyers 2024 | RealtyDoor',
      seoDesc: 'Everything you need to know about RERA, MahaRERA, and how to verify a real estate project in Pune.',
    },
    {
      type: 'FAQ', title: 'Frequently Asked Questions', slug: 'faq',
      content: JSON.stringify([
        { q: 'How does RealtyDoor ensure I get genuine leads?', a: 'Multi-step OTP verification. The buyer verifies their phone, and the partner must verify a site-visit OTP before buyer contact is revealed.' },
        { q: 'What is the escrow / token advance system?', a: 'Before closing a deal the buyer deposits a token advance via Razorpay into our escrow. Released to the seller once confirmed, or refunded if it falls through.' },
        { q: 'How long does KYC verification take?', a: 'Our team typically reviews KYC documents within 24 working hours. You will receive a notification once complete.' },
        { q: 'What documents do I need for KYC?', a: 'Government-issued ID (Aadhaar or PAN), address proof, and relevant professional certifications (RERA registration for agents/builders).' },
        { q: 'Can I list my property for free?', a: 'Yes, listing is free. We earn a platform commission only on successful deal closures.' },
      ]),
      excerpt: 'Common questions about RealtyDoor, property listings, KYC, escrow, and the buying process.',
      tags: ['FAQ', 'Help', 'KYC', 'Escrow', 'Listings'],
      isPublished: true, publishedAt: new Date('2024-01-01'),
    },
    {
      type: 'FAQ', title: 'Bengaluru Plot Buying FAQs', slug: 'bengaluru-plot-buying-faqs',
      content: JSON.stringify({
        categories: [
          {
            category: 'Legal & Document Verification',
            faqs: [
              {
                question: 'What are the 3 documents every plot buyer MUST check?',
                answerHtml: '<p>Never buy a plot without verifying these three critical documents:</p><ul><li><strong>The Mother Deed:</strong> Traces the ownership history of the land back to its origin. Essential to prove the seller has absolute rights.</li><li><strong>Encumbrance Certificate (EC) - 30 Years:</strong> Proves there are no pending loans, mortgages, or legal disputes on the property.</li><li><strong>DC Conversion Order:</strong> Confirms the Deputy Commissioner has legally converted the land from agricultural to residential use.</li></ul><p><strong>Realtydoor Data Insight:</strong> Over 64% of property disputes in Bangalore arise from missing links in the Mother Deed. We verify all 30 years of history before shortlisting.</p>',
                relatedBlogSlug: 'critical-plot-documents-checklist-bangalore',
              },
              {
                question: 'BDA vs BMRDA vs Panchayat — which is actually safe?',
                answerHtml: '<p>There is a massive difference in safety, legality, and loan eligibility:</p><p><strong>BDA / BMRDA / RERA (100% Safe):</strong> Follows strict city planning rules. Mandated 30ft minimum roads, designated parks, and STPs. Fully eligible for SBI, HDFC, and all nationalized bank loans up to 70-80%.</p><p><strong>Panchayat / B-Khata (High Risk):</strong> Often lacks basic infrastructure. Highly risky, illegal for residential development in many zones, and practically impossible to get major bank funding.</p>',
                relatedBlogSlug: 'bda-vs-bmrda-vs-panchayat-khata-bangalore',
              },
              {
                question: 'How to read a Sale Deed before signing — red flags to spot',
                answerHtml: "<p>Before you sign, check these three critical sections:</p><ol><li><strong>The Indemnity Clause:</strong> Ensure it states the seller will compensate you if the title is found defective later.</li><li><strong>Schedule Property Dimensions:</strong> The dimensions in the deed MUST perfectly match the physical measurements and the layout plan.</li><li><strong>Seller Consistency:</strong> The names on the deed must exactly match the Encumbrance Certificate. If it's inherited property, ALL legal heirs must sign.</li></ol>",
                relatedBlogSlug: 'property-sale-deed-red-flags-bangalore',
              },
              {
                question: 'Converting agricultural land to residential — what it costs and how long?',
                answerHtml: '<p>DC Conversion (Deputy Commissioner) is a mandatory legal process to convert farm land for residential use.</p><ul><li><strong>Timeline:</strong> Typically takes 3 to 6 months depending on the zone.</li><li><strong>Costs:</strong> Varies heavily based on government guidance value, land size, and specific zoning regulations.</li></ul><p><strong>Warning:</strong> Never buy agricultural land hoping you can easily convert it later. Buy land that is ALREADY converted to avoid years of bureaucratic delays.</p>',
                relatedBlogSlug: 'dc-conversion-agricultural-land-bangalore',
              },
            ],
          },
          {
            category: 'Taxes, Fees & Hidden Costs',
            faqs: [
              {
                question: 'Stamp duty + registration charges in Karnataka — full breakdown 2026',
                answerHtml: '<p>As of 2026, here is the exact breakdown for properties above ₹45 Lakhs in Karnataka:</p><ul><li>Stamp Duty: 5.60%</li><li>Registration Fee: 1.00%</li><li>Cess &amp; Surcharges: ~0.05%</li><li><strong>Total Approximate: 6.65%</strong></li></ul><p>Always calculate this against the Government Guidance Value or the Sale Value, whichever is higher.</p>',
                relatedBlogSlug: 'stamp-duty-registration-charges-bangalore',
              },
              {
                question: 'How property tax works in Bangalore — and why unpaid tax is YOUR problem',
                answerHtml: "<p>In Bangalore, the liability of unpaid property tax transfers to the new buyer.</p><p>If the seller hasn't paid tax for 5 years, the BBMP will demand the arrears (with heavy penalties) from YOU after registration. We ensure up-to-date tax receipts (Tax Paid Receipts - TPR) are collected and verified before any token advance is paid.</p>",
                relatedBlogSlug: 'property-tax-bangalore-unpaid-arrears',
              },
            ],
          },
          {
            category: 'Site Visit & Negotiation',
            faqs: [
              {
                question: 'What to look for during a plot site visit — live checklist',
                answerHtml: "<p>Don't just look at the view. Check these physical indicators:</p><ul><li><strong>Approach Road Width:</strong> BMRDA requires a minimum 30ft road. If it's narrower, the layout is likely unapproved.</li><li><strong>High-Tension Wires:</strong> Ensure no major electrical lines pass directly over the plot (severely impacts resale and construction safety).</li><li><strong>Boundary Stones:</strong> Are the physical dimensions clearly marked and matching the layout plan?</li><li><strong>Water Logging Indicators:</strong> Check the slope of the layout and ask locals about monsoon flooding.</li></ul>",
                relatedBlogSlug: 'plot-site-visit-checklist-bangalore',
              },
              {
                question: '10 questions to ask any plot seller before paying a token advance',
                answerHtml: '<p>Crucial questions to weed out bad sellers:</p><ul><li>Is the original mother deed with you or pledged to a bank?</li><li>Are all legal heirs of the property alive and willing to sign?</li><li>Has the layout been handed over to the local authority for maintenance?</li><li>What is the current guidance value versus your asking price?</li><li>Are there any pending property tax or association dues?</li></ul>',
                relatedBlogSlug: '10-questions-plot-token-advance-bangalore',
              },
              {
                question: 'How to negotiate a plot price in Bangalore — 6 proven tactics',
                answerHtml: "<p>Data-driven negotiation works best:</p><ul><li><strong>Guidance Value Baseline:</strong> Use the sub-registrar's guidance value to anchor your negotiation.</li><li><strong>Fast Closing Discount:</strong> Offer a faster closing timeline (30 days vs 90 days). Sellers often drop prices by 5-10% for immediate liquidity.</li><li><strong>Market Comps:</strong> Quote recent transaction values (not asking prices) of adjacent plots.</li><li><strong>Check Motivation:</strong> Is the seller relocating or funding an education? Highly motivated sellers offer the best margins.</li></ul>",
                relatedBlogSlug: 'negotiate-plot-price-bangalore',
              },
            ],
          },
          {
            category: 'Financing & Loans',
            faqs: [
              {
                question: 'Why are plot loans harder to get than home loans?',
                answerHtml: '<p>Banks view open land as a higher speculative risk compared to a constructed flat.</p><p><strong>Home Loans:</strong> Typically 80-90% funding.</p><p><strong>Plot Loans:</strong> Capped at 70% funding.</p><p>Furthermore, plot loans are strictly reserved for approved layouts (BDA, BMRDA, RERA). You cannot get a nationalized bank loan for an unapproved Panchayat layout.</p>',
                relatedBlogSlug: 'why-plot-loans-are-harder-than-home-loans-bangalore-bangalore',
              },
              {
                question: 'Plot loan comparison: SBI vs HDFC vs Axis?',
                answerHtml: '<ul><li><strong>SBI:</strong> Offers the lowest interest rates (~8.5%) but has the strictest legal verification processes and longer processing times (2-4 weeks).</li><li><strong>HDFC/Axis:</strong> Offer slightly higher rates (~8.75% - 9.0%) but provide much faster processing (7-10 days) and excellent doorstep service.</li></ul><p>We match you with the right bank based on your property type and credit profile to ensure zero rejections.</p>',
                relatedBlogSlug: 'plot-loan-comparison-sbi-hdfc-axis',
              },
            ],
          },
          {
            category: 'Performance Data & Real Case Studies',
            faqs: [
              {
                question: 'Data drop: Realtydoor client portfolio performance — H1 2026',
                answerHtml: '<p><strong>14.2%</strong> Average Annualized Appreciation. <strong>0%</strong> Legal Disputes or Stalled Handovers.</p><p>In the first half of 2026, plots acquired through Realtydoor significantly outperformed local benchmarks, driven by our strict filtering for tier-1 developer layouts and upcoming metro corridors.</p>',
                relatedBlogSlug: 'realtydoor-portfolio-performance-h1-2026',
              },
              {
                question: '6-month check-in: Where are our January 2026 buyers now?',
                answerHtml: '<p>Clients who secured plots in January 2026 in emerging corridors like Hosur Road and Devanahalli have already seen a 6-9% equity bump.</p><p>This rapid growth was driven by two factors we predicted:</p><ul><li>Revised government guidance values pushing up floor prices.</li><li>New infrastructure and tech park announcements in the state budget.</li></ul>',
                relatedBlogSlug: 'where-are-our-january-2026-plot-buyers-now',
              },
              {
                question: 'Case study: ₹38L Sarjapur plot — how we found it, verified it, closed it',
                answerHtml: '<p><strong>The Goal:</strong> Client wanted a secure plot under ₹40L in Sarjapur.</p><ul><li><strong>Rejected:</strong> 14 properties due to hidden B-Khata issues and lake buffer zone (NGT) violations.</li><li><strong>Found:</strong> A ₹38L fully BMRDA-approved plot in an upcoming layout.</li><li><strong>Negotiated:</strong> Secured a 5% discount by offering a 12-day closing timeline.</li></ul>',
                relatedBlogSlug: 'case-study-38l-sarjapur-plot',
              },
              {
                question: 'Case study: IT manager, Devanahalli ₹26L → ₹71L in 4 years',
                answerHtml: '<p>An IT manager bought a 1500 sqft plot in Devanahalli in 2022 for ₹26L through our advisory.</p><p>2022 Value: ₹26 Lakhs → 2026 Value: ₹71 Lakhs</p><p>Driven by the Airport expansion, Blue Line Metro, and massive SEZ developments. This is the power of holding clear-title land in high-growth corridors.</p>',
                relatedBlogSlug: 'case-study-devanahalli-plot-26l-to-71l',
              },
            ],
          },
          {
            category: 'Investment Strategy & ROI',
            faqs: [
              {
                question: 'The ₹50L mistake most Bangalore buyers make (and how to avoid it)',
                answerHtml: '<p>The biggest mistake is waiting 2-3 years for the "perfect" plot or a market crash, all while paying ₹30,000/month in rent.</p><p>In Bangalore\'s market, a premium plot priced at ₹50L today will likely hit ₹75L by the time you finish over-researching.</p><p><strong>The Fix:</strong> Stop looking for a 100% perfect plot. If the title is 100% clear and the location has solid 5-year growth drivers, act decisively.</p>',
                relatedBlogSlug: 'costly-mistakes-bangalore-plot-buyers-make',
              },
              {
                question: 'Plot vs Flat vs Mutual Fund — honest data comparison',
                answerHtml: '<p>Here is how the data stacks up from 2021-2026 in Bangalore:</p><ul><li>Premium Plots (South/North Bangalore): +120% to +150%</li><li>Mutual Funds (Nifty 50 Index): +70% to +90%</li><li>Luxury Flats (Whitefield/ORR): +40% to +60%</li></ul><p>While mutual funds offer liquidity, plots offer unparalleled exponential growth. Flats begin depreciating structurally the moment you buy them, and suffer from high monthly maintenance.</p>',
                relatedBlogSlug: 'plot-vs-flat-vs-mutual-fund-investment',
              },
            ],
          },
          {
            category: 'Location Guide (2026)',
            faqs: [
              {
                question: 'North Bangalore vs South Bangalore plots — 10-year outlook',
                answerHtml: '<p><strong>North Bangalore:</strong> Aggressive, high-growth market driven by KIA Airport, Blue Line Metro, and upcoming Boeing/Foxconn tech parks. Best for massive capital appreciation.</p><p><strong>South Bangalore:</strong> Established, lifestyle-driven market (Sarjapur, Kanakapura Rd). Offers stable, steady appreciation with much better immediate livability and schools.</p>',
                relatedBlogSlug: 'north-vs-south-bangalore-plots-10-year-outlook',
              },
              {
                question: 'Hosur Road plots — underrated or overhyped? My honest take',
                answerHtml: '<p><strong>Verdict: Highly Underrated.</strong></p><p>With the upcoming Yellow Line metro and massive industrial growth expanding towards Attibele and Anekal, Hosur road is offering clear-title plots at ₹30L-₹40L.</p><p>This corridor will see massive compounding in the next 5 years as the Electronic City IT corridor physically expands southward.</p>',
                relatedBlogSlug: null,
              },
              {
                question: 'Sarjapur vs Whitefield vs Devanahalli in 2026?',
                answerHtml: '<ul><li><strong>Whitefield:</strong> Saturated but highly stable. Good for end-use, low capital appreciation.</li><li><strong>Sarjapur:</strong> Excellent mid-term growth due to upcoming tech parks, but currently suffers from severe traffic bottlenecks.</li><li><strong>Devanahalli:</strong> The ultimate long-term play. High risk/high reward, driven by Airport expansion and massive SEZ developments.</li></ul>',
                relatedBlogSlug: 'sarjapur-vs-whitefield-vs-devanahalli-investment',
              },
              {
                question: 'Is Hoskote a good place to live?',
                answerHtml: '<p>Hoskote is rapidly developing into a peaceful, well-connected suburb. For those looking to escape the dense city traffic while maintaining access to IT hubs via upcoming ring roads, it offers an excellent quality of life.</p>',
                relatedBlogSlug: 'is-investing-in-hoskote-plots-worth-it',
              },
              {
                question: 'How far is Hoskote from Bangalore Airport?',
                answerHtml: '<p>Hoskote is approximately 40-50 minutes away from Kempegowda International Airport. The completion of the STRR will further reduce this travel time drastically.</p>',
                relatedBlogSlug: 'is-investing-in-hoskote-plots-worth-it',
              },
              {
                question: 'Why is land value increasing in Hoskote?',
                answerHtml: '<p>The surge is primarily driven by massive infrastructure projects (STRR, PRR), proximity to the Narsapura Industrial hub, and the outward expansion of the Whitefield IT corridor.</p>',
                relatedBlogSlug: 'is-investing-in-hoskote-plots-worth-it',
              },
            ],
          },
          {
            category: 'NRI Buyers',
            faqs: [
              {
                question: 'NRI Guide: How to buy a Bangalore plot remotely in 2026?',
                answerHtml: '<p>You no longer need to fly down to close a deal. The standard process is:</p><ol><li><strong>Virtual Tour &amp; Legal Check:</strong> We conduct live video tours and clear 30-year property titles with our legal team.</li><li><strong>Specific Power of Attorney (SPA):</strong> You draft an SPA and register/attest it at the local Indian Embassy or Consulate in your country of residence.</li><li><strong>Courier &amp; Registration:</strong> You courier the original SPA to a trusted blood relative in Bangalore, who will sign the final sale deed on your behalf at the sub-registrar office.</li></ol>',
                relatedBlogSlug: 'nri-guide-buying-plot-bangalore-remotely',
              },
              {
                question: 'Is a PAN card mandatory for NRIs to buy property in India?',
                answerHtml: '<p>Yes, a Permanent Account Number (PAN) card is strictly mandatory for any real estate transaction in India, regardless of the value. It is required for property registration, TDS compliance, and filing related income tax returns.</p>',
                relatedBlogSlug: 'nri-guide-buying-plot-bangalore-remotely',
              },
              {
                question: 'What are the TDS (Tax Deducted at Source) rules for NRIs buying a plot?',
                answerHtml: '<p>If you are buying from a resident Indian and the property value exceeds ₹50 Lakhs, you must deduct 1% TDS. However, if you are buying from another NRI, the TDS rate is much higher (typically 20% to 23% depending on long-term capital gains), and you will need to deduct this before paying the seller.</p>',
                relatedBlogSlug: 'nri-guide-buying-plot-bangalore-remotely',
              },
              {
                question: 'Can I easily repatriate the money back to my home country when I sell the plot later?',
                answerHtml: '<p>Yes, but with limits. NRIs can repatriate up to USD 1 million per financial year (April–March) from their NRO account, which includes proceeds from property sales. You will need to submit Form 15CA and a Chartered Accountant\'s certificate (Form 15CB) to your bank confirming that applicable capital gains taxes have been paid.</p>',
                relatedBlogSlug: 'nri-guide-buying-plot-bangalore-remotely',
              },
              {
                question: 'Can an NRI buy a property jointly with a foreign citizen spouse?',
                answerHtml: '<p>A foreign citizen of non-Indian origin cannot buy property in India unless they are a resident of India (living in India for more than 182 days in the preceding year). Therefore, an NRI cannot jointly purchase property with a non-resident foreign citizen spouse. However, joint ownership with a resident Indian or another NRI is permitted.</p>',
                relatedBlogSlug: 'nri-guide-buying-plot-bangalore-remotely',
              },
            ],
          },
        ],
      }),
      excerpt: 'Categorized FAQs for Bengaluru plot buyers — legal documents, taxes, financing, site visits, and NRI guidance.',
      tags: ['FAQ', 'Bengaluru', 'Plots', 'Legal', 'NRI'],
      isPublished: true, publishedAt: new Date(),
    },
    {
      type: 'ANNOUNCEMENT', title: 'Welcome to RealtyDoor Beta!', slug: 'welcome-realtydoor-beta',
      content: "<p>We are excited to launch RealtyDoor — India's most transparent real estate platform. Our mission is to eliminate property fraud through technology, escrow-backed deals, and KYC-verified partners.</p><p>During beta, all services are available at introductory pricing. We'd love your feedback!</p>",
      excerpt: 'RealtyDoor is officially live! Explore verified properties and enjoy secure escrow-backed deals.',
      imageUrl: 'https://images.unsplash.com/photo-1560518883-ce09059eeffa?w=1200',
      author: 'RealtyDoor Team',
      tags: ['Announcement', 'Launch', 'Beta'],
      isPublished: true, publishedAt: new Date('2024-01-01'),
    },
  ];

  for (const block of contentDefs) {
    const existing = block.slug
      ? await prisma.contentBlock.findFirst({ where: { slug: block.slug } })
      : null;
    if (!existing) {
      await prisma.contentBlock.create({ data: block });
      console.log(`✅  Content  : [${block.type}] ${block.title}`);
    } else {
      console.log(`⏭   Content  : [${block.type}] ${block.title}`);
    }
  }

  // ── 13. Notifications ─────────────────────────────────────────────────────

  const notifDefs = [
    { userId: partner.id, title: 'New Lead Assigned', type: 'LEAD_ASSIGNED', isRead: false, message: 'A new lead has been assigned to you for "3 BHK Flat in Baner".', linkUrl: '/partner/leads' },
    { userId: partner.id, title: 'Property Approved', type: 'PROPERTY_APPROVED', isRead: true, message: 'Your listing "3 BHK Flat in Baner" has been approved and is now live.', linkUrl: '/partner/listings' },
    { userId: user.id, title: 'Service Activated', type: 'SERVICE_ACTIVATED', isRead: false, message: 'Your Maintenance Premium plan is now active. Book your first visit anytime!', linkUrl: '/dashboard/services' },
    { userId: user.id, title: 'Escrow Payment Confirmed', type: 'ESCROW_HELD', isRead: true, message: 'Your token advance of ₹85,000 for "3 BHK Flat in Baner" is now held in escrow.', linkUrl: '/dashboard/finance' },
    { userId: user.id, title: 'Escrow Released to Seller', type: 'ESCROW_RELEASED', isRead: false, message: 'Your token advance for "3 BHK Flat in Baner" has been released to the seller. Deal confirmed!', linkUrl: '/dashboard/finance' },
    { userId: admin.id, title: 'New KYC Submission', type: 'KYC_PENDING', isRead: false, message: 'Priya Sharma (Partner) has submitted KYC documents for review.', linkUrl: '/admin/kyc' },
  ];

  for (const nData of notifDefs) {
    const existing = await prisma.notification.findFirst({
      where: { userId: nData.userId, title: nData.title },
    });
    if (!existing) {
      await prisma.notification.create({ data: nData });
      console.log(`✅  Notif    : [${nData.type}] ${nData.title}`);
    } else {
      console.log(`⏭   Notif    : ${nData.title}`);
    }
  }

  // ── 14. Favorites ─────────────────────────────────────────────────────────

  const favDefs = [
    { userId: user.id,  propertyId: propBaner.id },
    { userId: user.id,  propertyId: propOffice.id },
    { userId: user2.id, propertyId: propBaner.id },
    { userId: user2.id, propertyId: propAundh.id },
  ];

  for (const fData of favDefs) {
    const existing = await prisma.favorite.findFirst({
      where: { userId: fData.userId, propertyId: fData.propertyId },
    });
    if (!existing) {
      await prisma.favorite.create({ data: fData });
      console.log(`✅  Favorite : saved`);
    } else {
      console.log(`⏭   Favorite : (already exists)`);
    }
  }

  // ── 15. Property Edit Logs ────────────────────────────────────────────────

  const editLogDefs = [
    {
      propertyId: propBaner.id, editedBy: admin.id, editedByName: 'Admin User',
      fieldChanged: 'price', oldValue: '9000000', newValue: '8500000',
      editNote: 'Adjusted price to match comparable listings in Baner.',
    },
    {
      propertyId: propBaner.id, editedBy: admin.id, editedByName: 'Admin User',
      fieldChanged: 'reraNumber', oldValue: null, newValue: 'P52100012345',
      editNote: 'Added RERA number after partner provided document.',
    },
    {
      propertyId: propAundh.id, editedBy: admin.id, editedByName: 'Admin User',
      fieldChanged: 'isFeatured', oldValue: 'false', newValue: 'true',
      editNote: 'Promoting premium listing to featured section.',
    },
  ];

  for (const elData of editLogDefs) {
    const existing = await prisma.propertyEditLog.findFirst({
      where: { propertyId: elData.propertyId, fieldChanged: elData.fieldChanged },
    });
    if (!existing) {
      await prisma.propertyEditLog.create({ data: elData });
      console.log(`✅  EditLog  : "${elData.fieldChanged}" on property ${elData.propertyId}`);
    } else {
      console.log(`⏭   EditLog  : "${elData.fieldChanged}" (already exists)`);
    }
  }

  // ── 16. Audit Logs ────────────────────────────────────────────────────────

  const auditDefs = [
    {
      adminId: admin.id, action: 'LEAD_ASSIGNED', targetType: 'Lead', targetId: leadClosed.id,
      after: JSON.stringify({ assignedPartnerId: partner.id, status: 'ASSIGNED' }),
      ipAddress: '127.0.0.1', actorRole: 'ADMIN',
    },
    {
      adminId: admin.id, action: 'PROPERTY_APPROVED', targetType: 'Property', targetId: propBaner.id,
      before: JSON.stringify({ publishStatus: 'PENDING_APPROVAL' }),
      after: JSON.stringify({ publishStatus: 'APPROVED' }),
      ipAddress: '127.0.0.1', actorRole: 'ADMIN',
    },
    {
      adminId: admin.id, action: 'KYC_APPROVE', targetType: 'User', targetId: partner.id,
      before: JSON.stringify({ kycStatus: 'PENDING_REVIEW' }),
      after: JSON.stringify({ kycStatus: 'VERIFIED' }),
      ipAddress: '127.0.0.1', actorRole: 'ADMIN',
    },
    {
      adminId: admin.id, action: 'ESCROW_RELEASED', targetType: 'EscrowTransaction', targetId: escrow1.id,
      before: JSON.stringify({ status: 'HELD' }),
      after: JSON.stringify({ status: 'RELEASED' }),
      ipAddress: '127.0.0.1', actorRole: 'ADMIN',
    },
    {
      adminId: admin.id, action: 'PROPERTY_REJECTED', targetType: 'Property', targetId: propRejected.id,
      before: JSON.stringify({ publishStatus: 'PENDING_APPROVAL' }),
      after: JSON.stringify({ publishStatus: 'REJECTED', rejectionNote: 'RERA number missing.' }),
      ipAddress: '127.0.0.1', actorRole: 'ADMIN',
    },
  ];

  for (const aData of auditDefs) {
    const existing = await prisma.auditLog.findFirst({
      where: { adminId: aData.adminId, action: aData.action, targetId: aData.targetId },
    });
    if (!existing) {
      await prisma.auditLog.create({ data: aData });
      console.log(`✅  Audit    : ${aData.action} on ${aData.targetType}`);
    } else {
      console.log(`⏭   Audit    : ${aData.action} (already exists)`);
    }
  }

  // ── 17. Construction Updates ──────────────────────────────────────────────

  const constructionUpdateDefs = [
    {
      propertyId: propUnderConstruction.id,
      milestoneTitle: 'Foundation Work Completed',
      description: 'Excavation and foundation work for all 4 towers has been completed ahead of schedule. Structural safety audit passed with Grade A certification.',
      mediaUrls: [
        'https://images.unsplash.com/photo-1504307651254-35680f356dfd?w=800',
        'https://images.unsplash.com/photo-1581094288338-2314dddb7ece?w=800',
      ],
      completionPct: 15,
      postedAt: daysAgo(60),
    },
    {
      propertyId: propUnderConstruction.id,
      milestoneTitle: 'Floors 1–5 Slab Casting Done',
      description: 'Slab casting for floors 1 through 5 completed across Tower A and B. Electrical and plumbing rough-in work underway.',
      mediaUrls: [
        'https://images.unsplash.com/photo-1590725140246-20acddc1ec6d?w=800',
      ],
      completionPct: 30,
      postedAt: daysAgo(30),
    },
    {
      propertyId: propUnderConstruction.id,
      milestoneTitle: 'Floors 6–10 Structural Work In Progress',
      description: 'Currently working on floors 6–10. Brickwork on lower floors progressing well. Window installation scheduled for next month.',
      mediaUrls: [
        'https://images.unsplash.com/photo-1582561424760-0321d75e81fa?w=800',
      ],
      completionPct: 45,
      postedAt: daysAgo(5),
    },
  ];

  for (const cuData of constructionUpdateDefs) {
    const existing = await prisma.constructionUpdate.findFirst({
      where: { propertyId: cuData.propertyId, milestoneTitle: cuData.milestoneTitle },
    });
    if (!existing) {
      await prisma.constructionUpdate.create({ data: cuData });
      console.log(`✅  ConstrUp : ${cuData.milestoneTitle} (${cuData.completionPct}%)`);
    } else {
      console.log(`⏭   ConstrUp : ${cuData.milestoneTitle}`);
    }
  }

  // ── 18. Video Tour Requests ────────────────────────────────────────────────

  // Mark user1 as NRI so the request makes sense
  await prisma.user.update({ where: { id: user.id }, data: { isNRI: true } });

  const videoTourDefs = [
    // PENDING — just submitted
    {
      userId: user.id, propertyId: propBaner.id,
      status: 'PENDING',
      userNote: 'I am based in Dubai and cannot visit in person. Please arrange a live walkthrough of the 3 BHK.',
    },
    // ASSIGNED — admin assigned to partner
    {
      userId: user2.id, propertyId: propUnderConstruction.id,
      status: 'ASSIGNED',
      assignedTo: partner2.id,
      scheduledAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000), // 3 days from now
      userNote: 'Interested in the under-construction project. Want to see current progress on site.',
      adminNote: 'Assigned to Priya Sharma (builder). Scheduled virtual walk for 3 days out.',
    },
    // COMPLETED — video delivered
    {
      userId: user.id, propertyId: propAundh.id,
      status: 'COMPLETED',
      assignedTo: partner.id,
      videoUrl: 'https://example.com/tours/aundh-4bhk-walkaround.mp4',
      scheduledAt: daysAgo(10),
      completedAt: daysAgo(9),
      userNote: 'NRI buyer from UK. Please cover the garden and rooftop terrace in detail.',
      adminNote: 'Tour completed. Video uploaded and shared with buyer.',
    },
  ];

  for (const vtData of videoTourDefs) {
    const existing = await prisma.videoTourRequest.findFirst({
      where: { userId: vtData.userId, propertyId: vtData.propertyId },
    });
    if (!existing) {
      await prisma.videoTourRequest.create({ data: vtData });
      console.log(`✅  VideoTour: [${vtData.status}] userId=${vtData.userId}`);
    } else {
      console.log(`⏭   VideoTour: (already exists)`);
    }
  }

  // ── 19. B2B Connection ────────────────────────────────────────────────────

  let b2b = await prisma.b2BConnection.findFirst({
    where: { buyerPartnerId: partner2.id, propertyId: propBaner.id },
  });
  if (!b2b) {
    b2b = await prisma.b2BConnection.create({
      data: {
        listingPartnerId: partner.id,
        buyerPartnerId: partner2.id,
        propertyId: propBaner.id,
        status: 'INTERESTED',
        message: 'I have a client looking for a 3 BHK in Baner. Would like to discuss co-brokerage terms.',
      },
    });
    console.log(`✅  B2B      : partner2 INTERESTED in Baner property`);
  } else {
    console.log(`⏭   B2B      : (already exists)`);
  }

  // ── 20. Vendors ───────────────────────────────────────────────────────────

  const vendorDefs = [
    { name: 'Quick Fix Plumbers',   phone: '+919800100200', email: 'quickfix@example.com',  category: 'PLUMBING',   city: 'Pune', notes: 'Available 7 days. Specialises in burst pipes and tap fittings.', isActive: true },
    { name: 'Safe Electric Co.',    phone: '+919800200300', email: 'safeelec@example.com',  category: 'ELECTRICAL', city: 'Pune', notes: 'ESCI-certified. 24hr emergency callout.', isActive: true },
    { name: 'ColorCraft Painters',  phone: '+919800300400', email: null,                     category: 'PAINTING',   city: 'Pune', notes: 'Interior and exterior painting. 3-year warranty.', isActive: true },
    { name: 'BuildRight Carpentry', phone: '+919800400500', email: 'buildright@example.com', category: 'CARPENTRY',  city: 'Pune', notes: 'Modular kitchen and wardrobe specialists.', isActive: true },
    { name: 'All-Round Services',   phone: '+919800500600', email: null,                     category: 'GENERAL',    city: 'Pune', notes: 'General handyman — minor repairs and maintenance.', isActive: false },
  ];

  const vendors = [];
  for (const vData of vendorDefs) {
    const existing = await prisma.vendor.findFirst({ where: { phone: vData.phone } });
    if (!existing) {
      const v = await prisma.vendor.create({ data: vData });
      console.log(`✅  Vendor   : ${vData.name} [${vData.category}]`);
      vendors.push(v);
    } else {
      console.log(`⏭   Vendor   : ${vData.name}`);
      vendors.push(existing);
    }
  }
  const [vendor1] = vendors;

  // ── 21. Property Reviews ───────────────────────────────────────────────────

  const reviewDefs = [
    // Approved — visible publicly
    {
      userId: user.id, propertyId: propBaner.id,
      rating: 5, title: 'Excellent flat — highly recommend',
      body: 'The 3 BHK in Baner exceeded our expectations. Great construction quality, excellent ventilation, and the society amenities are top-notch. RealtyDoor made the entire process seamless.',
      isApproved: true, moderatedAt: daysAgo(3), moderatedByAdminId: admin.id,
    },
    // Pending moderation — not yet public
    {
      userId: user2.id, propertyId: propBaner.id,
      rating: 3, title: 'Good property, maintenance could improve',
      body: 'The flat itself is well-designed but the society maintenance team is slow to respond. Lift was down for 2 days last month.',
      isApproved: false,
    },
    // Approved on a different property
    {
      userId: user2.id, propertyId: propAundh.id,
      rating: 4, title: 'Premium locality, worth the price',
      body: 'The bungalow in Aundh is spacious and the private garden is a great bonus. Slightly over budget but quality justifies it.',
      isApproved: true, moderatedAt: daysAgo(5), moderatedByAdminId: admin.id,
    },
  ];

  const reviews = [];
  for (const rData of reviewDefs) {
    const existing = await prisma.propertyReview.findFirst({
      where: { userId: rData.userId, propertyId: rData.propertyId },
    });
    if (!existing) {
      const r = await prisma.propertyReview.create({ data: rData });
      console.log(`✅  Review   : ${rData.rating}★ [${rData.isApproved ? 'APPROVED' : 'PENDING'}] by userId=${rData.userId}`);
      reviews.push(r);
    } else {
      console.log(`⏭   Review   : (already exists)`);
      reviews.push(existing);
    }
  }
  const [review1] = reviews;

  // ── 22. Disputes ──────────────────────────────────────────────────────────

  const disputeDefs = [
    // OPEN — just raised by user1 on the HELD escrow
    {
      userId: user2.id, type: 'ESCROW', referenceId: escrow2.id,
      reason: 'Escrow held but deal fallen through',
      description: 'The seller has withdrawn from the deal after the token was deposited. The escrow is still HELD and I need it refunded urgently. Please investigate and initiate the refund process.',
      status: 'OPEN',
    },
    // UNDER_REVIEW — admin has acknowledged
    {
      userId: user.id, type: 'SERVICE', referenceId: sub.id,
      reason: 'Vendor did not show up for scheduled visit',
      description: 'The plumbing vendor was scheduled for 10 Jan but did not arrive. No advance notice was given. This has disrupted our schedule and the leaking tap is now causing water damage.',
      status: 'UNDER_REVIEW',
      adminNote: 'We have contacted Quick Fix Plumbers. A replacement visit has been rescheduled for tomorrow.',
    },
  ];

  const disputes = [];
  for (const dData of disputeDefs) {
    const existing = await prisma.dispute.findFirst({
      where: { userId: dData.userId, referenceId: dData.referenceId },
    });
    if (!existing) {
      const d = await prisma.dispute.create({ data: dData });
      console.log(`✅  Dispute  : [${dData.status}] ${dData.type} by userId=${dData.userId}`);
      disputes.push(d);
    } else {
      console.log(`⏭   Dispute  : (already exists)`);
      disputes.push(existing);
    }
  }
  const [dispute1] = disputes;

  // ── 23. Platform Config ───────────────────────────────────────────────────

  const configDefs = [
    { key: 'platform_name',          value: 'RealtyDoor',                                                      description: 'Platform display name',                         isPublic: true,  updatedByAdminId: admin.id },
    { key: 'support_phone',          value: '+919000000001',                                                    description: 'Customer support WhatsApp number',               isPublic: true,  updatedByAdminId: admin.id },
    { key: 'support_email',          value: 'support@realtydoor.in',                                            description: 'Customer support email address',                 isPublic: true,  updatedByAdminId: admin.id },
    { key: 'rera_disclaimer',        value: 'RERA registrations vary by state. Verify at maharera.mahaonline.gov.in before investing.', description: 'RERA disclaimer shown on listings', isPublic: true, updatedByAdminId: admin.id },
    { key: 'platform_commission_pct', value: '2',                                                               description: 'Platform commission % on closed deals',          isPublic: false, updatedByAdminId: admin.id },
    { key: 'escrow_token_min_paise', value: '5000000',                                                          description: 'Minimum token advance in paise (₹50,000)',       isPublic: false, updatedByAdminId: admin.id },
    { key: 'razorpay_webhook_secret', value: 'whsec_seed_placeholder',                                          description: 'Razorpay webhook HMAC signing secret',           isPublic: false, updatedByAdminId: admin.id },
  ];

  for (const cData of configDefs) {
    await prisma.platformConfig.upsert({
      where:  { key: cData.key },
      update: cData,
      create: cData,
    });
    console.log(`✅  Config   : ${cData.key} [${cData.isPublic ? 'public' : 'private'}]`);
  }

  // ── 24. Partner Support Tickets ───────────────────────────────────────────

  const supportTicketDefs = [
    {
      partnerId: partner.id, ticketNo: 'SUP-0001',
      subject: 'Escrow release delayed for deal D-0038',
      description: 'The deal was closed 5 days ago but the escrow has not been released yet. Buyer has confirmed the deal. Please investigate and initiate release.',
      category: 'ESCROW', status: 'OPEN',
    },
    {
      partnerId: partner.id, ticketNo: 'SUP-0002',
      subject: 'Buyer OTP not received via WhatsApp',
      description: 'Buyer Suresh Mehta did not receive the site visit OTP on +919000000003. We tried 3 times. Please resend or override.',
      category: 'LEAD', status: 'RESOLVED',
      adminReply: 'OTP has been resent. If issue persists contact WATI support. OTP can also be overridden by admin on request.',
      repliedAt: new Date('2024-06-20'), resolvedAt: new Date('2024-06-20'),
    },
    {
      partnerId: partner.id, ticketNo: 'SUP-0003',
      subject: 'Listing rejected — needs clarification',
      description: 'My listing for "2 BHK Flat in Wakad" was rejected but the rejection note says RERA number missing. I have provided RERA P52100099999. Please re-review.',
      category: 'LISTING', status: 'RESOLVED',
      adminReply: 'RERA number verified. Listing has been approved and is now live.',
      repliedAt: new Date('2024-06-12'), resolvedAt: new Date('2024-06-12'),
    },
  ];

  const supportTickets = [];
  for (const stData of supportTicketDefs) {
    const existing = await prisma.partnerSupportTicket.findFirst({
      where: { ticketNo: stData.ticketNo },
    });
    if (!existing) {
      const st = await prisma.partnerSupportTicket.create({ data: stData });
      console.log(`✅  SupTicket: [${stData.status}] ${stData.ticketNo} — ${stData.subject}`);
      supportTickets.push(st);
    } else {
      console.log(`⏭   SupTicket: ${stData.ticketNo}`);
      supportTickets.push(existing);
    }
  }
  const [supportTicket1] = supportTickets;

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log('\n──────────────────────────────────────────────────────────────');
  console.log('🌱  Seed complete!\n');
  console.log('  Copy these IDs into Postman / Thunder Client as variables:\n');
  console.log(`  adminId        = ${admin.id}`);
  console.log(`  partnerId      = ${partner.id}   ← KYC VERIFIED`);
  console.log(`  partner2Id     = ${partner2.id}   ← KYC PENDING_REVIEW`);
  console.log(`  userId         = ${user.id}   ← buyer 1`);
  console.log(`  user2Id        = ${user2.id}   ← buyer 2`);
  console.log(`  propertyId       = ${propBaner.id}   ← 3BHK Baner (APPROVED)`);
  console.log(`  ucPropertyId     = ${propUnderConstruction.id}   ← Wakad (UNDER_CONSTRUCTION)`);
  console.log(`  pendingPropId    = ${propPending.id}   ← Wakad (PENDING_APPROVAL)`);
  console.log(`  rejectedPropId   = ${propRejected.id}   ← Viman Nagar (REJECTED)`);
  console.log(`  leadId         = ${leadClosed.id}   ← CLOSED lead  (+ 10 UNASSIGNED in admin queue)`);
  console.log(`  escrowId       = ${escrow1.id}   ← RELEASED`);
  console.log(`  escrowHeldId   = ${escrow2.id}   ← HELD`);
  console.log(`  subscriptionId = ${sub.id}`);
  console.log(`  vendorId       = ${vendor1?.id ?? 'see above'}`);
  console.log(`  reviewId       = ${review1?.id ?? 'see above'}`);
  console.log(`  disputeId      = ${dispute1?.id ?? 'see above'}`);
  console.log(`  configKey      = support_phone  (use any key from platform config)`);
  console.log(`  supportTicketId = ${supportTicket1?.id ?? 'see above'}   ← SUP-0001 (OPEN)`);
  console.log('\n  Clerk IDs set (replace before live auth testing):');
  console.log(`    ADMIN_CLERK_ID    = ${ADMIN_CLERK_ID}`);
  console.log(`    PARTNER_CLERK_ID  = ${PARTNER_CLERK_ID}`);
  console.log(`    PARTNER2_CLERK_ID = ${PARTNER2_CLERK_ID}`);
  console.log(`    USER_CLERK_ID     = ${USER_CLERK_ID}`);
  console.log(`    USER2_CLERK_ID    = ${USER2_CLERK_ID}`);
  console.log('──────────────────────────────────────────────────────────────\n');
}

main()
  .catch((e) => { console.error('❌  Seed failed:', e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
