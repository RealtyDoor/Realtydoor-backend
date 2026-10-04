const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const logger = require('../../lib/logger');
const { send } = require('../../lib/email');
const { sendTemplateMessage } = require('../../lib/wati');
const { createAuditLog } = require('../../lib/auditLog');

// ─── 11.1 — reply thread ──────────────────────────────────────────────────────
//
// A reply goes out over whichever channels the sender actually gave us. Both
// legs are attempted independently and recorded by result: a WhatsApp failure
// must not lose an email that did send, and the thread must not claim a
// channel that never delivered.
//
// WhatsApp uses a template because that's the only thing WATI will send to a
// user outside a 24h session window. The template has to exist and be
// Meta-approved; if it isn't, that leg fails and the email still goes.
const WHATSAPP_REPLY_TEMPLATE = 'contact_reply';

async function replyToMessage(messageId, { body, subject, alsoWhatsapp }, adminId, ip) {
  const msg = await prisma.contactMessage.findUnique({ where: { id: messageId } });
  if (!msg) throw new ApiError(404, 'Message not found');
  if (!msg.email && !msg.phone) {
    throw new ApiError(400, 'This message has no email or phone to reply to', { code: 'NO_REPLY_CHANNEL' });
  }

  const channels = [];
  const failures = [];

  if (msg.email) {
    try {
      await send({
        to: msg.email,
        subject: subject || `Re: ${msg.subject}`,
        html: `<p>${body.replace(/\n/g, '<br>')}</p>`,
      });
      channels.push('EMAIL');
    } catch (err) {
      failures.push(`email: ${err.message}`);
      logger.error('[contactReply] email failed', { messageId, error: err.message });
    }
  }

  if (alsoWhatsapp && msg.phone) {
    try {
      await sendTemplateMessage(msg.phone, WHATSAPP_REPLY_TEMPLATE, [
        { name: '1', value: msg.name },
        { name: '2', value: body.slice(0, 600) },
      ]);
      channels.push('WHATSAPP');
    } catch (err) {
      failures.push(`whatsapp: ${err.message}`);
      logger.error('[contactReply] whatsapp failed', { messageId, error: err.message });
    }
  }

  // Every requested channel failed — surface it rather than recording a
  // reply that never reached anyone.
  if (!channels.length) {
    throw new ApiError(502, `Could not send the reply. ${failures.join('; ')}`, { code: 'REPLY_SEND_FAILED' });
  }

  const reply = await prisma.contactReply.create({
    data: {
      contactMessageId: messageId,
      body,
      channels,
      deliveryNote: failures.length ? failures.join('; ') : null,
      sentByAdminId: adminId,
    },
  });

  // Replying implies it's been seen and dealt with — but never downgrade a
  // row someone already marked RESOLVED.
  await prisma.contactMessage.update({
    where: { id: messageId },
    data: { isRead: true, ...(msg.status === 'RESOLVED' ? {} : { status: 'REPLIED' }) },
  });

  await createAuditLog({
    adminId, action: 'CONTACT_REPLIED', targetType: 'ContactMessage', targetId: messageId,
    after: { channels, partialFailure: failures.length ? failures.join('; ') : null }, ipAddress: ip,
  });

  return { reply, channels, failures };
}

async function getMessageThread(messageId) {
  const msg = await prisma.contactMessage.findUnique({
    where: { id: messageId },
    include: { replies: { orderBy: { createdAt: 'asc' } } },
  });
  if (!msg) throw new ApiError(404, 'Message not found');
  return msg;
}

// ─── 11.2 — states ────────────────────────────────────────────────────────────

async function setStatus(messageId, status, adminId, ip) {
  const msg = await prisma.contactMessage.findUnique({ where: { id: messageId } });
  if (!msg) throw new ApiError(404, 'Message not found');

  const updated = await prisma.contactMessage.update({
    where: { id: messageId },
    data: {
      status,
      resolvedAt: status === 'RESOLVED' ? new Date() : null,
      // Marking spam or resolved also clears it from the unread badge; there
      // is nothing left to read.
      ...(status === 'NEW' ? {} : { isRead: true }),
    },
  });

  await createAuditLog({
    adminId, action: 'CONTACT_STATUS_SET', targetType: 'ContactMessage', targetId: messageId,
    before: { status: msg.status }, after: { status }, ipAddress: ip,
  });

  return updated;
}

// ─── 11.3 — reply templates ───────────────────────────────────────────────────

async function listTemplates() {
  return prisma.contactReplyTemplate.findMany({ orderBy: { name: 'asc' } });
}

async function createTemplate(data) {
  const existing = await prisma.contactReplyTemplate.findUnique({ where: { name: data.name } });
  if (existing) throw new ApiError(409, 'A template with this name already exists');
  return prisma.contactReplyTemplate.create({ data });
}

async function updateTemplate(id, data) {
  const tpl = await prisma.contactReplyTemplate.findUnique({ where: { id } });
  if (!tpl) throw new ApiError(404, 'Template not found');
  return prisma.contactReplyTemplate.update({ where: { id }, data });
}

async function deleteTemplate(id) {
  const tpl = await prisma.contactReplyTemplate.findUnique({ where: { id } });
  if (!tpl) throw new ApiError(404, 'Template not found');
  await prisma.contactReplyTemplate.delete({ where: { id } });
  return { deleted: true, name: tpl.name };
}

// ─── 11.4 — compose a new outbound message ────────────────────────────────────
//
// Recorded as a ContactMessage with source OUTBOUND so it appears in the same
// inbox thread view as inbound mail, rather than living in a separate place
// the admin has to remember to check.
async function compose({ name, email, phone, subject, body, alsoWhatsapp }, adminId, ip) {
  if (!email && !phone) {
    throw new ApiError(400, 'An email or phone is required to send a message', { code: 'NO_REPLY_CHANNEL' });
  }

  const msg = await prisma.contactMessage.create({
    data: {
      name, email: email ?? null, phone: phone ?? null,
      subject,
      // The outbound body is the first thing in the thread; the reply row
      // below carries the same text as the actual sent artefact.
      message: body,
      source: 'OUTBOUND',
      status: 'NEW',
      isRead: true,
    },
  });

  try {
    const result = await replyToMessage(msg.id, { body, subject, alsoWhatsapp }, adminId, ip);
    return { message: msg, ...result };
  } catch (err) {
    // Nothing was delivered, so don't leave a phantom outbound row behind.
    await prisma.contactMessage.delete({ where: { id: msg.id } }).catch(() => {});
    throw err;
  }
}

module.exports = {
  replyToMessage, getMessageThread, setStatus,
  listTemplates, createTemplate, updateTemplate, deleteTemplate,
  compose,
};
