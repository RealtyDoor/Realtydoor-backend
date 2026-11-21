// The designed welcome email for a new buyer or partner. Table layout with inline styles so it renders the same in Gmail, Outlook,
// Apple Mail and phone clients. Only claims what the product does today (no payment promises). Colours: brand blue #2c2fee.
const fs = require('fs');
const path = require('path');
const { portalUrl } = require('./portalUrl');
const {
  FILES, LOGO_CID, SOCIAL, ASSETS_DIR, esc, BLUE, INK, MUTED, SOFT, LINE, FONT,
  makeSrc, attachmentsFor, socialsHtml, headerRow, helpRow, footerRow, pageOpen, pageClose, stepRows,
} = require('./emailShell');

const CONTENT = {
  buyer: {
    subject: 'Welcome to Realtydoor: your account is ready',
    preheader: 'Verified Bengaluru listings, site visits and expert help, all in one place.',
    headline: 'Welcome to Realtydoor',
    intro: 'Your account is ready. Realtydoor helps you find a verified home or plot in Bengaluru and buy it with confidence, with our team beside you at every step.',
    featuresTitle: 'What you can do',
    features: [
      ['Browse verified listings', 'Every property is checked by our team before it goes live.'],
      ['Save your favourites', 'Keep a shortlist and come back to it from any device.'],
      ['Book a site visit', 'Tell us a property you like and we arrange the visit with the owner or partner.'],
      ['Know the neighbourhood', 'Locality reports show growth, connectivity and what living there is like.'],
      ['Get help any time', 'Raise a support ticket from your dashboard and our team replies.'],
    ],
    stepsTitle: 'How to sign in',
    steps: ['Open the Realtydoor app using the button below.', 'Choose Google, or use the email you registered with.', 'Verify your phone number once with a WhatsApp code. You will land on your dashboard.'],
    button: 'Open the Realtydoor app',
    note: 'Please use this address. The partner portal and the admin site will not open for a buyer account.',
    kind: 'buyer',
  },
  partner: {
    subject: 'Welcome to Realtydoor: your partner account is ready',
    preheader: 'Complete your KYC to start listing properties and receiving leads.',
    headline: 'Welcome to Realtydoor',
    intro: 'Your partner account is ready. List your properties, receive verified buyer leads and track every deal from one dashboard.',
    featuresTitle: 'Your next steps',
    features: [
      ['1. Complete your KYC', 'Upload your documents from the partner dashboard. Our team verifies them, usually within a short time.'],
      ['2. List your properties', 'Add photos, details and documents. Listings go live after our team approves them.'],
      ['3. Receive and work leads', 'Verified buyers are assigned to you. Book visits and update each lead in the app.'],
      ['4. Get paid for closed deals', 'Your commission is calculated from the final deal price and shown in your finance section.'],
    ],
    stepsTitle: 'How to sign in',
    steps: ['Open the partner portal using the button below.', 'Choose Google, or use the email you registered with.', 'Verify your phone number once with a WhatsApp code. You will land on your partner dashboard.'],
    button: 'Open the partner portal',
    note: 'Please use this address only. The buyer app and the admin site will not open for a partner account.',
    kind: 'partner',
  },
};


// inline: true puts every image in the HTML as a data URI (for a browser preview); otherwise they are attached and referenced by cid.
function buildWelcomeEmail(name, role, { inline = false } = {}) {
  const src = (cid) => (inline ? `data:image/png;base64,${fs.readFileSync(path.join(ASSETS_DIR, FILES[cid])).toString('base64')}` : `cid:${cid}`);
  const c = CONTENT[role === 'PARTNER' ? 'partner' : 'buyer'];
  const url = portalUrl(c.kind);
  const support = process.env.SUPPORT_EMAIL || 'support@realtydoor.com';
  const first = esc(String(name || '').trim().split(/\s+/)[0] || 'there');

  const socials = `<table role="presentation" cellpadding="0" cellspacing="0"><tr>${SOCIAL.map(([label, href, cid]) =>
    `<td style="padding-right:10px;"><a href="${esc(href)}" title="${esc(label)}" style="text-decoration:none;"><img src="${src(cid)}" width="40" height="40" alt="${esc(label)}" style="display:block;border:0;border-radius:20px;font:400 12px/40px ${FONT};color:#ffffff;"></a></td>`).join('')}</tr></table>`;

  const features = c.features.map(([t, d]) => `
        <tr><td style="padding:10px 0;border-bottom:1px solid ${LINE};">
          <div style="font:600 15px/22px ${FONT};color:${INK};">${esc(t)}</div>
          <div style="font:400 14px/21px ${FONT};color:${MUTED};padding-top:2px;">${esc(d)}</div>
        </td></tr>`).join('');

  const steps = c.steps.map((s, i) => `
        <tr>
          <td width="34" valign="top" style="padding:6px 0;"><div style="width:24px;height:24px;line-height:24px;border-radius:12px;background:${BLUE};color:#ffffff;text-align:center;font:600 13px/24px ${FONT};">${i + 1}</div></td>
          <td valign="top" style="padding:6px 0;font:400 14px/22px ${FONT};color:${INK};">${esc(s)}</td>
        </tr>`).join('');

  const button = url ? `
      <tr><td align="center" style="padding:22px 0 8px;">
        <a href="${esc(url)}" style="display:inline-block;background:${BLUE};color:#ffffff;text-decoration:none;font:600 16px/20px ${FONT};padding:14px 28px;border-radius:10px;">${esc(c.button)}</a>
      </td></tr>
      <tr><td align="center" style="font:400 13px/20px ${FONT};color:${MUTED};padding-bottom:6px;">or copy this address: <a href="${esc(url)}" style="color:${BLUE};">${esc(url)}</a></td></tr>` : '';

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(c.headline)}</title></head>
<body style="margin:0;padding:0;background:#eef0f7;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#eef0f7;">${esc(c.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef0f7;"><tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;">
    <tr><td style="background:${BLUE};padding:28px 32px;">
      <img src="${src(LOGO_CID)}" width="330" height="40" alt="Realtydoor" style="display:block;border:0;font:700 20px/24px ${FONT};color:#ffffff;">
    </td></tr>
    <tr><td style="padding:32px 32px 8px;">
      <div style="font:700 26px/32px ${FONT};color:${INK};">${esc(c.headline)}, ${first}!</div>
      <div style="font:400 15px/24px ${FONT};color:${MUTED};padding-top:10px;">${esc(c.intro)}</div>
    </td></tr>
    <tr><td style="padding:12px 32px 4px;">
      <div style="font:700 13px/18px ${FONT};color:${BLUE};text-transform:uppercase;letter-spacing:.8px;padding-bottom:4px;">${esc(c.featuresTitle)}</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${features}</table>
    </td></tr>
    <tr><td style="padding:20px 32px 8px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${SOFT};border-radius:12px;"><tr><td style="padding:20px 22px;">
        <div style="font:700 16px/22px ${FONT};color:${INK};padding-bottom:6px;">${esc(c.stepsTitle)}</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${steps}</table>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${button}</table>
        <div style="font:400 12px/18px ${FONT};color:${MUTED};padding-top:12px;text-align:center;">${esc(c.note)}</div>
      </td></tr></table>
    </td></tr>
    <tr><td style="padding:20px 32px 28px;">
      <div style="font:700 15px/22px ${FONT};color:${INK};">Need a hand?</div>
      <div style="font:400 14px/22px ${FONT};color:${MUTED};padding-top:4px;">Write to <a href="mailto:${esc(support)}" style="color:${BLUE};">${esc(support)}</a> or call <a href="tel:+919844412345" style="color:${BLUE};">+91 98444 12345</a>. We are happy to help.</div>
    </td></tr>
    <tr><td style="background:#0b0c1d;padding:26px 32px 24px;">
      <div style="font:700 13px/18px ${FONT};color:#ffffff;text-transform:uppercase;letter-spacing:.8px;padding-bottom:12px;">Follow us on</div>
      <div style="font:400 13px/20px ${FONT};color:#c9cbe0;">${socials}</div>
      <div style="font:400 12px/19px ${FONT};color:#9a9db8;padding-top:16px;border-top:1px solid #25273d;margin-top:16px;">Realtydoor tech private limited<br>#785/10, 14th Cross, Krishna Rajendra Road, above Adlabs, 7th Block, Jayanagar, Bengaluru, Karnataka 560070</div>
      <div style="font:400 12px/18px ${FONT};color:#7b7e99;padding-top:10px;">You are receiving this because you created a Realtydoor account with this email address.</div>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
  const attachments = inline ? [] : Object.entries(FILES).map(([cid, file]) => ({ filename: file, path: path.join(ASSETS_DIR, file), cid }));
  return { subject: c.subject, html, attachments };
}

// ─── Build-out (onboarding) form emails ────────────────────────────────────────────────────────────────────────────────────────────────
// "ready": sent to the builder or owner when the team creates (or re-issues) their private link. "received": sent after they press Send.
// The link is private: the email says so. Text only claims what the form does today.
function istDate(d) {
  try { return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' }); } catch { return ''; }
}

// What each email says. 'ready' and 'received' are the link and the thank-you; the other four are sent when the team changes the request's status.
// Nothing here promises a date or an outcome: each says what the team is doing and what, if anything, the sender needs to do.
const FORM_EMAILS = {
  ready: {
    subject: 'Your Realtydoor property details form is ready',
    preheader: 'A private form to share your property details and documents with Realtydoor.',
    headline: (first) => `Your details form is ready, ${first}`,
    intro: (what) => `Realtydoor has prepared a secure form for ${what}. Fill in the details you have and upload your documents, so we can prepare your listing correctly.`,
    stepsTitle: 'How it works',
    steps: ['Open the form with the button below. No sign-in is needed.', 'Fill in what you can. Your answers are saved as you go, so you can come back to the same link.', 'Add your documents (for example the RERA certificate, approvals, brochure and photos).', 'Press Send when you are done. Our team is notified straight away.'],
    reason: 'You are receiving this because Realtydoor asked you for your property details.',
  },
  received: {
    subject: 'We received your property details',
    preheader: 'Thank you. Our team will review your details and get back to you.',
    headline: (first) => `Thank you, ${first}!`,
    intro: (what) => `We have received the details you sent for ${what}. Thank you for taking the time.`,
    stepsTitle: 'What happens next',
    steps: ['Our team reviews what you sent.', 'We may contact you if anything needs clarifying.', 'We then prepare your listing and let you know.'],
    note: 'If something is missing or wrong, just reply to this email or contact us below.',
    reason: 'You are receiving this because you sent your property details to Realtydoor.',
  },
  in_discussion: {
    subject: 'We are reviewing your property details',
    preheader: 'Our team has started going through what you sent.',
    headline: (first) => `We are on it, ${first}`,
    intro: (what) => `Our team has started going through the details you sent for ${what}. We may call or write to you with a few questions.`,
    stepsTitle: 'What happens next',
    steps: ['We check your details and documents.', 'We reach out if anything needs clarifying.', 'Once everything is clear, we prepare your listing.'],
    note: 'No action is needed from you right now.',
    reason: 'You are receiving this because you sent your property details to Realtydoor.',
  },
  ready_to_list: {
    subject: 'Your property details are ready to list',
    preheader: 'We have what we need to prepare your listing.',
    headline: (first) => `Good news, ${first}`,
    intro: (what) => `Your details for ${what} are complete, and we are ready to prepare your listing.`,
    stepsTitle: 'What happens next',
    steps: ['We create your listing from the details you sent.', 'Our team checks it before it is approved.', 'Once approved, it goes live on Realtydoor.'],
    note: 'We will keep you posted. If anything has changed, please tell us.',
    reason: 'You are receiving this because you sent your property details to Realtydoor.',
  },
  listing_created: {
    subject: 'Your listing has been created',
    preheader: 'Your property listing is created and goes through our approval check next.',
    headline: (first) => `Your listing is created, ${first}`,
    intro: (what) => `We have created the listing for ${what} from the details you sent. It now goes through our approval check before it appears on the site.`,
    stepsTitle: 'What happens next',
    steps: ['Our team checks the listing.', 'Once approved, it goes live on Realtydoor.', 'If we need to change anything, we will contact you.'],
    note: 'Thank you for trusting Realtydoor with your property.',
    reason: 'You are receiving this because you sent your property details to Realtydoor.',
  },
  closed: {
    subject: 'An update on your property details',
    preheader: 'We have closed this request for now.',
    headline: (first) => `A quick update, ${first}`,
    intro: (what) => `We have closed the request for ${what} for now. If you would like to continue, or share new details, just reply to this email or contact us below and we will gladly help.`,
    stepsTitle: 'If you would like to continue',
    steps: ['Reply to this email, or call us.', 'We will reopen your request and send you a fresh link if needed.'],
    note: 'Nothing is needed from you unless you want to continue.',
    reason: 'You are receiving this because you sent your property details to Realtydoor.',
  },
};

function buildFormEmail(kind, { name, title, formUrl, expiresAt } = {}, { inline = false } = {}) {
  const c = FORM_EMAILS[kind] || FORM_EMAILS.received;
  const src = makeSrc(inline);
  const support = process.env.SUPPORT_EMAIL || 'support@realtydoor.com';
  const first = esc(String(name || '').trim().split(/\s+/)[0] || 'there');
  const what = esc(String(title || '').trim() || 'your property');
  const ready = kind === 'ready';
  const expiry = expiresAt ? istDate(expiresAt) : '';

  const subject = c.subject;
  const preheader = c.preheader;
  const headline = c.headline(first);
  const intro = c.intro(what);
  const stepsTitle = c.stepsTitle;
  const steps = c.steps;
  const note = ready ? `This link is private to you. Please do not share it${expiry ? `. It stays open until ${expiry}` : ''}.` : c.note;
  const reason = c.reason;

  const button = ready && formUrl ? `
      <tr><td align="center" style="padding:22px 0 8px;">
        <a href="${esc(formUrl)}" style="display:inline-block;background:${BLUE};color:#ffffff;text-decoration:none;font:600 16px/20px ${FONT};padding:14px 28px;border-radius:10px;">Open the form</a>
      </td></tr>
      <tr><td align="center" style="font:400 13px/20px ${FONT};color:${MUTED};padding-bottom:6px;word-break:break-all;">or copy this private address:<br><a href="${esc(formUrl)}" style="color:${BLUE};">${esc(formUrl)}</a></td></tr>` : '';

  const html = pageOpen(headline.replace(/&[a-z#0-9]+;/g, ''), preheader) + `
    ${headerRow(src)}
    <tr><td style="padding:32px 32px 8px;">
      <div style="font:700 26px/32px ${FONT};color:${INK};">${headline}</div>
      <div style="font:400 15px/24px ${FONT};color:${MUTED};padding-top:10px;">${intro}</div>
    </td></tr>
    <tr><td style="padding:20px 32px 8px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${SOFT};border-radius:12px;"><tr><td style="padding:20px 22px;">
        <div style="font:700 16px/22px ${FONT};color:${INK};padding-bottom:6px;">${esc(stepsTitle)}</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${stepRows(steps)}</table>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${button}</table>
        <div style="font:400 12px/18px ${FONT};color:${MUTED};padding-top:12px;text-align:center;">${esc(note)}</div>
      </td></tr></table>
    </td></tr>
    ${helpRow(support)}
    ${footerRow(src, reason)}` + pageClose;
  return { subject, html, attachments: attachmentsFor(inline) };
}

module.exports = { buildWelcomeEmail, buildFormEmail };
