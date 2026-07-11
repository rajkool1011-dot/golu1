import * as XLSX from "xlsx";
import type { InvoiceRecord, RateSplit } from "./parser";
import { GSTIN_REGEX, stateFromGstin } from "./states";

/**
 * Import invoices from an Excel/CSV file.
 * Expected columns (case-insensitive, aliases supported):
 *   Invoice Number / Invoice #
 *   Invoice Date / Date
 *   Customer / Receiver / Customer Name
 *   GSTIN / Customer GSTIN
 *   Place of Supply / POS
 *   Invoice Value / Total Value
 *   Rate / Tax Rate / GST %
 *   Taxable / Taxable Value
 *   IGST / IGST Amount
 *   CGST / CGST Amount
 *   SGST / SGST Amount
 * One row per rate split; rows with the same Invoice Number merge.
 */

const ALIAS: Record<string, string[]> = {
  invoiceNumber: ["invoice number", "invoice no", "invoice #", "inv no", "inv number", "inum"],
  invoiceDate: ["invoice date", "date", "inv date", "idt"],
  customerName: ["customer", "customer name", "receiver", "receiver name", "party", "party name"],
  customerGstin: ["gstin", "customer gstin", "gstin/uin of recipient", "ctin", "gstin of recipient"],
  placeOfSupply: ["place of supply", "pos", "place"],
  invoiceValue: ["invoice value", "total value", "total", "val", "grand total"],
  rate: ["rate", "tax rate", "gst rate", "gst %", "rt", "rate %"],
  taxable: ["taxable value", "taxable", "txval", "taxable amount"],
  igst: ["igst", "igst amount", "iamt", "igst amt"],
  cgst: ["cgst", "cgst amount", "camt", "cgst amt"],
  sgst: ["sgst", "sgst amount", "samt", "sgst amt", "utgst"],
};

function normHeader(s: string): string {
  return String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function buildColMap(headers: string[]): Record<string, number> {
  const map: Record<string, number> = {};
  const normed = headers.map(normHeader);
  for (const [key, aliases] of Object.entries(ALIAS)) {
    for (let i = 0; i < normed.length; i++) {
      if (aliases.includes(normed[i])) {
        map[key] = i;
        break;
      }
    }
  }
  return map;
}

function toNumber(v: unknown): number {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return v;
  const n = Number(String(v).replace(/[,\s₹]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function toStr(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date)
    return `${String(v.getDate()).padStart(2, "0")}-${String(v.getMonth() + 1).padStart(2, "0")}-${v.getFullYear()}`;
  return String(v).trim();
}

export async function importInvoicesFromExcel(file: File): Promise<InvoiceRecord[]> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array", cellDates: true });
  const records: InvoiceRecord[] = [];
  const byNumber = new Map<string, InvoiceRecord>();

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const rows: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: "" });
    if (!rows.length) continue;

    // find header row (first row containing a known alias)
    let headerRow = 0;
    for (let i = 0; i < Math.min(10, rows.length); i++) {
      const cols = (rows[i] as unknown[]).map((c) => normHeader(String(c)));
      if (cols.some((c) => ALIAS.invoiceNumber.includes(c) || ALIAS.taxable.includes(c) || ALIAS.rate.includes(c))) {
        headerRow = i;
        break;
      }
    }

    const headers = (rows[headerRow] as unknown[]).map((c) => String(c ?? ""));
    const col = buildColMap(headers);
    if (col.invoiceNumber == null && col.rate == null && col.taxable == null) continue;

    for (let i = headerRow + 1; i < rows.length; i++) {
      const r = rows[i] as unknown[];
      const invNo = toStr(r[col.invoiceNumber ?? -1]);
      const rate = toNumber(r[col.rate ?? -1]);
      const taxable = toNumber(r[col.taxable ?? -1]);
      if (!invNo && taxable === 0 && rate === 0) continue;

      const key = invNo || `${file.name}#${i}`;
      let rec = byNumber.get(key);
      if (!rec) {
        const gstin = toStr(r[col.customerGstin ?? -1]).toUpperCase();
        const validGstin = GSTIN_REGEX.test(gstin) ? gstin : null;
        rec = {
          fileName: file.name,
          invoiceNumber: invNo || null,
          invoiceDate: toStr(r[col.invoiceDate ?? -1]) || null,
          customerGstin: validGstin,
          customerName: toStr(r[col.customerName ?? -1]) || null,
          placeOfSupply: toStr(r[col.placeOfSupply ?? -1]) || null,
          invoiceValue: col.invoiceValue != null ? toNumber(r[col.invoiceValue]) : null,
          supplierGstin: null,
          supplierState: validGstin ? stateFromGstin(validGstin) : null,
          rateSplits: [],
          hsnItems: [],
          category: validGstin ? "B2B" : "B2C",
          supplyType: "Unknown",
          issues: [],
          rawText: "",
        };
        byNumber.set(key, rec);
        records.push(rec);
      }

      const split: RateSplit = {
        rate,
        taxableValue: taxable,
        igst: toNumber(r[col.igst ?? -1]),
        cgst: toNumber(r[col.cgst ?? -1]),
        sgst: toNumber(r[col.sgst ?? -1]),
      };
      if (split.taxableValue > 0 || split.rate > 0) rec.rateSplits.push(split);
    }
  }

  // Derive supplyType & invoiceValue if missing
  for (const r of records) {
    const igst = r.rateSplits.reduce((a, s) => a + s.igst, 0);
    const intra = r.rateSplits.reduce((a, s) => a + s.cgst + s.sgst, 0);
    r.supplyType = igst > 0 ? "Interstate" : intra > 0 ? "Intrastate" : "Unknown";
    if (r.invoiceValue == null || r.invoiceValue === 0) {
      r.invoiceValue = r.rateSplits.reduce(
        (a, s) => a + s.taxableValue + s.igst + s.cgst + s.sgst,
        0,
      );
    }
    if (!r.rateSplits.length) r.issues.push("No rate rows found");
  }

  return records;
}
