import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const SYSTEM_PROMPT = `You are an Indian GST Invoice Extraction Engine.

Your task is to extract invoice information with 100% accuracy.

Rules:
1. Never guess any value.
2. Read every field exactly as printed.
3. Preserve Invoice Number / GSTIN / Customer Name / Invoice Date exactly.
4. Detect Place of Supply.
5. Detect whether IGST or CGST+SGST.
6. Group invoice according to GST Rate for "rows".
7. Also extract every HSN/SAC line item into "hsn": one entry per line item.
   - hsn: the HSN or SAC code as printed (digits only if possible).
   - description: item description text.
   - uqc: unit of measure printed on the line (e.g. NOS, KGS, PCS, MTR, BAG). If absent use "OTH".
   - quantity: numeric quantity of that line.
   - rate: GST rate % of that line (0/3/5/12/18/28).
   - taxable_value: taxable amount of that line.
   - igst / cgst / sgst / cess: tax amounts of that line (0 if not applicable).
8. Verify Taxable + GST = Invoice Total.
9. Return JSON only. Missing fields = null. No explanations.

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
 ],
 "hsn": [
   { "hsn": "", "description": "", "uqc": "", "quantity": 0, "rate": 18, "taxable_value": 0, "igst": 0, "cgst": 0, "sgst": 0, "cess": 0 }
 ]
}`;

const RowSchema = z.object({
  rate: z.number(),
  taxable_value: z.number().nullable().default(0),
  igst: z.number().nullable().default(0),
  cgst: z.number().nullable().default(0),
  sgst: z.number().nullable().default(0),
});

const HsnSchema = z.object({
  hsn: z.string().nullable().default(""),
  description: z.string().nullable().default(""),
  uqc: z.string().nullable().default(""),
  quantity: z.number().nullable().default(0),
  rate: z.number().nullable().default(0),
  taxable_value: z.number().nullable().default(0),
  igst: z.number().nullable().default(0),
  cgst: z.number().nullable().default(0),
  sgst: z.number().nullable().default(0),
  cess: z.number().nullable().default(0),
});

const InvoiceSchema = z.object({
  invoice_no: z.string().nullable(),
  invoice_date: z.string().nullable(),
  customer_name: z.string().nullable(),
  customer_gstin: z.string().nullable(),
  place_of_supply: z.string().nullable(),
  invoice_value: z.number().nullable(),
  rows: z.array(RowSchema).default([]),
  hsn: z.array(HsnSchema).default([]),
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

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let res!: Response;
    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Lovable-API-Key": apiKey,
        },
        body: JSON.stringify(body),
      });
      if (res.status !== 429 || attempt === MAX_ATTEMPTS) break;
      const retryAfter = Number(res.headers.get("retry-after")) || 0;
      const wait = retryAfter > 0 ? retryAfter * 1000 : Math.min(30000, 1000 * 2 ** (attempt - 1)) + Math.random() * 500;
      await sleep(wait);
    }

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
