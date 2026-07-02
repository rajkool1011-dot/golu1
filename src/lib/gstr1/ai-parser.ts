import { extractInvoiceWithAI } from "./extract.functions";
import type { InvoiceRecord, RateSplit } from "./parser";
import { stateFromGstin } from "./states";

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  // Chunked to avoid call-stack overflow on large PDFs.
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function isValidGstinLite(g: string) {
  return /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/.test(g);
}

export async function parseInvoiceAI(file: File): Promise<InvoiceRecord> {
  const base64 = await fileToBase64(file);
  const ai = await extractInvoiceWithAI({
    data: {
      fileName: file.name,
      mimeType: file.type || "application/pdf",
      base64,
    },
  });

  const rateSplits: RateSplit[] = (ai.rows ?? []).map((r) => ({
    rate: Number(r.rate) || 0,
    taxableValue: Number(r.taxable_value) || 0,
    igst: Number(r.igst) || 0,
    cgst: Number(r.cgst) || 0,
    sgst: Number(r.sgst) || 0,
  }));

  const customerGstin = ai.customer_gstin?.toUpperCase().trim() || null;
  const category: "B2B" | "B2C" = customerGstin ? "B2B" : "B2C";

  const hasIgst = rateSplits.some((r) => r.igst > 0);
  const hasCgstSgst = rateSplits.some((r) => r.cgst > 0 || r.sgst > 0);
  const supplyType: InvoiceRecord["supplyType"] = hasIgst
    ? "Interstate"
    : hasCgstSgst
      ? "Intrastate"
      : "Unknown";

  const rec: InvoiceRecord = {
    fileName: file.name,
    invoiceNumber: ai.invoice_no?.trim() || null,
    invoiceDate: ai.invoice_date?.trim() || null,
    customerGstin,
    customerName: ai.customer_name?.trim() || null,
    placeOfSupply: ai.place_of_supply?.trim() || null,
    invoiceValue: ai.invoice_value ?? null,
    supplierGstin: null,
    supplierState: customerGstin ? stateFromGstin(customerGstin) : null,
    rateSplits,
    category,
    supplyType,
    issues: [],
    rawText: "",
  };

  // Validation
  if (!rec.invoiceNumber) rec.issues.push("Missing invoice number");
  if (!rec.invoiceDate) rec.issues.push("Missing invoice date");
  if (!rec.invoiceValue) rec.issues.push("Missing invoice value");
  if (rec.rateSplits.length === 0) rec.issues.push("No GST rate/tax amounts detected");
  if (customerGstin && !isValidGstinLite(customerGstin))
    rec.issues.push("Invalid customer GSTIN format");

  for (const r of rec.rateSplits) {
    const totalTax = r.igst + r.cgst + r.sgst;
    const expected = (r.taxableValue * r.rate) / 100;
    if (r.taxableValue > 0 && Math.abs(totalTax - expected) > Math.max(2, expected * 0.02)) {
      rec.issues.push(
        `Tax mismatch @${r.rate}%: taxable ${r.taxableValue.toFixed(2)}, tax ${totalTax.toFixed(2)}, expected ~${expected.toFixed(2)}`,
      );
    }
  }

  // Taxable + Tax vs Invoice Value (±1% or ±2)
  if (rec.invoiceValue && rec.rateSplits.length) {
    const sum = rec.rateSplits.reduce(
      (a, r) => a + r.taxableValue + r.igst + r.cgst + r.sgst,
      0,
    );
    if (Math.abs(sum - rec.invoiceValue) > Math.max(2, rec.invoiceValue * 0.01)) {
      rec.issues.push(
        `Invoice total mismatch: rows sum ${sum.toFixed(2)} vs invoice value ${rec.invoiceValue.toFixed(2)}`,
      );
    }
  }

  return rec;
}
