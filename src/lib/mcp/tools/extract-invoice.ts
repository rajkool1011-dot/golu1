import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { extractInvoiceWithAI } from "@/lib/gstr1/extract.functions";

export default defineTool({
  name: "extract_gst_invoice",
  title: "Extract GST invoice",
  description:
    "Extract structured Indian GST invoice fields (invoice no, date, customer, GSTIN, place of supply, invoice value, per-rate rows, and per-line HSN/SAC items) from raw invoice text. Input the plain text of the invoice (e.g. copied from a PDF).",
  inputSchema: {
    invoice_text: z
      .string()
      .min(20)
      .describe("Raw invoice text to extract. Should include tax lines and totals."),
    file_name: z
      .string()
      .optional()
      .describe("Optional file name for context only."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ invoice_text, file_name }) => {
    const result = await extractInvoiceWithAI({
      data: { fileName: file_name ?? "invoice.txt", text: invoice_text },
    });

    if (!result.ok) {
      return {
        content: [{ type: "text", text: `${result.code}: ${result.message}` }],
        isError: true,
      };
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result.invoice, null, 2) }],
      structuredContent: { invoice: result.invoice },
    };
  },
});
