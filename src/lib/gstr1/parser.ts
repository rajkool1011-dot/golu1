import { GSTIN_REGEX, stateFromGstin, STATE_CODES } from "./states";

// Configure pdfjs worker (Vite ?url import)
import * as pdfjsLib from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
(pdfjsLib as unknown as { GlobalWorkerOptions: { workerSrc: string } }).GlobalWorkerOptions.workerSrc = workerSrc;

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
  const Y_TOL = 3;
  const out: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const items = content.items as Array<{ str: string; transform: number[]; width?: number }>;
    const lineMap = new Map<number, Array<{ str: string; x: number; width: number }>>();
    for (const it of items) {
      if (!it.str || !it.str.trim()) continue;
      const yKey = Math.round(it.transform[5] / Y_TOL) * Y_TOL;
      if (!lineMap.has(yKey)) lineMap.set(yKey, []);
      lineMap.get(yKey)!.push({
        str: it.str,
        x: it.transform[4],
        width: it.width ?? it.str.length * 5,
      });
    }
    const sorted = [...lineMap.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([, arr]) => {
        arr.sort((a, b) => a.x - b.x);
        let line = "";
        for (let j = 0; j < arr.length; j++) {
          if (j > 0) {
            const gap = arr[j].x - (arr[j - 1].x + arr[j - 1].width);
            line += gap > 10 ? "  " : gap > 2 ? " " : "";
          }
          line += arr[j].str;
        }
        return line;
      });
    out.push(sorted.join("\n"));
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

const DATE_TOKEN_PATTERN =
  "([0-3]?\\d[\\/\\-.][01]?\\d[\\/\\-.](?:\\d{2}|\\d{4})|[0-3]?\\d[\\s\u00a0\-][A-Za-z]{3,9}[\\s\u00a0,\-]+\\d{2,4}|(?:20)?\\d{2}[\\/\\-.][01]?\\d[\\/\\-.][0-3]?\\d)";

function dateTokenRegex(flags = "gi") {
  return new RegExp(DATE_TOKEN_PATTERN, flags);
}

function dateTokens(line: string): Array<{ value: string; index: number }> {
  const re = dateTokenRegex("gi");
  const out: Array<{ value: string; index: number }> = [];
  let m;
  while ((m = re.exec(line))) {
    out.push({ value: m[1].replace(/\s+/g, " ").trim(), index: m.index });
  }
  return out;
}

function isNonInvoiceDateContext(text: string): boolean {
  return /\b(?:due|delivery|delivered|dispatch|dispatched|order|purchase\s*order|po|eway|e-way|e\s*way|ack(?:nowledg(?:e)?ment)?|challan|lr|payment|valid|expiry|period|statement|return|shipping|transport)\s*(?:no\.?|number|#)?\s*(?:date|dt|dated)?\b/i.test(
    text,
  );
}

function nearestTokenToColumn(tokens: Array<{ value: string; index: number }>, columnIndex: number) {
  return tokens.reduce((best, token) =>
    Math.abs(token.index - columnIndex) < Math.abs(best.index - columnIndex) ? token : best,
  );
}

function extractInvoiceDate(text: string): string | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const candidates: Array<{ value: string; score: number; line: number }> = [];
  const push = (value: string | undefined, score: number, line: number) => {
    if (!value) return;
    candidates.push({ value: value.replace(/\s+/g, " ").trim(), score, line });
  };

  lines.forEach((line, i) => {
    const tokens = dateTokens(line);
    if (tokens.length) {
      for (const token of tokens) {
        const before = line.slice(Math.max(0, token.index - 80), token.index);
        const near = line.slice(Math.max(0, token.index - 80), token.index + token.value.length + 35);
        let score = 20;
        if (/\b(?:invoice|inv\.?|bill|tax\s*invoice|doc(?:ument)?)\b/i.test(before)) score += 90;
        if (/\b(?:invoice\s*date|inv\.?\s*date|bill\s*date|document\s*date|date\s*of\s*invoice|dated|dt\.?)\b/i.test(near))
          score += 100;
        else if (/\b(?:date|dt\.?)\b/i.test(before)) score += 45;
        if (isNonInvoiceDateContext(near)) score -= 140;
        push(token.value, score, i);
      }
    }

    const dateHeaderMatch = line.match(/\b(?:invoice\s*date|inv\.?\s*date|bill\s*date|document\s*date|date\s*of\s*invoice|dated|dt\.?)\b/i);
    const hasInvoiceHeader = /\b(?:tax\s*invoice|invoice\s*(?:no|number|#)?|inv\.?\s*(?:no|number|#)?|bill\s*(?:no|number|#)?)\b/i.test(line);
    const hasDateHeader = /\b(?:date|dated|dt\.?)\b/i.test(line);

    // Highlighted/table cells often render as one header row (Invoice No | Dated)
    // followed by a value row. Prefer the date directly under the Date/Dated column.
    if ((hasInvoiceHeader && hasDateHeader) || dateHeaderMatch) {
      const columnIndex = dateHeaderMatch?.index ?? line.search(/\b(?:date|dated|dt\.?)\b/i);
      for (let offset = 1; offset <= 3 && i + offset < lines.length; offset++) {
        const nextLine = lines[i + offset];
        if (isNonInvoiceDateContext(nextLine)) continue;
        const nextTokens = dateTokens(nextLine);
        if (!nextTokens.length) continue;
        const chosen = nearestTokenToColumn(nextTokens, Math.max(0, columnIndex));
        push(chosen.value, 210 - offset * 15, i + offset);
        break;
      }
    }
  });

  if (candidates.length) {
    candidates.sort((a, b) => b.score - a.score || a.line - b.line);
    return normalizeDate(candidates[0].value);
  }

  const fallback = text.match(dateTokenRegex("i"));
  return fallback ? normalizeDate(fallback[1].replace(/\s+/g, " ").trim()) : null;
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", sept: "09", oct: "10", nov: "11", dec: "12",
};

function normalizeDate(raw: string): string {
  const s = raw.trim().replace(/\s+/g, " ");
  const expandYY = (y: string) => {
    if (y.length === 4) return y;
    const n = parseInt(y, 10);
    return (n >= 70 ? 1900 + n : 2000 + n).toString();
  };
  // DD-MON-YY or DD MON YYYY
  let m = s.match(/^([0-3]?\d)[\s\-\/,]+([A-Za-z]{3,9})[\s\-\/,]+(\d{2,4})$/);
  if (m) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mon) return `${m[1].padStart(2, "0")}-${mon}-${expandYY(m[3])}`;
  }
  // YYYY-MM-DD
  m = s.match(/^(\d{4})[\-\/.]([01]?\d)[\-\/.]([0-3]?\d)$/);
  if (m) return `${m[3].padStart(2, "0")}-${m[2].padStart(2, "0")}-${m[1]}`;
  // DD/MM/YY(YY) or DD-MM-YY(YY)
  m = s.match(/^([0-3]?\d)[\-\/.]([01]?\d)[\-\/.](\d{2,4})$/);
  if (m) return `${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}-${expandYY(m[3])}`;
  return s;
}


function extractPlaceOfSupply(text: string): string | null {
  const patterns = [
    /Place\s*of\s*Supply\s*[:\-]?\s*([A-Za-z0-9\-\s&()]+?)(?:\n|State|GSTIN|\(|$)/i,
    /\bState\s*(?:Name)?\s*[:\-]\s*([A-Za-z&\s]+?)(?:\s*,|\n|Code|GSTIN|Party|Bill|Ship|$)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const raw = m[1].trim().replace(/\s+/g, " ");
      const codeMatch = raw.match(/^(\d{2})[\s\-]/);
      if (codeMatch) return STATE_CODES[codeMatch[1]] ?? raw;
      return raw;
    }
  }
  return null;
}

function extractCustomerName(text: string): string | null {
  const patterns = [
    /Party\s*Name\s*[:\-]?\s*([A-Za-z0-9 &.,'\-]{2,80})/i,
    /(?:Bill(?:ed)?\s*To|Buyer|Customer|Consignee)\s*[:\-]?\s*\n?\s*([A-Z][A-Za-z0-9 &.,'\-]{2,80})/,
    /(?:Bill(?:ed)?\s*To|Buyer|Customer|Consignee)\s*[:\-]\s*([A-Za-z0-9 &.,'\-]{2,80})/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1].trim().replace(/\s+/g, " ");
  }
  return null;
}

function extractInvoiceValue(text: string): number | null {
  const labels =
    "(?:Grand\\s*Total|Invoice\\s*Total|Total\\s*Invoice\\s*Value|Total\\s*Amount|Bill\\s*Total|Net\\s*(?:Payable|Amount)|Amount\\s*Payable|Amount\\s*Chargeable(?:\\s*\\(in\\s*words\\))?|Balance\\s*Due|Total)";
  // Look at each occurrence of a label and take the last numeric amount within ~60 chars
  const re = new RegExp(`${labels}[^\\n\\r]{0,80}?(?:₹|Rs\\.?|INR)?\\s*(-?[\\d,]+\\.\\d{2})`, "gi");
  let best: number | null = null;
  let m;
  while ((m = re.exec(text))) {
    const v = num(m[1]);
    if (v > (best ?? 0)) best = v;
  }
  if (best !== null) return best;
  // Fallback: largest currency-formatted number in the doc
  const amounts = [...text.matchAll(/(?:₹|Rs\.?|INR)\s*(-?[\d,]+\.\d{2})/g)].map((x) => num(x[1]));
  if (amounts.length) return Math.max(...amounts);
  return null;
}


/**
 * Detect rate splits. Looks for GST rate percentages (5,12,18,28) associated
 * with taxable / tax amounts. Supports both split rows (CGST+SGST) and IGST rows.
 */
function extractRateSplits(text: string): RateSplit[] {
  const validRates = [0, 3, 5, 12, 18, 28];
  const bucket = new Map<number, RateSplit>();
  const ensure = (rate: number) => {
    if (!bucket.has(rate))
      bucket.set(rate, { rate, taxableValue: 0, igst: 0, cgst: 0, sgst: 0 });
    return bucket.get(rate)!;
  };
  const AMT = "([\\d,]+(?:\\.\\d{1,2})?)";

  // Heuristic 1: explicit IGST / CGST / SGST with % on same line.
  const withPct = (label: string) =>
    new RegExp(`${label}[^\\n]{0,40}?(\\d{1,2}(?:\\.\\d+)?)\\s*%[^\\n]{0,60}?${AMT}(?:[^\\n]{0,40}?${AMT})?`, "gi");
  const runPct = (re: RegExp, kind: "i" | "c" | "s") => {
    let mm;
    while ((mm = re.exec(text))) {
      let rate = parseFloat(mm[1]);
      if (kind !== "i") rate = rate * 2;
      if (!validRates.includes(Math.round(rate))) continue;
      const first = num(mm[2]);
      const second = mm[3] ? num(mm[3]) : null;
      const b = ensure(Math.round(rate));
      if (second !== null) {
        b.taxableValue = Math.max(b.taxableValue, first);
        if (kind === "i") b.igst += second;
        else if (kind === "c") b.cgst += second;
        else b.sgst += second;
      } else {
        if (kind === "i") b.igst += first;
        else if (kind === "c") b.cgst += first;
        else b.sgst += first;
      }
    }
  };
  runPct(withPct("IGST"), "i");
  runPct(withPct("CGST"), "c");
  runPct(withPct("SGST|UTGST"), "s");

  // Heuristic 2: tax-summary table row with rate + amounts.
  const rowRe = new RegExp(
    `(?:^|\\s)(0|3|5|12|18|28)(?:\\.0+)?\\s*%?\\s+${AMT}\\s+${AMT}(?:\\s+${AMT})?(?:\\s+${AMT})?`,
    "gm",
  );
  let m;
  while ((m = rowRe.exec(text))) {
    const rate = parseFloat(m[1]);
    if (!validRates.includes(Math.round(rate))) continue;
    const nums = [m[2], m[3], m[4], m[5]].filter(Boolean).map(num);
    if (nums.length < 2) continue;
    const taxable = nums[0];
    if (taxable <= 0) continue;
    const rec = ensure(rate);
    rec.taxableValue = Math.max(rec.taxableValue, taxable);
    if (nums.length >= 4) {
      rec.igst += nums[1];
      rec.cgst += nums[2];
      rec.sgst += nums[3];
    } else if (nums.length === 3) {
      const half = rate / 2;
      const expectedHalf = (taxable * half) / 100;
      if (Math.abs(nums[1] - expectedHalf) < Math.max(2, expectedHalf * 0.05)) {
        rec.cgst += nums[1];
        rec.sgst += nums[2];
      } else {
        rec.igst += nums[1];
      }
    } else {
      const expectedIgst = (taxable * rate) / 100;
      if (Math.abs(nums[1] - expectedIgst) < Math.max(2, expectedIgst * 0.05)) {
        rec.igst += nums[1];
      } else {
        rec.cgst += nums[1];
        rec.sgst += nums[1];
      }
    }
  }

  // Heuristic 3: tax lines WITHOUT % — infer rate from taxable subtotal.
  if (bucket.size === 0) {
    const grab = (label: string): number => {
      const re = new RegExp(`${label}[^A-Za-z0-9\\n]{0,20}(?:Rs\\.?|₹|INR)?\\s*${AMT}`, "gi");
      let total = 0;
      let mm;
      while ((mm = re.exec(text))) total += num(mm[1]);
      return total;
    };
    const igst = grab("IGST");
    const cgst = grab("CGST");
    const sgst = grab("SGST|UTGST");
    const taxableM = text.match(/(?:Taxable\s*(?:Value|Amount)|Sub[\s-]*Total)[^\n]{0,40}?([\d,]+\.\d{2})/i);
    const taxable = taxableM ? num(taxableM[1]) : 0;
    const tax = igst + cgst + sgst;
    if (taxable > 0 && tax > 0) {
      const inferred = Math.round((tax / taxable) * 100);
      const rate = validRates.reduce(
        (p, c) => (Math.abs(c - inferred) < Math.abs(p - inferred) ? c : p),
        18,
      );
      const b = ensure(rate);
      b.taxableValue = taxable;
      b.igst = igst;
      b.cgst = cgst;
      b.sgst = sgst;
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
