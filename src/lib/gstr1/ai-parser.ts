import { parseInvoicePdf, readPdfText, type InvoiceRecord } from "./parser";
import { extractInvoiceWithAI } from "./extract.functions";
import { stateFromGstin } from "./states";

/**
 * Hybrid extraction (cost-optimized):
 * 1. Run local OCR + rule-based parser (0 credits).
 * 2. If the result looks complete, return it — no AI call.
 * 3. Only when key fields are missing do we call the AI extractor,
 *    then merge AI values into the local record.
 *
 * This keeps AI cost near zero for clean invoices and reserves paid
 * calls for the few PDFs the local parser can't handle.
 */

function isComplete(rec: InvoiceRecord): boolean {
  const hasNumber = !!rec.invoiceNumber;
  const hasRows = rec.rateSplits.length > 0 &&
    rec.rateSplits.some((r) => (r.taxableValue || 0) > 0);
  const hasValue = (rec.invoiceValue ?? 0) > 0;
  return hasNumber && hasRows && hasValue;
}

export async function parseInvoiceAI(file: File): Promise<InvoiceRecord> {
  const local = await parseInvoicePdf(file);
  if (isComplete(local)) return local;

  // Local parser incomplete — try AI. Reuse the text we already OCR'd
  // via rawText so we don't re-run Tesseract.
  const text = local.rawText || (await readPdfText(file));
  try {
    const result = await extractInvoiceWithAI({ data: { fileName: file.name, text } });
    if (!result.ok) {
      local.issues.push(`AI fallback unavailable: ${result.code}`);
      return local;
    }
    const ai = result.invoice;

    // Merge: prefer AI values where local is missing/empty.
    const merged: InvoiceRecord = {
      ...local,
      invoiceNumber: local.invoiceNumber || ai.invoice_no,
      invoiceDate: local.invoiceDate || ai.invoice_date,
      customerName: local.customerName || ai.customer_name,
      customerGstin: local.customerGstin || ai.customer_gstin,
      placeOfSupply: local.placeOfSupply || ai.place_of_supply,
      invoiceValue: local.invoiceValue ?? ai.invoice_value,
      source: (local.rateSplits.length > 0 || local.invoiceNumber) ? "AI+OCR" : "AI",
    };

    if (local.rateSplits.length === 0 && ai.rows.length > 0) {
      merged.rateSplits = ai.rows.map((r) => ({
        rate: r.rate,
        taxableValue: r.taxable_value ?? 0,
        igst: r.igst ?? 0,
        cgst: r.cgst ?? 0,
        sgst: r.sgst ?? 0,
      }));
    }

    // Re-derive supplyType/category if AI filled in GSTIN or POS.
    if (!merged.supplierState && merged.supplierGstin) {
      merged.supplierState = stateFromGstin(merged.supplierGstin);
    }
    if (merged.supplierState && merged.placeOfSupply) {
      merged.supplyType =
        merged.supplierState.toLowerCase() === merged.placeOfSupply.toLowerCase()
          ? "Intrastate"
          : "Interstate";
    }
    merged.category = merged.customerGstin ? "B2B" : "B2C";

    return merged;
  } catch (e) {
    local.issues.push(`AI fallback error: ${e instanceof Error ? e.message : String(e)}`);
    return local;
  }
}
