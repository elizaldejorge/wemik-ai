/**
 * ClawGuard - AutoFix Orchestrator
 * by elizaldejorge
 *
 * Single entry point for the autofix flow. Scans the skill, classifies each
 * finding, applies Tier 1 fixes (dry-run by default), prepares Tier 2 proposals
 * (disabled pending business sign-off), and flags Tier 3 for manual review.
 *
 * Used by:
 *   - /clawguard-autofix slash command in index.js
 *   - (future) dashboard "Review & Fix" drawer
 *   - (future) CLI
 */

import { scanAndSave } from "../scan.js";
import { resolveSkillPath } from "../resolveSkill.js";
import { bucketFindings } from "./classify.js";
import { applyFix } from "./tier1.js";
import { proposeFix } from "./tier2.js";
import { flagForReview } from "./tier3.js";
import db from "../db.js";

// Persist autofix runs so the dashboard can show history.
db.exec(`
  CREATE TABLE IF NOT EXISTS autofix_runs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id      INTEGER,
    skill_name   TEXT NOT NULL,
    dry_run      INTEGER NOT NULL,
    tier1_total  INTEGER NOT NULL,
    tier1_applied INTEGER NOT NULL,
    tier2_total  INTEGER NOT NULL,
    tier3_total  INTEGER NOT NULL,
    report       TEXT NOT NULL,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

/**
 * Run a full autofix pass against a skill.
 *
 * @param {string}   skillName
 * @param {object}   [options]
 * @param {boolean}  [options.dryRun=true]       If true, never writes to disk.
 * @param {boolean}  [options.skipScan=false]    If true, use options.findings instead of scanning.
 * @param {object[]} [options.findings]          Pre-existing findings to classify.
 * @param {string[]} [options.onlyReasons]       If set, apply ONLY Tier-1 fixes whose reason is in this list.
 *                                               Known reasons: cve-bump, pin-version, gitignore-secret-file, regen-lockfile.
 * @returns {Promise<object>} report
 */
export async function runAutofix(skillName, options = {}) {
  const dryRun       = options.dryRun !== false; // default true
  const skipScan     = options.skipScan === true;
  const onlyReasons  = Array.isArray(options.onlyReasons) && options.onlyReasons.length > 0
    ? new Set(options.onlyReasons)
    : null;

  // 1. Scan (unless caller already has findings)
  let scanResult = null;
  let findings = options.findings;
  if (!skipScan) {
    scanResult = await scanAndSave(skillName, { respectLists: false });
    if (scanResult.skipped) {
      return {
        skillName,
        dryRun,
        error: `Skipped: ${scanResult.skipped}`,
        scan: scanResult,
      };
    }
    findings = scanResult.findings;
  }
  if (!findings) findings = [];

  const skillPath = resolveSkillPath(skillName);
  if (!skillPath) {
    return { skillName, dryRun, error: "Could not resolve skill path" };
  }

  // 2. Classify findings into tiers
  const { tier1, tier2, tier3 } = bucketFindings(findings);

  // 3. Tier 1 — apply (or preview) deterministic fixes
  const tier1Results = [];
  for (const f of tier1) {
    // If caller passed onlyReasons, skip Tier-1 fixes whose reason is not in the allowlist.
    const expectedReason = f._fixReason;
    if (onlyReasons && !onlyReasons.has(expectedReason)) {
      tier1Results.push({
        finding: summarizeFinding(f),
        applied: false,
        reason: expectedReason,
        changed: [],
        error: `Skipped: reason '${expectedReason}' not in filter [${[...onlyReasons].join(", ")}]`,
      });
      continue;
    }
    const result = await applyFix(f, skillPath, { dryRun });
    tier1Results.push({ finding: summarizeFinding(f), ...result });
  }

  // 4. Tier 2 — stub proposals (will be AI-drafted once enabled)
  const tier2Results = [];
  for (const f of tier2) {
    const proposal = await proposeFix(f, skillPath, { dryRun: true });
    tier2Results.push({ finding: summarizeFinding(f), ...proposal });
  }

  // 5. Tier 3 — flag only
  const tier3Results = tier3.map((f) => ({
    finding: summarizeFinding(f),
    ...flagForReview(f),
  }));

  const report = {
    skillName,
    skillPath,
    dryRun,
    scanId: scanResult?.scanId ?? null,
    counts: {
      tier1Total:   tier1.length,
      tier1Applied: tier1Results.filter((r) => r.applied).length,
      tier2Total:   tier2.length,
      tier3Total:   tier3.length,
    },
    tier1: tier1Results,
    tier2: tier2Results,
    tier3: tier3Results,
  };

  // 6. Persist run
  db.prepare(
    `INSERT INTO autofix_runs
       (scan_id, skill_name, dry_run, tier1_total, tier1_applied, tier2_total, tier3_total, report)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    report.scanId,
    skillName,
    dryRun ? 1 : 0,
    report.counts.tier1Total,
    report.counts.tier1Applied,
    report.counts.tier2Total,
    report.counts.tier3Total,
    JSON.stringify(report)
  );

  return report;
}

function summarizeFinding(f) {
  return {
    severity: f.severity,
    category: f.category,
    message:  f.message,
    detail:   f.detail,
    package:  f.package,
    fix:      f.fix,
  };
}

/**
 * Run autofix against every installed skill in ~/.openclaw/extensions/.
 * Used by /clawguard-fix-all-skills. Dry-run default, obviously.
 *
 * @param {object} [options]
 * @param {boolean}  [options.dryRun=true]
 * @param {string[]} [options.onlyReasons]
 * @returns {Promise<{
 *   skills:  object[],         // per-skill runAutofix reports
 *   totals:  {
 *     tier1Total: number,
 *     tier1Applied: number,
 *     tier2Total: number,
 *     tier3Total: number,
 *     errors: number,
 *   }
 * }>}
 */
export async function runAutofixAll(options = {}) {
  const fs   = await import("fs");
  const os   = await import("os");
  const path = await import("path");
  const extensionsDir = path.join(os.homedir(), ".openclaw", "extensions");

  if (!fs.existsSync(extensionsDir)) {
    return {
      skills: [],
      totals: { tier1Total: 0, tier1Applied: 0, tier2Total: 0, tier3Total: 0, errors: 0 },
      error:  `No extensions directory at ${extensionsDir}`,
    };
  }

  const entries = fs.readdirSync(extensionsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name);

  const results = [];
  const totals  = { tier1Total: 0, tier1Applied: 0, tier2Total: 0, tier3Total: 0, errors: 0 };

  for (const skill of entries) {
    try {
      const report = await runAutofix(skill, options);
      results.push(report);
      if (report.error) {
        totals.errors++;
      } else {
        totals.tier1Total   += report.counts.tier1Total;
        totals.tier1Applied += report.counts.tier1Applied;
        totals.tier2Total   += report.counts.tier2Total;
        totals.tier3Total   += report.counts.tier3Total;
      }
    } catch (err) {
      results.push({ skillName: skill, error: err.message });
      totals.errors++;
    }
  }

  return { skills: results, totals };
}
