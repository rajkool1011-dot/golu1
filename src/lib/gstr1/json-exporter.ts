import type { InvoiceRecord } from "./parser";

const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/;

const MONTHS: Record<string, string> = {
  JAN: "01", JANUARY: "01", FEB: "02", FEBRUARY: "02", MAR: "03", MARCH: "03",
  APR: "04", APRIL: "04", MAY: "05", JUN: "06", JUNE: "06", JUL: "07", JULY: "07",
  AUG: "08", AUGUST: "08", SEP: "09", SEPT: "09", SEPTEMBER: "09",
  OCT: "10", OCTOBER: "10", NOV: "11", NOVEMBER: "11", DEC: "12", DECEMBER: "12",
};

function normalizeDate(d: string | null | undefined): string | null {
  if (!d) return null;
  const s = d.trim();
  let m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{2}|\d{4})$/);
  if (m) {
    const yy = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}-${yy}`;
  }
  m = s.match(/^(\d{1,2})[-\/\s]([A-Za-z]+)[-\/\s](\d{2}|\d{4})$/);
  if (m) {
    const mm = MONTHS[m[2].toUpperCase()];
    if (mm) {
      const yy = m[3].length === 2 ? `20${m[3]}` : m[3];
      return `${m[1].padStart(2, "0")}-${mm}-${yy}`;
    }
  }
  return null;
}

function fpFromDate(d: string | null | undefined): string | null {
  const n = normalizeDate(d);
  if (!n) return null;
  const m = n.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  return m ? `${m[2]}${m[3]}` : null;
}

function posCode(place: string | null | undefined, gstin: string | null | undefined): string | null {
  if (place) {
    const m = place.match(/^(\d{1,2})/);
    if (m) return m[1].padStart(2, "0");
  }
  if (gstin) return gstin.slice(0, 2);
  return null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface JsonExportOptions {
  supplierGstin: string;
  filingPeriod?: string;
}

export function buildGstr1Json(records: InvoiceRecord[], opts: JsonExportOptions) {
  const b2b = records.filter(
    (r) => r.category === "B2B" && r.customerGstin && GSTIN_PATTERN.test(r.customerGstin.trim()),
  );

  const fp =
    opts.filingPeriod ||
    b2b.map((r) => fpFromDate(r.invoiceDate)).find((v): v is string => !!v) ||
    "";

  const byCtin = new Map<string, InvoiceRecord[]>();
  for (const r of b2b) {
    const ctin = r.customerGstin!.trim().toUpperCase();
    const arr = byCtin.get(ctin) ?? [];
    arr.push(r);
    byCtin.set(ctin, arr);
  }

  const b2bBlock = Array.from(byCtin.entries()).map(([ctin, invs]) => ({
    ctin,
    inv: invs.map((r) => {
      const itms = r.rateSplits
        .filter((s) => Number(s.taxableValue) > 0)
        .map((s, i) => {
          const rate = Number(s.rate);
          const num = Math.round(rate * 100) + (i + 1);
          const iamt = round2(s.igst);
          const camt = round2(s.cgst);
          const samt = round2(s.sgst);
          const itm_det: Record<string, number> = {
            txval: round2(s.taxableValue),
            rt: rate,
            csamt: 0,
          };
          if (iamt > 0) itm_det.iamt = iamt;
          if (camt > 0) itm_det.camt = camt;
          if (samt > 0) itm_det.samt = samt;
          return { num, itm_det };
        });

      return {
        inum: r.invoiceNumber ?? "",
        idt: r.invoiceDate ?? "",
        val: round2(Number(r.invoiceValue ?? 0)),
        pos: posCode(r.placeOfSupply, r.customerGstin) ?? "",
        rchrg: "N",
        inv_typ: "R",
        itms,
      };
    }),
  }));

  return {
    gstin: opts.supplierGstin.trim().toUpperCase(),
    fp,
    version: "GST3.2.4",
    hash: "hash",
    b2b: b2bBlock,
  };
}

export async function exportGstr1Json(records: InvoiceRecord[], opts: JsonExportOptions): Promise<void> {
  const payload = buildGstr1Json(records, opts);
  const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `gstr1_${payload.fp || "return"}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
