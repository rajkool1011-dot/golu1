import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Upload, ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { parseInvoicePdf, readPdfText, type InvoiceRecord } from "@/lib/gstr1/parser";
import { parseInvoiceAI } from "@/lib/gstr1/ai-parser";
import { extractInvoiceWithAI } from "@/lib/gstr1/extract.functions";

export const Route = createFileRoute("/compare")({
  head: () => ({
    meta: [
      { title: "Compare Extractors — Local vs AI vs Hybrid" },
      {
        name: "description",
        content:
          "Side-by-side demo of three GST invoice extraction approaches: local pdfjs parser, AI-only, and hybrid AI+validation.",
      },
    ],
  }),
  component: ComparePage,
});

type ColResult = {
  label: string;
  desc: string;
  loading: boolean;
  ms?: number;
  error?: string;
  data?: {
    invoiceNumber: string | null;
    invoiceDate: string | null;
    customerName: string | null;
    customerGstin: string | null;
    placeOfSupply: string | null;
    invoiceValue: number | null;
    supplyType: string;
    rateSplits: { rate: number; taxableValue: number; igst: number; cgst: number; sgst: number }[];
    hsnCount: number;
    issues: string[];
  };
};

function toCol(rec: InvoiceRecord): ColResult["data"] {
  return {
    invoiceNumber: rec.invoiceNumber,
    invoiceDate: rec.invoiceDate,
    customerName: rec.customerName,
    customerGstin: rec.customerGstin,
    placeOfSupply: rec.placeOfSupply,
    invoiceValue: rec.invoiceValue,
    supplyType: rec.supplyType,
    rateSplits: rec.rateSplits,
    hsnCount: rec.hsnItems.length,
    issues: rec.issues,
  };
}

function fmt(n: number | null | undefined) {
  if (n == null) return "—";
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function ComparePage() {
  const [file, setFile] = useState<File | null>(null);
  const [cols, setCols] = useState<ColResult[]>([
    { label: "Local Parser (pdfjs + regex)", desc: "Pure client-side heuristics", loading: false },
    { label: "AI Only", desc: "Raw AI extraction from text, no post-validation", loading: false },
    { label: "Hybrid (AI + Validation)", desc: "AI extract + validation + local fallback", loading: false },
  ]);

  const run = async (f: File) => {
    setFile(f);
    setCols((c) => c.map((x) => ({ ...x, loading: true, error: undefined, data: undefined, ms: undefined })));

    // Col A: local
    (async () => {
      const t0 = performance.now();
      try {
        const rec = await parseInvoicePdf(f);
        setCols((c) => {
          const n = [...c];
          n[0] = { ...n[0], loading: false, data: toCol(rec), ms: performance.now() - t0 };
          return n;
        });
      } catch (e) {
        setCols((c) => {
          const n = [...c];
          n[0] = { ...n[0], loading: false, error: (e as Error).message, ms: performance.now() - t0 };
          return n;
        });
      }
    })();

    // Col B: AI only (from text, minimal post-processing)
    (async () => {
      const t0 = performance.now();
      try {
        const text = (await readPdfText(f)).slice(0, 45000);
        const ai = await extractInvoiceWithAI({ data: { fileName: f.name, text } });
        if (!ai.ok) throw new Error(ai.message);
        const inv = ai.invoice;
        const rateSplits = (inv.rows ?? []).map((r) => ({
          rate: Number(r.rate) || 0,
          taxableValue: Number(r.taxable_value) || 0,
          igst: Number(r.igst) || 0,
          cgst: Number(r.cgst) || 0,
          sgst: Number(r.sgst) || 0,
        }));
        const hasIgst = rateSplits.some((r) => r.igst > 0);
        const hasCgstSgst = rateSplits.some((r) => r.cgst > 0 || r.sgst > 0);
        setCols((c) => {
          const n = [...c];
          n[1] = {
            ...n[1],
            loading: false,
            ms: performance.now() - t0,
            data: {
              invoiceNumber: inv.invoice_no,
              invoiceDate: inv.invoice_date,
              customerName: inv.customer_name,
              customerGstin: inv.customer_gstin,
              placeOfSupply: inv.place_of_supply,
              invoiceValue: inv.invoice_value,
              supplyType: hasIgst ? "Interstate" : hasCgstSgst ? "Intrastate" : "Unknown",
              rateSplits,
              hsnCount: (inv.hsn ?? []).length,
              issues: [],
            },
          };
          return n;
        });
      } catch (e) {
        setCols((c) => {
          const n = [...c];
          n[1] = { ...n[1], loading: false, error: (e as Error).message, ms: performance.now() - t0 };
          return n;
        });
      }
    })();

    // Col C: hybrid
    (async () => {
      const t0 = performance.now();
      try {
        const rec = await parseInvoiceAI(f);
        setCols((c) => {
          const n = [...c];
          n[2] = { ...n[2], loading: false, data: toCol(rec), ms: performance.now() - t0 };
          return n;
        });
      } catch (e) {
        setCols((c) => {
          const n = [...c];
          n[2] = { ...n[2], loading: false, error: (e as Error).message, ms: performance.now() - t0 };
          return n;
        });
      }
    })();
  };

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (!f.name.toLowerCase().endsWith(".pdf")) {
      toast.error("Please select a PDF invoice");
      return;
    }
    run(f);
  };

  return (
    <div className="min-h-screen bg-background p-4 md:p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <Link to="/" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-4 w-4" /> Back to app
            </Link>
            <h1 className="mt-2 text-2xl md:text-3xl font-bold">Extractor Comparison Demo</h1>
            <p className="text-sm text-muted-foreground">
              Upload one invoice PDF. Runs three extractors in parallel and shows results side-by-side.
            </p>
          </div>
          <label className="cursor-pointer">
            <input type="file" accept="application/pdf" className="hidden" onChange={onPick} />
            <Button asChild>
              <span>
                <Upload className="mr-2 h-4 w-4" /> Upload PDF
              </span>
            </Button>
          </label>
        </div>

        {file && (
          <div className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{file.name}</span> · {(file.size / 1024).toFixed(1)} KB
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-3">
          {cols.map((c, i) => (
            <Card key={i} className="p-4 space-y-3">
              <div>
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold">{c.label}</h3>
                  {c.ms != null && <Badge variant="outline">{c.ms.toFixed(0)}ms</Badge>}
                </div>
                <p className="text-xs text-muted-foreground mt-1">{c.desc}</p>
              </div>

              {c.loading && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
                  <Loader2 className="h-4 w-4 animate-spin" /> Extracting…
                </div>
              )}

              {c.error && (
                <div className="text-sm text-destructive bg-destructive/10 rounded p-2 break-words">{c.error}</div>
              )}

              {c.data && (
                <div className="space-y-2 text-sm">
                  <Field label="Invoice #" value={c.data.invoiceNumber} />
                  <Field label="Date" value={c.data.invoiceDate} />
                  <Field label="Customer" value={c.data.customerName} />
                  <Field label="GSTIN" value={c.data.customerGstin} mono />
                  <Field label="Place of Supply" value={c.data.placeOfSupply} />
                  <Field label="Invoice Value" value={c.data.invoiceValue != null ? `₹ ${fmt(c.data.invoiceValue)}` : null} />
                  <Field label="Supply Type" value={c.data.supplyType} />
                  <Field label="HSN Lines" value={String(c.data.hsnCount)} />
                  <div>
                    <div className="text-xs text-muted-foreground mb-1">Rate splits</div>
                    {c.data.rateSplits.length === 0 ? (
                      <div className="text-xs italic text-muted-foreground">None detected</div>
                    ) : (
                      <div className="space-y-1">
                        {c.data.rateSplits.map((r, j) => (
                          <div key={j} className="text-xs bg-muted rounded px-2 py-1 font-mono">
                            {r.rate}% · tx {fmt(r.taxableValue)} · i {fmt(r.igst)} · c {fmt(r.cgst)} · s {fmt(r.sgst)}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  {c.data.issues.length > 0 && (
                    <div>
                      <div className="text-xs text-muted-foreground mb-1">Issues</div>
                      <ul className="text-xs list-disc pl-4 space-y-0.5 text-amber-600 dark:text-amber-400">
                        {c.data.issues.map((iss, j) => <li key={j}>{iss}</li>)}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {!c.loading && !c.data && !c.error && (
                <div className="text-xs text-muted-foreground py-8 text-center">Upload a PDF to see results</div>
              )}
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string | null | undefined; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-2 border-b border-border/50 pb-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={`text-xs text-right ${mono ? "font-mono" : ""} ${!value ? "italic text-muted-foreground" : ""}`}>
        {value || "—"}
      </span>
    </div>
  );
}
