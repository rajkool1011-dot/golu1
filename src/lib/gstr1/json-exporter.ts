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

      const totIgst = round2(r.rateSplits.reduce((a, s) => a + (Number(s.igst) || 0), 0));
      const totCgst = round2(r.rateSplits.reduce((a, s) => a + (Number(s.cgst) || 0), 0));
      const totSgst = round2(r.rateSplits.reduce((a, s) => a + (Number(s.sgst) || 0), 0));

      return {
        inum: r.invoiceNumber ?? "",
        idt: normalizeDate(r.invoiceDate) ?? r.invoiceDate ?? "",
        val: round2(Number(r.invoiceValue ?? 0)),
        iamt: totIgst,
        camt: totCgst,
        samt: totSgst,
        pos: posCode(r.placeOfSupply, r.customerGstin) ?? "",
        rchrg: "N",
        inv_typ: "R",
        itms,
      };

    }),
  }));

  // B2CS aggregation by (pos, rate)
  const supplierStateCode = opts.supplierGstin.trim().slice(0, 2);
  const b2c = records.filter((r) => r.category === "B2C");
  const b2csMap = new Map<string, { pos: string; rt: number; txval: number; iamt: number; camt: number; samt: number }>();
  for (const r of b2c) {
    const pos = posCode(r.placeOfSupply, r.customerGstin);
    if (!pos) continue;
    for (const s of r.rateSplits) {
      const txval = Number(s.taxableValue) || 0;
      if (txval <= 0) continue;
      const rt = Number(s.rate) || 0;
      const key = `${pos}||${rt}`;
      const a = b2csMap.get(key) ?? { pos, rt, txval: 0, iamt: 0, camt: 0, samt: 0 };
      a.txval += txval;
      a.iamt += Number(s.igst) || 0;
      a.camt += Number(s.cgst) || 0;
      a.samt += Number(s.sgst) || 0;
      b2csMap.set(key, a);
    }
  }
  const b2csBlock = Array.from(b2csMap.values()).map((a) => {
    const intra = a.pos === supplierStateCode;
    const row: Record<string, string | number> = {
      sply_ty: intra ? "INTRA" : "INTER",
      rt: a.rt,
      typ: "OE",
      pos: a.pos,
      txval: round2(a.txval),
    };
    if (intra) {
      row.camt = round2(a.camt || (a.txval * a.rt) / 200);
      row.samt = round2(a.samt || (a.txval * a.rt) / 200);
    } else {
      row.iamt = round2(a.iamt || (a.txval * a.rt) / 100);
    }
    row.csamt = 0;
    return row;
  });

  return {
    gstin: opts.supplierGstin.trim().toUpperCase(),
    fp,
    version: "GST3.2.4",
    hash: "hash",
    b2b: b2bBlock,
    b2cs: b2csBlock,
  };
}

function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function exportGstr1Json(records: InvoiceRecord[], opts: JsonExportOptions): Promise<void> {
  const payload = buildGstr1Json(records, opts);
  downloadJson(payload, `gstr1_${payload.fp || "return"}.json`);
}

/** B2B section only */
export function buildB2bJson(records: InvoiceRecord[], opts: JsonExportOptions) {
  const full = buildGstr1Json(records, opts);
  return { gstin: full.gstin, fp: full.fp, version: full.version, hash: full.hash, b2b: full.b2b };
}

/** B2CS section only */
export function buildB2csJson(records: InvoiceRecord[], opts: JsonExportOptions) {
  const full = buildGstr1Json(records, opts);
  return { gstin: full.gstin, fp: full.fp, version: full.version, hash: full.hash, b2cs: full.b2cs };
}

/** HSN summary aggregated across all records */
export function buildHsnJson(records: InvoiceRecord[], opts: JsonExportOptions) {
  type Agg = {
    hsn_sc: string; desc: string; uqc: string; rt: number;
    qty: number; txval: number; iamt: number; camt: number; samt: number; csamt: number;
  };
  const map = new Map<string, Agg>();
  for (const r of records) {
    for (const h of r.hsnItems) {
      const hsn_sc = (h.hsn || "").trim();
      if (!hsn_sc && !h.taxableValue) continue;
      const rt = Number(h.rate) || 0;
      const uqc = (h.uqc || "OTH").toUpperCase();
      const key = `${hsn_sc}||${rt}||${uqc}`;
      const a = map.get(key) ?? {
        hsn_sc, desc: h.description || "", uqc, rt,
        qty: 0, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0,
      };
      a.qty += Number(h.quantity) || 0;
      a.txval += Number(h.taxableValue) || 0;
      a.iamt += Number(h.igst) || 0;
      a.camt += Number(h.cgst) || 0;
      a.samt += Number(h.sgst) || 0;
      a.csamt += Number(h.cess) || 0;
      map.set(key, a);
    }
  }
  const data = Array.from(map.values()).map((a, i) => ({
    num: i + 1,
    hsn_sc: a.hsn_sc,
    desc: a.desc,
    uqc: a.uqc,
    qty: round2(a.qty),
    rt: a.rt,
    txval: round2(a.txval),
    iamt: round2(a.iamt),
    camt: round2(a.camt),
    samt: round2(a.samt),
    csamt: round2(a.csamt),
  }));
  const fp = opts.filingPeriod || records.map((r) => fpFromDate(r.invoiceDate)).find((v): v is string => !!v) || "";
  return {
    gstin: opts.supplierGstin.trim().toUpperCase(),
    fp,
    version: "GST3.2.4",
    hash: "hash",
    hsn: { data },
  };
}

/** Doc issue section — invoice numbers issued (doc_num 1 = outward invoices) */
export function buildDocsJson(records: InvoiceRecord[], opts: JsonExportOptions) {
  const nums = records
    .map((r) => (r.invoiceNumber ?? "").trim())
    .filter((n) => !!n);

  // Split into consecutive ranges based on numeric suffix
  type Range = { from: string; to: string; totnum: number };
  const ranges: Range[] = [];
  const parsed = nums.map((n) => {
    const m = n.match(/^(.*?)(\d+)$/);
    return m ? { prefix: m[1], num: parseInt(m[2], 10), width: m[2].length, raw: n } : null;
  });
  const grouped = new Map<string, { num: number; width: number; raw: string }[]>();
  for (const p of parsed) {
    if (!p) continue;
    const arr = grouped.get(p.prefix) ?? [];
    arr.push({ num: p.num, width: p.width, raw: p.raw });
    grouped.set(p.prefix, arr);
  }
  for (const [prefix, list] of grouped) {
    list.sort((a, b) => a.num - b.num);
    let start = 0;
    for (let i = 1; i <= list.length; i++) {
      if (i === list.length || list[i].num !== list[i - 1].num + 1) {
        const a = list[start];
        const b = list[i - 1];
        ranges.push({
          from: `${prefix}${String(a.num).padStart(a.width, "0")}`,
          to: `${prefix}${String(b.num).padStart(b.width, "0")}`,
          totnum: b.num - a.num + 1,
        });
        start = i;
      }
    }
  }
  // Non-numeric invoice numbers → each as its own single-entry range
  for (const p of parsed) {
    if (p) continue;
  }
  nums.forEach((n, idx) => {
    if (!parsed[idx]) ranges.push({ from: n, to: n, totnum: 1 });
  });

  const docs = ranges.map((r, i) => ({
    num: i + 1,
    from: r.from,
    to: r.to,
    totnum: r.totnum,
    cancel: 0,
    net_issue: r.totnum,
  }));

  const fp = opts.filingPeriod || records.map((r) => fpFromDate(r.invoiceDate)).find((v): v is string => !!v) || "";
  return {
    gstin: opts.supplierGstin.trim().toUpperCase(),
    fp,
    version: "GST3.2.4",
    hash: "hash",
    doc_issue: {
      doc_det: [{ doc_num: 1, doc_typ: "Invoices for outward supply", docs }],
    },
  };
}

export function exportB2bJson(records: InvoiceRecord[], opts: JsonExportOptions) {
  const p = buildB2bJson(records, opts);
  downloadJson(p, `gstr1_b2b_${p.fp || "return"}.json`);
}
export function exportB2csJson(records: InvoiceRecord[], opts: JsonExportOptions) {
  const p = buildB2csJson(records, opts);
  downloadJson(p, `gstr1_b2cs_${p.fp || "return"}.json`);
}
export function exportHsnJson(records: InvoiceRecord[], opts: JsonExportOptions) {
  const p = buildHsnJson(records, opts);
  downloadJson(p, `gstr1_hsn_${p.fp || "return"}.json`);
}
export function exportDocsJson(records: InvoiceRecord[], opts: JsonExportOptions) {
  const p = buildDocsJson(records, opts);
  downloadJson(p, `gstr1_docs_${p.fp || "return"}.json`);
}
