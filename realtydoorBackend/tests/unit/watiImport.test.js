// Copying existing WATI conversations into our chat threads: the date WATI writes, each message's shape, and a slice of the import.
jest.mock('axios', () => ({ create: jest.fn() }));
jest.mock('../../src/lib/prisma', () => ({
  lead: { findFirst: jest.fn() },
  whatsAppMessage: { findMany: jest.fn(), createMany: jest.fn() },
}));

const axios = require('axios');
const prisma = require('../../src/lib/prisma');
const imp = require('../../src/modules/wati/watiImport.service');

describe('parseContactDate and statusOf', () => {
  test('reads the way WATI writes a date', () => {
    expect(imp.parseContactDate('Nov-04-2026').toISOString()).toBe('2026-11-04T00:00:00.000Z');
    expect(imp.parseContactDate('Oct-31-2026').toISOString()).toBe('2026-10-31T00:00:00.000Z');
    expect(imp.parseContactDate('nonsense')).toBeNull();
  });
  test('delivery words', () => {
    expect(imp.statusOf({ statusString: 'READ' })).toBe('READ');
    expect(imp.statusOf({ statusString: 'DELIVERED' })).toBe('DELIVERED');
    expect(imp.statusOf({ statusString: 'FAILED' })).toBe('FAILED');
    expect(imp.statusOf({})).toBe('SENT');
  });
});

describe('toRow', () => {
  test('a buyer message, a broadcast we sent, and what is skipped', () => {
    const inbound = imp.toRow({ owner: false, type: 'text', text: 'Interested in Lakeview', whatsappMessageId: 'w1', created: '2026-11-04T10:00:00Z', contactName: 'Asha', messageReferral: { source_id: 'ad1' } }, '+919876500123', 'L1');
    expect(inbound).toMatchObject({ direction: 'IN', kind: 'TEXT', status: 'RECEIVED', watiMessageId: 'w1', leadId: 'L1', senderName: 'Asha', referral: { source_id: 'ad1' } });
    const bc = imp.toRow({ owner: true, eventType: 'broadcastMessage', finalText: 'Hello 😊', id: 'b1', statusString: 'READ', created: '2026-11-04T10:00:00Z' }, '+919876500123');
    expect(bc).toMatchObject({ direction: 'OUT', kind: 'TEMPLATE', text: 'Hello 😊', status: 'READ', watiMessageId: 'b1' });
    expect(imp.toRow({ eventType: 'ticket', text: 'Assigned to X' }, '+91')).toBeNull();
    expect(imp.toRow({ owner: false, text: '' }, '+91')).toBeNull();
  });
});

describe('importSlice', () => {
  const http = { get: jest.fn() };
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.WATI_API_ENDPOINT = 'https://wati.example/1'; process.env.WATI_ACCESS_TOKEN = 't';
    axios.create.mockReturnValue(http);
    prisma.lead.findFirst.mockResolvedValue({ id: 'L1' });
    prisma.whatsAppMessage.findMany.mockResolvedValue([{ watiMessageId: 'w-old' }]);
    prisma.whatsAppMessage.createMany.mockResolvedValue({ count: 1 });
  });
  const contacts = [{ wAid: '919876500123', created: 'Nov-04-2026' }, { wAid: '919876500999', created: 'Aug-01-2026' }];
  const messages = { messages: { items: [{ owner: false, type: 'text', text: 'Hi', whatsappMessageId: 'w-new', created: '2026-11-04T10:00:00Z' }, { owner: true, type: 'text', text: 'Old', whatsappMessageId: 'w-old', created: '2026-11-04T09:00:00Z' }, { eventType: 'ticket' }], hasNextPage: false } };
  http.get.mockImplementation(async (url) => (url.includes('getContacts') ? { data: { contact_list: contacts, link: { total: 2 } } } : { data: messages }));

  test('copies what is new, skips what is already here, and stops at contacts older than the date', async () => {
    const out = await imp.importSlice({ since: '2026-10-01', pages: 2 });
    expect(out).toMatchObject({ contacts: 1, withReplies: 1, messages: 1, inbound: 1, done: true });
    expect(prisma.whatsAppMessage.createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({ watiMessageId: 'w-new', phone: '+919876500123', leadId: 'L1', direction: 'IN' })] });
  });
  test('a dry run counts and writes nothing', async () => {
    const out = await imp.importSlice({ since: '2026-10-01', dryRun: true });
    expect(out.messages).toBe(2);
    expect(prisma.whatsAppMessage.createMany).not.toHaveBeenCalled();
  });
  test('refuses when WATI is not connected', async () => {
    delete process.env.WATI_ACCESS_TOKEN;
    await expect(imp.importSlice({})).rejects.toMatchObject({ statusCode: 400 });
  });
});
