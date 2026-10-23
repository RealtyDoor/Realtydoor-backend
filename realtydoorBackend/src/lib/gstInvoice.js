'use strict';

// Tax invoice arithmetic for the buyer's processing fee (T62). All amounts are paise.
//
// The fee the buyer pays already includes 18% GST, so the invoice works backwards: taxable value = fee / 1.18, rounded to the
// paisa, and the tax is whatever is left, so taxable + tax always equals what the buyer paid. With no buyer address on record
// the place of supply is the supplier's location, so the tax is split into equal CGST and SGST (the odd paisa goes to SGST).
function splitGstInclusive(inclusivePaise, gstPct = 18) {
  // Anything that is not a finite number (text, NaN, Infinity, nothing) is treated as zero rather than carried through as NaN.
  const n = Number(inclusivePaise);
  const total = Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
  const taxable = Math.round((total * 100) / (100 + gstPct));
  const tax = total - taxable;
  const cgst = Math.floor(tax / 2);
  return { taxablePaise: taxable, cgstPaise: cgst, sgstPaise: tax - cgst, totalPaise: total };
}

// Indian financial year runs 1 April to 31 March: 12 Oct 2026 is "26-27", 5 Feb 2027 is also "26-27".
// Read in India time (UTC+5:30, no DST), not the server's own zone: a UTC server would otherwise number an
// invoice raised at 1 April 2026 00:30 IST as FY "25-26" and put it in the wrong series.
function financialYear(date = new Date()) {
  const ist = new Date(new Date(date).getTime() + 5.5 * 3600 * 1000);
  const startYear = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
  return `${String(startYear).slice(-2)}-${String(startYear + 1).slice(-2)}`;
}

// "RD/26-27/00001": consecutive within a financial year, unique, and within the 16 characters the GST rules allow.
function formatInvoiceNo(fy, seq, prefix = 'RD') {
  return `${prefix}/${fy}/${String(seq).padStart(5, '0')}`;
}

module.exports = { splitGstInclusive, financialYear, formatInvoiceNo };
