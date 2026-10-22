const https = require('https');
const PDFDocument = require('pdfkit');
const { isTrustedMediaUrl } = require('./trustedUrl');

// A brochure for any listed property, built from its CMS record. Used when the property has no brochure PDF of its own
// (a partner-uploaded or imported one always wins; see properties.controller.js getBrochure).
// Standard PDF fonts have no rupee sign, so amounts are written "Rs.".

const rs = (n) => (n == null ? null : `Rs. ${Math.round(n).toLocaleString('en-IN')}`);

function priceLine(p) {
  if (p.listingType === 'RENT' && p.monthlyRent) return `${rs(p.monthlyRent)} per month`;
  if (!p.price) return 'Price on request';
  const lakh = p.price >= 10000000 ? `${(p.price / 10000000).toFixed(2)} crore` : `${(p.price / 100000).toFixed(1)} lakh`;
  return `From ${rs(p.price)} (${lakh})${p.priceNegotiable ? ', negotiable' : ''}`;
}

// Only images on our own storage are fetched, and a redirect is never followed: listing image URLs are partner-controlled,
// so anything else could be made to point the server at an internal address (server-side request forgery).
function fetchImage(url) {
  return new Promise((resolve) => {
    if (!isTrustedMediaUrl(url)) return resolve(null);
    const req = https.get(url, { timeout: 8000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      const type = String(res.headers['content-type'] || '');
      // pdfkit reads JPEG and PNG only
      if (!/jpe?g|png/i.test(type)) { res.resume(); return resolve(null); }
      const MAX_BYTES = 5 * 1024 * 1024;
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BYTES) { req.destroy(); return resolve(null); }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function buildPropertyBrochurePdf(p, siteOrigin = 'https://www.realtydoor.com') {
  const images = [];
  for (const u of (p.images || []).slice(0, 4)) {
    const buf = await fetchImage(u);
    if (buf) images.push(buf);
    if (images.length === 3) break;
  }

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 48, size: 'A4', info: { Title: `${p.title} | Realtydoor brochure`, Author: 'Realtydoor' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width - 96;
    doc.fontSize(11).fillColor('#2c2fee').text('REALTYDOOR', { characterSpacing: 2 });
    doc.moveDown(0.6).fontSize(24).fillColor('#111').text(p.title, { width: W });
    const place = [p.locality, p.city, p.state].filter(Boolean).join(', ');
    if (place) doc.moveDown(0.2).fontSize(11).fillColor('#666').text(place);
    doc.moveDown(0.6).fontSize(16).fillColor('#2c2fee').text(priceLine(p));

    if (images[0]) {
      try { doc.moveDown(0.8).image(images[0], doc.x, doc.y, { fit: [W, 230], align: 'center' }); doc.y += 240; } catch (_) { /* skip a bad image */ }
    }

    const facts = [
      ['Type', String(p.propertyType || '').replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())],
      ['For', p.listingType === 'RENT' ? 'Rent' : 'Sale'],
      ['Plot area', p.plotArea ? `${Math.round(p.plotArea).toLocaleString('en-IN')} sq. ft.` : null],
      ['Carpet area', p.carpetArea ? `${Math.round(p.carpetArea).toLocaleString('en-IN')} sq. ft.` : null],
      ['Built-up area', p.builtUpArea ? `${Math.round(p.builtUpArea).toLocaleString('en-IN')} sq. ft.` : null],
      ['Bedrooms', p.bhk ? `${p.bhk} BHK` : null],
      ['Bathrooms', p.bathrooms || null],
      ['Facing', p.facing || null],
      ['Furnishing', p.furnishing ? String(p.furnishing).replace(/_/g, ' ').toLowerCase() : null],
      ['RERA number', p.reraNumber || null],
      ['Address', [p.address, p.pincode].filter(Boolean).join(' - ') || null],
    ].filter(([, v]) => v);
    if (facts.length) {
      doc.moveDown(0.8).fontSize(13).fillColor('#111').text('Key details');
      doc.moveDown(0.3).fontSize(10.5).fillColor('#333');
      facts.forEach(([k, v]) => doc.text(`${k}: `, { continued: true }).fillColor('#111').text(String(v)).fillColor('#333'));
    }

    if (p.description) {
      doc.moveDown(0.8).fontSize(13).fillColor('#111').text('About this property');
      doc.moveDown(0.3).fontSize(10.5).fillColor('#333').text(String(p.description).replace(/\s+/g, ' ').trim(), { width: W, align: 'left' });
    }
    if ((p.amenities || []).length) {
      doc.moveDown(0.8).fontSize(13).fillColor('#111').text('Amenities');
      doc.moveDown(0.3).fontSize(10.5).fillColor('#333').text(p.amenities.join('  |  '), { width: W });
    }
    if ((p.nearbyLandmarks || []).length) {
      doc.moveDown(0.8).fontSize(13).fillColor('#111').text('Nearby');
      doc.moveDown(0.3).fontSize(10.5).fillColor('#333').text(p.nearbyLandmarks.join('  |  '), { width: W });
    }

    if (images.length > 1) {
      doc.addPage();
      doc.fontSize(13).fillColor('#111').text('Photos');
      doc.moveDown(0.5);
      images.slice(1).forEach((img) => {
        try { const y = doc.y; doc.image(img, 48, y, { fit: [W, 300], align: 'center' }); doc.y = y + 315; } catch (_) { /* skip */ }
      });
    }

    doc.fontSize(10).fillColor('#111').text('Talk to us', 48, doc.page.height - 130, { width: W });
    doc.fontSize(9.5).fillColor('#555')
      .text('Phone / WhatsApp: +91 98444 12345   |   Email: info@realtydoor.com')
      .text(`Listing: ${siteOrigin}/properties/${p.slug}`)
      .moveDown(0.5).fontSize(8).fillColor('#999')
      .text('Details are as listed by the owner or partner and may change. Please verify approvals, area and price before you pay any token. Generated from the live listing.', { width: W });
    doc.end();
  });
}

module.exports = { buildPropertyBrochurePdf };
