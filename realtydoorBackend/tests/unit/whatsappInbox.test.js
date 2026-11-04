// WhatsApp conversations: reading a WATI webhook message, the thread, and inbound enquiries becoming leads.
jest.mock('../../src/lib/prisma', () => ({
  whatsAppMessage: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), groupBy: jest.fn(), findMany: jest.fn(), findUnique: jest.fn() },
  lead: { findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn() },
  leadNote: { create: jest.fn().mockResolvedValue({}) },
  user: { findFirst: jest.fn() },
  leadIntegration: { findFirst: jest.fn(), create: jest.fn() },
  watiMessageLog: { findFirst: jest.fn(), findUnique: jest.fn() },
}));
jest.mock('../../src/modules/leadIntake/leadIntake.service', () => ({ ingest: jest.fn() }));

const prisma = require('../../src/lib/prisma');
const intake = require('../../src/modules/leadIntake/leadIntake.service');
const inbox = require('../../src/modules/wati/whatsappInbox.service');

const msg = (over = {}) => ({ waId: '919876500123', text: 'Hi, I am interested in Lakeview', senderName: 'Asha', id: 'wm-1', type: 'text', owner: false, timestamp: '1793000000', ...over });

beforeEach(() => {
  jest.clearAllMocks();
  prisma.whatsAppMessage.findFirst.mockResolvedValue(null);
  prisma.whatsAppMessage.create.mockImplementation(async ({ data }) => ({ id: 'row1', ...data }));
  prisma.whatsAppMessage.update.mockResolvedValue({});
  prisma.lead.findFirst.mockResolvedValue(null);
  prisma.user.findFirst.mockResolvedValue(null);
  prisma.leadIntegration.findFirst.mockResolvedValue({ id: 'i1', kind: 'WHATSAPP', mappings: [] });
  intake.ingest.mockResolvedValue({ status: 'CREATED', leadId: 'L1' });
});

describe('readMessage', () => {
  test('reads a text message, with the phone in E.164', () => {
    const m = inbox.readMessage(msg());
    expect(m).toMatchObject({ phone: '+919876500123', text: 'Hi, I am interested in Lakeview', kind: 'TEXT', senderName: 'Asha', watiMessageId: 'wm-1', fromUs: false });
    expect(m.at.getTime()).toBe(1793000000 * 1000);
  });
  test('a photo with no caption gets a placeholder; a click-to-WhatsApp ad is kept', () => {
    const m = inbox.readMessage({ waId: '919876500123', type: 'image', data: 'https://files.example/p.jpg', sourceId: 'ad-9', sourceUrl: 'https://fb.me/x' });
    expect(m).toMatchObject({ kind: 'IMAGE', text: '[Photo]', mediaUrl: 'https://files.example/p.jpg' });
    expect(m.referral).toMatchObject({ sourceId: 'ad-9' });
  });
  test('owner: true means our side sent it', () => {
    expect(inbox.readMessage(msg({ owner: true })).fromUs).toBe(true);
  });
});

describe('recordMessage', () => {
  test('a message from a number we do not know becomes a lead and the thread points at it', async () => {
    const out = await inbox.recordMessage(msg());
    expect(out).toMatchObject({ status: 'recorded', leadId: 'L1' });
    expect(intake.ingest).toHaveBeenCalledWith(expect.objectContaining({ id: 'i1' }), expect.objectContaining({ phone: '+919876500123', name: 'Asha', source: 'whatsapp', message: 'Hi, I am interested in Lakeview', externalId: 'wm-1' }));
    expect(prisma.whatsAppMessage.update).toHaveBeenCalledWith({ where: { id: 'row1' }, data: { leadId: 'L1' } });
  });
  test('the first message from a click-to-WhatsApp ad carries the ad as the campaign', async () => {
    await inbox.recordMessage(msg({ sourceId: 'ad-77', sourceHeadline: 'Lakeview launch' }));
    expect(intake.ingest.mock.calls[0][1]).toMatchObject({ campaign: 'Lakeview launch' });
  });
  test('a buyer who already has an open lead gets a note, not a second lead', async () => {
    prisma.lead.findFirst.mockResolvedValue({ id: 'L9', status: 'ASSIGNED', refCode: 'RD-L-9' });
    const out = await inbox.recordMessage(msg());
    expect(out.leadId).toBe('L9');
    expect(intake.ingest).not.toHaveBeenCalled();
    expect(prisma.leadNote.create.mock.calls[0][0].data).toMatchObject({ leadId: 'L9', kind: 'WHATSAPP' });
    expect(prisma.whatsAppMessage.create.mock.calls[0][0].data.leadId).toBe('L9');
  });
  test('a partner or staff member writing to us is kept in the thread but is not a lead', async () => {
    prisma.user.findFirst.mockResolvedValue({ role: 'PARTNER' });
    const out = await inbox.recordMessage(msg());
    expect(out.status).toBe('recorded');
    expect(intake.ingest).not.toHaveBeenCalled();
  });
  test('the same WATI message twice is stored once', async () => {
    prisma.whatsAppMessage.findFirst.mockResolvedValue({ id: 'x' });
    expect(await inbox.recordMessage(msg())).toEqual({ status: 'seen' });
    expect(prisma.whatsAppMessage.create).not.toHaveBeenCalled();
  });
  test('a reply staff send from the WATI inbox is recorded as ours and never makes a lead', async () => {
    const out = await inbox.recordMessage(msg({ owner: true, text: 'We will call you at 5' }));
    expect(prisma.whatsAppMessage.create.mock.calls[0][0].data).toMatchObject({ direction: 'OUT', status: 'SENT' });
    expect(intake.ingest).not.toHaveBeenCalled();
    expect(out.status).toBe('recorded');
  });
  test('the echo of a template we sent from the app is ignored (it is already recorded with its details)', async () => {
    expect(await inbox.recordMessage(msg({ owner: true, eventType: 'templateMessageSent' }))).toEqual({ status: 'ignored' });
    expect(prisma.whatsAppMessage.create).not.toHaveBeenCalled();
  });
  test('a message with no phone or nothing in it is ignored', async () => {
    expect(await inbox.recordMessage({ text: 'hi' })).toEqual({ status: 'ignored' });
    expect(await inbox.recordMessage({ waId: '919876500123' })).toEqual({ status: 'ignored' });
  });
});

describe('threads and details', () => {
  test('a thread reads oldest first and carries the lead', async () => {
    prisma.whatsAppMessage.findMany.mockResolvedValue([{ id: 'b', at: 2 }, { id: 'a', at: 1 }]);
    prisma.lead.findFirst.mockResolvedValue({ id: 'L1', refCode: 'RD-L-1' });
    const t = await inbox.getThread('919876500123');
    expect(t.messages.map((m) => m.id)).toEqual(['a', 'b']);
    expect(t.lead.refCode).toBe('RD-L-1');
    expect(prisma.whatsAppMessage.findMany.mock.calls[0][0].where).toEqual({ phone: '+919876500123' });
  });
  test('a message detail joins the delivery events from the log', async () => {
    prisma.whatsAppMessage.findUnique.mockResolvedValue({ id: 'm1', watiMessageId: 'w1', leadId: 'L1' });
    prisma.watiMessageLog.findFirst.mockResolvedValue({ status: 'READ', templateName: 't', parameters: { name: 'Asha' }, renderedText: 'Hi Asha', eventHistory: [{ status: 'SENT' }, { status: 'READ' }] });
    prisma.lead.findUnique.mockResolvedValue({ id: 'L1', refCode: 'RD-L-1' });
    const d = await inbox.getMessageDetail('m1');
    expect(d.log).toMatchObject({ renderedText: 'Hi Asha', eventHistory: [{ status: 'SENT' }, { status: 'READ' }] });
    expect(d.lead.refCode).toBe('RD-L-1');
    prisma.whatsAppMessage.findUnique.mockResolvedValue(null);
    expect(await inbox.getMessageDetail('none')).toBeNull();
  });
});

describe('log detail', () => {
  test('joins the chat message and the lead to a delivery-log row', async () => {
    prisma.watiMessageLog.findUnique.mockResolvedValue({ id: 'g1', messageId: 'w1', leadId: null, recipientPhone: '+919876500123', eventHistory: [{ status: 'SENT' }] });
    prisma.whatsAppMessage.findFirst.mockResolvedValue({ id: 'm1', leadId: 'L1' });
    prisma.lead.findUnique.mockResolvedValue({ id: 'L1', refCode: 'RD-L-1' });
    const d = await inbox.getLogDetail('g1');
    expect(d).toMatchObject({ id: 'g1', recipientPhone: '+919876500123', threadMessageId: 'm1', lead: { refCode: 'RD-L-1' } });
    prisma.watiMessageLog.findUnique.mockResolvedValue(null);
    expect(await inbox.getLogDetail('x')).toBeNull();
  });
});
