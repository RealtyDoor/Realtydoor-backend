'use strict';

// The shared look of every Realtydoor email (Nov 2026): logo header, contact block, social footer, colours and font. Table layout with inline
// styles so it renders the same in Gmail, Outlook, Apple Mail and phone clients. Images are attached by cid (multipart/related, inline), so no
// mail client has to fetch anything. renderEmail() builds a whole branded message from a few parts; the welcome and build-out emails use the
// same pieces. Colours: brand blue #2c2fee.
const fs = require('fs');
const path = require('path');

// The real logo lockup (white mark and REALTYDOOR.COM in Eurostile Extended Bold, on one line; mark from
// admin-nextjs/public/brand/logo-mark.svg), attached to the message so every mail client shows it
// without hosting or blocked remote images. Referenced in the HTML as cid:realtydoor-logo.
const ASSETS_DIR = path.join(__dirname, '../assets/email');
const LOGO_CID = 'realtydoor-logo';
// Round white-on-navy social badges rendered from the site's own icons (admin-nextjs/public/icons/social), also attached by cid.
const SOCIAL = [
  ['Instagram', 'https://www.instagram.com/realtydoorofficial/', 'social-instagram'],
  ['Facebook', 'https://www.facebook.com/realtydoorbengaluru/', 'social-facebook'],
  ['LinkedIn', 'https://www.linkedin.com/company/realtydoor-com/', 'social-linkedin'],
  ['YouTube', 'https://www.youtube.com/@Realtydoor', 'social-youtube'],
  ['Google reviews', 'https://share.google/cpFUUuxeCWwNuwYhW', 'social-google'],
];
const FILES = { [LOGO_CID]: 'logo-lockup-white.png', ...Object.fromEntries(SOCIAL.map(([, , cid]) => [cid, `${cid}.png`])) };

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const BLUE = '#2c2fee';
const INK = '#1a1d29';
const MUTED = '#5b616a';
const SOFT = '#f6f6ff';
const LINE = '#e6e8f0';
// Brand body font is Helvetica Neue; mail clients cannot load web fonts, so it is first in the stack and Arial follows where it is missing.
const FONT = "'Helvetica Neue',Helvetica,Arial,sans-serif";



// The same logo header, contact block and footer for every designed email (welcome, build-out form).
function makeSrc(inline) {
  return (cid) => (inline ? `data:image/png;base64,${fs.readFileSync(path.join(ASSETS_DIR, FILES[cid])).toString('base64')}` : `cid:${cid}`);
}
const attachmentsFor = (inline) => (inline ? [] : Object.entries(FILES).map(([cid, file]) => ({ filename: file, path: path.join(ASSETS_DIR, file), cid })));
const socialsHtml = (src) => `<table role="presentation" cellpadding="0" cellspacing="0"><tr>${SOCIAL.map(([label, href, cid]) =>
  `<td style="padding-right:10px;"><a href="${esc(href)}" title="${esc(label)}" style="text-decoration:none;"><img src="${src(cid)}" width="40" height="40" alt="${esc(label)}" style="display:block;border:0;border-radius:20px;font:400 12px/40px ${FONT};color:#ffffff;"></a></td>`).join('')}</tr></table>`;
const headerRow = (src) => `<tr><td style="background:${BLUE};padding:28px 32px;">
      <img src="${src(LOGO_CID)}" width="330" height="40" alt="Realtydoor" style="display:block;border:0;font:700 20px/24px ${FONT};color:#ffffff;">
    </td></tr>`;
const helpRow = (support) => `<tr><td style="padding:20px 32px 28px;">
      <div style="font:700 15px/22px ${FONT};color:${INK};">Need a hand?</div>
      <div style="font:400 14px/22px ${FONT};color:${MUTED};padding-top:4px;">Write to <a href="mailto:${esc(support)}" style="color:${BLUE};">${esc(support)}</a> or call <a href="tel:+919844412345" style="color:${BLUE};">+91 98444 12345</a>. We are happy to help.</div>
    </td></tr>`;
const footerRow = (src, reason) => `<tr><td style="background:#0b0c1d;padding:26px 32px 24px;">
      <div style="font:700 13px/18px ${FONT};color:#ffffff;text-transform:uppercase;letter-spacing:.8px;padding-bottom:12px;">Follow us on</div>
      <div style="font:400 13px/20px ${FONT};color:#c9cbe0;">${socialsHtml(src)}</div>
      <div style="font:400 12px/19px ${FONT};color:#9a9db8;padding-top:16px;border-top:1px solid #25273d;margin-top:16px;">Realtydoor tech private limited<br>#785/10, 14th Cross, Krishna Rajendra Road, above Adlabs, 7th Block, Jayanagar, Bengaluru, Karnataka 560070</div>
      <div style="font:400 12px/18px ${FONT};color:#7b7e99;padding-top:10px;">${esc(reason)}</div>
    </td></tr>`;
const pageOpen = (title, preheader) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#eef0f7;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#eef0f7;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef0f7;"><tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;">`;
const pageClose = `
  </table>
</td></tr></table>
</body></html>`;
const stepRows = (steps) => steps.map((t, i) => `
        <tr>
          <td width="34" valign="top" style="padding:6px 0;"><div style="width:24px;height:24px;line-height:24px;border-radius:12px;background:${BLUE};color:#ffffff;text-align:center;font:600 13px/24px ${FONT};">${i + 1}</div></td>
          <td valign="top" style="padding:6px 0;font:400 14px/22px ${FONT};color:${INK};">${esc(t)}</td>
        </tr>`).join('');

// One branded message from a few parts. Every value in `details` is escaped here; `introHtml` and `noteHtml` are HTML the CALLER has already
// escaped (they carry <strong> and links), so build them with esc() for anything typed by a person.
//   details: [[label, value], ...]   a soft card of key facts (amount, property, reference)
//   steps:   ['...', '...']          numbered "what happens next" (optional, shown with stepsTitle)
//   button:  { label, url }          the one main action
function detailsCard(details) {
  if (!details || !details.length) return '';
  const rows = details.filter(([, v]) => v !== undefined && v !== null && String(v) !== '').map(([k, v]) => `
        <tr>
          <td valign="top" style="padding:8px 0;border-bottom:1px solid ${LINE};font:400 13px/20px ${FONT};color:${MUTED};width:42%;">${esc(k)}</td>
          <td valign="top" style="padding:8px 0;border-bottom:1px solid ${LINE};font:600 15px/22px ${FONT};color:${INK};text-align:right;">${esc(v)}</td>
        </tr>`).join('');
  if (!rows) return '';
  return `<tr><td style="padding:12px 32px 4px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${SOFT};border-radius:12px;"><tr><td style="padding:6px 22px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
      </td></tr></table>
    </td></tr>`;
}

function buttonRow(button) {
  if (!button || !button.url) return '';
  return `<tr><td align="center" style="padding:22px 32px 6px;">
      <a href="${esc(button.url)}" style="display:inline-block;background:${BLUE};color:#ffffff;text-decoration:none;font:600 16px/20px ${FONT};padding:14px 28px;border-radius:10px;">${esc(button.label)}</a>
    </td></tr>
    <tr><td align="center" style="font:400 12px/18px ${FONT};color:${MUTED};padding:6px 32px 4px;word-break:break-all;">or open: <a href="${esc(button.url)}" style="color:${BLUE};">${esc(button.url)}</a></td></tr>`;
}

function stepsCard(stepsTitle, steps) {
  if (!steps || !steps.length) return '';
  return `<tr><td style="padding:20px 32px 8px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${SOFT};border-radius:12px;"><tr><td style="padding:20px 22px;">
        <div style="font:700 16px/22px ${FONT};color:${INK};padding-bottom:6px;">${esc(stepsTitle || 'What happens next')}</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${stepRows(steps)}</table>
      </td></tr></table>
    </td></tr>`;
}

function renderEmail({ title, preheader = '', headlineHtml, introHtml = '', details, stepsTitle, steps, button, noteHtml = '', reason, inline = false, support }) {
  const src = makeSrc(inline);
  const sup = support || process.env.SUPPORT_EMAIL || 'support@realtydoor.com';
  const html = pageOpen(title, preheader) + `
    ${headerRow(src)}
    <tr><td style="padding:32px 32px 8px;">
      <div style="font:700 26px/32px ${FONT};color:${INK};">${headlineHtml}</div>
      ${introHtml ? `<div style="font:400 15px/24px ${FONT};color:${MUTED};padding-top:10px;">${introHtml}</div>` : ''}
    </td></tr>
    ${detailsCard(details)}
    ${stepsCard(stepsTitle, steps)}
    ${buttonRow(button)}
    ${noteHtml ? `<tr><td style="padding:14px 32px 0;"><div style="font:400 13px/20px ${FONT};color:${MUTED};text-align:center;">${noteHtml}</div></td></tr>` : ''}
    <tr><td style="font-size:0;line-height:0;height:8px;">&nbsp;</td></tr>
    ${helpRow(sup)}
    ${footerRow(src, reason || 'You are receiving this because of your Realtydoor account.')}` + pageClose;
  return { html, attachments: attachmentsFor(inline) };
}

module.exports = {
  ASSETS_DIR, LOGO_CID, SOCIAL, FILES, esc, BLUE, INK, MUTED, SOFT, LINE, FONT,
  makeSrc, attachmentsFor, socialsHtml, headerRow, helpRow, footerRow, pageOpen, pageClose, stepRows, renderEmail,
};
