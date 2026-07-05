import type { InvoiceRecord } from "./parser";

/**
 * Export B2C (Small) summary CSV matching the GSTR-1 offline utility "b2cs" section.
 * Columns:
 *   Type, Place Of Supply, Rate, Applicable % of Tax Rate, Taxable Value,
 *   Cess Amount, E-Commerce GSTIN
 * Rows are aggregated across all B2C invoices by (Place Of Supply, Rate).
 */
const COLUMNS = [
  "Type",
  "Place Of Supply",
  "Rate",
  "Applicable % of Tax Rate",
  "Taxable Value",
  "Cess Amount",
  "E-Commerce GSTIN",
] as const;

function fmt(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "0";
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function padPlaceOfSupply(value: string): string {
  const m = value.match(/^(\d{1,2})\s*-\s*(.+)$/);
  if (!m) return value;
  return `${m[1].padStart(2, "0")}-${m[2].trim()}`;
}

export function exportB2cWorkbook(records: InvoiceRecord[]): void {
  interface Agg {
    pos: string;
    rate: number;
    taxable: number;
  }
  const map = new Map<string, Agg>();

  const b2c = records.filter((r) => r.category === "B2C");
  for (const r of b2c) {
    const pos = padPlaceOfSupply((r.placeOfSupply ?? "").trim());
    if (!pos) continue;
    for (const s of r.rateSplits) {
      const rate = Number(s.rate) || 0;
      const taxable = Number(s.taxableValue) || 0;
      if (taxable <= 0) continue;
      const key = `${pos}||${rate}`;
      let a = map.get(key);
      if (!a) {
        a = { pos, rate, taxable: 0 };
        map.set(key, a);
      }
      a.taxable += taxable;
    }
  }

  const rows: string[][] = [];
  for (const a of map.values()) {
    rows.push(["OE", a.pos, fmt(a.rate), "", fmt(a.taxable), "", ""]);
  }

  const csv =
    [COLUMNS as unknown as string[], ...rows]
      .map((r) => r.map(csvCell).join(","))
      .join("\r\n") + "\r\n";

  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "b2cs.csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
