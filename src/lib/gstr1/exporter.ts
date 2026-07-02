import * as XLSX from "xlsx";
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

/** Convert DD-MM-YYYY → DD-MMM-YY (e.g. 14-07-2017 → 14-Jul-17). */
function toTemplateDate(input: string | null | undefined): string {
  if (!input) return "";
  const m = input.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return input;
  const [, dd, mm, yyyy] = m;
  const mi = parseInt(mm, 10) - 1;
  if (mi < 0 || mi > 11) return input;
  return `${dd}-${MONTHS[mi]}-${yyyy.slice(2)}`;
}

function invoiceType(r: InvoiceRecord): string {
  return r.category === "B2B" ? "Regular B2B" : "Regular";
}

export function exportGstr1Workbook(records: InvoiceRecord[]): void {
  const rows: Record<string, string | number>[] = [];

  for (const r of records) {
    const splits = r.rateSplits.length
      ? r.rateSplits
      : [{ rate: 0, taxableValue: 0, igst: 0, cgst: 0, sgst: 0 }];
    for (const s of splits) {
      rows.push({
        "GSTIN/UIN of Recipient": r.customerGstin ?? "",
        "Receiver Name": r.customerName ?? "",
        "Invoice Number": r.invoiceNumber ?? "",
        "Invoice date": toTemplateDate(r.invoiceDate),
        "Invoice Value": r.invoiceValue ?? 0,
        "Place Of Supply": r.placeOfSupply ?? "",
        "Reverse Charge": "N",
        "Applicable % of Tax Rate": "",
        "Invoice Type": invoiceType(r),
        "E-Commerce GSTIN": "",
        "Rate": s.rate,
        "Taxable Value": s.taxableValue,
        "Cess Amount": 0,
      });
    }
  }

  const ws = XLSX.utils.json_to_sheet(rows, { header: COLUMNS as unknown as string[] });
  const csv = XLSX.utils.sheet_to_csv(ws);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 10);
  const a = document.createElement("a");
  a.href = url;
  a.download = `GSTR1_${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
