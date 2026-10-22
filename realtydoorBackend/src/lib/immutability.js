'use strict';

// Append-only guards (money model phase 2). Installed as a Prisma client
// extension in lib/prisma.js, so NO code path in the app can edit or delete an
// audit row or a ledger row, whatever route or script calls it. (Someone with
// direct database access still can; the audit hash chain exists to show it.)

const WRITE_BLOCKED = ['update', 'updateMany', 'delete', 'deleteMany', 'upsert'];

// TdsEntry is append-only except for the fields the accountant fills in after
// the deduction: deposit, challan, return, certificate.
const TDS_EDITABLE = [
  'depositedAt', 'challanNumber', 'bsrCode', 'returnQuarter', 'returnFiledAt', 'form16aIssuedAt',
];

function refuse(model, op) {
  const err = new Error(`${model} is append-only: ${op} is not allowed. Write a new row (or an ADJUSTMENT) instead.`);
  err.code = 'APPEND_ONLY';
  throw err;
}

function guardAll(model) {
  return Object.fromEntries(WRITE_BLOCKED.map((op) => [op, ({ args, query }) => {
    void args; void query; return refuse(model, op);
  }]));
}

function guardTds(op) {
  return ({ args, query }) => {
    if (op === 'delete' || op === 'deleteMany' || op === 'upsert') return refuse('TdsEntry', op);
    const keys = Object.keys(args?.data || {});
    const bad = keys.filter((k) => !TDS_EDITABLE.includes(k));
    if (bad.length) return refuse('TdsEntry', `${op} of ${bad.join(', ')}`);
    return query(args);
  };
}

const extension = {
  name: 'append-only-money',
  query: {
    auditLog: guardAll('AuditLog'),
    moneyLedgerEntry: guardAll('MoneyLedgerEntry'),
    tdsEntry: Object.fromEntries(WRITE_BLOCKED.map((op) => [op, guardTds(op)])),
  },
};

module.exports = { extension, WRITE_BLOCKED, TDS_EDITABLE };
