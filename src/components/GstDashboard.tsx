import { useMemo } from "react";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { InvoiceRecord } from "@/lib/gstr1/parser";

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function parseDate(s: string | null): { y: number; m: number } | null {
  if (!s) return null;
  const t = s.trim();
  let m = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) { let y = Number(m[3]); if (y < 100) y += 2000; return { y, m: Number(m[2]) }; }
  m = t.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (m) return { y: Number(m[1]), m: Number(m[2]) };
  const d = new Date(t);
  if (!isNaN(d.getTime())) return { y: d.getFullYear(), m: d.getMonth() + 1 };
  return null;
}
const mKey = (y: number, m: number) => `${MONTHS[m - 1]} ${y}`;

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

const fmt = (n: number) =>
  n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function GstDashboard({ records }: { records: InvoiceRecord[] }) {
  const data = useMemo(() => {
    const invoices = dedupe(records);
    const grand = { taxable: 0, igst: 0, cgst: 0, sgst: 0 };
    for (const r of invoices)
      for (const s of r.rateSplits) {
        grand.taxable += s.taxableValue;
        grand.igst += s.igst;
        grand.cgst += s.cgst;
        grand.sgst += s.sgst;
      }
    const total = grand.taxable + grand.igst + grand.cgst + grand.sgst;

    // monthly
    const mMap = new Map<string, { y: number; m: number; count: number; taxable: number; igst: number; cgst: number; sgst: number }>();
    for (const r of invoices) {
      const d = parseDate(r.invoiceDate);
      const key = d ? mKey(d.y, d.m) : "Unknown";
      let b = mMap.get(key);
      if (!b) { b = { y: d?.y ?? 0, m: d?.m ?? 0, count: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0 }; mMap.set(key, b); }
      b.count++;
      for (const s of r.rateSplits) {
        b.taxable += s.taxableValue; b.igst += s.igst; b.cgst += s.cgst; b.sgst += s.sgst;
      }
    }
    const monthly = [...mMap.entries()]
      .map(([k, v]) => ({ key: k, ...v }))
      .sort((a, b) => a.y - b.y || a.m - b.m);

    // hsn
    const hMap = new Map<string, { count: number; qty: number; taxable: number; igst: number; cgst: number; sgst: number }>();
    for (const r of invoices) {
      const seenC = new Set<string>();
      for (const h of r.hsnItems) {
        const code = (h.hsn || "").trim() || "UNSPECIFIED";
        let a = hMap.get(code);
        if (!a) { a = { count: 0, qty: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0 }; hMap.set(code, a); }
        if (!seenC.has(code)) { a.count++; seenC.add(code); }
        a.qty += h.quantity;
        a.taxable += h.taxableValue; a.igst += h.igst; a.cgst += h.cgst; a.sgst += h.sgst;
      }
    }
    const hsn = [...hMap.entries()]
      .map(([code, v]) => ({ code, ...v }))
      .sort((a, b) => b.taxable - a.taxable);

    return { invoices: invoices.length, grand, total, monthly, hsn };
  }, [records]);

  const kpis = [
    { label: "Total Invoices", value: data.invoices.toString() },
    { label: "Total Taxable", value: fmt(data.grand.taxable) },
    { label: "Total IGST", value: fmt(data.grand.igst) },
    { label: "Total CGST", value: fmt(data.grand.cgst) },
    { label: "Total SGST", value: fmt(data.grand.sgst) },
    { label: "Total Invoice Value", value: fmt(data.total) },
  ];

  return (
    <section className="mt-10 space-y-6">
      <h2 className="text-2xl font-bold tracking-tight">GST Summary Dashboard</h2>

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        {kpis.map((k) => (
          <Card key={k.label} className="overflow-hidden">
            <div className="bg-primary px-3 py-2 text-xs font-medium text-primary-foreground">
              {k.label}
            </div>
            <div className="px-3 py-3 text-lg font-semibold">{k.value}</div>
          </Card>
        ))}
      </div>

      {/* Monthly */}
      <Card className="overflow-hidden">
        <div className="bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">
          Monthly Invoice Summary
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Month</TableHead>
              <TableHead className="text-right">Invoices</TableHead>
              <TableHead className="text-right">Taxable</TableHead>
              <TableHead className="text-right">IGST</TableHead>
              <TableHead className="text-right">CGST</TableHead>
              <TableHead className="text-right">SGST</TableHead>
              <TableHead className="text-right">Total Value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.monthly.map((m) => (
              <TableRow key={m.key}>
                <TableCell>{m.key}</TableCell>
                <TableCell className="text-right">{m.count}</TableCell>
                <TableCell className="text-right">{fmt(m.taxable)}</TableCell>
                <TableCell className="text-right">{fmt(m.igst)}</TableCell>
                <TableCell className="text-right">{fmt(m.cgst)}</TableCell>
                <TableCell className="text-right">{fmt(m.sgst)}</TableCell>
                <TableCell className="text-right">
                  {fmt(m.taxable + m.igst + m.cgst + m.sgst)}
                </TableCell>
              </TableRow>
            ))}
            <TableRow className="bg-green-50 font-semibold dark:bg-green-950/30">
              <TableCell>Grand Total</TableCell>
              <TableCell className="text-right">
                {data.monthly.reduce((a, b) => a + b.count, 0)}
              </TableCell>
              <TableCell className="text-right">{fmt(data.grand.taxable)}</TableCell>
              <TableCell className="text-right">{fmt(data.grand.igst)}</TableCell>
              <TableCell className="text-right">{fmt(data.grand.cgst)}</TableCell>
              <TableCell className="text-right">{fmt(data.grand.sgst)}</TableCell>
              <TableCell className="text-right">{fmt(data.total)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Card>

      {/* HSN */}
      <Card className="overflow-hidden">
        <div className="bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">
          HSN Summary
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>HSN</TableHead>
              <TableHead className="text-right">Invoices</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">Taxable</TableHead>
              <TableHead className="text-right">IGST</TableHead>
              <TableHead className="text-right">CGST</TableHead>
              <TableHead className="text-right">SGST</TableHead>
              <TableHead className="text-right">Total Value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.hsn.map((h) => (
              <TableRow key={h.code}>
                <TableCell className="font-mono text-xs">{h.code}</TableCell>
                <TableCell className="text-right">{h.count}</TableCell>
                <TableCell className="text-right">{h.qty}</TableCell>
                <TableCell className="text-right">{fmt(h.taxable)}</TableCell>
                <TableCell className="text-right">{fmt(h.igst)}</TableCell>
                <TableCell className="text-right">{fmt(h.cgst)}</TableCell>
                <TableCell className="text-right">{fmt(h.sgst)}</TableCell>
                <TableCell className="text-right">
                  {fmt(h.taxable + h.igst + h.cgst + h.sgst)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </section>
  );
}
