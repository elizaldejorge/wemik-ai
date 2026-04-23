/**
 * ClawGuard - Dashboard Server
 * by elizaldejorge
 *
 * Express server that powers the ClawGuard dashboard at localhost:3334
 * Serves scan history, findings, blocklist, and whitelist via REST API
 */

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import open from "open";

import db from "../lib/db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3334;

// Shared DB instance from lib/db.js — always resolves to repo_root/db/clawguard.db
// regardless of process.cwd(). This fixes a latent bug where running the
// dashboard from a different directory would open an empty, unrelated DB file.
function getDB() {
  return db;
}

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ─── CORS (for local dev) ─────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  next();
});

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// GET /api/status — server health check
app.get("/api/status", (req, res) => {
  res.json({
    status: "online",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
  });
});

// GET /api/scans — get all scan history (last 50)
app.get("/api/scans", (req, res) => {
  try {
    const scans = getDB()
      .prepare(
        `SELECT id, skill_name, risk_score, risk_level, scanned_at
         FROM scans
         ORDER BY scanned_at DESC
         LIMIT 50`
      )
      .all();
    res.json(scans);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/scans/:id — get full scan details including findings
app.get("/api/scans/:id", (req, res) => {
  try {
    const scan = getDB()
      .prepare(`SELECT * FROM scans WHERE id = ?`)
      .get(req.params.id);

    if (!scan) return res.status(404).json({ error: "Scan not found" });

    scan.findings = JSON.parse(scan.findings);
    res.json(scan);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/scans/skill/:name — get scan history for a specific skill
app.get("/api/scans/skill/:name", (req, res) => {
  try {
    const scans = getDB()
      .prepare(
        `SELECT * FROM scans
         WHERE skill_name = ?
         ORDER BY scanned_at DESC
         LIMIT 10`
      )
      .all(req.params.name);

    scans.forEach((s) => (s.findings = JSON.parse(s.findings)));
    res.json(scans);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats — dashboard summary stats
app.get("/api/stats", (req, res) => {
  try {
    const database = getDB();

    const totalScans = database
      .prepare(`SELECT COUNT(*) as count FROM scans`)
      .get().count;

    const dangerous = database
      .prepare(`SELECT COUNT(*) as count FROM scans WHERE risk_level LIKE '%DANGEROUS%'`)
      .get().count;

    const caution = database
      .prepare(`SELECT COUNT(*) as count FROM scans WHERE risk_level LIKE '%CAUTION%'`)
      .get().count;

    const safe = database
      .prepare(`SELECT COUNT(*) as count FROM scans WHERE risk_level LIKE '%SAFE%'`)
      .get().count;

    const blocklisted = database
      .prepare(`SELECT COUNT(*) as count FROM blocklist`)
      .get().count;

    const whitelisted = database
      .prepare(`SELECT COUNT(*) as count FROM whitelist`)
      .get().count;

    const lastScan = database
      .prepare(`SELECT skill_name, risk_score, risk_level, scanned_at FROM scans ORDER BY scanned_at DESC LIMIT 1`)
      .get();

    res.json({
      totalScans,
      dangerous,
      caution,
      safe,
      blocklisted,
      whitelisted,
      lastScan: lastScan || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/blocklist — get all blocked skills
app.get("/api/blocklist", (req, res) => {
  try {
    const blocked = getDB()
      .prepare(`SELECT * FROM blocklist ORDER BY blocked_at DESC`)
      .all();
    res.json(blocked);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/blocklist/:name — remove from blocklist
app.delete("/api/blocklist/:name", (req, res) => {
  try {
    getDB()
      .prepare(`DELETE FROM blocklist WHERE skill_name = ?`)
      .run(req.params.name);
    res.json({ success: true, message: `${req.params.name} removed from blocklist` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/whitelist — get all trusted skills
app.get("/api/whitelist", (req, res) => {
  try {
    const trusted = getDB()
      .prepare(`SELECT * FROM whitelist ORDER BY added_at DESC`)
      .all();
    res.json(trusted);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/whitelist/:name — remove from whitelist
app.delete("/api/whitelist/:name", (req, res) => {
  try {
    getDB()
      .prepare(`DELETE FROM whitelist WHERE skill_name = ?`)
      .run(req.params.name);
    res.json({ success: true, message: `${req.params.name} removed from whitelist` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/chart/severity — findings breakdown by severity for chart
app.get("/api/chart/severity", (req, res) => {
  try {
    const scans = getDB()
      .prepare(`SELECT findings FROM scans ORDER BY scanned_at DESC LIMIT 20`)
      .all();

    const counts = { critical: 0, high: 0, medium: 0, low: 0 };

    for (const scan of scans) {
      const findings = JSON.parse(scan.findings);
      for (const f of findings) {
        if (counts[f.severity] !== undefined) counts[f.severity]++;
      }
    }

    res.json(counts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/chart/timeline — scan scores over time for chart
app.get("/api/chart/timeline", (req, res) => {
  try {
    const scans = getDB()
      .prepare(
        `SELECT skill_name, risk_score, scanned_at
         FROM scans
         ORDER BY scanned_at DESC
         LIMIT 20`
      )
      .all();

    res.json(scans.reverse()); // chronological order
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SERVE DASHBOARD ──────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ─── START SERVER ─────────────────────────────────────────────────────────────
export function startDashboard(autoOpen = true) {
  return new Promise((resolve) => {
    app.listen(PORT, () => {
      console.log(`\n🛡️  ClawGuard Dashboard running at http://localhost:${PORT}\n`);
      if (autoOpen) {
        open(`http://localhost:${PORT}`).catch(() => {});
      }
      resolve(PORT);
    });
  });
}

export { app };