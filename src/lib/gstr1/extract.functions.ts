import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const SYSTEM_PROMPT = `You are an Indian GST Invoice Extraction Engine.

Extract ONLY the following fields from the uploaded invoice.

Return JSON only.

{
  "invoice_no":"",
  "invoice_date":"",
  "buyer_name":"",
  "buyer_gstin":"",
  "place_of_supply":"",
  "invoice_value":0,
  "gst_data":[
    {
      "gst_rate":0,
      "taxable_value":0,
      "igst":0,
      "cgst":0,
      "sgst":0
    }
  ]
}

Rules:
- Never guess values.
- Preserve invoice number exactly.
- Preserve GSTIN exactly.
- Extract buyer name exactly.
- Detect Place of Supply.
- Detect Invoice Value.
- Group tax by GST Rate.
- If invoice contains 5%,12%,18%,28%, create separate objects.
- Ignore HSN.
- Ignore Quantity.
- Ignore UQC.
- Ignore Item Description.
- Ignore Bank Details.
- Ignore Terms & Conditions.
- Return valid JSON only.`;

const GstRowSchema = z.object({
  gst_rate: z.number().nullable().default(0),
  taxable_value: z.number().nullable().default(0),
  igst: z.number().nullable().default(0),
  cgst: z.number().nullable().default(0),
  sgst: z.number().nullable().default(0),
});

const AiResponseSchema = z.object({
  invoice_no: z.string().nullable().default(null),
  invoice_date: z.string().nullable().default(null),
  buyer_name: z.string().nullable().default(null),
  buyer_gstin: z.string().nullable().default(null),
  place_of_supply: z.string().nullable().default(null),
  invoice_value: z.number().nullable().default(null),
  gst_data: z.array(GstRowSchema).default([]),
});

// Internal shape used by the rest of the app (ai-parser expects `rows`, `hsn`,
// `customer_name`, `customer_gstin`). We keep that stable and map the new
// AI response into it.
const InvoiceSchema = z.object({
  invoice_no: z.string().nullable(),
  invoice_date: z.string().nullable(),
  customer_name: z.string().nullable(),
  customer_gstin: z.string().nullable(),
  place_of_supply: z.string().nullable(),
  invoice_value: z.number().nullable(),
  rows: z
    .array(
      z.object({
        rate: z.number(),
        taxable_value: z.number().nullable().default(0),
        igst: z.number().nullable().default(0),
        cgst: z.number().nullable().default(0),
        sgst: z.number().nullable().default(0),
      }),
    )
    .default([]),
  hsn: z.array(z.any()).default([]),
});


export type ExtractedInvoice = z.infer<typeof InvoiceSchema>;

export type ExtractInvoiceResult =
  | { ok: true; invoice: ExtractedInvoice }
  | { ok: false; code: "AI_CREDITS_EXHAUSTED" | "AI_RATE_LIMIT" | "AI_GATEWAY_ERROR" | "AI_EMPTY_RESPONSE" | "AI_INVALID_JSON"; message: string };

const Input = z.object({
  fileName: z.string(),
  text: z.string(),
  userGeminiKey: z.string().optional(),
});

function stripJson(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) return fence[1].trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) return text.slice(first, last + 1);
  return text.trim();
}

/** Best-effort repair of a truncated JSON object by closing open brackets. */
function repairTruncatedJson(text: string): string {
  let s = text.trim();
  const first = s.indexOf("{");
  if (first > 0) s = s.slice(first);
  // Strip trailing partial token (unterminated string, dangling comma/colon).
  // Find last position outside a string that safely terminates a value.
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  let lastSafe = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') { inStr = false; lastSafe = i + 1; }
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "{" || c === "[") { stack.push(c); lastSafe = i + 1; continue; }
    if (c === "}" || c === "]") { stack.pop(); lastSafe = i + 1; continue; }
    if (c === "," || c === " " || c === "\n" || c === "\r" || c === "\t") {
      if (c === ",") lastSafe = i; // trim before dangling comma
      continue;
    }
    // digits/letters within a literal — advance safe pointer only when we know it ends
    lastSafe = i + 1;
  }
  let out = s.slice(0, lastSafe);
  // If we were inside a string, drop the partial one and any preceding "key":
  if (inStr) {
    const q = out.lastIndexOf('"');
    if (q !== -1) out = out.slice(0, q);
    out = out.replace(/,?\s*"[^"]*"\s*:\s*$/, "").replace(/,\s*$/, "");
  }
  out = out.replace(/[,:]\s*$/, "");
  // Recompute open brackets and append closers.
  const stk: string[] = [];
  let inS = false, es = false;
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (inS) {
      if (es) es = false;
      else if (c === "\\") es = true;
      else if (c === '"') inS = false;
      continue;
    }
    if (c === '"') inS = true;
    else if (c === "{" || c === "[") stk.push(c);
    else if (c === "}" || c === "]") stk.pop();
  }
  while (stk.length) {
    const open = stk.pop();
    out += open === "{" ? "}" : "]";
  }
  return out;
}


export const extractInvoiceWithAI = createServerFn({ method: "POST" })
  .inputValidator((v: unknown) => Input.parse(v))
  .handler(async ({ data }) => {
    // Priority: user's own Gemini key (free tier, no Lovable credits) →
    // project GEMINI_API_KEY → LOVABLE_API_KEY gateway.
    const geminiKey = data.userGeminiKey?.trim() || process.env.GEMINI_API_KEY;
    const lovableKey = process.env.LOVABLE_API_KEY;
    if (!geminiKey && !lovableKey) throw new Error("Missing GEMINI_API_KEY or LOVABLE_API_KEY");

    // Cost reduction: cap input tokens tightly. 15k chars ~ 4-5k tokens is
    // plenty for a single invoice; tail rarely holds primary fields.
    const invoiceText = data.text.trim().slice(0, 15000);
    const userPrompt = `Extract invoice fields from this invoice text (file: ${data.fileName}). Return JSON only.\n\n${invoiceText}`;

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const MAX_ATTEMPTS = 8;
    let res!: Response;
    const useGemini = Boolean(geminiKey);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (useGemini) {
        res = await fetch(
          // Cheapest Gemini tier suitable for structured extraction.
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-goog-api-key": geminiKey!,
            },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
              contents: [{ role: "user", parts: [{ text: userPrompt }] }],
              generationConfig: {
                responseMimeType: "application/json",
                maxOutputTokens: 2048,
                temperature: 0,
              },
            }),
          },
        );
      } else {
        res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Lovable-API-Key": lovableKey!,
            "X-Lovable-AIG-SDK": "vercel-ai-sdk",
          },
          body: JSON.stringify({
            model: "google/gemini-2.5-flash-lite",
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: userPrompt },
            ],
            response_format: { type: "json_object" },
            max_tokens: 2048,
          }),
        });
      }
      if ((res.status !== 429 && res.status < 500) || attempt === MAX_ATTEMPTS) break;
      const retryAfter = Number(res.headers.get("retry-after")) || 0;
      const wait = retryAfter > 0
        ? retryAfter * 1000
        : Math.min(60000, 2000 * 2 ** (attempt - 1)) + Math.random() * 750;
      await sleep(wait);
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      if (res.status === 402) {
        return {
          ok: false,
          code: "AI_CREDITS_EXHAUSTED",
          message: "AI credits exhausted — add credits in workspace billing.",
        } satisfies ExtractInvoiceResult;
      }
      if (res.status === 429) {
        return {
          ok: false,
          code: "AI_RATE_LIMIT",
          message: "AI rate limit reached — please retry in a moment.",
        } satisfies ExtractInvoiceResult;
      }
      return {
        ok: false,
        code: "AI_GATEWAY_ERROR",
        message: `AI error ${res.status}: ${errText.slice(0, 300)}`,
      } satisfies ExtractInvoiceResult;
    }

    let raw = "";
    if (useGemini) {
      const json = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      raw = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    } else {
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      raw = json.choices?.[0]?.message?.content ?? "";
    }
    if (!raw) {
      return {
        ok: false,
        code: "AI_EMPTY_RESPONSE",
        message: "AI returned an empty response",
      } satisfies ExtractInvoiceResult;
    }


    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJson(raw));
    } catch {
      // Response was likely truncated mid-JSON — attempt to repair and reparse.
      try {
        parsed = JSON.parse(repairTruncatedJson(stripJson(raw)));
      } catch {
        return {
          ok: false,
          code: "AI_INVALID_JSON",
          message: `AI returned non-JSON output: ${raw.slice(0, 200)}`,
        } satisfies ExtractInvoiceResult;
      }
    }
    const ai = AiResponseSchema.parse(parsed);
    const mapped = {
      invoice_no: ai.invoice_no,
      invoice_date: ai.invoice_date,
      customer_name: ai.buyer_name,
      customer_gstin: ai.buyer_gstin,
      place_of_supply: ai.place_of_supply,
      invoice_value: ai.invoice_value,
      rows: (ai.gst_data ?? []).map((r) => ({
        rate: Number(r.gst_rate) || 0,
        taxable_value: Number(r.taxable_value) || 0,
        igst: Number(r.igst) || 0,
        cgst: Number(r.cgst) || 0,
        sgst: Number(r.sgst) || 0,
      })),
      hsn: [],
    };
    return {
      ok: true,
      invoice: InvoiceSchema.parse(mapped),
    } satisfies ExtractInvoiceResult;
  });
