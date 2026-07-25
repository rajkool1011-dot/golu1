import type { InvoiceRecord, RateSplit } from "./parser";
import { stateFromGstin } from "./states";

/**
 * Zero-credit auto-repair pass. Runs AFTER local + AI parsing and tries to
 * resolve common validation issues the user would otherwise have to fix
 * manually:
 *
 *  1. Fix supplyType if we now have supplier+customer GSTINs.
 *  2. Recompute IGST/CGST/SGST from taxable × rate when the printed tax is
 *     0 or wildly off — honoring supplyType (interstate → IGST only,
 *     intrastate → equal CGST+SGST).
 *  3. If invoice value is missing but rate splits are present, derive
 *     invoiceValue = Σ(taxable + tax).
 *  4. If invoice value is present but rate splits are missing/empty and
 *     we have a plausible taxable subtotal, infer a single-rate row.
 *  5. Re-validate and rewrite the `issues` list from scratch.
 *
 * Purely deterministic — no network calls, no credits.
 */

const VALID_RATES = [0, 3, 5, 12, 18, 28];
const APPROX = (a: number, b: number, tol = 2, pct = 0.02) =>
  Math.abs(a - b) <= Math.max(tol, Math.abs(b) * pct);

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function ensureSupplyType(rec: InvoiceRecord) {
  if (rec.supplyType !== "Unknown") return;
  const supState =
    rec.supplierState || (rec.supplierGstin ? stateFromGstin(rec.supplierGstin) : null);
  const posState =
    rec.placeOfSupply || (rec.customerGstin ? stateFromGstin(rec.customerGstin) : null);
  if (supState && posState) {
    rec.supplyType =
      supState.toLowerCase() === posState.toLowerCase() ? "Intrastate" : "Interstate";
    if (!rec.supplierState) rec.supplierState = supState;
    if (!rec.placeOfSupply) rec.placeOfSupply = posState;
  }
}

function fixTaxAmounts(rec: InvoiceRecord) {
  for (const r of rec.rateSplits) {
    if (r.taxableValue <= 0 || r.rate <= 0) continue;
    const expected = (r.taxableValue * r.rate) / 100;
    const printed = r.igst + r.cgst + r.sgst;
    const wildlyOff = printed === 0 || !APPROX(printed, expected, 2, 0.05);
    if (!wildlyOff) {
      // Still enforce supplyType shape without changing totals.
      if (rec.supplyType === "Interstate" && (r.cgst > 0 || r.sgst > 0)) {
        r.igst = round2(r.cgst + r.sgst + r.igst);
        r.cgst = 0;
        r.sgst = 0;
      } else if (rec.supplyType === "Intrastate" && r.igst > 0) {
        const half = round2((r.igst + r.cgst + r.sgst) / 2);
        r.cgst = half;
        r.sgst = half;
        r.igst = 0;
      }
      continue;
    }
    // Recompute from taxable × rate.
    if (rec.supplyType === "Interstate") {
      r.igst = round2(expected);
      r.cgst = 0;
      r.sgst = 0;
    } else if (rec.supplyType === "Intrastate") {
      const half = round2(expected / 2);
      r.cgst = half;
      r.sgst = half;
      r.igst = 0;
    } else {
      // Unknown supply type — keep as intrastate split (safer default when
      // supplier state is unknown; better than leaving zero tax).
      const half = round2(expected / 2);
      r.cgst = half;
      r.sgst = half;
      r.igst = 0;
    }
  }
}

function inferInvoiceValue(rec: InvoiceRecord) {
  if (rec.invoiceValue && rec.invoiceValue > 0) return;
  if (!rec.rateSplits.length) return;
  let sum = 0;
  for (const r of rec.rateSplits) sum += r.taxableValue + r.igst + r.cgst + r.sgst;
  if (sum > 0) rec.invoiceValue = round2(sum);
}

function inferRateSplitFromValue(rec: InvoiceRecord) {
  if (rec.rateSplits.length > 0) return;
  if (!rec.invoiceValue || rec.invoiceValue <= 0) return;
  // Try each rate: assume single-rate invoice with taxable = value/(1+rate/100)
  // and check whether text contains any hint of the chosen rate.
  const hasHint = (rate: number) =>
    new RegExp(`\\b${rate}\\s*%`, "i").test(rec.rawText) ||
    (rate === 18 && /gst\s*18/i.test(rec.rawText));
  const candidate = [18, 12, 5, 28, 3].find(hasHint);
  if (!candidate) return;
  const taxable = round2(rec.invoiceValue / (1 + candidate / 100));
  const tax = round2(rec.invoiceValue - taxable);
  const split: RateSplit = {
    rate: candidate,
    taxableValue: taxable,
    igst: rec.supplyType === "Interstate" ? tax : 0,
    cgst: rec.supplyType === "Interstate" ? 0 : round2(tax / 2),
    sgst: rec.supplyType === "Interstate" ? 0 : round2(tax / 2),
  };
  rec.rateSplits.push(split);
}

function invoiceNumberFromFileNameAggressive(name: string): string | null {
  const base = name.replace(/\.[^.]+$/, "").toUpperCase().trim();
  // Any alnum sequence 4-30 chars containing both a letter and digit.
  const m = base.match(/([A-Z0-9][A-Z0-9\/\-]{3,29})/);
  if (!m) return null;
  const v = m[1];
  if (!/[A-Z]/.test(v) || !/\d/.test(v)) return null;
  return v;
}

function ensureInvoiceNumber(rec: InvoiceRecord) {
  if (rec.invoiceNumber && rec.invoiceNumber.trim()) return;
  const guess = invoiceNumberFromFileNameAggressive(rec.fileName);
  if (guess) rec.invoiceNumber = guess;
}

function revalidate(rec: InvoiceRecord) {
  const kept: string[] = [];
  // Preserve non-numeric operational issues (duplicates, format warnings) —
  // drop the ones auto-fix targets so we can regenerate them cleanly.
  for (const s of rec.issues) {
    if (/Tax mismatch|Value mismatch|Invoice number is empty|No GST rate\/tax|Missing invoice value|Interstate invoice has CGST|Intrastate invoice has IGST/.test(s))
      continue;
    kept.push(s);
  }
  const issues: string[] = kept;

  if (!rec.invoiceNumber || !rec.invoiceNumber.trim()) issues.push("Invoice number is empty");
  if (!rec.invoiceValue) issues.push("Missing invoice value");
  if (rec.rateSplits.length === 0) issues.push("No GST rate/tax amounts detected");

  let sumTaxable = 0;
  let sumTax = 0;
  for (const r of rec.rateSplits) {
    const total = r.igst + r.cgst + r.sgst;
    sumTaxable += r.taxableValue;
    sumTax += total;
    const expected = (r.taxableValue * r.rate) / 100;
    if (r.taxableValue > 0 && Math.abs(total - expected) > Math.max(2, expected * 0.02)) {
      issues.push(
        `Tax mismatch @${r.rate}%: taxable ${r.taxableValue.toFixed(2)}, tax ${total.toFixed(2)}, expected ~${expected.toFixed(2)}`,
      );
    }
    if (rec.supplyType === "Interstate" && (r.cgst > 0 || r.sgst > 0))
      issues.push(`@${r.rate}%: Interstate invoice has CGST/SGST`);
    if (rec.supplyType === "Intrastate" && r.igst > 0)
      issues.push(`@${r.rate}%: Intrastate invoice has IGST`);
  }
  if (rec.invoiceValue && sumTaxable > 0) {
    const computed = sumTaxable + sumTax;
    const tol = Math.max(2, rec.invoiceValue * 0.01);
    if (Math.abs(computed - rec.invoiceValue) > tol) {
      issues.push(
        `Value mismatch: taxable + GST (${computed.toFixed(2)}) ≠ invoice value (${rec.invoiceValue.toFixed(2)})`,
      );
    }
  }
  rec.issues = issues;
}

export function autoFix(rec: InvoiceRecord): InvoiceRecord {
  // Guard: don't over-fix records that already validate cleanly.
  const initiallyClean = rec.issues.length === 0;
  ensureSupplyType(rec);
  ensureInvoiceNumber(rec);
  if (!initiallyClean) {
    fixTaxAmounts(rec);
    inferRateSplitFromValue(rec);
    inferInvoiceValue(rec);
  }
  // Round all money fields to 2dp to prevent floating-point drift issues.
  for (const r of rec.rateSplits) {
    r.taxableValue = round2(r.taxableValue);
    r.igst = round2(r.igst);
    r.cgst = round2(r.cgst);
    r.sgst = round2(r.sgst);
  }
  if (rec.invoiceValue) rec.invoiceValue = round2(rec.invoiceValue);
  revalidate(rec);
  // Tag records that we actually repaired so the UI badge shows it.
  if (!initiallyClean && rec.issues.length === 0) {
    rec.source = rec.source ? `${rec.source}+Fix` as InvoiceRecord["source"] : "OCR+Fix" as InvoiceRecord["source"];
  }
  return rec;
}
