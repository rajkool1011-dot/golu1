import { parseInvoicePdf, type InvoiceRecord } from "./parser";

/**
 * OCR + rule-based only. No Gemini / OpenAI / Lovable AI calls.
 * `readPdfText` inside parseInvoicePdf already falls back to Tesseract OCR
 * for scanned / image-based PDFs, so this covers both text and scanned files.
 */
export async function parseInvoiceAI(file: File): Promise<InvoiceRecord> {
  return parseInvoicePdf(file);
}
