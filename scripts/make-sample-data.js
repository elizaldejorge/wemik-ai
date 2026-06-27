/**
 * Wemik — Demo sample data generator
 * Creates a FAKE (synthetic) Qatari retail-banking portfolio for the showcase.
 * No real people, QIDs, IBANs, or accounts — all generated.
 *
 *   node scripts/make-sample-data.js
 *   → demo-data/qatar-retail-portfolio.xlsx
 */
import * as XLSX from "xlsx";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "..", "demo-data");

// Deterministic PRNG so the demo file is stable across runs.
let seed = 20260626;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }
function int(min, max) { return Math.floor(rnd() * (max - min + 1)) + min; }

const FIRST = ["Ahmed", "Mohammed", "Ali", "Khalid", "Hamad", "Jassim", "Fahad", "Nasser", "Youssef", "Omar",
  "Fatima", "Aisha", "Mariam", "Noora", "Hessa", "Sara", "Latifa", "Reem", "Maha", "Dana",
  "Rajesh", "Priya", "John", "Maria", "Mohan", "Sunita", "David", "Grace", "Imran", "Sofia"];
const LAST = ["Al-Thani", "Al-Kuwari", "Al-Marri", "Al-Sulaiti", "Al-Naimi", "Al-Mansoori", "Al-Emadi",
  "Khan", "Nair", "Fernandes", "Pereira", "Santos", "Rahman", "Hussain", "Mathew", "Costa"];
const PRODUCTS = ["Personal Loan", "Auto Loan", "Credit Card", "Home Finance", "Salary Advance"];
const BRANCHES = ["West Bay", "Al Sadd", "Doha City Center", "Lusail", "Al Rayyan", "The Pearl"];
const BANK_CODES = ["QNBA", "CBQA", "DOHB", "QIBK", "MARK"];

function qid() {
  // 11 digits, starts 2 or 3 (matches Wemik's QID detector)
  let s = pick(["2", "3"]);
  for (let i = 0; i < 10; i++) s += int(0, 9);
  return s;
}
function iban() {
  // QA + 2 check + 4-letter bank + 21 digits = looks like a real Qatari IBAN
  let s = "QA" + int(10, 99) + pick(BANK_CODES);
  for (let i = 0; i < 21; i++) s += int(0, 9);
  return s;
}
function phone() { return "+974 " + pick(["3", "5", "6", "7"]) + int(100, 999) + " " + int(1000, 9999); }

const rows = [];
const N = 42;
for (let i = 0; i < N; i++) {
  const name = `${pick(FIRST)} ${pick(LAST)}`;
  const salary = int(7000, 65000);
  // skew some customers into trouble for a meaningful risk split
  const stress = rnd();
  const debt = stress > 0.75 ? int(salary * 9, salary * 20)      // heavy
            : stress > 0.45 ? int(salary * 4, salary * 9)         // moderate
            : int(0, salary * 4);                                 // light
  const dpd = stress > 0.78 ? pick([90, 120, 150, 180])
           : stress > 0.5  ? pick([0, 30, 45, 60])
           : pick([0, 0, 0, 15]);
  rows.push({
    "Customer Name": name,
    "QID": qid(),
    "IBAN": iban(),
    "Mobile": phone(),
    "Product": pick(PRODUCTS),
    "Branch": pick(BRANCHES),
    "Monthly Salary (QAR)": salary,
    "Outstanding Loan (QAR)": debt,
    "Days Past Due": dpd,
  });
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const ws = XLSX.utils.json_to_sheet(rows);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, "Retail Portfolio");
const out = path.join(OUT_DIR, "qatar-retail-portfolio.xlsx");
XLSX.writeFile(wb, out);

// also a CSV twin for convenience
fs.writeFileSync(
  path.join(OUT_DIR, "qatar-retail-portfolio.csv"),
  XLSX.utils.sheet_to_csv(ws)
);

console.log(`✓ wrote ${N} synthetic customers → ${out}`);
console.log(`  columns: ${Object.keys(rows[0]).join(", ")}`);
