import { extractInvoiceWithAI } from "./extract.functions";
import { readPdfText, type InvoiceRecord, type RateSplit } from "./parser";
import { stateFromGstin, normalizePlaceOfSupply, STATE_CODES } from "./states";

function isValidGstinLite(g: string) {
  return /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/.test(g);
}

export async function parseInvoiceAI(file: File): Promise<InvoiceRecord> {
  const text = (await readPdfText(file)).slice(0, 45000);
  if (!text.trim()) {
    throw new Error("No readable PDF text found. Please upload a text-based invoice PDF.");
  }

  const ai = await extractInvoiceWithAI({
    data: {
      fileName: file.name,
      text,
    },
  });

  if (!ai.ok) {
    throw Object.assign(new Error(ai.message), { code: ai.code });
  }

  const invoice = ai.invoice;

  const rateSplits: RateSplit[] = (invoice.rows ?? []).map((r) => ({
    rate: Number(r.rate) || 0,
    taxableValue: Number(r.taxable_value) || 0,
    igst: Number(r.igst) || 0,
    cgst: Number(r.cgst) || 0,
    sgst: Number(r.sgst) || 0,
  }));

  const hsnItems = (invoice.hsn ?? []).map((h) => ({
    hsn: (h.hsn ?? "").toString().trim(),
    description: (h.description ?? "").toString().trim(),
    uqc: ((h.uqc ?? "").toString().trim() || "OTH").toUpperCase(),
    quantity: Number(h.quantity) || 0,
    rate: Number(h.rate) || 0,
    taxableValue: Number(h.taxable_value) || 0,
    igst: Number(h.igst) || 0,
    cgst: Number(h.cgst) || 0,
    sgst: Number(h.sgst) || 0,
    cess: Number(h.cess) || 0,
  })).filter((h) => h.hsn || h.taxableValue > 0);

  const customerGstin = invoice.customer_gstin?.toUpperCase().trim() || null;
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
    invoiceNumber: invoice.invoice_no?.trim() || null,
    invoiceDate: invoice.invoice_date?.trim() || null,
    customerGstin,
    customerName: invoice.customer_name?.trim() || null,
    placeOfSupply:
      normalizePlaceOfSupply(invoice.place_of_supply) ??
      (customerGstin
        ? (() => {
            const code = customerGstin.slice(0, 2);
            const name = STATE_CODES[code];
            return name ? `${code}-${name}` : null;
          })()
        : null),
    invoiceValue: invoice.invoice_value ?? null,
    supplierGstin: null,
    supplierState: customerGstin ? stateFromGstin(customerGstin) : null,
    rateSplits,
    hsnItems,
    category,
    supplyType,
    issues: [],
    rawText: text,
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
