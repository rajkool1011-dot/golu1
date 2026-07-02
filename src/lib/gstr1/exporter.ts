import * as XLSX from "xlsx";
import type { InvoiceRecord } from "./parser";

/**
 * Export records into a GSTR-1 style workbook with B2B, B2CL, B2CS sheets.
 * One row per rate split per invoice.
 */
export function exportGstr1Workbook(records: InvoiceRecord[]): void {
  const b2b: any[] = [];
  const b2cl: any[] = [];
  const b2cs = new Map<string, any>(); // aggregated by (POS, rate)
  const issues: any[] = [];

  for (const r of records) {
    if (r.issues.length) {
      issues.push({
        File: r.fileName,
        Invoice: r.invoiceNumber ?? "",
        Issues: r.issues.join("; "),
      });
    }
    for (const s of r.rateSplits) {
      const base = {
        "GSTIN/UIN of Recipient": r.customerGstin ?? "",
        "Receiver Name": r.customerName ?? "",
        "Invoice Number": r.invoiceNumber ?? "",
        "Invoice date": r.invoiceDate ?? "",
        "Invoice Value": r.invoiceValue ?? "",
        "Place Of Supply": r.placeOfSupply ?? "",
        "Reverse Charge": "N",
        "Applicable % of Tax Rate": "",
        "Invoice Type": "Regular",
        "E-Commerce GSTIN": "",
        "Rate": s.rate,
        "Taxable Value": s.taxableValue,
        "Cess Amount": 0,
        "IGST": s.igst,
        "CGST": s.cgst,
        "SGST": s.sgst,
      };

      if (r.category === "B2B") {
        b2b.push(base);
      } else if (r.supplyType === "Interstate" && (r.invoiceValue ?? 0) > 250000) {
        b2cl.push(base);
      } else {
        // B2CS aggregation
        const key = `${r.placeOfSupply ?? ""}|${s.rate}|${r.supplyType}`;
        const prev = b2cs.get(key);
        if (prev) {
          prev["Taxable Value"] += s.taxableValue;
          prev["IGST"] += s.igst;
          prev["CGST"] += s.cgst;
          prev["SGST"] += s.sgst;
        } else {
          b2cs.set(key, {
            "Type": r.supplyType === "Interstate" ? "OE" : "OE",
            "Place Of Supply": r.placeOfSupply ?? "",
            "Applicable % of Tax Rate": "",
            "Rate": s.rate,
            "Taxable Value": s.taxableValue,
            "Cess Amount": 0,
            "E-Commerce GSTIN": "",
            "IGST": s.igst,
            "CGST": s.cgst,
            "SGST": s.sgst,
          });
        }
      }
    }
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(b2b), "B2B");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(b2cl), "B2CL");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([...b2cs.values()]), "B2CS");
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      records.map((r) => ({
        File: r.fileName,
        Invoice: r.invoiceNumber ?? "",
        Date: r.invoiceDate ?? "",
        "Customer GSTIN": r.customerGstin ?? "",
        "Customer Name": r.customerName ?? "",
        "Place of Supply": r.placeOfSupply ?? "",
        "Invoice Value": r.invoiceValue ?? "",
        Category: r.category,
        "Supply Type": r.supplyType,
        "Rate Splits": r.rateSplits.length,
        Issues: r.issues.join("; "),
      })),
    ),
    "Summary",
  );
  if (issues.length)
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(issues), "Issues");

  const stamp = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `GSTR1_${stamp}.xlsx`);
}
