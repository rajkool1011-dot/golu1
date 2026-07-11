import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  FileText,
  Upload,
  Download,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Trash2,
  Sparkles,
  ShieldCheck,
  FileSpreadsheet,
  ChevronDown,
  FileJson,
  FileType2,
  LayoutDashboard,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { InvoiceRecord } from "@/lib/gstr1/parser";
import { parseInvoiceAI } from "@/lib/gstr1/ai-parser";
import { importInvoicesFromExcel } from "@/lib/gstr1/excel-importer";
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

type FileStatus = "queued" | "processing" | "retrying" | "completed" | "failed";

function Index() {
  const [files, setFiles] = useState<File[]>([]);
  const [statuses, setStatuses] = useState<FileStatus[]>([]);
  const [records, setRecords] = useState<InvoiceRecord[]>([]);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [creditsExhausted, setCreditsExhausted] = useState(false);

  const isSupported = (name: string) =>
    /\.(pdf|xlsx|xls|csv)$/i.test(name);

  const onFiles = useCallback((incoming: FileList | File[]) => {
    const accepted = Array.from(incoming).filter((f) => isSupported(f.name));
    if (!accepted.length) {
      toast.error("Please add PDF or Excel/CSV files");
      return;
    }
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => f.name + f.size));
      const merged = [...prev];
      const addedStatuses: FileStatus[] = [];
      for (const f of accepted) {
        if (!seen.has(f.name + f.size)) {
          merged.push(f);
          addedStatuses.push("queued");
        }
      }
      setStatuses((s) => [...s, ...addedStatuses]);
      return merged;
    });
  }, []);

  const isCreditsError = (msg: string) =>
    /credits?\s*exhaust|402|add credits|insufficient (funds|credits)|payment required/i.test(msg);


  const setStatus = (index: number, status: FileStatus) => {
    setStatuses((prev) => {
      const next = [...prev];
      while (next.length <= index) next.push("queued");
      next[index] = status;
      return next;
    });
  };

  const process = async () => {
    if (!files.length) return;
    // Only work on files not already completed successfully
    const pending = files
      .map((f, i) => ({ f, i }))
      .filter(({ i }) => statuses[i] !== "completed");
    if (!pending.length) {
      toast.info("All files are already processed");
      return;
    }
    setProcessing(true);
    setCreditsExhausted(false);
    setProgress(0);
    // Reset non-completed statuses to queued
    setStatuses((prev) =>
      files.map((_, i) => (prev[i] === "completed" ? "completed" : "queued")),
    );

    const out: InvoiceRecord[] = [];
    let done = 0;
    let halted = false;

    const failed = (f: File, msg: string): InvoiceRecord => ({
      fileName: f.name,
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
      issues: [`Failed to parse: ${msg}`],
      rawText: "",
    });

    const parsePdfWithRetry = async (f: File, i: number): Promise<InvoiceRecord> => {
      let lastErr: unknown;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          return await parseInvoiceAI(f);
        } catch (e) {
          lastErr = e;
          const msg = (e as Error).message || "";
          if (isCreditsError(msg)) {
            halted = true;
            throw e;
          }
          const rateLimited = /429|rate|limit|quota/i.test(msg);
          if (!rateLimited) break;
          setStatus(i, "retrying");
          // backoff: 2s, 5s, 10s, 20s
          await new Promise((r) => setTimeout(r, [2000, 5000, 10000, 20000][attempt]));
        }
      }
      return failed(f, (lastErr as Error)?.message ?? "unknown error");
    };

    // Worker pool: process files with limited concurrency so 100+ PDFs run smoothly
    const CONCURRENCY = 1;
    let cursor = 0;
    const runNext = async (): Promise<void> => {
      while (cursor < pending.length) {
        if (halted) return;
        const { f, i } = pending[cursor++];
        setStatus(i, "processing");
        const isExcel = /\.(xlsx|xls|csv)$/i.test(f.name);
        const newRecs: InvoiceRecord[] = [];
        let hadCreditsError = false;
        try {
          if (isExcel) {
            const recs = await importInvoicesFromExcel(f);
            if (!recs.length) throw new Error("No invoice rows detected in sheet");
            newRecs.push(...recs);
          } else {
            newRecs.push(await parsePdfWithRetry(f, i));
          }
        } catch (e) {
          const msg = (e as Error).message || "unknown error";
          if (isCreditsError(msg)) {
            hadCreditsError = true;
            halted = true;
            setStatus(i, "queued");
          } else {
            newRecs.push(failed(f, msg));
          }
        }
        if (hadCreditsError) return;
        out.push(...newRecs);
        done++;
        const anyFail = newRecs.some((r) => r.issues.some((s) => s.startsWith("Failed to parse")));
        setStatus(i, anyFail ? "failed" : "completed");
        setProgress(Math.round((done / pending.length) * 100));
        setRecords((prev) => [...prev, ...newRecs]);
        for (const r of newRecs) {
          if (r.issues.some((s) => s.startsWith("Failed to parse"))) {
            toast.error(`${f.name}: extraction failed`);
          } else {
            toast.success(`Extracted ${r.invoiceNumber ?? f.name}`);
          }
        }
      }
    };
    // Reset the live-updating table before this run
    setRecords([]);
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, pending.length) }, runNext),
    );

    if (halted) {
      setCreditsExhausted(true);
      toast.error("AI extraction paused — please retry in a moment");
      setProcessing(false);
      return;
    }

    // Duplicate-invoice-number annotation across the whole batch
    const numCounts = new Map<string, number>();
    for (const r of out) if (r.invoiceNumber) numCounts.set(r.invoiceNumber, (numCounts.get(r.invoiceNumber) ?? 0) + 1);
    for (const r of out)
      if (r.invoiceNumber && (numCounts.get(r.invoiceNumber) ?? 0) > 1 && !r.issues.includes("Duplicate invoice number"))
        r.issues.push("Duplicate invoice number");

    setRecords([...out]);
    setProcessing(false);
    toast.success(`Processed ${out.length} invoice${out.length === 1 ? "" : "s"}`);
  };

  // Keep a stable ref to the latest `process` so the auto-resume effect
  // never captures a stale closure.
  const processRef = useRef(process);
  useEffect(() => {
    processRef.current = process;
  });

  // Auto-resume flow when credits are exhausted:
  //  - retry every 60s (countdown shown in banner)
  //  - retry immediately when the tab regains focus (user likely just added credits)
  const RETRY_INTERVAL_SEC = 60;
  const [retryIn, setRetryIn] = useState(RETRY_INTERVAL_SEC);
  useEffect(() => {
    if (!creditsExhausted || processing) {
      setRetryIn(RETRY_INTERVAL_SEC);
      return;
    }
    setRetryIn(RETRY_INTERVAL_SEC);
    const tick = setInterval(() => {
      setRetryIn((s) => {
        if (s <= 1) {
          setCreditsExhausted(false);
          void processRef.current();
          return RETRY_INTERVAL_SEC;
        }
        return s - 1;
      });
    }, 1000);
    const onFocus = () => {
      setCreditsExhausted(false);
      void processRef.current();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(tick);
      window.removeEventListener("focus", onFocus);
    };
  }, [creditsExhausted, processing]);



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
    <div className="min-h-dvh bg-background text-foreground">
      {/* Top nav */}
      <header className="sticky top-0 z-30 border-b border-border/70 bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4 sm:px-6">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground shadow-sm">
            <FileSpreadsheet className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate font-display text-sm font-semibold tracking-tight">
              GSTR-1 Auto Prep
            </div>
            <div className="hidden truncate text-[11px] text-muted-foreground sm:block">
              Invoice PDFs → GSTR-1 ready exports
            </div>
          </div>
          <span className="hidden items-center gap-1.5 rounded-full border border-border bg-muted/60 px-3 py-1 text-[11px] font-medium text-muted-foreground md:inline-flex">
            <ShieldCheck className="h-3.5 w-3.5 text-[color:var(--brand)]" aria-hidden="true" />
            Runs 100% in your browser
          </span>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8 lg:py-10">
        {/* Hero band */}
        <section
          aria-labelledby="hero-title"
          className="overflow-hidden rounded-2xl border border-border bg-[linear-gradient(135deg,var(--primary),color-mix(in_oklab,var(--brand)_70%,var(--primary)))] p-6 text-primary-foreground shadow-[var(--shadow-elegant)] sm:p-8"
        >
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-4 sm:items-center">
            <div className="min-w-0">
              <div className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-medium ring-1 ring-white/15">
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" /> AI-assisted extraction
              </div>
              <h1 id="hero-title" className="mt-3 font-display text-2xl font-bold tracking-tight sm:text-3xl lg:text-4xl">
                From PDF invoices to GSTR-1 in one click
              </h1>
              <p className="mt-2 max-w-xl text-sm text-primary-foreground/80 sm:text-base">
                Drop your tax invoices. We auto rate-split, validate GSTINs, classify B2B / B2C,
                and export the offline utility JSON, CSV, HSN and B2C files.
              </p>
            </div>
            <div className="hidden shrink-0 rounded-xl bg-white/10 p-4 ring-1 ring-white/15 sm:block">
              <div className="text-[11px] uppercase tracking-wider text-primary-foreground/70">Queued</div>
              <div className="mt-1 font-display text-3xl font-bold tabular-nums">{files.length}</div>
              <div className="text-[11px] text-primary-foreground/70">PDF files</div>
            </div>
          </div>
        </section>

        {/* Dashboard grid */}
        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          {/* Main column */}
          <div className="min-w-0 space-y-6">
            {/* Dropzone */}
            <Card
              aria-label="Upload PDF invoices"
              className={`border-2 border-dashed p-8 text-center transition-all sm:p-10 ${
                dragOver
                  ? "border-[color:var(--brand)] bg-[color:var(--brand)]/5 ring-4 ring-[color:var(--brand)]/10"
                  : "border-border hover:border-[color:var(--brand)]/60"
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
              <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-[color:var(--brand)]/10 text-[color:var(--brand)]">
                <Upload className="h-7 w-7" aria-hidden="true" />
              </div>
              <p className="mt-4 text-sm font-medium text-foreground">
                Drag &amp; drop invoices here
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                PDF, XLSX, XLS or CSV — individual files or an entire folder
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                <label>
                  <input
                    type="file"
                    multiple
                    accept=".pdf,.xlsx,.xls,.csv,application/pdf"
                    className="sr-only"
                    aria-label="Select invoice files"
                    onChange={(e) => e.target.files && onFiles(e.target.files)}
                  />
                  <Button asChild variant="default" className="min-h-11">
                    <span>Select Files</span>
                  </Button>
                </label>
                <label>
                  <input
                    type="file"
                    multiple
                    accept=".pdf,.xlsx,.xls,.csv,application/pdf"
                    className="sr-only"
                    aria-label="Select a folder of invoices"
                    // @ts-expect-error webkitdirectory not in types
                    webkitdirectory=""
                    directory=""
                    onChange={(e) => e.target.files && onFiles(e.target.files)}
                  />
                  <Button asChild variant="outline" className="min-h-11">
                    <span>Select Folder</span>
                  </Button>
                </label>
              </div>

            </Card>

            {/* Credits-exhausted banner */}
            {creditsExhausted && (
              <Card className="border-destructive/40 bg-destructive/5 p-4 sm:p-5" role="alert">
                <div className="flex items-start gap-3">
                  <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-destructive">
                      AI credits exhausted
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Extraction paused. Add credits in workspace billing — the
                      queue will resume automatically when the tab regains focus,
                      or in <span className="font-medium tabular-nums text-foreground">{retryIn}s</span> on the next auto-retry.
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => { setCreditsExhausted(false); void process(); }}
                    className="shrink-0"
                  >
                    Resume now
                  </Button>
                </div>
              </Card>
            )}

            {/* File queue */}
            {files.length > 0 && (
              <Card className="p-4 sm:p-5">
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold">
                      {files.length} file{files.length === 1 ? "" : "s"} in queue
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      PDF, XLSX, XLS or CSV
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => { setFiles([]); setStatuses([]); setRecords([]); setCreditsExhausted(false); }}
                      aria-label="Clear file queue"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                      <span className="hidden sm:inline">Clear</span>
                    </Button>
                    <Button
                      size="sm"
                      onClick={process}
                      disabled={processing || creditsExhausted}
                    >
                      {processing ? (
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                      ) : (
                        <FileText className="h-4 w-4" aria-hidden="true" />
                      )}
                      <span>{processing ? "Processing…" : "Process invoices"}</span>
                    </Button>
                  </div>
                </div>
                {(() => {
                  const pdfCount = files.filter((f) => /\.pdf$/i.test(f.name)).length;
                  const pendingPdfs = files.filter(
                    (f, i) => /\.pdf$/i.test(f.name) && statuses[i] !== "completed",
                  ).length;
                  if (pdfCount === 0) return null;
                  // Based on real gateway logs: avg ~0.017 cr/invoice, range 0.005–0.038
                  const avg = 0.017;
                  const lo = pendingPdfs * 0.005;
                  const hi = pendingPdfs * 0.038;
                  const est = pendingPdfs * avg;
                  return (
                    <div className="mt-3 rounded-md border border-dashed bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
                      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                        <span>
                          <span className="font-medium text-foreground">{pendingPdfs}</span> PDF
                          {pendingPdfs === 1 ? "" : "s"} will call AI
                          {pdfCount !== pendingPdfs && (
                            <span className="ml-1">({pdfCount - pendingPdfs} already done)</span>
                          )}
                        </span>
                        <span>
                          Est. cost:{" "}
                          <span className="font-medium tabular-nums text-foreground">
                            ~{est.toFixed(2)} cr
                          </span>{" "}
                          <span className="opacity-70">
                            ({lo.toFixed(2)}–{hi.toFixed(2)})
                          </span>
                        </span>
                        <span>
                          Capacity per 1 cr:{" "}
                          <span className="font-medium tabular-nums text-foreground">~60 PDFs</span>
                        </span>
                      </div>
                    </div>
                  );
                })()}
                {processing && (
                  <div className="mt-3">
                    <Progress value={progress} aria-label={`Processing ${progress}%`} />
                    <div className="mt-1 text-right text-[11px] tabular-nums text-muted-foreground">
                      {progress}%
                    </div>
                  </div>
                )}
                <div className="mt-3 max-h-64 overflow-auto rounded-md border">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-muted/60 text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">File</th>
                        <th className="w-32 px-3 py-2 text-right font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {files.map((f, i) => {
                        const s: FileStatus = statuses[i] ?? "queued";
                        const styles: Record<FileStatus, string> = {
                          queued: "bg-muted text-muted-foreground",
                          processing: "bg-primary/10 text-primary",
                          retrying: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
                          completed: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
                          failed: "bg-destructive/10 text-destructive",
                        };
                        const label: Record<FileStatus, string> = {
                          queued: "Queued",
                          processing: "Processing",
                          retrying: "Retrying",
                          completed: "Completed",
                          failed: "Failed",
                        };
                        return (
                          <tr key={f.name + i} className="border-t">
                            <td className="max-w-0 px-3 py-2">
                              <div className="truncate" title={f.name}>{f.name}</div>
                            </td>
                            <td className="px-3 py-2 text-right">
                              <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium ${styles[s]}`}>
                                {s === "processing" || s === "retrying" ? (
                                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                                ) : s === "completed" ? (
                                  <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                                ) : s === "failed" ? (
                                  <AlertCircle className="h-3 w-3" aria-hidden="true" />
                                ) : null}
                                {label[s]}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}

            {/* Results */}
            {records.length > 0 && (
              <>
                <Card className="p-4 sm:p-5">
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
                    <div className="min-w-0">
                      <h2 className="font-display text-base font-semibold tracking-tight">Exports</h2>
                      <p className="truncate text-xs text-muted-foreground">
                        Ready-to-file JSON, CSV, HSN and dashboard bundles
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge variant="secondary" className="hidden tabular-nums sm:inline-flex">
                        {records.length} invoice{records.length === 1 ? "" : "s"}
                      </Badge>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button size="sm" className="min-h-11">
                            <Download className="h-4 w-4" aria-hidden="true" />
                            <span>Export</span>
                            <ChevronDown className="h-4 w-4 opacity-70" aria-hidden="true" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-64">
                          <DropdownMenuLabel>GSTR-1 Return</DropdownMenuLabel>
                          <DropdownMenuItem onClick={() => {
                            const gstin = window.prompt("Your (supplier) GSTIN — 15 chars:")?.trim().toUpperCase() ?? "";
                            if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/.test(gstin)) {
                              toast.error("Invalid supplier GSTIN");
                              return;
                            }
                            const fp = window.prompt("Filing period MMYYYY (blank = use invoice date):", "")?.trim() || undefined;
                            exportGstr1Json(records, { supplierGstin: gstin, filingPeriod: fp });
                          }}>
                            <FileJson className="h-4 w-4" aria-hidden="true" />
                            <span>GSTR-1 JSON</span>
                            <span className="ml-auto text-[10px] text-muted-foreground">Offline utility</span>
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => exportGstr1Workbook(records)}>
                            <FileSpreadsheet className="h-4 w-4" aria-hidden="true" />
                            <span>GSTR-1 CSV (B2B)</span>
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuLabel>HSN Summary</DropdownMenuLabel>
                          <DropdownMenuItem onClick={() => exportHsnWorkbook(records, { category: "B2B" })}>
                            <FileType2 className="h-4 w-4" aria-hidden="true" />
                            <span>HSN B2B CSV</span>
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => exportHsnWorkbook(records, { category: "B2C" })}>
                            <FileType2 className="h-4 w-4" aria-hidden="true" />
                            <span>HSN B2C CSV</span>
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuLabel>B2C & Dashboard</DropdownMenuLabel>
                          <DropdownMenuItem onClick={() => exportB2cWorkbook(records)}>
                            <FileSpreadsheet className="h-4 w-4" aria-hidden="true" />
                            <span>B2C CSV</span>
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => exportDashboardWorkbook(records)}>
                            <LayoutDashboard className="h-4 w-4" aria-hidden="true" />
                            <span>GST Dashboard XLSX</span>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                </Card>


                <Card className="overflow-hidden">
                  <div className="border-b border-border px-4 py-3 sm:px-5">
                    <h2 className="font-display text-base font-semibold tracking-tight">Invoices</h2>
                    <p className="text-xs text-muted-foreground">Per-invoice totals with tax split</p>
                  </div>
                  <div className="overflow-x-auto">
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
                              <TableCell className="text-right tabular-nums">
                                {r.invoiceValue != null ? fmt(r.invoiceValue) : "—"}
                              </TableCell>
                              <TableCell className="text-right tabular-nums">{fmt(t.taxable)}</TableCell>
                              <TableCell className="text-right tabular-nums">{t.igst > 0 ? fmt(t.igst) : "—"}</TableCell>
                              <TableCell className="text-right tabular-nums">{t.cgst > 0 ? fmt(t.cgst) : "—"}</TableCell>
                              <TableCell className="text-right tabular-nums">{t.sgst > 0 ? fmt(t.sgst) : "—"}</TableCell>
                              <TableCell className="text-xs">
                                {r.rateSplits.map((s) => `${s.rate}%`).join(", ") || "—"}
                              </TableCell>
                              <TableCell>
                                {r.issues.length === 0 ? (
                                  <span className="inline-flex items-center gap-1 text-emerald-600">
                                    <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                                    <span className="sr-only">OK</span>
                                    <span aria-hidden="true">OK</span>
                                  </span>
                                ) : (
                                  <span
                                    className="inline-flex items-center gap-1 text-amber-600"
                                    title={r.issues.join("\n")}
                                  >
                                    <AlertCircle className="h-4 w-4" aria-hidden="true" />
                                    <span className="sr-only">{r.issues.length} issues:</span>
                                    {r.issues.length}
                                  </span>
                                )}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                </Card>

                <GstDashboard records={records} />

                {records.some((r) => r.issues.length) && (
                  <Card className="p-4 sm:p-5">
                    <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
                      <AlertCircle className="h-4 w-4 text-amber-600" aria-hidden="true" />
                      Validation issues
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
          </div>

          {/* Right rail — summary */}
          <aside aria-label="Summary" className="space-y-4 lg:sticky lg:top-20 lg:self-start">
            <Card className="p-4">
              <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Session summary
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-3">
                <SummaryItem label="Invoices" value={records.length} />
                <SummaryItem label="Rate rows" value={totals.splits} />
                <SummaryItem label="Taxable" value={records.length ? fmt(totals.taxable) : "—"} />
                <SummaryItem label="IGST" value={records.length ? fmt(totals.igst) : "—"} />
                <SummaryItem label="CGST" value={records.length ? fmt(totals.cgst) : "—"} />
                <SummaryItem label="SGST" value={records.length ? fmt(totals.sgst) : "—"} />
              </dl>
              {totals.issues > 0 && (
                <div className="mt-3 flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
                  <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                  {totals.issues} invoice{totals.issues === 1 ? "" : "s"} need review
                </div>
              )}
            </Card>

            <Card className="p-4 text-xs text-muted-foreground">
              <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-foreground">
                Tips
              </div>
              <ul className="space-y-1.5 leading-relaxed">
                <li>• Use text-based PDFs (not scanned images).</li>
                <li>• Duplicate invoice numbers are flagged automatically.</li>
                <li>• Exports match the GSTR-1 offline utility templates.</li>
              </ul>
            </Card>
          </aside>
        </div>

        <footer className="mt-10 border-t border-border pt-6 text-center text-xs text-muted-foreground">
          Scanned PDFs (image-only) are not supported in this browser-only build — use text-based PDFs.
        </footer>
      </main>
    </div>
  );
}

function SummaryItem({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-muted/40 p-2.5">
      <dt className="truncate text-[11px] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate font-display text-base font-semibold tabular-nums text-foreground">
        {value}
      </dd>
    </div>
  );
}

function fmt(n: number): string {
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
