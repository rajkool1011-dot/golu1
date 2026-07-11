import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import { FileText, Upload, Download, AlertCircle, CheckCircle2, Loader2, Trash2 } from "lucide-react";
import type { InvoiceRecord } from "@/lib/gstr1/parser";
import { parseInvoiceAI } from "@/lib/gstr1/ai-parser";
import { exportGstr1Workbook } from "@/lib/gstr1/exporter";
import { exportGstr1Json } from "@/lib/gstr1/json-exporter";
import { exportHsnWorkbook } from "@/lib/gstr1/hsn-exporter";
import { exportB2cWorkbook } from "@/lib/gstr1/b2c-exporter";
import { exportDashboardWorkbook } from "@/lib/gstr1/dashboard-exporter";
import { GstDashboard } from "@/components/GstDashboard";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "GSTR-1 Auto Prep — Extract invoices to GSTR-1 Excel" },
      {
        name: "description",
        content:
          "Drop PDF tax invoices and export a ready-to-file GSTR-1 workbook. Auto rate-splits, GSTIN validation, B2B/B2C classification.",
      },
      { property: "og:title", content: "GSTR-1 Auto Prep" },
      {
        property: "og:description",
        content: "PDF tax invoices → GSTR-1 Excel. All processed in your browser.",
      },
    ],
  }),
  component: Index,
});

function Index() {
  const [files, setFiles] = useState<File[]>([]);
  const [records, setRecords] = useState<InvoiceRecord[]>([]);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [dragOver, setDragOver] = useState(false);

  const onFiles = useCallback((incoming: FileList | File[]) => {
    const pdfs = Array.from(incoming).filter((f) => f.name.toLowerCase().endsWith(".pdf"));
    if (!pdfs.length) {
      toast.error("Please add PDF files");
      return;
    }
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => f.name + f.size));
      const merged = [...prev];
      for (const f of pdfs) if (!seen.has(f.name + f.size)) merged.push(f);
      return merged;
    });
  }, []);

  const process = async () => {
    if (!files.length) return;
    setProcessing(true);
    setProgress(0);
    const out: InvoiceRecord[] = [];
    for (let i = 0; i < files.length; i++) {
      try {
        const rec = await parseInvoiceAI(files[i]);
        out.push(rec);
      } catch (e) {
        out.push({
          fileName: files[i].name,
          invoiceNumber: null,
          invoiceDate: null,
          customerGstin: null,
          customerName: null,
          placeOfSupply: null,
          invoiceValue: null,
          supplierGstin: null,
          supplierState: null,
          rateSplits: [],
          hsnItems: [],
          category: "B2C",
          supplyType: "Unknown",
          issues: [`Failed to parse: ${(e as Error).message}`],
          rawText: "",
        });
      }
      setProgress(Math.round(((i + 1) / files.length) * 100));
      if (i < files.length - 1) await new Promise((r) => setTimeout(r, 2500));
    }
    // Duplicate detection
    const numCounts = new Map<string, number>();
    for (const r of out) if (r.invoiceNumber) numCounts.set(r.invoiceNumber, (numCounts.get(r.invoiceNumber) ?? 0) + 1);
    for (const r of out)
      if (r.invoiceNumber && (numCounts.get(r.invoiceNumber) ?? 0) > 1)
        r.issues.push("Duplicate invoice number");

    setRecords(out);
    setProcessing(false);
    toast.success(`Processed ${out.length} invoice${out.length === 1 ? "" : "s"}`);
  };

  const totals = useMemo(() => {
    let taxable = 0, igst = 0, cgst = 0, sgst = 0, splits = 0, issues = 0;
    for (const r of records) {
      if (r.issues.length) issues++;
      for (const s of r.rateSplits) {
        splits++;
        taxable += s.taxableValue;
        igst += s.igst;
        cgst += s.cgst;
        sgst += s.sgst;
      }
    }
    return { taxable, igst, cgst, sgst, splits, issues };
  }, [records]);

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-7xl px-6 py-10">
        <header className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight">GSTR-1 Auto Prep</h1>
          <p className="mt-1 text-muted-foreground">
            Drop PDF tax invoices → get a GSTR-1 ready Excel. Everything runs in your browser.
          </p>
        </header>

        {/* Dropzone */}
        <Card
          className={`border-2 border-dashed p-10 text-center transition-colors ${
            dragOver ? "border-primary bg-primary/5" : "border-border"
          }`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (e.dataTransfer.files.length) onFiles(e.dataTransfer.files);
          }}
        >
          <Upload className="mx-auto mb-3 h-10 w-10 text-muted-foreground" />
          <p className="mb-4 text-sm text-muted-foreground">
            Drag &amp; drop PDF invoices here, or select files / a folder
          </p>
          <div className="flex justify-center gap-2">
            <label>
              <input
                type="file"
                multiple
                accept="application/pdf"
                className="hidden"
                onChange={(e) => e.target.files && onFiles(e.target.files)}
              />
              <Button asChild variant="default">
                <span>Select PDFs</span>
              </Button>
            </label>
            <label>
              <input
                type="file"
                multiple
                accept="application/pdf"
                className="hidden"
                // @ts-expect-error webkitdirectory not in types
                webkitdirectory=""
                directory=""
                onChange={(e) => e.target.files && onFiles(e.target.files)}
              />
              <Button asChild variant="outline">
                <span>Select Folder</span>
              </Button>
            </label>
          </div>
        </Card>

        {/* File queue */}
        {files.length > 0 && (
          <Card className="mt-6 p-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-sm font-medium">
                {files.length} file{files.length === 1 ? "" : "s"} queued
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => { setFiles([]); setRecords([]); }}>
                  <Trash2 className="mr-1 h-4 w-4" /> Clear
                </Button>
                <Button size="sm" onClick={process} disabled={processing}>
                  {processing ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <FileText className="mr-1 h-4 w-4" />}
                  {processing ? "Processing…" : "Process invoices"}
                </Button>
              </div>
            </div>
            {processing && <Progress value={progress} className="mb-2" />}
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
              {files.slice(0, 20).map((f) => (
                <span key={f.name} className="rounded bg-muted px-2 py-0.5">{f.name}</span>
              ))}
              {files.length > 20 && <span>+ {files.length - 20} more…</span>}
            </div>
          </Card>
        )}

        {/* Results */}
        {records.length > 0 && (
          <>
            <div className="mt-8 grid grid-cols-2 gap-4 md:grid-cols-6">
              <Stat label="Invoices" value={records.length} />
              <Stat label="Rate rows" value={totals.splits} />
              <Stat label="Taxable" value={fmt(totals.taxable)} />
              <Stat label="IGST" value={fmt(totals.igst)} />
              <Stat label="CGST+SGST" value={fmt(totals.cgst + totals.sgst)} />
              <Stat label="Issues" value={totals.issues} warn={totals.issues > 0} />
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <Button variant="outline" onClick={() => {
                const gstin = window.prompt("Your (supplier) GSTIN — 15 chars:")?.trim().toUpperCase() ?? "";
                if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/.test(gstin)) {
                  toast.error("Invalid supplier GSTIN");
                  return;
                }
                const fp = window.prompt("Filing period MMYYYY (blank = use invoice date):", "")?.trim() || undefined;
                exportGstr1Json(records, { supplierGstin: gstin, filingPeriod: fp });
              }}>
                <Download className="mr-2 h-4 w-4" /> Export GSTR-1 JSON
              </Button>
              <Button variant="outline" onClick={() => exportHsnWorkbook(records, { category: "B2B" })}>
                <Download className="mr-2 h-4 w-4" /> HSN B2B CSV
              </Button>
              <Button variant="outline" onClick={() => exportHsnWorkbook(records, { category: "B2C" })}>
                <Download className="mr-2 h-4 w-4" /> HSN B2C CSV
              </Button>
              <Button variant="outline" onClick={() => exportB2cWorkbook(records)}>
                <Download className="mr-2 h-4 w-4" /> Export B2C CSV
              </Button>
              <Button variant="outline" onClick={() => exportDashboardWorkbook(records)}>
                <Download className="mr-2 h-4 w-4" /> GST Dashboard XLSX
              </Button>
              <Button onClick={() => exportGstr1Workbook(records)}>
                <Download className="mr-2 h-4 w-4" /> Export GSTR-1 CSV
              </Button>
            </div>

            <Card className="mt-4 overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>File</TableHead>
                    <TableHead>Invoice #</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>GSTIN</TableHead>
                    <TableHead>POS</TableHead>
                    <TableHead>Cat.</TableHead>
                    <TableHead>Supply</TableHead>
                    <TableHead className="text-right">Value</TableHead>
                    <TableHead className="text-right">Taxable</TableHead>
                    <TableHead className="text-right">IGST</TableHead>
                    <TableHead className="text-right">CGST</TableHead>
                    <TableHead className="text-right">SGST</TableHead>
                    <TableHead>Rates</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {records.map((r, i) => {
                    const t = r.rateSplits.reduce(
                      (a, s) => ({
                        taxable: a.taxable + s.taxableValue,
                        igst: a.igst + s.igst,
                        cgst: a.cgst + s.cgst,
                        sgst: a.sgst + s.sgst,
                      }),
                      { taxable: 0, igst: 0, cgst: 0, sgst: 0 },
                    );
                    return (
                    <TableRow key={i}>
                      <TableCell className="max-w-[180px] truncate text-xs" title={r.fileName}>
                        {r.fileName}
                      </TableCell>
                      <TableCell>{r.invoiceNumber ?? "—"}</TableCell>
                      <TableCell>{r.invoiceDate ?? "—"}</TableCell>
                      <TableCell className="max-w-[160px] truncate" title={r.customerName ?? ""}>
                        {r.customerName ?? "—"}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{r.customerGstin ?? "—"}</TableCell>
                      <TableCell>{r.placeOfSupply ?? "—"}</TableCell>
                      <TableCell>
                        <Badge variant={r.category === "B2B" ? "default" : "secondary"}>
                          {r.category}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{r.supplyType}</Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        {r.invoiceValue != null ? fmt(r.invoiceValue) : "—"}
                      </TableCell>
                      <TableCell className="text-right">{fmt(t.taxable)}</TableCell>
                      <TableCell className="text-right">{t.igst > 0 ? fmt(t.igst) : "—"}</TableCell>
                      <TableCell className="text-right">{t.cgst > 0 ? fmt(t.cgst) : "—"}</TableCell>
                      <TableCell className="text-right">{t.sgst > 0 ? fmt(t.sgst) : "—"}</TableCell>
                      <TableCell className="text-xs">
                        {r.rateSplits.map((s) => `${s.rate}%`).join(", ") || "—"}
                      </TableCell>
                      <TableCell>
                        {r.issues.length === 0 ? (
                          <span className="inline-flex items-center gap-1 text-green-600">
                            <CheckCircle2 className="h-4 w-4" /> OK
                          </span>
                        ) : (
                          <span
                            className="inline-flex items-center gap-1 text-amber-600"
                            title={r.issues.join("\n")}
                          >
                            <AlertCircle className="h-4 w-4" /> {r.issues.length}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                    );
                  })}

                </TableBody>
              </Table>
            </Card>

            <GstDashboard records={records} />



            {records.some((r) => r.issues.length) && (
              <Card className="mt-4 p-4">
                <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                  <AlertCircle className="h-4 w-4 text-amber-600" /> Validation issues
                </div>
                <ul className="space-y-1 text-xs text-muted-foreground">
                  {records
                    .filter((r) => r.issues.length)
                    .map((r, i) => (
                      <li key={i}>
                        <span className="font-medium text-foreground">{r.fileName}</span>
                        {r.invoiceNumber ? ` (#${r.invoiceNumber})` : ""}: {r.issues.join("; ")}
                      </li>
                    ))}
                </ul>
              </Card>
            )}
          </>
        )}

        <footer className="mt-10 text-center text-xs text-muted-foreground">
          Scanned PDFs (image-only) are not supported in this browser-only build — use text-based PDFs.
        </footer>
      </div>
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: string | number; warn?: boolean }) {
  return (
    <Card className="p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${warn ? "text-amber-600" : ""}`}>{value}</div>
    </Card>
  );
}

function fmt(n: number): string {
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
