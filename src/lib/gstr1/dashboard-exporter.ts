import ExcelJS from "exceljs";
import type { InvoiceRecord } from "./parser";

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function parseInvoiceDate(s: string | null): { y: number; m: number } | null {
  if (!s) return null;
  const t = s.trim();
  // DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY
  let m = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    return { y, m: Number(m[2]) };
  }
  // YYYY-MM-DD
  m = t.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (m) return { y: Number(m[1]), m: Number(m[2]) };
  // DD Mon YYYY
  m = t.match(/^(\d{1,2})[\s\-]([A-Za-z]{3,})[\s\-](\d{2,4})$/);
  if (m) {
    const mi = MONTHS.findIndex((x) => x.toLowerCase() === m![2].slice(0, 3).toLowerCase());
    if (mi >= 0) {
      let y = Number(m[3]);
      if (y < 100) y += 2000;
      return { y, m: mi + 1 };
    }
  }
  const d = new Date(t);
  if (!isNaN(d.getTime())) return { y: d.getFullYear(), m: d.getMonth() + 1 };
  return null;
}

const monthKey = (y: number, m: number) => `${MONTHS[m - 1]} ${y}`;

// Dedupe by invoice number (fallback to fileName)
function dedupe(records: InvoiceRecord[]): InvoiceRecord[] {
  const seen = new Set<string>();
  const out: InvoiceRecord[] = [];
  for (const r of records) {
    const key = (r.invoiceNumber?.trim().toUpperCase() ?? "") + "|" + (r.invoiceDate ?? "");
    const k = key.length > 1 ? key : `FILE:${r.fileName}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

const BLUE = "FF1F4E79";
const BLUE_LIGHT = "FFDCE6F1";
const GREEN = "FFC6EFCE";
const GREY = "FFBFBFBF";
const WHITE = "FFFFFFFF";

const INR = '_-"₹"* #,##0.00_-;[Red]_-"₹"* -#,##0.00_-;_-"₹"* "-"??_-;_-@_-';
const INT = "#,##0";

interface Totals {
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
}
const zeroTot = (): Totals => ({ taxable: 0, igst: 0, cgst: 0, sgst: 0 });
const totalVal = (t: Totals) => t.taxable + t.igst + t.cgst + t.sgst;

export async function exportDashboardWorkbook(records: InvoiceRecord[]): Promise<void> {
  const invoices = dedupe(records);
  const wb = new ExcelJS.Workbook();
  wb.creator = "GSTR-1 Auto Prep";
  wb.created = new Date();

  const ws = wb.addWorksheet("GST Dashboard", {
    views: [{ showGridLines: false }],
  });

  // Column widths
  ws.columns = [
    { width: 22 }, { width: 18 }, { width: 18 }, { width: 18 },
    { width: 18 }, { width: 18 }, { width: 20 }, { width: 18 }, { width: 14 },
  ];

  // ===== Title =====
  ws.mergeCells("A1:I1");
  const title = ws.getCell("A1");
  title.value = "GST Summary Dashboard";
  title.font = { name: "Calibri", size: 20, bold: true, color: { argb: WHITE } };
  title.alignment = { vertical: "middle", horizontal: "center" };
  title.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLUE } };
  ws.getRow(1).height = 34;

  let row = 3;

  // ===== 1. OVERALL SUMMARY =====
  row = sectionHeader(ws, row, "1. OVERALL SUMMARY", 9);

  const grand = zeroTot();
  for (const r of invoices) {
    for (const s of r.rateSplits) {
      grand.taxable += s.taxableValue;
      grand.igst += s.igst;
      grand.cgst += s.cgst;
      grand.sgst += s.sgst;
    }
  }

  const kpis: [string, number, string][] = [
    ["Total Invoices", invoices.length, INT],
    ["Total Taxable Value", grand.taxable, INR],
    ["Total IGST", grand.igst, INR],
    ["Total CGST", grand.cgst, INR],
    ["Total SGST", grand.sgst, INR],
    ["Total Invoice Value", totalVal(grand), INR],
  ];

  // KPI grid: 2 columns x 3 rows, each KPI spans 4 columns wide (label + value)
  for (let i = 0; i < kpis.length; i++) {
    const [label, value, fmt] = kpis[i];
    const r = row + Math.floor(i / 2) * 2;
    const c = 1 + (i % 2) * 5; // A or F
    ws.mergeCells(r, c, r, c + 3);
    const lbl = ws.getCell(r, c);
    lbl.value = label;
    lbl.font = { name: "Calibri", size: 10, bold: true, color: { argb: WHITE } };
    lbl.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLUE } };
    lbl.alignment = { vertical: "middle", horizontal: "left", indent: 1 };

    ws.mergeCells(r + 1, c, r + 1, c + 3);
    const val = ws.getCell(r + 1, c);
    val.value = value;
    val.numFmt = fmt;
    val.font = { name: "Calibri", size: 14, bold: true, color: { argb: "FF1F4E79" } };
    val.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLUE_LIGHT } };
    val.alignment = { vertical: "middle", horizontal: "right", indent: 1 };
    ws.getRow(r).height = 20;
    ws.getRow(r + 1).height = 26;
    thinBorderRange(ws, r, c, r + 1, c + 3);
  }
  row += Math.ceil(kpis.length / 2) * 2 + 2;

  // ===== 2. MONTHLY INVOICE SUMMARY =====
  row = sectionHeader(ws, row, "2. MONTHLY INVOICE SUMMARY", 7);

  const monthMap = new Map<string, { key: string; y: number; m: number; count: number; t: Totals }>();
  for (const r of invoices) {
    const d = parseInvoiceDate(r.invoiceDate);
    const key = d ? monthKey(d.y, d.m) : "Unknown";
    const y = d?.y ?? 0;
    const m = d?.m ?? 0;
    let bucket = monthMap.get(key);
    if (!bucket) {
      bucket = { key, y, m, count: 0, t: zeroTot() };
      monthMap.set(key, bucket);
    }
    bucket.count++;
    for (const s of r.rateSplits) {
      bucket.t.taxable += s.taxableValue;
      bucket.t.igst += s.igst;
      bucket.t.cgst += s.cgst;
      bucket.t.sgst += s.sgst;
    }
  }
  const monthRows = [...monthMap.values()].sort((a, b) => a.y - b.y || a.m - b.m);

  row = tableHeader(ws, row, ["Month", "No. of Invoices", "Taxable Value", "IGST", "CGST", "SGST", "Total Invoice Value"]);
  for (const b of monthRows) {
    dataRow(ws, row++, [b.key, b.count, b.t.taxable, b.t.igst, b.t.cgst, b.t.sgst, totalVal(b.t)], [null, INT, INR, INR, INR, INR, INR]);
  }
  const monthTot = monthRows.reduce(
    (a, b) => ({
      count: a.count + b.count,
      t: {
        taxable: a.t.taxable + b.t.taxable,
        igst: a.t.igst + b.t.igst,
        cgst: a.t.cgst + b.t.cgst,
        sgst: a.t.sgst + b.t.sgst,
      },
    }),
    { count: 0, t: zeroTot() },
  );
  totalRow(ws, row++, ["Grand Total", monthTot.count, monthTot.t.taxable, monthTot.t.igst, monthTot.t.cgst, monthTot.t.sgst, totalVal(monthTot.t)], [null, INT, INR, INR, INR, INR, INR]);
  row += 2;

  // ===== 3. OVERALL HSN SUMMARY =====
  row = sectionHeader(ws, row, "3. OVERALL HSN SUMMARY", 7);

  interface HsnAgg { count: number; t: Totals }
  const hsnMap = new Map<string, HsnAgg>();
  for (const r of invoices) {
    const seenPerInv = new Set<string>();
    for (const h of r.hsnItems) {
      const code = (h.hsn || "").trim() || "UNSPECIFIED";
      let agg = hsnMap.get(code);
      if (!agg) {
        agg = { count: 0, t: zeroTot() };
        hsnMap.set(code, agg);
      }
      if (!seenPerInv.has(code)) {
        agg.count++;
        seenPerInv.add(code);
      }
      agg.t.taxable += h.taxableValue;
      agg.t.igst += h.igst;
      agg.t.cgst += h.cgst;
      agg.t.sgst += h.sgst;
    }
  }
  const hsnSorted = [...hsnMap.entries()].sort((a, b) => b[1].t.taxable - a[1].t.taxable);

  row = tableHeader(ws, row, ["HSN Code", "No. of Invoices", "Taxable Value", "IGST", "CGST", "SGST", "Total Invoice Value"]);
  const hsnGrand = zeroTot();
  let hsnCount = 0;
  for (const [code, a] of hsnSorted) {
    dataRow(ws, row++, [code, a.count, a.t.taxable, a.t.igst, a.t.cgst, a.t.sgst, totalVal(a.t)], [null, INT, INR, INR, INR, INR, INR]);
    hsnGrand.taxable += a.t.taxable;
    hsnGrand.igst += a.t.igst;
    hsnGrand.cgst += a.t.cgst;
    hsnGrand.sgst += a.t.sgst;
    hsnCount += a.count;
  }
  totalRow(ws, row++, ["Grand Total", hsnCount, hsnGrand.taxable, hsnGrand.igst, hsnGrand.cgst, hsnGrand.sgst, totalVal(hsnGrand)], [null, INT, INR, INR, INR, INR, INR]);
  row += 2;

  // ===== 4. MONTHLY HSN SUMMARY =====
  row = sectionHeader(ws, row, "4. MONTHLY HSN SUMMARY", 9);

  interface MHAgg { count: number; qty: number; t: Totals }
  const mhMap = new Map<string, Map<string, MHAgg>>(); // monthKey -> hsn -> agg
  const monthMeta = new Map<string, { y: number; m: number }>();
  for (const r of invoices) {
    const d = parseInvoiceDate(r.invoiceDate);
    const mk = d ? monthKey(d.y, d.m) : "Unknown";
    if (!monthMeta.has(mk)) monthMeta.set(mk, { y: d?.y ?? 0, m: d?.m ?? 0 });
    let inner = mhMap.get(mk);
    if (!inner) {
      inner = new Map();
      mhMap.set(mk, inner);
    }
    const seenPerInv = new Set<string>();
    for (const h of r.hsnItems) {
      const code = (h.hsn || "").trim() || "UNSPECIFIED";
      let agg = inner.get(code);
      if (!agg) {
        agg = { count: 0, qty: 0, t: zeroTot() };
        inner.set(code, agg);
      }
      if (!seenPerInv.has(code)) {
        agg.count++;
        seenPerInv.add(code);
      }
      agg.qty += h.quantity;
      agg.t.taxable += h.taxableValue;
      agg.t.igst += h.igst;
      agg.t.cgst += h.cgst;
      agg.t.sgst += h.sgst;
    }
  }
  const mhMonths = [...mhMap.keys()].sort((a, b) => {
    const A = monthMeta.get(a)!; const B = monthMeta.get(b)!;
    return A.y - B.y || A.m - B.m;
  });

  row = tableHeader(ws, row, ["Month", "HSN Code", "No. of Invoices", "Quantity", "Taxable Value", "IGST", "CGST", "SGST", "Total Invoice Value"]);
  const gTot: MHAgg = { count: 0, qty: 0, t: zeroTot() };
  for (const mk of mhMonths) {
    const inner = mhMap.get(mk)!;
    const sub: MHAgg = { count: 0, qty: 0, t: zeroTot() };
    const sortedCodes = [...inner.entries()].sort((a, b) => b[1].t.taxable - a[1].t.taxable);
    for (const [code, a] of sortedCodes) {
      dataRow(
        ws, row++,
        [mk, code, a.count, a.qty, a.t.taxable, a.t.igst, a.t.cgst, a.t.sgst, totalVal(a.t)],
        [null, null, INT, INT, INR, INR, INR, INR, INR],
      );
      sub.count += a.count; sub.qty += a.qty;
      sub.t.taxable += a.t.taxable; sub.t.igst += a.t.igst;
      sub.t.cgst += a.t.cgst; sub.t.sgst += a.t.sgst;
    }
    subtotalRow(
      ws, row++,
      [`${mk} Total`, "", sub.count, sub.qty, sub.t.taxable, sub.t.igst, sub.t.cgst, sub.t.sgst, totalVal(sub.t)],
      [null, null, INT, INT, INR, INR, INR, INR, INR],
    );
    gTot.count += sub.count; gTot.qty += sub.qty;
    gTot.t.taxable += sub.t.taxable; gTot.t.igst += sub.t.igst;
    gTot.t.cgst += sub.t.cgst; gTot.t.sgst += sub.t.sgst;
  }
  totalRow(
    ws, row++,
    ["Grand Total", "", gTot.count, gTot.qty, gTot.t.taxable, gTot.t.igst, gTot.t.cgst, gTot.t.sgst, totalVal(gTot.t)],
    [null, null, INT, INT, INR, INR, INR, INR, INR],
  );

  // Save
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `GST_Dashboard_${new Date().toISOString().slice(0, 10)}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ===== Helpers =====

function sectionHeader(ws: ExcelJS.Worksheet, row: number, text: string, span: number): number {
  ws.mergeCells(row, 1, row, span);
  const c = ws.getCell(row, 1);
  c.value = text;
  c.font = { name: "Calibri", size: 12, bold: true, color: { argb: WHITE } };
  c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLUE } };
  c.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  ws.getRow(row).height = 24;
  return row + 1;
}

function tableHeader(ws: ExcelJS.Worksheet, row: number, headers: string[]): number {
  for (let i = 0; i < headers.length; i++) {
    const c = ws.getCell(row, i + 1);
    c.value = headers[i];
    c.font = { name: "Calibri", size: 10, bold: true, color: { argb: WHITE } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLUE } };
    c.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    c.border = allThin();
  }
  ws.getRow(row).height = 22;
  return row + 1;
}

function dataRow(
  ws: ExcelJS.Worksheet,
  row: number,
  values: (string | number)[],
  fmts: (string | null)[],
): void {
  for (let i = 0; i < values.length; i++) {
    const c = ws.getCell(row, i + 1);
    c.value = values[i];
    if (fmts[i]) c.numFmt = fmts[i]!;
    c.font = { name: "Calibri", size: 10 };
    c.alignment = { vertical: "middle", horizontal: typeof values[i] === "number" ? "right" : "left", indent: 1 };
    c.border = allThin();
  }
}

function totalRow(
  ws: ExcelJS.Worksheet,
  row: number,
  values: (string | number)[],
  fmts: (string | null)[],
): void {
  for (let i = 0; i < values.length; i++) {
    const c = ws.getCell(row, i + 1);
    c.value = values[i];
    if (fmts[i]) c.numFmt = fmts[i]!;
    c.font = { name: "Calibri", size: 10, bold: true, color: { argb: "FF006100" } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GREEN } };
    c.alignment = { vertical: "middle", horizontal: typeof values[i] === "number" ? "right" : "left", indent: 1 };
    c.border = allThin();
  }
  ws.getRow(row).height = 22;
}

function subtotalRow(
  ws: ExcelJS.Worksheet,
  row: number,
  values: (string | number)[],
  fmts: (string | null)[],
): void {
  for (let i = 0; i < values.length; i++) {
    const c = ws.getCell(row, i + 1);
    c.value = values[i];
    if (fmts[i]) c.numFmt = fmts[i]!;
    c.font = { name: "Calibri", size: 10, bold: true, color: { argb: "FF1F4E79" } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLUE_LIGHT } };
    c.alignment = { vertical: "middle", horizontal: typeof values[i] === "number" ? "right" : "left", indent: 1 };
    c.border = allThin();
  }
}

function allThin(): Partial<ExcelJS.Borders> {
  const s: ExcelJS.Border = { style: "thin", color: { argb: GREY } };
  return { top: s, left: s, bottom: s, right: s };
}

function thinBorderRange(ws: ExcelJS.Worksheet, r1: number, c1: number, r2: number, c2: number) {
  for (let r = r1; r <= r2; r++) {
    for (let c = c1; c <= c2; c++) {
      ws.getCell(r, c).border = allThin();
    }
  }
}
