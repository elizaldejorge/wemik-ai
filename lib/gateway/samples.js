/**
 * Wemik Gateway — Demo Sample Prompts
 * by Jorge Elizalde
 *
 * Realistic-but-fake regulated-industry prompts for the Guided Demo. All
 * names, IDs, IBANs, cards and contacts are fabricated test data. The card
 * numbers are Luhn-valid test PANs; the QIDs/IBANs are syntactically shaped
 * but not real.
 */

export const SAMPLE_PROMPTS = [
  {
    id: "bank-dispute",
    sector: "Banking",
    title: "Card dispute",
    target: "sovereign-local",
    text: "Customer Ahmed Al-Thani (QID 28412345678) wants to dispute a QAR 12,500 charge on card 4111 1111 1111 1111. His IBAN is QA58DOHB00001234567890123456, phone +974 5512 3456, email ahmed.althani@example.qa. Draft a response.",
  },
  {
    id: "bank-loan",
    sector: "Banking",
    title: "Loan eligibility (external model)",
    target: "external-cloud",
    text: "Assess loan eligibility for customer Fatima Al-Kuwari (QID 29911223344), monthly income QAR 32,000, existing IBAN QA29QNBA00009876543210987654. Summarize the application.",
  },
  {
    id: "hospital-summary",
    sector: "Healthcare",
    title: "Patient note summary",
    target: "sovereign-local",
    text: "Summarize for patient Mariam Al-Sulaiti (MRN: 884512), DOB 1991-04-12, diagnosed with type 2 diabetes. Phone +974 6677 8899. Draft a follow-up appointment message.",
  },
  {
    id: "gov-credential",
    sector: "Government",
    title: "Credential leak (should be blocked)",
    target: "external-cloud",
    text: "Use this service token to fetch records for citizen Khalid Al-Marri: sk-9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a. Email khalid.marri@example.qa.",
  },
];

export default { SAMPLE_PROMPTS };
