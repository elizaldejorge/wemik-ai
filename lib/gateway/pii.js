/**
 * Wemik Gateway — Sensitive-Data Detection & Redaction
 * by Jorge Elizalde
 *
 * Deterministic, local detectors that find sensitive entities in a prompt,
 * redact them to typed placeholders ([QID_1], [PAN_1], ...), and can
 * re-identify them again INSIDE the perimeter. The raw values never leave
 * this process: the model only ever receives the redacted text, and the
 * audit log only stores masked values.
 *
 * This is intentionally rule-based (no network, no model) so it works fully
 * offline / air-gapped — the sovereignty promise the deck makes.
 */

// Sensitivity tiers (highest wins for the policy decision).
export const SENSITIVITY_RANK = { restricted: 3, confidential: 2, internal: 1 };

// Each detector: { type, class, sensitivity, re, validate?, label }
// `re` must be global. `validate(match)` optionally rejects false positives.
const DETECTORS = [
  {
    type: "PAN", cls: "payment-card", sensitivity: "restricted", label: "Payment card (PAN)",
    re: /\b(?:\d[ -]?){13,19}\b/g,
    validate: (m) => luhnValid(m.replace(/[ -]/g, "")) && m.replace(/\D/g, "").length >= 13,
  },
  {
    type: "QID", cls: "national-id", sensitivity: "restricted", label: "Qatar ID (QID)",
    re: /\b[23]\d{10}\b/g,
  },
  {
    type: "IBAN", cls: "bank-account", sensitivity: "restricted", label: "IBAN / bank account",
    re: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g,
    validate: (m) => /^(QA|AE|SA|BH|KW|OM|GB|DE|FR)/.test(m),
  },
  {
    type: "PASSPORT", cls: "national-id", sensitivity: "restricted", label: "Passport number",
    re: /\b[A-PR-WY][0-9]{7,8}\b/g,
  },
  {
    type: "SECRET", cls: "credential", sensitivity: "restricted", label: "API key / credential",
    re: /\b(?:sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
  },
  {
    type: "MRN", cls: "health", sensitivity: "restricted", label: "Medical record / diagnosis",
    re: /\b(?:MRN[:#]?\s*\d{5,}|diagnos(?:is|ed)\s+(?:with\s+)?[A-Za-z][A-Za-z\s'-]{2,40})/gi,
  },
  {
    type: "EMAIL", cls: "contact", sensitivity: "confidential", label: "Email address",
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    type: "PHONE", cls: "contact", sensitivity: "confidential", label: "Phone number",
    re: /(?:\+974[\s-]?)?\b\d{3,4}[\s-]?\d{4}\b|\+\d{1,3}[\s-]?(?:\d[\s-]?){6,12}\d/g,
    validate: (m) => m.replace(/\D/g, "").length >= 7,
  },
  {
    type: "NAME", cls: "identity", sensitivity: "confidential", label: "Person name",
    re: /\b(?:Mr|Mrs|Ms|Miss|Dr|Sheikh|Sheikha|Eng)\.?\s+[A-Z][a-z]+(?:[\s-][A-Z][a-z]+){0,3}|\b(?:[Cc]ustomer|[Pp]atient|[Cc]lient|[Aa]pplicant|[Mm]ember|[Cc]itizen)\s+([A-Z][a-z]+(?:[\s-][A-Z][a-z]+){1,3})/g,
  },
  {
    type: "DOB", cls: "identity", sensitivity: "confidential", label: "Date of birth",
    re: /\b(?:DOB|date of birth|born)\b[:\s]*\d{1,4}[\/.\-]\d{1,2}[\/.\-]\d{1,4}/gi,
  },
  {
    type: "ADDR", cls: "location", sensitivity: "confidential", label: "Street address",
    re: /\b(?:Villa|Building|Bldg|Apt|Apartment|Street|St\.|Zone|Flat)\s+[\w,\s-]{3,40}\b/gi,
  },
];

function luhnValid(num) {
  if (!/^\d+$/.test(num)) return false;
  let sum = 0, alt = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = num.charCodeAt(i) - 48;
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d; alt = !alt;
  }
  return sum % 10 === 0;
}

/** Mask a raw value for safe display / storage: keep last few chars only. */
export function maskValue(type, value) {
  const v = String(value);
  if (type === "EMAIL") {
    const [u, d] = v.split("@");
    return `${u.slice(0, 1)}${"•".repeat(Math.max(2, u.length - 1))}@${d || ""}`;
  }
  if (type === "NAME" || type === "ADDR" || type === "MRN" || type === "DOB") {
    return v.split(/\s+/).map((w) => (w.length > 1 ? w[0] + "•".repeat(w.length - 1) : w)).join(" ");
  }
  const tail = v.replace(/\s/g, "").slice(-3);
  return `${"•".repeat(4)}${tail}`;
}

/**
 * Detect sensitive entities. Returns non-overlapping matches, earliest first.
 * @returns {{type,cls,sensitivity,label,value,start,end}[]}
 */
export function detect(text) {
  const raw = [];
  for (const d of DETECTORS) {
    d.re.lastIndex = 0;
    let m;
    while ((m = d.re.exec(text)) !== null) {
      const value = (m[1] || m[0]).trim();
      if (!value) continue;
      const start = m.index + m[0].indexOf(value);
      if (d.validate && !d.validate(value)) continue;
      raw.push({ type: d.type, cls: d.cls, sensitivity: d.sensitivity, label: d.label, value, start, end: start + value.length });
    }
  }
  // Resolve overlaps: prefer the more sensitive / longer match.
  raw.sort((a, b) => a.start - b.start || (SENSITIVITY_RANK[b.sensitivity] - SENSITIVITY_RANK[a.sensitivity]) || (b.end - b.start) - (a.end - a.start));
  const chosen = [];
  let lastEnd = -1;
  for (const e of raw) {
    if (e.start >= lastEnd) { chosen.push(e); lastEnd = e.end; }
  }
  return chosen;
}

/**
 * Redact text. Returns the redacted string plus a re-identification map
 * (placeholder -> entity). Identical values share one placeholder.
 * @returns {{redacted, entities, map}}
 */
export function redact(text) {
  const entities = detect(text);
  const counters = {};
  const valueToPlaceholder = new Map();
  const map = {};
  const out = [];
  let cursor = 0;

  for (const e of entities) {
    out.push(text.slice(cursor, e.start));
    let placeholder = valueToPlaceholder.get(`${e.type}:${e.value}`);
    if (!placeholder) {
      counters[e.type] = (counters[e.type] || 0) + 1;
      placeholder = `[${e.type}_${counters[e.type]}]`;
      valueToPlaceholder.set(`${e.type}:${e.value}`, placeholder);
      map[placeholder] = {
        type: e.type, cls: e.cls, sensitivity: e.sensitivity, label: e.label,
        value: e.value, masked: maskValue(e.type, e.value),
      };
    }
    out.push(placeholder);
    cursor = e.end;
  }
  out.push(text.slice(cursor));

  // entity summary (no raw values — safe to persist / show in audit)
  const summary = Object.entries(map).map(([placeholder, v]) => ({
    placeholder, type: v.type, cls: v.cls, sensitivity: v.sensitivity, label: v.label, masked: v.masked,
  }));

  return { redacted: out.join(""), entities: summary, map };
}

/** Re-identify placeholders back to raw values — LOCAL display only. */
export function reidentify(text, map) {
  let out = String(text || "");
  for (const [placeholder, v] of Object.entries(map || {})) {
    out = out.split(placeholder).join(v.value);
  }
  return out;
}

/** Highest sensitivity tier present in an entity summary. */
export function topSensitivity(summary = []) {
  let top = null, rank = 0;
  for (const e of summary) {
    const r = SENSITIVITY_RANK[e.sensitivity] || 0;
    if (r > rank) { rank = r; top = e.sensitivity; }
  }
  return top; // null | 'internal' | 'confidential' | 'restricted'
}

export default { detect, redact, reidentify, maskValue, topSensitivity, SENSITIVITY_RANK };
