const { success, created } = require('../../utils/ApiResponse');
const service = require('./dataAck.service');
const { recordAckSchema } = require('./dataAck.validator');

async function record(req, res, next) {
  try {
    const { type, version, leadId } = recordAckSchema.parse(req.body);
    const ack = await service.record(req.user.id, { type, version, leadId }, req.ip);
    created(res, ack, 'Acknowledgment recorded');
  } catch (err) { next(err); }
}

async function getStatus(req, res, next) {
  try {
    const type = req.query.type === 'POST_OTP_RESTRICTED_USE' ? 'POST_OTP_RESTRICTED_USE' : 'LEAD_DATA_HANDLING';
    const leadId = req.query.leadId || null;
    success(res, await service.getStatus(req.user.id, type, leadId));
  } catch (err) { next(err); }
}

module.exports = { record, getStatus };
