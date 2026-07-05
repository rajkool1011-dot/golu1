import type { InvoiceRecord } from "./parser";

/**
 * Export aggregated HSN summary as CSV matching the GSTR-1 offline utility
 * "hsn" section columns:
 *   HSN, Description, UQC, Total Quantity, Total Value, Taxable Value,
 *   Integrated Tax, Central Tax, State/UT Tax, Cess Amount, Rate
 * Rows are aggregated across all invoices by (HSN, Rate, UQC).
 */
const COLUMNS = [
  "HSN",
  "Description",
  "UQC",
  "Total Quantity",
  "Total Value",
  "Taxable Value",
  "Integrated Tax",
  "Central Tax",
  "State/UT Tax",
  "Cess Amount",
  "Rate",
] as const;

const UQC_ALLOWED = new Set([
  "BAG", "BAL", "BDL", "BKL", "BOU", "BOX", "BTL", "BUN", "CAN", "CBM", "CCM",
  "CMS", "CTN", "DOZ", "DRM", "GGK", "GMS", "GRS", "GYD", "KGS", "KLR", "KME",
  "LTR", "MLT", "MTR", "MTS", "NOS", "PAC", "PCS", "PRS", "QTL", "ROL", "SET",
  "SQF", "SQM", "SQY", "TBS", "TGM", "THD", "TON", "TUB", "UGS", "UNT", "YDS", "OTH",
]);

function normalizeUqc(raw: string): string {
  const t = raw.trim().toUpperCase();
  if (!t) return "OTH";
  const map: Record<string, string> = {
    NOS: "NOS", NO: "NOS", NUMBERS: "NOS", PC: "PCS", PCS: "PCS",
    KG: "KGS", KGS: "KGS", KILOGRAM: "KGS", KILOGRAMS: "KGS",
    MTR: "MTR", METER: "MTR", METRE: "MTR", MTRS: "MTR", M: "MTR",
    LTR: "LTR", LITRE: "LTR", LITER: "LTR", L: "LTR",
    BAG: "BAG", BAGS: "BAG", BOX: "BOX", BOTTLE: "BTL", BTL: "BTL",
    SET: "SET", DOZ: "DOZ", DOZEN: "DOZ", PACK: "PAC", PKT: "PAC",
    UNIT: "UNT", UNITS: "UNT", TON: "TON", TONS: "TON", ROLL: "ROL",
  };
  const mapped = map[t] ?? t;
  return UQC_ALLOWED.has(mapped) ? mapped : `${mapped}-${mapped}`.length && UQC_ALLOWED.has(mapped) ? mapped : (UQC_ALLOWED.has(t) ? t : "OTH");
}

function fmt(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "0";
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function exportHsnWorkbook(records: InvoiceRecord[]): void {
  interface Agg {
    hsn: string;
    description: string;
    uqc: string;
    rate: number;
    quantity: number;
    taxable: number;
    igst: number;
    cgst: number;
    sgst: number;
    cess: number;
  }
  const map = new Map<string, Agg>();

  for (const rec of records) {
    for (const h of rec.hsnItems ?? []) {
      const hsn = (h.hsn ?? "").replace(/\D/g, "");
      if (!hsn) continue;
      const uqc = normalizeUqc(h.uqc ?? "");
      const rate = Number(h.rate) || 0;
      const key = `${hsn}||${rate}||${uqc}`;
      let a = map.get(key);
      if (!a) {
        a = {
          hsn,
          description: (h.description ?? "").replace(/[\r\n]+/g, " ").trim(),
          uqc,
          rate,
          quantity: 0,
          taxable: 0,
          igst: 0,
          cgst: 0,
          sgst: 0,
          cess: 0,
        };
        map.set(key, a);
      }
      a.quantity += Number(h.quantity) || 0;
      a.taxable += Number(h.taxableValue) || 0;
      a.igst += Number(h.igst) || 0;
      a.cgst += Number(h.cgst) || 0;
      a.sgst += Number(h.sgst) || 0;
      a.cess += Number(h.cess) || 0;
      if (!a.description && h.description) a.description = h.description.trim();
    }
  }

  const rows: string[][] = [];
  for (const a of map.values()) {
    const totalValue = a.taxable + a.igst + a.cgst + a.sgst + a.cess;
    rows.push([
      a.hsn,
      a.description || a.hsn,
      a.uqc,
      fmt(a.quantity),
      fmt(totalValue),
      fmt(a.taxable),
      fmt(a.igst),
      fmt(a.cgst),
      fmt(a.sgst),
      fmt(a.cess),
      fmt(a.rate),
    ]);
  }

  const csv =
    [COLUMNS as unknown as string[], ...rows]
      .map((r) => r.map(csvCell).join(","))
      .join("\r\n") + "\r\n";

  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "hsn.csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
