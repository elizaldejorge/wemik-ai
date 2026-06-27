/**
 * Wemik — Secure File Ingestion (the bank-portfolio demo)
 * by Jorge Elizalde
 *
 * The showcase flow:
 *   1. A bank uploads a spreadsheet (or PDF) of customers with sensitive data.
 *   2. Wemik redacts the IDENTITY columns LOCALLY (name, QID, IBAN, card, phone…),
 *      keeping the FINANCIAL figures (salary, loan, days-past-due) so the model can
 *      reason on the numbers — but never learns *who* anyone is.
 *   3. Only the redacted rows are sent to the model with the user's instruction
 *      ("group by debt risk and summarise").
 *   4. The model's answer (still using placeholders) is RE-IDENTIFIED locally.
 *   5. A reorganised Excel is produced with the real names restored on-device.
 *
 * Nothing identifying ever leaves the machine. Works offline (deterministic
 * fallback grouping) so the demo never hard-fails on camera.
 */

import * as XLSX from "xlsx";
import { maskValue } from "../gateway/pii.js";
import { generateChat } from "./models.js";

// ─── Column classification ────────────────────────────────────────────────────
// Header keyword → sensitive identity type. Matched case-insensitively, EN + AR.
const SENSITIVE_HEADERS = [
  { type: "NAME",     label: "Customer name",   keys: ["name", "customer", "client", "full name", "الاسم", "العميل"] },
  { type: "QID",      label: "Qatar ID (QID)",  keys: ["qid", "qatar id", "national id", "id no", "id number", "البطاقة", "الرقم الشخصي"] },
  { type: "IBAN",     label: "IBAN / account",  keys: ["iban", "account", "acct", "account no", "account number", "رقم الحساب"] },
  { type: "PAN",      label: "Card number",     keys: ["card", "pan", "card no", "card number", "البطاقة الائتمانية"] },
  { type: "EMAIL",    label: "Email",           keys: ["email", "e-mail", "mail", "بريد"] },
  { type: "PHONE",    label: "Phone",           keys: ["phone", "mobile", "tel", "contact no", "هاتف", "جوال"] },
  { type: "PASSPORT", label: "Passport",        keys: ["passport", "جواز"] },
  { type: "ADDR",     label: "Address",         keys: ["address", "villa", "zone", "street", "عنوان"] },
  { type: "DOB",      label: "Date of birth",   keys: ["dob", "date of birth", "birth", "الميلاد"] },
];

// Numeric financial columns used by the offline fallback grouping.
const FINANCIAL_HINTS = {
  daysPastDue: ["days past due", "dpd", "overdue", "days overdue", "past due"],
  debt:        ["outstanding", "loan", "debt", "balance", "exposure", "owed", "principal"],
  income:      ["salary", "income", "monthly salary", "wage"],
};

function normHeader(h) { return String(h ?? "").trim().toLowerCase(); }

function classifyHeader(header) {
  const h = normHeader(header);
  if (!h) return null;
  for (const s of SENSITIVE_HEADERS) {
    if (s.keys.some((k) => h === k || h.includes(k))) return s;
  }
  return null;
}

function matchHint(headers, hintList) {
  for (const header of headers) {
    const h = normHeader(header);
    if (hintList.some((k) => h.includes(k))) return header;
  }
  return null;
}

function toNumber(v) {
  if (v == null) return 0;
  const n = Number(String(v).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

// ─── Parsing ──────────────────────────────────────────────────────────────────
/** Parse xlsx/csv buffer → { headers, rows }. */
function parseTable(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  const headers = rows.length
    ? Object.keys(rows[0])
    : (XLSX.utils.sheet_to_json(sheet, { header: 1 })[0] || []);
  return { headers, rows };
}

// ─── Redaction (by identity column) ───────────────────────────────────────────
function redactTable(headers, rows) {
  const colType = {};
  for (const h of headers) { const t = classifyHeader(h); if (t) colType[h] = t; }

  const counters = {};
  const valueToPlaceholder = new Map();
  const vault = {}; // placeholder -> { type, label, value, masked }

  const redactedRows = rows.map((row) => {
    const out = {};
    for (const h of headers) {
      const t = colType[h];
      const cell = row[h];
      if (t && cell !== "" && cell != null) {
        const key = `${t.type}:${cell}`;
        let placeholder = valueToPlaceholder.get(key);
        if (!placeholder) {
          counters[t.type] = (counters[t.type] || 0) + 1;
          placeholder = `[${t.type}_${counters[t.type]}]`;
          valueToPlaceholder.set(key, placeholder);
          vault[placeholder] = {
            type: t.type, label: t.label,
            value: String(cell), masked: maskValue(t.type, String(cell)),
          };
        }
        out[h] = placeholder;
      } else {
        out[h] = cell;
      }
    }
    return out;
  });

  return { redactedRows, vault, sensitiveCols: Object.keys(colType), colType };
}

function reidentifyText(text, vault) {
  let out = String(text ?? "");
  // longest placeholder names first is unnecessary (they're [TYPE_n]); plain replace is safe
  for (const [placeholder, v] of Object.entries(vault)) {
    out = out.split(placeholder).join(v.value);
  }
  return out;
}

// ─── Model task: regroup the redacted rows ────────────────────────────────────
function rowsToCsv(headers, rows) {
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.map(esc).join(","), ...rows.map((r) => headers.map((h) => esc(r[h])).join(","))].join("\n");
}

function buildGroupingPrompt({ headers, redactedRows, instruction }) {
  const csv = rowsToCsv(headers, redactedRows);
  return [
    "You are a bank analyst assistant. Below is a customer table where IDENTITY",
    "values have been replaced with placeholders like [NAME_1], [QID_1], [IBAN_1].",
    "The financial figures are real. Do NOT guess or reconstruct any placeholder —",
    "keep them VERBATIM in your output so they can be restored locally.",
    "",
    `TABLE (CSV):\n${csv}`,
    "",
    `TASK: ${instruction || "Group these customers into Low / Medium / High credit-risk tiers based on days past due, outstanding loan and income. Summarise each tier."}`,
    "",
    "Respond with ONLY valid JSON, no prose, in this exact shape:",
    '{ "headline": "one sentence", "groups": [ { "tier": "High risk", "rule": "why these belong here", "members": ["[NAME_1]", "[NAME_4]"], "summary": "1-2 sentence summary" } ] }',
  ].join("\n");
}

function parseModelJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  // strip code fences
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const a = s.indexOf("{"); const b = s.lastIndexOf("}");
  if (a === -1 || b === -1 || b < a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

// ─── Deterministic fallback (offline, no model) ───────────────────────────────
function fallbackGrouping({ headers, redactedRows }) {
  const dpdCol = matchHint(headers, FINANCIAL_HINTS.daysPastDue);
  const debtCol = matchHint(headers, FINANCIAL_HINTS.debt);
  const incomeCol = matchHint(headers, FINANCIAL_HINTS.income);
  const nameCol = headers.find((h) => classifyHeader(h)?.type === "NAME");

  const tiers = { "High risk": [], "Medium risk": [], "Low risk": [] };
  for (const r of redactedRows) {
    const dpd = dpdCol ? toNumber(r[dpdCol]) : 0;
    const debt = debtCol ? toNumber(r[debtCol]) : 0;
    const income = incomeCol ? toNumber(r[incomeCol]) : 0;
    const dti = income > 0 ? debt / (income * 12) : (debt > 0 ? 99 : 0);
    let tier = "Low risk";
    if (dpd >= 90 || dti >= 0.6) tier = "High risk";
    else if (dpd >= 30 || dti >= 0.35) tier = "Medium risk";
    tiers[tier].push(nameCol ? r[nameCol] : (r[headers[0]] ?? ""));
  }
  const rule = {
    "High risk": "90+ days past due, or debt-to-annual-income ≥ 0.6",
    "Medium risk": "30–89 days past due, or debt-to-annual-income 0.35–0.6",
    "Low risk": "current, or low debt-to-income",
  };
  const groups = Object.entries(tiers)
    .filter(([, m]) => m.length)
    .map(([tier, members]) => ({
      tier, rule: rule[tier], members,
      summary: `${members.length} customer(s) in this tier.`,
    }));
  return { headline: "Customers grouped into credit-risk tiers by days-past-due and debt-to-income.", groups };
}

// ─── Reorganise rows (real values restored locally, sorted by tier) ───────────
function enrichAndSort({ headers, rows, redactedRows, grouping, tierColName = "Risk Tier" }) {
  const placeholderTier = {};
  for (const g of grouping.groups || []) {
    for (const m of g.members || []) placeholderTier[String(m).trim()] = g.tier;
  }
  const nameHeader = headers.find((h) => classifyHeader(h)?.type === "NAME");
  const tierRank = { "High risk": 0, "Medium risk": 1, "Low risk": 2 };

  const enriched = rows.map((row, i) => {
    const redacted = redactedRows[i] || {};
    const namePlaceholder = nameHeader ? String(redacted[nameHeader] ?? "").trim() : "";
    const tier = placeholderTier[namePlaceholder] || "Unclassified";
    return { [tierColName]: tier, ...row };
  });
  enriched.sort((a, b) => (tierRank[a[tierColName]] ?? 9) - (tierRank[b[tierColName]] ?? 9));
  return { tierColName, headers: [tierColName, ...headers], rows: enriched };
}

function buildXlsxBase64({ headers, rows }) {
  const ws = XLSX.utils.json_to_sheet(rows, { header: headers });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Output");
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" })).toString("base64");
}

// masked privacy summary (safe to show)
function summariseVault(vault) {
  const byType = {};
  for (const v of Object.values(vault)) {
    byType[v.type] = byType[v.type] || { type: v.type, label: v.label, count: 0, sample: v.masked };
    byType[v.type].count++;
  }
  return Object.values(byType);
}

// Route the upload to a task based on the user's instruction.
function detectTask(instruction) {
  return /\b(draft|write|reply|respond|message|messages|reminder|letter|email|notice|outreach|correspond|notify)\b/i.test(String(instruction || ""))
    ? "draft" : "group";
}

// ─── Drafting mode: bilingual customer correspondence ─────────────────────────
function buildDraftPrompt({ headers, rows, instruction }) {
  const csv = rowsToCsv(headers, rows);
  return [
    "You are a bank customer-communications assistant. Below are customers whose",
    "identities are redacted as placeholders like [NAME_1], [IBAN_1], [QID_1].",
    "Keep every placeholder VERBATIM — never guess, translate, or expand them.",
    "",
    `CUSTOMERS (CSV):\n${csv}`,
    "",
    `TASK: ${instruction || "Draft a short, polite payment-reminder message for each customer."}`,
    "Write each message in BOTH English and Modern Standard Arabic. Keep it concise,",
    "professional and compliant; greet the customer using their [NAME_x] placeholder.",
    "",
    'Respond with ONLY valid JSON: { "drafts": [ { "id": "[NAME_1]", "en": "…", "ar": "…" } ] }',
  ].join("\n");
}

// Offline bilingual templates so the demo always produces letters.
function fallbackDrafts({ headers, rows }) {
  const nameCol = headers.find((h) => classifyHeader(h)?.type === "NAME");
  const dpdCol = matchHint(headers, FINANCIAL_HINTS.daysPastDue);
  const debtCol = matchHint(headers, FINANCIAL_HINTS.debt);
  return rows.map((r) => {
    const id = nameCol ? r[nameCol] : (r[headers[0]] ?? "[NAME_1]");
    const dpd = dpdCol ? toNumber(r[dpdCol]) : 0;
    const amt = debtCol ? toNumber(r[debtCol]).toLocaleString("en-US") : "";
    const en = `Dear ${id},\n\nThis is a courteous reminder that your account currently shows an outstanding balance of QAR ${amt}${dpd ? `, now ${dpd} days past due` : ""}. Kindly arrange payment at your earliest convenience, or contact us so we can discuss suitable options. Thank you for banking with us.`;
    const ar = `عزيزي ${id}،\n\nنذكّركم بلطف بوجود رصيد مستحق على حسابكم بقيمة ${amt} ريال قطري${dpd ? `، ومتأخر الآن ${dpd} يوماً` : ""}. نرجو منكم ترتيب السداد في أقرب وقت ممكن، أو التواصل معنا لمناقشة الخيارات المناسبة. شكراً لتعاملكم معنا.`;
    return { id, en, ar };
  });
}

async function draftMode({ headers, rows, redactedRows, vault, protectedCount, protectedByType, instruction, providerCfg, fileName }) {
  // Target overdue customers if a days-past-due column exists (you don't send a
  // payment reminder to someone who's current). Draft ALL of them.
  const dpdCol = matchHint(headers, FINANCIAL_HINTS.daysPastDue);
  let indices = rows.map((_, i) => i);
  let overdueOnly = false;
  if (dpdCol) {
    const overdue = indices.filter((i) => toNumber(redactedRows[i][dpdCol]) > 0);
    if (overdue.length) { indices = overdue; overdueOnly = true; }
  }
  indices = indices.slice(0, 500); // sanity bound only
  const target = indices.map((i) => redactedRows[i]);

  // Only call a remote model for a small batch (token limits / reliability);
  // otherwise — and offline by default — draft every one from compliant templates.
  let parsed = null, provider = "sovereign", model = "wemik-local", fellBack = false, note;
  if (target.length <= 12) {
    const prompt = buildDraftPrompt({ headers, rows: target, instruction });
    try {
      const gen = await generateChat([{ role: "user", content: prompt }], providerCfg);
      provider = gen.provider; model = gen.model; fellBack = Boolean(gen.fellBack); note = gen.note;
      parsed = parseModelJson(gen.text);
    } catch { parsed = null; }
  }

  let usedFallback = false;
  let drafts = parsed && Array.isArray(parsed.drafts) && parsed.drafts.length ? parsed.drafts : null;
  if (!drafts) { drafts = fallbackDrafts({ headers, rows: target }); usedFallback = true; }

  // Re-identify each draft locally → real names appear in the letters.
  const letters = drafts.map((d) => ({
    name: reidentifyText(d.id || d.name || "", vault) || "Customer",
    en: reidentifyText(d.en || "", vault),
    ar: reidentifyText(d.ar || "", vault),
  }));

  const dlRows = letters.map((l) => ({ "Customer": l.name, "Message (English)": l.en, "Message (Arabic)": l.ar }));
  const downloadXlsxBase64 = buildXlsxBase64({ headers: ["Customer", "Message (English)", "Message (Arabic)"], rows: dlRows });
  const sample = drafts[0] || {};

  return {
    ok: true,
    mode: "draft",
    fileName,
    rowCount: rows.length,
    draftedCount: letters.length,
    protectedCount,
    protectedByType,
    headline: `Drafted ${letters.length} bilingual ${/remind|overdue|collect|due/i.test(instruction) ? "payment reminder" : "message"}${letters.length === 1 ? "" : "s"}${overdueOnly ? " for every overdue account" : ""} — English and Arabic.`,
    letters,
    redactedPreview: `What the model saw (placeholders only):\n\nEN: ${sample.en || ""}\n\nAR: ${sample.ar || ""}`,
    instruction: instruction || "Draft bilingual messages for each customer.",
    provider, model,
    aiUsed: !usedFallback && !fellBack,
    note: usedFallback ? "Drafted on-device from compliant templates (no model configured)." : note,
    downloadFileName: fileName.replace(/\.[^.]+$/, "") + "-messages.xlsx",
    downloadXlsxBase64,
  };
}

// ─── Public entry ─────────────────────────────────────────────────────────────
/**
 * Process an uploaded portfolio file end-to-end.
 * @param {{buffer:Buffer, fileName:string, instruction:string, providerCfg?:object, actor?:string}} args
 */
export async function processPortfolio({ buffer, fileName = "upload.xlsx", instruction = "", providerCfg = {} } = {}) {
  if (!buffer || !buffer.length) return { ok: false, error: "Empty file" };

  let headers, rows;
  try {
    ({ headers, rows } = parseTable(buffer));
  } catch (err) {
    return { ok: false, error: `Could not parse file: ${err.message}` };
  }
  if (!rows.length) return { ok: false, error: "No rows found in the file." };

  // 1–2. Redact identity columns locally.
  const { redactedRows, vault, sensitiveCols, colType } = redactTable(headers, rows);
  const protectedCount = Object.keys(vault).length;
  const protectedByType = summariseVault(vault);

  // Route by intent: "draft/message/reminder…" → bilingual correspondence.
  if (detectTask(instruction) === "draft") {
    return await draftMode({ headers, rows, redactedRows, vault, protectedCount, protectedByType, instruction, providerCfg, fileName });
  }

  // 3. Ask the model to regroup the REDACTED rows.
  const prompt = buildGroupingPrompt({ headers, redactedRows, instruction });
  let grouping = null, provider = "sovereign", model = "wemik-local", fellBack = false, note;
  try {
    const gen = await generateChat([{ role: "user", content: prompt }], providerCfg);
    provider = gen.provider; model = gen.model; fellBack = Boolean(gen.fellBack); note = gen.note;
    grouping = parseModelJson(gen.text);
  } catch {
    grouping = null;
  }
  // 4. Deterministic fallback so the demo always produces a result.
  let usedFallback = false;
  if (!grouping || !Array.isArray(grouping.groups) || !grouping.groups.length) {
    grouping = fallbackGrouping({ headers, redactedRows });
    usedFallback = true;
  }

  // 5. Re-identify (names restored locally), sort rows, build the workbook + preview.
  const groupsReal = (grouping.groups || []).map((g) => ({
    tier: g.tier,
    rule: g.rule || "",
    summary: reidentifyText(g.summary || "", vault),
    members: (g.members || []).map((m) => reidentifyText(m, vault)),
    count: (g.members || []).length,
  }));
  const reorganised = enrichAndSort({ headers, rows, redactedRows, grouping });
  const downloadXlsxBase64 = buildXlsxBase64(reorganised);

  return {
    ok: true,
    mode: "group",
    fileName,
    rowCount: rows.length,
    columns: headers,
    sensitiveColumns: sensitiveCols,
    protectedCount,
    protectedByType,
    headline: reidentifyText(grouping.headline || "", vault),
    groups: groupsReal,
    // reorganised table (real values restored locally) for the right-side preview
    preview: { headers: reorganised.headers, rows: reorganised.rows, tierColumn: reorganised.tierColName },
    // "what the model saw" — redacted CSV (first rows for the proof panel)
    redactedPreview: rowsToCsv(headers, redactedRows.slice(0, 12)),
    instruction: instruction || "Group customers into credit-risk tiers and summarise each.",
    provider, model,
    aiUsed: !usedFallback && !fellBack,
    note: usedFallback ? "Grouped on-device with deterministic rules (no model configured)." : note,
    downloadFileName: fileName.replace(/\.[^.]+$/, "") + "-reorganised.xlsx",
    downloadXlsxBase64,
  };
}

export default { processPortfolio };
