import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const SYSTEM_PROMPT = `You are an Indian GST Invoice Extraction Engine.

Your task is to extract invoice information with 100% accuracy.

Rules:
1. Never guess any value.
2. Read every field exactly as printed.
3. Preserve Invoice Number exactly.
4. Preserve GSTIN exactly.
5. Preserve Customer Name exactly.
6. Preserve Invoice Date.
7. Detect Place of Supply.
8. Detect whether IGST or CGST+SGST.
9. Ignore HSN, Quantity, UQC and Item Description.
10. Group invoice according to GST Rate.
11. If multiple GST rates exist, create one row for each GST rate.
12. Verify that: Taxable + GST = Invoice Total.
13. Return JSON only.
14. If any field is missing return null.
15. Never include explanations.

Return this exact JSON shape:
{
 "invoice_no": "",
 "invoice_date": "",
 "customer_name": "",
 "customer_gstin": "",
 "place_of_supply": "",
 "invoice_value": 0,
 "rows": [
   { "rate": 18, "taxable_value": 0, "igst": 0, "cgst": 0, "sgst": 0 }
 ]
}`;

const RowSchema = z.object({
  rate: z.number(),
  taxable_value: z.number().nullable().default(0),
  igst: z.number().nullable().default(0),
  cgst: z.number().nullable().default(0),
  sgst: z.number().nullable().default(0),
});

const InvoiceSchema = z.object({
  invoice_no: z.string().nullable(),
  invoice_date: z.string().nullable(),
  customer_name: z.string().nullable(),
  customer_gstin: z.string().nullable(),
  place_of_supply: z.string().nullable(),
  invoice_value: z.number().nullable(),
  rows: z.array(RowSchema).default([]),
});

export type ExtractedInvoice = z.infer<typeof InvoiceSchema>;

const Input = z.object({
  fileName: z.string(),
  mimeType: z.string(),
  base64: z.string(),
});

function stripJson(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) return fence[1].trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) return text.slice(first, last + 1);
  return text.trim();
}

export const extractInvoiceWithAI = createServerFn({ method: "POST" })
  .inputValidator((v: unknown) => Input.parse(v))
  .handler(async ({ data }) => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("Missing LOVABLE_API_KEY");

    const dataUrl = `data:${data.mimeType};base64,${data.base64}`;

    const body = {
      model: "google/gemini-3-flash-preview",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: `Extract invoice fields from this PDF (file: ${data.fileName}). Return JSON only.` },
            { type: "file", file: { filename: data.fileName, file_data: dataUrl } },
          ],
        },
      ],
      response_format: { type: "json_object" },
    };

    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Lovable-API-Key": apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      if (res.status === 429) throw new Error("AI rate limit reached — please retry in a moment.");
      if (res.status === 402) throw new Error("AI credits exhausted — add credits in workspace billing.");
      throw new Error(`AI Gateway error ${res.status}: ${errText.slice(0, 300)}`);
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = json.choices?.[0]?.message?.content ?? "";
    if (!raw) throw new Error("AI returned an empty response");

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJson(raw));
    } catch {
      throw new Error(`AI returned non-JSON output: ${raw.slice(0, 200)}`);
    }
    return InvoiceSchema.parse(parsed);
  });
