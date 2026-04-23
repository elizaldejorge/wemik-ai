/**
 * ClawGuard - Static Scanner
 * by elizaldejorge
 * 
 * Scans skill source code for:
 * - Hardcoded secrets & API keys
 * - Dangerous code patterns
 * - Obfuscation techniques
 * - Suspicious network calls
 */

import fs from "fs";
import path from "path";
import { resolveSkillPath } from "../lib/resolveSkill.js";

// ─── SECRET PATTERNS ──────────────────────────────────────────────────────────
const SECRET_PATTERNS = [
  { pattern: /sk-[a-zA-Z0-9]{32,}/, message: "OpenAI API key detected", severity: "critical" },
  { pattern: /ghp_[a-zA-Z0-9]{36}/, message: "GitHub personal access token detected", severity: "critical" },
  { pattern: /AKIA[0-9A-Z]{16}/, message: "AWS Access Key ID detected", severity: "critical" },
  { pattern: /Bearer\s+[a-zA-Z0-9\-._~+/]+=*/, message: "Hardcoded Bearer token detected", severity: "critical" },
  { pattern: /password\s*=\s*['"][^'"]{4,}['"]/i, message: "Hardcoded password detected", severity: "critical" },
  { pattern: /secret\s*=\s*['"][^'"]{4,}['"]/i, message: "Hardcoded secret value detected", severity: "high" },
  { pattern: /api[_-]?key\s*=\s*['"][^'"]{8,}['"]/i, message: "Hardcoded API key detected", severity: "critical" },
  { pattern: /private[_-]?key\s*=\s*['"][^'"]{8,}['"]/i, message: "Hardcoded private key detected", severity: "critical" },
  { pattern: /token\s*=\s*['"][a-zA-Z0-9\-._~+/]{16,}['"]/i, message: "Hardcoded token detected", severity: "high" },
];

// ─── DANGEROUS CODE PATTERNS ──────────────────────────────────────────────────
const DANGEROUS_PATTERNS = [
  { pattern: /eval\s*\(/, message: "Dynamic code execution via eval()", severity: "critical" },
  { pattern: /new\s+Function\s*\(/, message: "Dynamic function construction detected", severity: "critical" },
  { pattern: /child_process/, message: "Shell/process spawning capability detected", severity: "high" },
  { pattern: /execSync\s*\(/, message: "Synchronous shell execution detected", severity: "high" },
  { pattern: /exec\s*\(/, message: "exec() call — possible shell execution", severity: "high" },
  { pattern: /spawn\s*\(/, message: "Process spawning detected", severity: "high" },
  { pattern: /require\s*\(\s*['"]http/, message: "Remote code loading via require()", severity: "critical" },
  { pattern: /import\s*\(\s*['"]http/, message: "Remote code loading via dynamic import()", severity: "critical" },
  { pattern: /fs\.(writeFile|appendFile|unlink|rmdir|rm)\s*\(/, message: "File system write/delete operation detected", severity: "medium" },
  { pattern: /process\.env/, message: "Accessing environment variables", severity: "low" },
  { pattern: /os\.(homedir|tmpdir)\s*\(/, message: "Accessing system directories", severity: "low" },
  { pattern: /setTimeout\s*\(\s*[^,]+,\s*[0-9]{6,}\)/, message: "Long delayed execution — possible time bomb", severity: "high" },
  { pattern: /while\s*\(\s*true\s*\)/, message: "Infinite loop detected", severity: "high" },
  { pattern: /\.download\s*\(/, message: "File download capability detected", severity: "medium" },
];

// ─── OBFUSCATION PATTERNS ─────────────────────────────────────────────────────
const OBFUSCATION_PATTERNS = [
  { pattern: /\\x[0-9a-fA-F]{2}/, message: "Hex-encoded characters — possible obfuscation", severity: "medium" },
  { pattern: /(_0x[a-f0-9]{4,}|_0X[a-f0-9]{4,})/, message: "Obfuscated variable names detected", severity: "high" },
  { pattern: /[a-zA-Z0-9+/]{200,}={0,2}/, message: "Long base64-like string — possible encoded payload", severity: "medium" },
  { pattern: /Buffer\.from\s*\([^)]+,\s*['"]base64['"]\)/, message: "Base64 decoding — possible obfuscation", severity: "medium" },
  { pattern: /atob\s*\(/, message: "Base64 decode (atob) detected", severity: "low" },
];

// ─── SCANNER ──────────────────────────────────────────────────────────────────
export class StaticScanner {
  static async scan(skillName) {
    const findings = [];

    const skillPath = StaticScanner.resolveSkillPath(skillName);
    if (!skillPath) {
      findings.push({
        severity: "medium",
        message: `Could not locate source for skill: ${skillName}`,
        detail: "Manual review recommended before installing.",
        category: "access",
      });
      return findings;
    }

    const files = StaticScanner.getJSFiles(skillPath);

    for (const file of files) {
      let content;
      try {
        content = fs.readFileSync(file, "utf-8");
      } catch {
        continue;
      }

      const lines = content.split("\n");
      const allPatterns = [...SECRET_PATTERNS, ...DANGEROUS_PATTERNS, ...OBFUSCATION_PATTERNS];

      for (const { pattern, message, severity } of allPatterns) {
        lines.forEach((line, index) => {
          // Skip comments
          const trimmed = line.trim();
          if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;

          if (pattern.test(line)) {
            findings.push({
              severity,
              message,
              detail: `File: ${path.relative(skillPath, file)}`,
              line: index + 1,
              snippet: trimmed.substring(0, 100),
              category: SECRET_PATTERNS.includes({ pattern, message, severity })
                ? "secrets"
                : DANGEROUS_PATTERNS.includes({ pattern, message, severity })
                ? "dangerous-code"
                : "obfuscation",
            });
          }
        });
      }
    }

    return findings;
  }

  // Resolve where the skill lives on disk (shared resolver — see lib/resolveSkill.js)
  static resolveSkillPath(skillName) {
    return resolveSkillPath(skillName);
  }

  // Recursively get all JS/TS files; skips common build/vendor dirs.
  // Supports: .js .mjs .cjs .ts .tsx (.tsx added per CLAUDE.md rule #6)
  static getJSFiles(dir) {
    const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next"]);
    const results = [];
    const walk = (d) => {
      if (!fs.existsSync(d)) return;
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
          walk(full);
        } else if (entry.isFile() && /\.(js|mjs|cjs|ts|tsx)$/.test(entry.name)) {
          results.push(full);
        }
      }
    };
    walk(dir);
    return results;
  }
}