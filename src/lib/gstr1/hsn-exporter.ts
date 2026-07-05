import type { InvoiceRecord } from "./parser";

/**
 * Export aggregated HSN summary as CSV matching the GSTR-1 offline utility
 * "hsn" section columns:
 *   HSN, Description, UQC, Total Quantity, Total Value, Taxable Value,
 *   Integrated Tax, Central Tax, State/UT Tax, Cess Amount, Rate
 * Rows are aggregated across all invoices by (HSN, Rate, UQC).
 */
const COLUMNS = [
  "HSN",
  "Description",
  "UQC",
  "Total Quantity",
  "Total Value",
  "Taxable Value",
  "Integrated Tax",
  "Central Tax",
  "State/UT Tax",
  "Cess Amount",
  "Rate",
] as const;

// GSTR-1 UQC list — value must be "CODE-FULLNAME" (e.g. "NOS-NUMBERS", "BAG-BAGS").
const UQC_FULL: Record<string, string> = {
  BAG: "BAG-BAGS", BAL: "BAL-BALE", BDL: "BDL-BUNDLES", BKL: "BKL-BUCKLES",
  BOU: "BOU-BILLIONS OF UNITS", BOX: "BOX-BOX", BTL: "BTL-BOTTLES",
  BUN: "BUN-BUNCHES", CAN: "CAN-CANS", CBM: "CBM-CUBIC METERS",
  CCM: "CCM-CUBIC CENTIMETERS", CMS: "CMS-CENTIMETERS", CTN: "CTN-CARTONS",
  DOZ: "DOZ-DOZENS", DRM: "DRM-DRUMS", GGK: "GGK-GREAT GROSS",
  GMS: "GMS-GRAMMES", GRS: "GRS-GROSS", GYD: "GYD-GROSS YARDS",
  KGS: "KGS-KILOGRAMS", KLR: "KLR-KILOLITRE", KME: "KME-KILOMETRE",
  LTR: "LTR-LITRES", MLT: "MLT-MILILITRE", MTR: "MTR-METERS",
  MTS: "MTS-METRIC TON", NOS: "NOS-NUMBERS", PAC: "PAC-PACKS",
  PCS: "PCS-PIECES", PRS: "PRS-PAIRS", QTL: "QTL-QUINTAL", ROL: "ROL-ROLLS",
  SET: "SET-SETS", SQF: "SQF-SQUARE FEET", SQM: "SQM-SQUARE METERS",
  SQY: "SQY-SQUARE YARDS", TBS: "TBS-TABLETS", TGM: "TGM-TEN GROSS",
  TAR: "TAR-TAR", THD: "THD-THOUSANDS", TON: "TON-TONNES", TUB: "TUB-TUBES",
  UGS: "UGS-US GALLONS", UNT: "UNT-UNITS", YDS: "YDS-YARDS", OTH: "OTH-OTHERS",
};

function normalizeUqc(raw: string): string {
  const t = (raw ?? "").trim().toUpperCase().replace(/[^A-Z]/g, "");
  if (!t) return UQC_FULL.OTH;
  const alias: Record<string, string> = {
    NO: "NOS", NOS: "NOS", NUMBER: "NOS", NUMBERS: "NOS",
    PC: "PCS", PCS: "PCS", PIECE: "PCS", PIECES: "PCS",
    KG: "KGS", KGS: "KGS", KILOGRAM: "KGS", KILOGRAMS: "KGS",
    MTR: "MTR", METER: "MTR", METRE: "MTR", MTRS: "MTR", METERS: "MTR", METRES: "MTR", M: "MTR",
    LTR: "LTR", LITRE: "LTR", LITER: "LTR", LITRES: "LTR", LITERS: "LTR", L: "LTR",
    ML: "MLT", MLT: "MLT",
    BAG: "BAG", BAGS: "BAG",
    BOX: "BOX", BOXES: "BOX",
    BOTTLE: "BTL", BOTTLES: "BTL", BTL: "BTL",
    SET: "SET", SETS: "SET",
    DOZ: "DOZ", DOZEN: "DOZ", DOZENS: "DOZ",
    PACK: "PAC", PACKS: "PAC", PKT: "PAC", PACKET: "PAC", PAC: "PAC",
    UNIT: "UNT", UNITS: "UNT", UNT: "UNT",
    TON: "TON", TONS: "TON", TONNE: "TON", TONNES: "TON",
    ROLL: "ROL", ROLLS: "ROL", ROL: "ROL",
    CTN: "CTN", CARTON: "CTN", CARTONS: "CTN",
    DRUM: "DRM", DRUMS: "DRM", DRM: "DRM",
    GRAM: "GMS", GRAMS: "GMS", GM: "GMS", GMS: "GMS", G: "GMS",
    SQF: "SQF", SQFT: "SQF", SQM: "SQM", SQMT: "SQM", SQY: "SQY", SQYD: "SQY",
    PR: "PRS", PRS: "PRS", PAIR: "PRS", PAIRS: "PRS",
  };
  const code = alias[t] ?? (UQC_FULL[t] ? t : "OTH");
  return UQC_FULL[code] ?? UQC_FULL.OTH;
}

function fmt(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "0";
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function exportHsnWorkbook(records: InvoiceRecord[]): void {
  interface Agg {
    hsn: string;
    description: string;
    uqc: string;
    rate: number;
    quantity: number;
    taxable: number;
    igst: number;
    cgst: number;
    sgst: number;
    cess: number;
  }
  const map = new Map<string, Agg>();

  for (const rec of records) {
    for (const h of rec.hsnItems ?? []) {
      const hsn = (h.hsn ?? "").replace(/\D/g, "");
      if (!hsn) continue;
      const uqc = normalizeUqc(h.uqc ?? "");
      const rate = Number(h.rate) || 0;
      const key = `${hsn}||${rate}||${uqc}`;
      let a = map.get(key);
      if (!a) {
        a = {
          hsn,
          description: (h.description ?? "").replace(/[\r\n]+/g, " ").trim(),
          uqc,
          rate,
          quantity: 0,
          taxable: 0,
          igst: 0,
          cgst: 0,
          sgst: 0,
          cess: 0,
        };
        map.set(key, a);
      }
      a.quantity += Number(h.quantity) || 0;
      a.taxable += Number(h.taxableValue) || 0;
      a.igst += Number(h.igst) || 0;
      a.cgst += Number(h.cgst) || 0;
      a.sgst += Number(h.sgst) || 0;
      a.cess += Number(h.cess) || 0;
      if (!a.description && h.description) a.description = h.description.trim();
    }
  }

  const rows: string[][] = [];
  for (const a of map.values()) {
    const totalValue = a.taxable + a.igst + a.cgst + a.sgst + a.cess;
    rows.push([
      a.hsn,
      a.description || a.hsn,
      a.uqc,
      fmt(a.quantity),
      fmt(totalValue),
      fmt(a.taxable),
      fmt(a.igst),
      fmt(a.cgst),
      fmt(a.sgst),
      fmt(a.cess),
      fmt(a.rate),
    ]);
  }

  const csv =
    [COLUMNS as unknown as string[], ...rows]
      .map((r) => r.map(csvCell).join(","))
      .join("\r\n") + "\r\n";

  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "hsn.csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
