/**
 * ClawGuard - Main Entry Point
 * by elizaldejorge
 *
 * Security auditor for OpenClaw skills
 * Scans for malware, secrets, CVEs, and suspicious behavior
 * before they run on your system.
 *
 * Commands:
 *   /clawguard-scan [skill]            Full security audit
 *   /clawguard-status                  Last scan summary
 *   /clawguard-report [skill]          Full findings breakdown
 *   /clawguard-history                 Last 10 scans
 *   /clawguard-block [skill]           Add to blocklist
 *   /clawguard-unblock [skill]         Remove from blocklist
 *   /clawguard-whitelist [skill]       Mark as trusted
 *   /clawguard-unwhitelist [skill]     Un-trust a whitelisted skill
 *   /clawguard-digest                  24h security summary
 *   /clawguard-dashboard               Open dashboard in browser
 *
 *   AutoFix family:
 *   /clawguard-preview [skill]         Alias of /clawguard-autofix — dry-run preview
 *   /clawguard-autofix [skill]         Dry-run preview of Tier-1 fixes
 *   /clawguard-autofix-apply [skill]   Actually apply all Tier-1 fixes
 *   /clawguard-fix-all [skill]         Same as autofix-apply (friendly alias)
 *   /clawguard-fix-cves [skill]        Apply only CVE bumps (safest subset)
 *   /clawguard-fix-secrets [skill]     Apply only gitignore-secret-file (zero-risk hygiene)
 *   /clawguard-fix-all-skills          Fix every installed skill (dry-run by default)
 *   /clawguard-rescan [skill]          Re-scan and show change vs. previous scan
 */

import chalk from "chalk";

import db              from "./lib/db.js";
import { scanAndSave } from "./lib/scan.js";
import { runAutofix, runAutofixAll } from "./lib/autofix/index.js";
import { startDashboard } from "./dashboard/server.js";

function getRiskColor(score) {
  if (score >= 70) return chalk.red;
  if (score >= 40) return chalk.yellow;
  return chalk.green;
}

// ─── AUTOFIX REPORT FORMATTER ──────────────────────────────────────────────────────────
function formatAutofixReport(r) {
  if (r.error) return `❌ AutoFix error for **${r.skillName}**: ${r.error}`;

  const mode = r.dryRun ? "🔍 DRY-RUN (no files modified)" : "✍️ APPLIED";
  let msg = `## 🛡️ ClawGuard AutoFix — ${r.skillName}\n`;
  msg += `**Mode:** ${mode}\n`;
  msg += `**Tier 1 (safe auto-fixes):** ${r.counts.tier1Applied}/${r.counts.tier1Total} applied\n`;
  msg += `**Tier 2 (AI-assisted):** ${r.counts.tier2Total} pending sign-off — see CONTEXT/AUTOFIX_DESIGN.md\n`;
  msg += `**Tier 3 (manual review):** ${r.counts.tier3Total} flagged\n\n`;

  if (r.tier1.length) {
    msg += `### ✅ Tier 1\n`;
    for (const t of r.tier1) {
      const icon = t.applied ? "✅" : "⏭️";
      msg += `- ${icon} **${t.reason}** — ${t.finding.message}\n`;
      if (t.changed?.length) msg += `   files: ${t.changed.join(", ")}\n`;
      if (t.diff)            msg += "```diff\n" + t.diff + "\n```\n";
      if (t.error)           msg += `   ⚠️ ${t.error}\n`;
    }
    msg += "\n";
  }

  if (r.tier2.length) {
    msg += `### 🤖 Tier 2 (pending Javier sign-off)\n`;
    for (const t of r.tier2) {
      msg += `- ⏳ **${t.reason || "tier2-disabled"}** — ${t.finding.message}\n`;
    }
    msg += "_See CONTEXT/AUTOFIX_DESIGN.md for the 5 business decisions blocking Tier 2._\n\n";
  }

  if (r.tier3.length) {
    msg += `### ⚠️ Tier 3 (manual review required)\n`;
    for (const t of r.tier3) {
      msg += `- 🚨 **${t.finding.category}** — ${t.finding.message}\n`;
      if (t.recommendation) msg += `   👉 ${t.recommendation}\n`;
    }
    msg += "\n";
  }

  if (r.dryRun && r.counts.tier1Total > 0) {
    msg += `_Run \`/clawguard-autofix-apply ${r.skillName}\` to actually apply Tier 1 fixes._\n`;
  }
  return msg;
}

function formatAutofixAllReport(r, apply) {
  if (r.error) return `❌ Fix-All-Skills error: ${r.error}`;
  const mode = apply ? "✍️ APPLIED" : "🔍 DRY-RUN (no files modified)";
  let msg = `## 🛠️ ClawGuard Fix-All-Skills\n`;
  msg += `**Mode:** ${mode}\n`;
  msg += `**Skills scanned:** ${r.skills.length}\n`;
  msg += `**Tier 1 total:** ${r.totals.tier1Applied}/${r.totals.tier1Total} applied\n`;
  msg += `**Tier 2 flagged (pending sign-off):** ${r.totals.tier2Total}\n`;
  msg += `**Tier 3 flagged (manual review):** ${r.totals.tier3Total}\n`;
  if (r.totals.errors) msg += `**Errors:** ${r.totals.errors}\n`;
  msg += "\n| Skill | Tier1 | Tier2 | Tier3 | Notes |\n|---|---|---|---|---|\n";
  for (const s of r.skills) {
    if (s.error) {
      msg += `| ${s.skillName || "?"} | — | — | — | ⚠️ ${s.error} |\n`;
      continue;
    }
    msg += `| ${s.skillName} | ${s.counts.tier1Applied}/${s.counts.tier1Total} | ${s.counts.tier2Total} | ${s.counts.tier3Total} |  |\n`;
  }
  if (!apply && r.totals.tier1Total > 0) {
    msg += `\n_Run \`/clawguard-fix-all-skills apply=true\` to actually apply the Tier-1 fixes._\n`;
  }
  msg += `\n_Full details in dashboard at http://localhost:3334_`;
  return msg;
}

function formatRescanDelta(skillName, prev, current) {
  if (current.skipped) {
    return `⏭️ Rescan skipped: ${skillName} is ${current.skipped}.`;
  }
  const prevScore = prev?.risk_score ?? null;
  const currScore = current.score;
  const delta = prevScore === null ? null : currScore - prevScore;

  let msg = `## 🔄 ClawGuard Rescan — ${skillName}\n`;
  msg += `**Current:** ${current.level} (${currScore}/100)\n`;
  if (prevScore === null) {
    msg += `_No previous scan to compare against._`;
    return msg;
  }
  msg += `**Previous:** ${prev.risk_level} (${prevScore}/100)\n`;
  if (delta === 0) {
    msg += `**Change:** no change.\n`;
  } else if (delta < 0) {
    msg += `**Change:** ✅ improved by ${-delta} points.\n`;
  } else {
    msg += `**Change:** ⚠️ worse by ${delta} points.\n`;
  }

  const prevFindings = JSON.parse(prev.findings || "[]");
  const key = (f) => `${f.message}│${f.detail || ""}`;
  const prevKeys = new Set(prevFindings.map(key));
  const currKeys = new Set(current.findings.map(key));

  const resolved = prevFindings.filter(f => !currKeys.has(key(f)));
  const newOnes  = current.findings.filter(f => !prevKeys.has(key(f)));

  if (resolved.length) {
    msg += `\n### ✅ Resolved since last scan\n`;
    resolved.slice(0, 10).forEach(f => { msg += `- ${f.message}${f.detail ? ` (${f.detail})` : ""}\n`; });
    if (resolved.length > 10) msg += `_…and ${resolved.length - 10} more._\n`;
  }
  if (newOnes.length) {
    msg += `\n### 🚨 New findings\n`;
    newOnes.slice(0, 10).forEach(f => { msg += `- ${f.message}${f.detail ? ` (${f.detail})` : ""}\n`; });
    if (newOnes.length > 10) msg += `_…and ${newOnes.length - 10} more._\n`;
  }
  return msg;
}

// ─── FULL SCAN ────────────────────────────────────────────────────────────────
async function runFullScan(skillName, reply) {
  reply(`🛡️ **ClawGuard** scanning **${skillName}**...\n_Running static analysis, CVE check, and permission audit..._`);

  try {
    const result = await scanAndSave(skillName);

    // Short-circuit: blocklist
    if (result.skipped === "blocked") {
      reply(`🚫 **${skillName}** is on your blocklist.\nReason: ${result.blockedReason || "No reason provided"}\nUse /clawguard-unblock ${skillName} to remove it.`);
      return;
    }

    // Short-circuit: whitelist
    if (result.skipped === "whitelisted") {
      reply(`✅ **${skillName}** is on your whitelist — marked as trusted. Skipping scan.\nUse /clawguard-unwhitelist ${skillName} to remove it.`);
      return;
    }

    const allFindings = result.findings;
    const score       = result.score;
    const level       = result.level;

    // Build report
    const critical = allFindings.filter(f => f.severity === "critical");
    const high     = allFindings.filter(f => f.severity === "high");
    const medium   = allFindings.filter(f => f.severity === "medium");
    const low      = allFindings.filter(f => f.severity === "low");

    let report = `## 🛡️ ClawGuard Scan Report\n`;
    report += `**Skill:** \`${skillName}\`\n`;
    report += `**Risk Score:** ${score}/100\n`;
    report += `**Risk Level:** ${level}\n\n`;

    report += `### 📊 Findings Summary\n`;
    report += `| Severity | Count |\n|---|---|\n`;
    report += `| 🔴 Critical | ${critical.length} |\n`;
    report += `| 🟠 High     | ${high.length} |\n`;
    report += `| 🟡 Medium   | ${medium.length} |\n`;
    report += `| 🔵 Low      | ${low.length} |\n`;
    report += `| **Total**   | **${allFindings.length}** |\n\n`;

    // Show critical and high findings in detail
    if (critical.length > 0) {
      report += `### 🔴 Critical Findings\n`;
      critical.forEach(f => {
        report += `- **${f.message}**\n  ${f.detail || ""}\n`;
        if (f.fix) report += `  ✅ ${f.fix}\n`;
        if (f.osvUrl) report += `  🔗 ${f.osvUrl}\n`;
      });
      report += "\n";
    }

    if (high.length > 0) {
      report += `### 🟠 High Findings\n`;
      high.forEach(f => {
        report += `- **${f.message}**\n  ${f.detail || ""}\n`;
        if (f.fix) report += `  ✅ ${f.fix}\n`;
      });
      report += "\n";
    }

    if (medium.length > 0) {
      report += `### 🟡 Medium Findings\n`;
      medium.forEach(f => {
        report += `- **${f.message}**\n  ${f.detail || ""}\n`;
      });
      report += "\n";
    }

    // Recommendation
    report += `### 💡 Recommendation\n`;
    if (score >= 70) {
      report += `⛔ **Do NOT install this skill.** Critical security issues detected.\n`;
      report += `Run \`/clawguard-block ${skillName}\` to prevent accidental installation.\n`;
    } else if (score >= 40) {
      report += `⚠️ **Proceed with caution.** Review the findings above before installing.\n`;
    } else {
      report += `✅ **Skill appears safe.** No major issues detected.\n`;
      report += `Run \`/clawguard-whitelist ${skillName}\` to mark it as trusted.\n`;
    }

    report += `\n_View full history at http://localhost:3334_`;

    reply(report);

  } catch (err) {
    reply(`❌ **ClawGuard scan failed:** ${err.message}`);
    console.error(chalk.red("[ClawGuard] Scan error:"), err);
  }
}

// ─── COMMAND HANDLERS ─────────────────────────────────────────────────────────
function handleStatus(reply) {
  const last = db.prepare(`SELECT * FROM scans ORDER BY scanned_at DESC LIMIT 1`).get();
  if (!last) {
    reply("🛡️ **ClawGuard** is active. No scans run yet.\nUse `/clawguard-scan [skill-name]` to start.");
    return;
  }
  const findings = JSON.parse(last.findings);
  const critical = findings.filter(f => f.severity === "critical").length;
  reply(
    `🛡️ **ClawGuard Status**\n` +
    `Last scan: **${last.skill_name}** — ${last.risk_level} (${last.risk_score}/100)\n` +
    `Critical findings: ${critical}\n` +
    `Scanned: ${new Date(last.scanned_at).toLocaleString()}\n` +
    `Dashboard: http://localhost:3334`
  );
}

function handleHistory(reply) {
  const scans = db.prepare(`SELECT * FROM scans ORDER BY scanned_at DESC LIMIT 10`).all();
  if (!scans.length) {
    reply("🛡️ No scan history yet. Run `/clawguard-scan [skill-name]` to start.");
    return;
  }
  let msg = `## 🛡️ ClawGuard — Last ${scans.length} Scans\n\n`;
  msg += `| Skill | Score | Level | Date |\n|---|---|---|---|\n`;
  scans.forEach(s => {
    msg += `| ${s.skill_name} | ${s.risk_score}/100 | ${s.risk_level} | ${new Date(s.scanned_at).toLocaleDateString()} |\n`;
  });
  reply(msg);
}

function handleBlock(skillName, reason, reply) {
  if (!skillName) { reply("Usage: `/clawguard-block [skill-name] [optional reason]`"); return; }
  try {
    db.prepare(`INSERT OR REPLACE INTO blocklist (skill_name, reason) VALUES (?, ?)`).run(skillName, reason || null);
    reply(`🚫 **${skillName}** has been added to your blocklist.\n${reason ? `Reason: ${reason}` : ""}`);
  } catch (err) {
    reply(`❌ Failed to block skill: ${err.message}`);
  }
}

function handleWhitelist(skillName, reply) {
  if (!skillName) { reply("Usage: `/clawguard-whitelist [skill-name]`"); return; }
  try {
    db.prepare(`INSERT OR REPLACE INTO whitelist (skill_name) VALUES (?)`).run(skillName);
    reply(`✅ **${skillName}** has been added to your whitelist as trusted.`);
  } catch (err) {
    reply(`❌ Failed to whitelist skill: ${err.message}`);
  }
}

function handleDigest(reply) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const scans = db.prepare(`SELECT * FROM scans WHERE scanned_at >= ? ORDER BY scanned_at DESC`).all(since);

  if (!scans.length) {
    reply("🛡️ **ClawGuard 24h Digest** — No scans in the last 24 hours.");
    return;
  }

  const dangerous = scans.filter(s => s.risk_score >= 70).length;
  const caution   = scans.filter(s => s.risk_score >= 40 && s.risk_score < 70).length;
  const safe      = scans.filter(s => s.risk_score < 40).length;

  let msg = `## 🛡️ ClawGuard — 24h Security Digest\n\n`;
  msg += `**Total scans:** ${scans.length}\n`;
  msg += `🔴 Dangerous: ${dangerous} | 🟡 Caution: ${caution} | 🟢 Safe: ${safe}\n\n`;

  if (dangerous > 0) {
    msg += `### ⛔ Dangerous Skills Detected\n`;
    scans.filter(s => s.risk_score >= 70).forEach(s => {
      msg += `- **${s.skill_name}** — Score: ${s.risk_score}/100\n`;
    });
  }

  msg += `\n_Full report at http://localhost:3334_`;
  reply(msg);
}

// ─── PLUGIN REGISTRATION ──────────────────────────────────────────────────────
export default {
  name: "clawguard",
  version: "1.0.0",
  description: "🛡️ Security auditor for OpenClaw skills",
  author: "elizaldejorge",

  async onLoad(plugin) {
    console.log(chalk.cyan("\n🛡️  ClawGuard v1.0.0 loaded"));
    console.log(chalk.gray("   Security auditor for OpenClaw skills\n"));

    // Start dashboard server
    await startDashboard(false); // false = don't auto-open browser on load

    // Register commands
    plugin.registerCommand({
      name: "clawguard-scan",
      description: "Run a full security audit on a skill",
      args: [{ name: "skill", required: true }],
      handler: async ({ args, reply }) => {
        await runFullScan(args.skill, reply);
      },
    });

    plugin.registerCommand({
      name: "clawguard-status",
      description: "Show last scan summary",
      handler: ({ reply }) => handleStatus(reply),
    });

    plugin.registerCommand({
      name: "clawguard-history",
      description: "Show last 10 scans",
      handler: ({ reply }) => handleHistory(reply),
    });

    plugin.registerCommand({
      name: "clawguard-block",
      description: "Add a skill to the blocklist",
      args: [{ name: "skill", required: true }, { name: "reason", required: false }],
      handler: ({ args, reply }) => handleBlock(args.skill, args.reason, reply),
    });

    plugin.registerCommand({
      name: "clawguard-whitelist",
      description: "Mark a skill as trusted",
      args: [{ name: "skill", required: true }],
      handler: ({ args, reply }) => handleWhitelist(args.skill, reply),
    });

    plugin.registerCommand({
      name: "clawguard-digest",
      description: "Show 24-hour security summary",
      handler: ({ reply }) => handleDigest(reply),
    });

    plugin.registerCommand({
      name: "clawguard-dashboard",
      description: "Open the ClawGuard dashboard in your browser",
      handler: async ({ reply }) => {
        const { open } = await import("open");
        await open("http://localhost:3334");
        reply("🛡️ Opening ClawGuard dashboard at http://localhost:3334");
      },
    });

    plugin.registerCommand({
      name: "clawguard-autofix",
      description: "Preview safe Tier-1 fixes for a skill (dry-run, no disk writes)",
      args: [{ name: "skill", required: true }],
      handler: async ({ args, reply }) => {
        reply(`🛡️ **ClawGuard AutoFix (dry-run)** scanning **${args.skill}**...`);
        try {
          const r = await runAutofix(args.skill, { dryRun: true });
          reply(formatAutofixReport(r));
        } catch (err) {
          reply(`❌ AutoFix failed: ${err.message}`);
        }
      },
    });

    plugin.registerCommand({
      name: "clawguard-autofix-apply",
      description: "Actually apply safe Tier-1 fixes to a skill (writes to disk)",
      args: [{ name: "skill", required: true }],
      handler: async ({ args, reply }) => {
        reply(`⚠️ **ClawGuard AutoFix (APPLY)** modifying **${args.skill}**...`);
        try {
          const r = await runAutofix(args.skill, { dryRun: false });
          reply(formatAutofixReport(r));
        } catch (err) {
          reply(`❌ AutoFix failed: ${err.message}`);
        }
      },
    });

    // Friendly alias: /clawguard-preview → dry-run preview (same as autofix)
    plugin.registerCommand({
      name: "clawguard-preview",
      description: "Preview what ClawGuard would fix on a skill (dry-run, no writes)",
      args: [{ name: "skill", required: true }],
      handler: async ({ args, reply }) => {
        reply(`🔍 **ClawGuard Preview** for **${args.skill}**...`);
        try {
          const r = await runAutofix(args.skill, { dryRun: true });
          reply(formatAutofixReport(r));
        } catch (err) {
          reply(`❌ Preview failed: ${err.message}`);
        }
      },
    });

    // Friendly alias: /clawguard-fix-all — apply every Tier-1 fix.
    plugin.registerCommand({
      name: "clawguard-fix-all",
      description: "Apply every safe Tier-1 fix to a skill (CVEs, pins, gitignore)",
      args: [{ name: "skill", required: true }],
      handler: async ({ args, reply }) => {
        reply(`🛠️ **ClawGuard Fix-All** modifying **${args.skill}**...`);
        try {
          const r = await runAutofix(args.skill, { dryRun: false });
          reply(formatAutofixReport(r));
        } catch (err) {
          reply(`❌ Fix-all failed: ${err.message}`);
        }
      },
    });

    // Apply ONLY CVE bumps — the highest-signal, safest fix.
    plugin.registerCommand({
      name: "clawguard-fix-cves",
      description: "Apply only CVE version bumps to a skill (other fixes skipped)",
      args: [{ name: "skill", required: true }],
      handler: async ({ args, reply }) => {
        reply(`💉 **ClawGuard Fix-CVEs** bumping vulnerable deps in **${args.skill}**...`);
        try {
          const r = await runAutofix(args.skill, { dryRun: false, onlyReasons: ["cve-bump"] });
          reply(formatAutofixReport(r));
        } catch (err) {
          reply(`❌ Fix-CVEs failed: ${err.message}`);
        }
      },
    });

    // Apply ONLY gitignore-secret-file — zero-risk hygiene fix.
    plugin.registerCommand({
      name: "clawguard-fix-secrets",
      description: "Add any detected bundled secret files to .gitignore (never deletes)",
      args: [{ name: "skill", required: true }],
      handler: async ({ args, reply }) => {
        reply(`🔒 **ClawGuard Fix-Secrets** hardening .gitignore for **${args.skill}**...`);
        try {
          const r = await runAutofix(args.skill, { dryRun: false, onlyReasons: ["gitignore-secret-file"] });
          reply(formatAutofixReport(r));
        } catch (err) {
          reply(`❌ Fix-Secrets failed: ${err.message}`);
        }
      },
    });

    // Fix every installed skill at once. Dry-run default.
    plugin.registerCommand({
      name: "clawguard-fix-all-skills",
      description: "Run AutoFix against every installed skill (dry-run by default). Pass apply=true to actually write.",
      args: [{ name: "apply", required: false }],
      handler: async ({ args, reply }) => {
        const apply = args.apply === "true" || args.apply === "1" || args.apply === "yes";
        reply(`🛰️ **ClawGuard Fix-All-Skills** ${apply ? "applying fixes" : "(dry-run)"} across all installed skills...`);
        try {
          const r = await runAutofixAll({ dryRun: !apply });
          reply(formatAutofixAllReport(r, apply));
        } catch (err) {
          reply(`❌ Fix-All-Skills failed: ${err.message}`);
        }
      },
    });

    // Re-scan and show delta vs. previous scan — "did the fix actually fix it?"
    plugin.registerCommand({
      name: "clawguard-rescan",
      description: "Re-scan a skill and show how findings changed vs. previous scan",
      args: [{ name: "skill", required: true }],
      handler: async ({ args, reply }) => {
        const prev = db
          .prepare(`SELECT risk_score, risk_level, findings FROM scans WHERE skill_name = ? ORDER BY scanned_at DESC LIMIT 1`)
          .get(args.skill);
        reply(`🔄 **ClawGuard Rescan** of **${args.skill}**...`);
        try {
          const result = await scanAndSave(args.skill, { respectLists: false });
          reply(formatRescanDelta(args.skill, prev, result));
        } catch (err) {
          reply(`❌ Rescan failed: ${err.message}`);
        }
      },
    });

    // Un-block and un-whitelist. These were referenced in error messages but didn't exist.
    plugin.registerCommand({
      name: "clawguard-unblock",
      description: "Remove a skill from the blocklist",
      args: [{ name: "skill", required: true }],
      handler: ({ args, reply }) => {
        const info = db.prepare(`DELETE FROM blocklist WHERE skill_name = ?`).run(args.skill);
        reply(info.changes > 0
          ? `✅ **${args.skill}** removed from blocklist.`
          : `ℹ️ **${args.skill}** was not on the blocklist.`);
      },
    });

    plugin.registerCommand({
      name: "clawguard-unwhitelist",
      description: "Remove a skill from the whitelist (it will be scanned again)",
      args: [{ name: "skill", required: true }],
      handler: ({ args, reply }) => {
        const info = db.prepare(`DELETE FROM whitelist WHERE skill_name = ?`).run(args.skill);
        reply(info.changes > 0
          ? `✅ **${args.skill}** removed from whitelist. It will be scanned again next time.`
          : `ℹ️ **${args.skill}** was not on the whitelist.`);
      },
    });

    plugin.registerCommand({
      name: "clawguard-report",
      description: "Show full findings for a skill",
      args: [{ name: "skill", required: false }],
      handler: ({ args, reply }) => {
        const scan = args.skill
          ? db.prepare(`SELECT * FROM scans WHERE skill_name = ? ORDER BY scanned_at DESC LIMIT 1`).get(args.skill)
          : db.prepare(`SELECT * FROM scans ORDER BY scanned_at DESC LIMIT 1`).get();

        if (!scan) {
          reply(`No scan found${args.skill ? ` for ${args.skill}` : ""}. Run /clawguard-scan first.`);
          return;
        }

        const findings = JSON.parse(scan.findings);
        let msg = `## 🛡️ Full Report — ${scan.skill_name}\n`;
        msg += `**Score:** ${scan.risk_score}/100 | **Level:** ${scan.risk_level}\n\n`;

        ["critical", "high", "medium", "low"].forEach(sev => {
          const group = findings.filter(f => f.severity === sev);
          if (!group.length) return;
          const icons = { critical: "🔴", high: "🟠", medium: "🟡", low: "🔵" };
          msg += `### ${icons[sev]} ${sev.charAt(0).toUpperCase() + sev.slice(1)} (${group.length})\n`;
          group.forEach(f => {
            msg += `- **${f.message}**\n  ${f.detail || ""}\n`;
            if (f.fix) msg += `  ✅ ${f.fix}\n`;
            if (f.osvUrl) msg += `  🔗 ${f.osvUrl}\n`;
          });
          msg += "\n";
        });

        reply(msg);
      },
    });
  },
};