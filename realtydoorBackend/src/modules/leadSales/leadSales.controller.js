const { success, created } = require('../../utils/ApiResponse');
const service = require('./leadSales.service');
const { updateSalesSchema, addNoteSchema } = require('./leadSales.validator');

const wrap = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (err) { next(err); } };

const salesSummary = wrap(async (req, res) => success(res, await service.salesSummary(req.user)));
const owners = wrap(async (req, res) => success(res, await service.owners(req.user)));
const listNotes = wrap(async (req, res) => success(res, await service.listNotes(req.user, req.params.id)));
const addNote = wrap(async (req, res) => created(res, await service.addNote(req.user, req.params.id, addNoteSchema.parse(req.body), req.ip), 'Note added'));
const updateSales = wrap(async (req, res) => success(res, await service.updateSales(req.user, req.params.id, updateSalesSchema.parse(req.body), req.ip), 'Saved'));

// The whole file is built in memory (capped at 5,000 leads) and sent as a download, never cached.
const exportLeads = wrap(async (req, res) => {
  const { buffer, rows } = await service.exportLeads(req.user, req.query, req.ip);
  const stamp = new Date().toISOString().slice(0, 10);
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="realtydoor-leads-${stamp}.xlsx"`,
    'Cache-Control': 'private, no-store',
    'X-Row-Count': String(rows),
  });
  res.send(Buffer.from(buffer));
});

module.exports = { salesSummary, owners, listNotes, addNote, updateSales, exportLeads };
