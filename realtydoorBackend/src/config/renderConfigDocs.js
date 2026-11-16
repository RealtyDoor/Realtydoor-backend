'use strict';

// Writes the documents that come from the one list of settings (src/config/productionSpec.js). Pure functions: scripts/genConfigDocs.js
// writes the files, and a test compares them with what is on disk so they cannot drift.

const { SPEC, GROUPS, productionRule } = require('./productionSpec');

const oneLine = (t) => String(t).replace(/\s+/g, ' ').trim();

function wrap(text, width = 118) {
  const words = oneLine(text).split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width) { lines.push(line); line = w; } else line = (line + ' ' + w).trim();
  }
  if (line) lines.push(line);
  return lines;
}

function renderEnvExample() {
  const out = [
    '# Realtydoor API settings. GENERATED from src/config/productionSpec.js by scripts/genConfigDocs.js: do not edit by hand.',
    '# To add or change a setting, edit the spec and run `node scripts/genConfigDocs.js`.',
    '# Copy this file to .env for local work. Never commit .env or put a real secret in this file.',
    '',
  ];
  for (const [id, title] of GROUPS) {
    const rows = SPEC.filter((s) => s.scope === 'backend' && s.group === id);
    if (!rows.length) continue;
    out.push(`# ── ${title} ${'─'.repeat(Math.max(2, 70 - title.length))}`);
    for (const s of rows) {
      for (const l of wrap(s.desc)) out.push(`# ${l}`);
      out.push(`# Production: ${productionRule(s)}.${s.default !== undefined ? ` Default: ${s.default}.` : ''}`);
      out.push(`${s.key}=${s.secret ? '' : s.example}`);
      out.push('');
    }
  }
  return out.join('\n');
}

const cell = (t) => oneLine(t).replace(/\|/g, '\\|');

function renderRunbookTable() {
  const out = [
    '<!-- spec:begin (generated from src/config/productionSpec.js by scripts/genConfigDocs.js: do not edit by hand) -->',
    '',
    '| Setting | Where | In production | Default | What it is |',
    '|---|---|---|---|---|',
  ];
  for (const [id, title] of GROUPS) {
    const rows = SPEC.filter((s) => s.group === id);
    if (!rows.length) continue;
    out.push(`| **${title}** | | | | |`);
    for (const s of rows) {
      const where = s.scope === 'web' ? (s.web === 'build' ? 'web, build' : 'web, runtime') : 'API';
      out.push(`| \`${s.key}\`${s.secret ? ' (secret)' : ''} | ${where} | ${cell(productionRule(s))} | ${s.default !== undefined ? `\`${cell(s.default)}\`` : ''} | ${cell(s.desc)} |`);
    }
  }
  out.push('', '<!-- spec:end -->');
  return out.join('\n');
}

const BEGIN = '<!-- spec:begin';
const END = '<!-- spec:end -->';

function replaceBlock(markdown, block) {
  const a = markdown.indexOf(BEGIN);
  const b = markdown.indexOf(END);
  if (a < 0 || b < 0 || b < a) return null;
  return markdown.slice(0, a) + block + markdown.slice(b + END.length);
}

module.exports = { renderEnvExample, renderRunbookTable, replaceBlock };
