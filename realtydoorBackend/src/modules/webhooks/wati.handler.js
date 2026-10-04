const prisma = require('../../lib/prisma');
const logger = require('../../lib/logger');
const { recordDeliveryEvent } = require('../wati/wati.service');

// WATI sends both inbound replies and delivery-status callbacks to the same
// webhook, distinguished by eventType. Map its vocabulary onto our log's.
const DELIVERY_EVENTS = {
  sentMessage: 'SENT',
  message_sent: 'SENT',
  delivered: 'DELIVERED',
  messageDelivered: 'DELIVERED',
  read: 'READ',
  messageRead: 'READ',
  failed: 'FAILED',
  messageFailed: 'FAILED',
};

const KEYWORD_MAP = {
  '1': 'VERIFIED_CLOSED',
  'yes': 'VERIFIED_CLOSED',
  'interested': 'VERIFIED_CLOSED',
  '2': 'VERIFIED_DROPPED',
  'no': 'VERIFIED_DROPPED',
  'not interested': 'VERIFIED_DROPPED',
  '3': 'STILL_DECIDING',
  'maybe': 'STILL_DECIDING',
  'still deciding': 'STILL_DECIDING',
};

function parseStatus(text) {
  const normalized = (text || '').trim().toLowerCase();
  return KEYWORD_MAP[normalized] ?? null;
}

async function watiWebhook(req, res) {
  const token = process.env.WATI_WEBHOOK_TOKEN;
  if (token && req.headers['x-wati-token'] !== token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { waId, text, eventType, id, messageId, failureReason } = req.body || {};
    const phoneOf = (wa) => (wa ? (String(wa).startsWith('+') ? String(wa) : `+${wa}`) : null);

    // 12.5 — delivery-status callback: update the message log and stop. These
    // carry no `text`, so they'd previously fall straight through as ignored.
    const deliveryStatus = DELIVERY_EVENTS[eventType];
    if (deliveryStatus) {
      await recordDeliveryEvent({
        messageId: messageId || id || null,
        phone: phoneOf(waId),
        status: deliveryStatus,
        failureReason: failureReason || null,
      });
      return res.json({ status: 'ok', recorded: deliveryStatus });
    }

    if (!waId || !text) return res.json({ status: 'ignored' });

    // Any inbound reply means the last message we sent to this number got a
    // response, whether or not the text maps to a feedback keyword.
    await recordDeliveryEvent({ messageId: null, phone: phoneOf(waId), status: 'RESPONDED' });

    const status = parseStatus(text);
    if (!status) return res.json({ status: 'ignored' });

    const phone = phoneOf(waId);

    const lead = await prisma.lead.findFirst({
      where: {
        buyerPhone: phone,
        whatsappSentAt: { not: null },
        feedbackReceivedAt: null,
      },
      orderBy: { whatsappSentAt: 'desc' },
    });

    if (!lead) return res.json({ status: 'no_matching_lead' });

    await prisma.lead.update({
      where: { id: lead.id },
      data: { buyerFeedbackStatus: status, feedbackReceivedAt: new Date() },
    });

    logger.info('[watiWebhook] buyer feedback recorded', { leadId: lead.id, phone, status });
    return res.json({ status: 'ok' });
  } catch (err) {
    logger.error('[watiWebhook] error', { error: err.message });
    return res.status(500).json({ error: 'Internal error' });
  }
}

module.exports = { watiWebhook };
