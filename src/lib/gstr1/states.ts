// GSTIN state codes → State name (India)
export const STATE_CODES: Record<string, string> = {
  "01": "Jammu and Kashmir",
  "02": "Himachal Pradesh",
  "03": "Punjab",
  "04": "Chandigarh",
  "05": "Uttarakhand",
  "06": "Haryana",
  "07": "Delhi",
  "08": "Rajasthan",
  "09": "Uttar Pradesh",
  "10": "Bihar",
  "11": "Sikkim",
  "12": "Arunachal Pradesh",
  "13": "Nagaland",
  "14": "Manipur",
  "15": "Mizoram",
  "16": "Tripura",
  "17": "Meghalaya",
  "18": "Assam",
  "19": "West Bengal",
  "20": "Jharkhand",
  "21": "Odisha",
  "22": "Chhattisgarh",
  "23": "Madhya Pradesh",
  "24": "Gujarat",
  "25": "Daman & Diu",
  "26": "Dadra & Nagar Haveli",
  "27": "Maharashtra",
  "28": "Andhra Pradesh",
  "29": "Karnataka",
  "30": "Goa",
  "31": "Lakshadweep",
  "32": "Kerala",
  "33": "Tamil Nadu",
  "34": "Puducherry",
  "35": "Andaman & Nicobar Islands",
  "36": "Telangana",
  "37": "Andhra Pradesh",
  "38": "Ladakh",
  "97": "Other Territory",
  "99": "Centre Jurisdiction",
};

export const GSTIN_REGEX = /\b(\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d][Zz][A-Z\d])\b/;

export function stateFromGstin(gstin: string): string | null {
  const code = gstin?.slice(0, 2);
  return code ? STATE_CODES[code] ?? null : null;
}

/** Normalize any state string to "CC-State Name" (e.g. "37-Andhra Pradesh"). */
export function normalizePlaceOfSupply(input: string | null | undefined): string | null {
  if (!input) return null;
  const raw = input.trim();
  if (!raw) return null;
  // Already in "CC-Name" or "CC Name" form → normalize separator.
  const withCode = raw.match(/^(\d{1,2})\s*[-–.\s]\s*(.+)$/);
  if (withCode) {
    const code = withCode[1].padStart(2, "0");
    const name = STATE_CODES[code] ?? withCode[2].trim();
    return `${code}-${name}`;
  }
  // Plain state name → look up code.
  const norm = raw.toLowerCase().replace(/[^a-z]/g, "");
  for (const [code, name] of Object.entries(STATE_CODES)) {
    if (name.toLowerCase().replace(/[^a-z]/g, "") === norm) return `${code}-${name}`;
  }
  return raw;
}

export function isValidGstin(gstin: string): boolean {
  if (!gstin || gstin.length !== 15) return false;
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/.test(gstin)) return false;
  // Checksum validation
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = chars.indexOf(gstin[i]);
    if (v < 0) return false;
    const factor = i % 2 === 0 ? 1 : 2;
    const p = v * factor;
    sum += Math.floor(p / 36) + (p % 36);
  }
  const check = (36 - (sum % 36)) % 36;
  return chars[check] === gstin[14];
}
