import { GSTIN_REGEX, stateFromGstin, STATE_CODES } from "./states";

// Configure pdfjs worker (Vite ?url import)
import * as pdfjsLib from "pdfjs-dist";
// @ts-expect-error - vite worker url import
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
(pdfjsLib as any).GlobalWorkerOptions.workerSrc = workerSrc;

export interface RateSplit {
  rate: number;
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
}

export interface InvoiceRecord {
  fileName: string;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  customerGstin: string | null;
  customerName: string | null;
  placeOfSupply: string | null;
  invoiceValue: number | null;
  supplierGstin: string | null;
  supplierState: string | null;
  rateSplits: RateSplit[];
  category: "B2B" | "B2C";
  supplyType: "Interstate" | "Intrastate" | "Unknown";
  issues: string[];
  rawText: string;
}

async function readPdfText(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const pdf = await (pdfjsLib as any).getDocument({ data: buf }).promise;
  const out: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    // Preserve some layout by grouping items on the same line via y-coordinate
    const items = content.items as Array<{ str: string; transform: number[] }>;
    const lines = new Map<number, string[]>();
    for (const it of items) {
      const y = Math.round(it.transform[5]);
      if (!lines.has(y)) lines.set(y, []);
      lines.get(y)!.push(it.str);
    }
    const sorted = [...lines.entries()].sort((a, b) => b[0] - a[0]);
    out.push(sorted.map(([, arr]) => arr.join(" ")).join("\n"));
  }
  return out.join("\n");
}

function num(s: string): number {
  return parseFloat(s.replace(/,/g, "").replace(/[^\d.\-]/g, "")) || 0;
}

function findGstins(text: string): string[] {
  const re = /\b(\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d][Zz][A-Z\d])\b/g;
  const out = new Set<string>();
  let m;
  while ((m = re.exec(text))) out.add(m[1].toUpperCase());
  return [...out];
}

function extractInvoiceNumber(text: string): string | null {
  const patterns = [
    /Invoice\s*(?:No|Number|#)\.?\s*[:\-]?\s*([A-Z0-9\/\-]+)/i,
    /Bill\s*(?:No|Number)\.?\s*[:\-]?\s*([A-Z0-9\/\-]+)/i,
    /Inv\s*(?:No|#)\.?\s*[:\-]?\s*([A-Z0-9\/\-]+)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1].trim();
  }
  return null;
}

function extractInvoiceDate(text: string): string | null {
  const patterns = [
    /(?:Invoice|Bill|Dated?)\s*Date\s*[:\-]?\s*([0-3]?\d[\/\-\.][01]?\d[\/\-\.](?:20)?\d{2})/i,
    /Date\s*[:\-]?\s*([0-3]?\d[\/\-\.][01]?\d[\/\-\.](?:20)?\d{2})/i,
    /Dated?\s*[:\-]?\s*([0-3]?\d\s+[A-Za-z]{3,9}\s+\d{2,4})/i,
    /([0-3]?\d[\/\-\.][01]?\d[\/\-\.]20\d{2})/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1].trim();
  }
  return null;
}

function extractPlaceOfSupply(text: string): string | null {
  const m = text.match(/Place\s*of\s*Supply\s*[:\-]?\s*([A-Za-z0-9\-\s&()]+?)(?:\n|State|GSTIN|\(|$)/i);
  if (m) {
    const raw = m[1].trim().replace(/\s+/g, " ");
    // Sometimes formatted as "27-Maharashtra" or "Maharashtra (27)"
    const codeMatch = raw.match(/^(\d{2})[\s\-]/);
    if (codeMatch) return STATE_CODES[codeMatch[1]] ?? raw;
    return raw;
  }
  return null;
}

function extractCustomerName(text: string): string | null {
  const patterns = [
    /(?:Bill(?:ed)?\s*To|Buyer|Customer|Consignee)\s*[:\-]?\s*\n?\s*([A-Z][A-Za-z0-9 &.,'\-]{2,80})/,
    /(?:Bill(?:ed)?\s*To|Buyer|Customer|Consignee)\s*[:\-]\s*([A-Za-z0-9 &.,'\-]{2,80})/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1].trim();
  }
  return null;
}

function extractInvoiceValue(text: string): number | null {
  const patterns = [
    /(?:Grand\s*Total|Invoice\s*Total|Total\s*Invoice\s*Value|Total\s*Amount|Bill\s*Total|Net\s*Payable)\s*[:\-]?\s*₹?\s*(-?[\d,]+\.?\d*)/i,
    /Total\s*[:\-]?\s*₹?\s*(-?[\d,]+\.\d{2})\s*$/im,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return num(m[1]);
  }
  return null;
}

/**
 * Detect rate splits. Looks for GST rate percentages (5,12,18,28) associated
 * with taxable / tax amounts. Supports both split rows (CGST+SGST) and IGST rows.
 */
function extractRateSplits(text: string): RateSplit[] {
  const rates = [0, 3, 5, 12, 18, 28];
  const bucket = new Map<number, RateSplit>();

  // Heuristic 1: explicit IGST / CGST / SGST lines with %.
  //   "IGST 18% 1000.00 180.00"  or  "CGST 9% 90.00" + "SGST 9% 90.00"
  const igstRe = /IGST[^\n]*?(\d{1,2}(?:\.\d+)?)\s*%[^\n]*?([\d,]+\.\d{2})(?:[^\n]*?([\d,]+\.\d{2}))?/gi;
  const cgstRe = /CGST[^\n]*?(\d{1,2}(?:\.\d+)?)\s*%[^\n]*?([\d,]+\.\d{2})(?:[^\n]*?([\d,]+\.\d{2}))?/gi;
  const sgstRe = /SGST[^\n]*?(\d{1,2}(?:\.\d+)?)\s*%[^\n]*?([\d,]+\.\d{2})(?:[^\n]*?([\d,]+\.\d{2}))?/gi;

  const ensure = (rate: number) => {
    if (!bucket.has(rate))
      bucket.set(rate, { rate, taxableValue: 0, igst: 0, cgst: 0, sgst: 0 });
    return bucket.get(rate)!;
  };

  let m;
  while ((m = igstRe.exec(text))) {
    const rate = parseFloat(m[1]);
    const first = num(m[2]);
    const second = m[3] ? num(m[3]) : null;
    // If two numbers on line, first=taxable, second=igst; else it's the tax amt
    const b = ensure(rate);
    if (second !== null) {
      b.taxableValue += first;
      b.igst += second;
    } else {
      b.igst += first;
    }
  }
  while ((m = cgstRe.exec(text))) {
    const halfRate = parseFloat(m[1]);
    const rate = halfRate * 2;
    const first = num(m[2]);
    const second = m[3] ? num(m[3]) : null;
    const b = ensure(rate);
    if (second !== null) {
      b.taxableValue += first;
      b.cgst += second;
    } else {
      b.cgst += first;
    }
  }
  while ((m = sgstRe.exec(text))) {
    const halfRate = parseFloat(m[1]);
    const rate = halfRate * 2;
    const first = num(m[2]);
    const second = m[3] ? num(m[3]) : null;
    const b = ensure(rate);
    if (second !== null) {
      // Prefer whichever gives non-zero taxable; keep max
      if (b.taxableValue < first) b.taxableValue = first;
      b.sgst += second;
    } else {
      b.sgst += first;
    }
  }

  // Heuristic 2: tax-summary table with columns "Rate | Taxable | IGST | CGST | SGST"
  //   e.g. "18%  10000.00  0.00  900.00  900.00"
  const rowRe = /(\d{1,2}(?:\.\d+)?)\s*%\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})(?:\s+([\d,]+\.\d{2}))?/g;
  while ((m = rowRe.exec(text))) {
    const rate = parseFloat(m[1]);
    if (!rates.includes(Math.round(rate))) continue;
    const taxable = num(m[2]);
    const a = num(m[3]);
    const b = num(m[4]);
    const c = m[5] ? num(m[5]) : null;
    const rec = ensure(rate);
    rec.taxableValue = Math.max(rec.taxableValue, taxable);
    // If 4 amounts (taxable, IGST, CGST, SGST) present
    if (c !== null) {
      rec.igst += a;
      rec.cgst += b;
      rec.sgst += c;
    } else {
      // (taxable, CGST, SGST) — intrastate
      rec.cgst += a;
      rec.sgst += b;
    }
  }

  return [...bucket.values()].filter(
    (r) => r.taxableValue > 0 || r.igst > 0 || r.cgst > 0 || r.sgst > 0,
  );
}

export async function parseInvoicePdf(file: File): Promise<InvoiceRecord> {
  const text = await readPdfText(file);
  const gstins = findGstins(text);
  // Assume the first GSTIN found is the supplier (usually at top), the second is customer.
  const supplierGstin = gstins[0] ?? null;
  const customerGstin = gstins[1] ?? null;

  const supplierState = supplierGstin ? stateFromGstin(supplierGstin) : null;
  let placeOfSupply = extractPlaceOfSupply(text);
  if (!placeOfSupply && customerGstin) placeOfSupply = stateFromGstin(customerGstin);

  const rateSplits = extractRateSplits(text);

  const category: "B2B" | "B2C" = customerGstin ? "B2B" : "B2C";
  const supplyType: InvoiceRecord["supplyType"] =
    supplierState && placeOfSupply
      ? supplierState.toLowerCase() === placeOfSupply.toLowerCase()
        ? "Intrastate"
        : "Interstate"
      : "Unknown";

  const rec: InvoiceRecord = {
    fileName: file.name,
    invoiceNumber: extractInvoiceNumber(text),
    invoiceDate: extractInvoiceDate(text),
    customerGstin,
    customerName: extractCustomerName(text),
    placeOfSupply,
    invoiceValue: extractInvoiceValue(text),
    supplierGstin,
    supplierState,
    rateSplits,
    category,
    supplyType,
    issues: [],
    rawText: text,
  };

  validate(rec);
  return rec;
}

function validate(rec: InvoiceRecord) {
  if (!rec.invoiceNumber) rec.issues.push("Missing invoice number");
  if (!rec.invoiceDate) rec.issues.push("Missing invoice date");
  if (!rec.invoiceValue) rec.issues.push("Missing invoice value");
  if (rec.rateSplits.length === 0) rec.issues.push("No GST rate/tax amounts detected");
  if (rec.category === "B2B" && rec.customerGstin) {
    if (!isValidGstinLite(rec.customerGstin)) rec.issues.push("Invalid customer GSTIN format");
  }
  // Consistency: for each rate, tax ≈ taxable * rate/100 (±2)
  for (const r of rec.rateSplits) {
    const totalTax = r.igst + r.cgst + r.sgst;
    const expected = (r.taxableValue * r.rate) / 100;
    if (r.taxableValue > 0 && Math.abs(totalTax - expected) > Math.max(2, expected * 0.02)) {
      rec.issues.push(
        `Tax mismatch @${r.rate}%: taxable ${r.taxableValue.toFixed(2)}, tax ${totalTax.toFixed(2)}, expected ~${expected.toFixed(2)}`,
      );
    }
    // Interstate should only have IGST; Intrastate should have CGST+SGST
    if (rec.supplyType === "Interstate" && (r.cgst > 0 || r.sgst > 0))
      rec.issues.push(`@${r.rate}%: Interstate invoice has CGST/SGST`);
    if (rec.supplyType === "Intrastate" && r.igst > 0)
      rec.issues.push(`@${r.rate}%: Intrastate invoice has IGST`);
  }
}

function isValidGstinLite(g: string) {
  return /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/.test(g);
}

export { GSTIN_REGEX };
