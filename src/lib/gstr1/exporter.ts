import type { InvoiceRecord } from "./parser";

/**
 * Export records as a CSV matching the GSTR-1 offline utility template.
 * Columns (exact order):
 *   GSTIN/UIN of Recipient, Receiver Name, Invoice Number, Invoice date,
 *   Invoice Value, Place Of Supply, Reverse Charge, Applicable % of Tax Rate,
 *   Invoice Type, E-Commerce GSTIN, Rate, Taxable Value, Cess Amount
 * One row per rate split per invoice.
 */
const COLUMNS = [
  "GSTIN/UIN of Recipient",
  "Receiver Name",
  "Invoice Number",
  "Invoice date",
  "Invoice Value",
  "Place Of Supply",
  "Reverse Charge",
  "Applicable % of Tax Rate",
  "Invoice Type",
  "E-Commerce GSTIN",
  "Rate",
  "Taxable Value",
  "Cess Amount",
] as const;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/;

/** Convert DD-MM-YYYY → D-MMM-YY (e.g. 03-03-2020 → 3-Mar-20). */
function toTemplateDate(input: string | null | undefined): string {
  if (!input) return "";
  const m = input.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return input;
  const [, dd, mm, yyyy] = m;
  const mi = parseInt(mm, 10) - 1;
  if (mi < 0 || mi > 11) return input;
  return `${parseInt(dd, 10)}-${MONTHS[mi]}-${yyyy.slice(2)}`;
}

function invoiceType(r: InvoiceRecord): string {
  return r.category === "B2B" ? "Regular B2B" : "Regular";
}

function formatNumber(value: number | null | undefined): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return "";
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
}

function cleanText(value: string | null | undefined): string {
  return (value ?? "").replace(/[\r\n]+/g, " ").trim();
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Ensure "CC-Name" has a zero-padded 2-digit state code. */
function padPlaceOfSupply(value: string): string {
  const m = value.match(/^(\d{1,2})\s*-\s*(.+)$/);
  if (!m) return value;
  return `${m[1].padStart(2, "0")}-${m[2].trim()}`;
}

export function exportGstr1Workbook(records: InvoiceRecord[]): void {
  const rows: string[][] = [];

  const b2b = records.filter(
    (r) => r.category === "B2B" && !!r.customerGstin && GSTIN_PATTERN.test(r.customerGstin.trim()),
  );

  for (const r of b2b) {
    const gstin = r.customerGstin!.trim();
    const receiver = cleanText(r.customerName);
    const invNo = cleanText(r.invoiceNumber);
    const invDate = toTemplateDate(r.invoiceDate);
    const invValue = Number(r.invoiceValue ?? 0);
    const pos = padPlaceOfSupply(cleanText(r.placeOfSupply));

    // Utility rejects rows with missing required fields.
    if (!receiver || !invNo || !invDate || !pos || !(invValue > 0)) continue;

    const splits = r.rateSplits.filter(
      (s) => Number(s.rate) >= 0 && Number(s.taxableValue) > 0,
    );
    if (!splits.length) continue;

    for (const s of splits) {
      rows.push([
        gstin,
        receiver,
        invNo,
        invDate,
        formatNumber(invValue),
        pos,
        "N",
        "",
        invoiceType(r),
        "",
        formatNumber(s.rate),
        formatNumber(s.taxableValue),
        "",
      ]);
    }
  }

  const csv = [COLUMNS as unknown as string[], ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n") + "\r\n";
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "b2b,sez,de.csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
