import { parseInvoicePdf, readPdfText, type InvoiceRecord } from "./parser";
import { extractInvoiceWithAI } from "./extract.functions";
import { stateFromGstin } from "./states";
import { autoFix } from "./auto-fix";

/**
 * Hybrid extraction pipeline (cost-optimized, self-healing):
 *   1. Local OCR + rule-based parser (0 credits).
 *   2. Deterministic auto-fix pass (0 credits) — repairs missing tax
 *      amounts, invoice numbers, invoice values, and supply type.
 *   3. If STILL incomplete, try AI extraction using (a) user's own
 *      Gemini API key from localStorage (free tier, 0 Lovable credits),
 *      falling back to the project's GEMINI_API_KEY / LOVABLE_API_KEY.
 *   4. Merge AI values into the local record, then run auto-fix again.
 *
 * The auto-fix pass means the user doesn't have to keep reporting the
 * same tax-mismatch / value-mismatch / empty-invoice-number issues:
 * we recognise the pattern and repair it automatically.
 */

function isComplete(rec: InvoiceRecord): boolean {
  const hasNumber = !!rec.invoiceNumber;
  const hasRows = rec.rateSplits.length > 0 &&
    rec.rateSplits.some((r) => (r.taxableValue || 0) > 0);
  const hasValue = (rec.invoiceValue ?? 0) > 0;
  const noBlockingIssues = !rec.issues.some((s) =>
    /Tax mismatch|Value mismatch|No GST rate/.test(s),
  );
  return hasNumber && hasRows && hasValue && noBlockingIssues;
}

function readUserGeminiKey(): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const v = window.localStorage.getItem("gstr1.geminiKey");
    return v?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function parseInvoiceAI(file: File): Promise<InvoiceRecord> {
  // Step 1 + 2: local parse + auto-fix (zero credits).
  const local = autoFix(await parseInvoicePdf(file));
  if (isComplete(local)) return local;

  // Step 3: AI fallback — prefer the user's own Gemini key if present.
  const text = local.rawText || (await readPdfText(file));
  try {
    const result = await extractInvoiceWithAI({
      data: {
        fileName: file.name,
        text,
        userGeminiKey: readUserGeminiKey(),
      },
    });
    if (!result.ok) {
      local.issues.push(`AI fallback unavailable: ${result.code}`);
      return autoFix(local);
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

    // Step 4: second auto-fix pass on the merged record.
    return autoFix(merged);
  } catch (e) {
    local.issues.push(`AI fallback error: ${e instanceof Error ? e.message : String(e)}`);
    return autoFix(local);
  }
}
