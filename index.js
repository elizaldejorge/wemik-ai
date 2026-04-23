/**
 * ClawGuard - Main Entry Point
 * by elizaldejorge
 *
 * Security auditor for OpenClaw skills
 * Scans for malware, secrets, CVEs, and suspicious behavior
 * before they run on your system.
 *
 * Commands:
 *   /clawguard-scan [skill]       Full security audit
 *   /clawguard-status             Last scan summary
 *   /clawguard-report [skill]     Full findings breakdown
 *   /clawguard-history            Last 10 scans
 *   /clawguard-block [skill]      Add to blocklist
 *   /clawguard-whitelist [skill]  Add to whitelist
 *   /clawguard-digest             24h security summary
 *   /clawguard-dashboard          Open dashboard in browser
 */

import chalk from "chalk";

import db              from "./lib/db.js";
import { scanAndSave } from "./lib/scan.js";
import { startDashboard } from "./dashboard/server.js";

function getRiskColor(score) {
  if (score >= 70) return chalk.red;
  if (score >= 40) return chalk.yellow;
  return chalk.green;
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