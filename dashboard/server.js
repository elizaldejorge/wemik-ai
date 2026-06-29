/**
 * Wemik - Dashboard Server
 * by Jorge Elizalde
 *
 * Express server on http://localhost:3334 powering the Wemik secure AI chat app.
 * Binds to 127.0.0.1 only (never 0.0.0.0) so nothing leaves the machine.
 *
 * API surface:
 *   Auth:    GET /api/auth/status, POST /api/auth/login, POST /api/auth/logout,
 *            POST /api/auth/set-pin, POST /api/auth/clear-pin, GET /api/auth/me,
 *            GET /api/auth/sessions, POST /api/auth/sessions/:id/revoke,
 *            POST /api/auth/sessions/delegate
 *   Gateway: GET /api/gateway/samples|policy|requests|verify,
 *            POST /api/gateway/query, POST /api/gateway/requests/:id/approve|reject
 *   Chat:    GET/POST /api/chat/conversations, GET/DELETE /api/chat/conversations/:id,
 *            POST /api/chat/message, GET/POST /api/chat/provider
 *
 * Mutating endpoints require a valid session when a PIN is configured.
 * Read-only endpoints are always reachable so first-run is friction-free.
 */

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import open from "open";

import db from "../lib/db.js";
import { loadEnvFile } from "../lib/env.js";
import {
  isPinConfigured, setPin, clearPin, login, logout,
  requireAuth, requireRole, listSessions, revokeSession,
  mintDelegatedSession, ROLES,
} from "../lib/auth.js";
import gateway from "../lib/gateway/engine.js";
import gatewayPolicy from "../lib/gateway/policy.js";
import { SAMPLE_PROMPTS } from "../lib/gateway/samples.js";
import chat from "../lib/chat/engine.js";
import chatStore from "../lib/chat/store.js";
import chatSettings from "../lib/chat/settings.js";
import files from "../lib/chat/files.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");

loadEnvFile(path.join(ROOT_DIR, ".env"));

const app  = express();
const PORT = 3334;
const HOST = "127.0.0.1"; // localhost-only, never public

function getDB() { return db; }

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: "25mb" })); // generous so base64 file uploads fit

// Minimal cookie parser — avoids adding cookie-parser as a dep.
app.use((req, _res, next) => {
  req.cookies = {};
  const raw = req.headers?.cookie;
  if (raw) {
    for (const part of raw.split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k) req.cookies[k] = decodeURIComponent(v.join("="));
    }
  }
  next();
});

// index:false so "/" falls through to our chat-app route (not auto-served index.html).
app.use(express.static(path.join(__dirname), { index: false }));

// Restrictive CORS — localhost only, no credentials to third parties.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin",  "http://localhost:3334");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("X-Content-Type-Options", "nosniff");
  res.header("Referrer-Policy", "no-referrer");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

function actorLabel(req) {
  return req.session?.label ? `dashboard:${req.session.label}` : "dashboard";
}
function clientIp(req) {
  return (req.headers["x-forwarded-for"]?.toString().split(",")[0] || req.ip || "").trim();
}

// ─── STATUS ──────────────────────────────────────────────────────────────────
app.get("/api/status", (_req, res) => {
  res.json({
    status: "online",
    version: "1.3.0",
    pinConfigured: isPinConfigured(),
    timestamp: new Date().toISOString(),
  });
});

// ─── AUTH ────────────────────────────────────────────────────────────────────
// Auth status (no auth required — UI needs this to decide whether to show login)
app.get("/api/auth/status", (_req, res) => {
  res.json({ pinConfigured: isPinConfigured() });
});

// Login (public, rate-limited internally)
app.post("/api/auth/login", (req, res) => {
  const pin = req.body?.pin;
  const label = req.body?.label || "jorge";
  const r = login({
    pin, label,
    ip: clientIp(req),
    userAgent: req.headers["user-agent"] || null,
  });
  if (!r.ok) return res.status(r.locked ? 429 : 401).json({ error: r.error });
  res.json({ ok: true, token: r.token });
});

// Logout (needs a valid token to clear it)
app.post("/api/auth/logout", requireAuth, (req, res) => {
  const token = req.session?.token;
  logout(token, { actor: actorLabel(req), ip: clientIp(req), userAgent: req.headers["user-agent"] });
  res.json({ ok: true });
});

// Set PIN — allowed when no PIN exists (first-run) OR with a valid Admin session.
app.post("/api/auth/set-pin", (req, res, next) => {
  if (!isPinConfigured()) return next(); // first-run open
  // Configured: must be authenticated AND admin role.
  return requireAuth(req, res, (err) => {
    if (err) return next(err);
    return requireRole("admin")(req, res, next);
  });
}, (req, res) => {
  const r = setPin(req.body?.pin, { actor: actorLabel(req) });
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ ok: true });
});

app.post("/api/auth/clear-pin", requireAuth, requireRole("admin"), (req, res) => {
  clearPin({ actor: actorLabel(req) });
  res.json({ ok: true });
});

// Identity probe — returns current session's label + role for UI badges.
app.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({
    authMode:  req.authMode || "open",
    role:      req.role || "admin",
    label:     req.session?.label || null,
    expiresAt: req.session?.expires_at || null,
  });
});

app.get("/api/auth/sessions", requireAuth, requireRole("admin"), (_req, res) => res.json(listSessions()));

app.post("/api/auth/sessions/:id/revoke", requireAuth, requireRole("admin"), (req, res) => {
  const r = revokeSession(req.params.id, { actor: actorLabel(req) });
  if (!r.ok) return res.status(404).json({ error: r.error });
  res.json({ ok: true });
});

// Issue a role-scoped delegated session token. ADMIN ONLY.
// Returns the token EXACTLY ONCE — caller must persist it.
app.post("/api/auth/sessions/delegate", requireAuth, requireRole("admin"), (req, res) => {
  const role  = String(req.body?.role || "").trim();
  const label = (req.body?.label || "").toString().slice(0, 80);
  const ttlHours = Number(req.body?.ttlHours);
  if (!ROLES.includes(role)) {
    return res.status(400).json({ error: `Invalid role. One of: ${ROLES.join(", ")}` });
  }
  const r = mintDelegatedSession({
    role, label, ttlHours,
    actor: actorLabel(req),
    ip: clientIp(req),
    userAgent: req.headers?.["user-agent"] || null,
  });
  if (!r.ok) return res.status(400).json({ error: r.error });
  // Return token + metadata. UI is responsible for showing it once.
  res.json({ ok: true, token: r.token, role: r.role, expiresAt: r.expiresAt });
});

// ─── AUTH GATE ───────────────────────────────────────────────────────────────
// requireAuth here is a no-op when no PIN is configured (friction-free first-run).
app.use("/api", requireAuth);

// ─── WEMIK AI GATEWAY — sovereign control plane ("how it works" explainer) ────
// Pipeline: redact PII → classify → destination policy → RBAC → human approval
// → call model with REDACTED text only → tamper-evident hash-chained audit.
app.get("/api/gateway/samples", (_req, res) => res.json({ samples: SAMPLE_PROMPTS }));
app.get("/api/gateway/policy",  (_req, res) => res.json(gatewayPolicy.policyMatrix()));

app.get("/api/gateway/requests", requireRole("auditor"), (req, res) => {
  res.json({ requests: gateway.listRequests({ limit: clampInt(req.query.limit, 50, 1, 500) }) });
});
app.get("/api/gateway/verify", requireRole("auditor"), (_req, res) => res.json(gateway.verifyChain()));

// Submitting a prompt is an Operator+ action (Viewer/Auditor get a real 403).
app.post("/api/gateway/query", requireRole("operator"), async (req, res) => {
  try {
    const prompt      = String(req.body?.prompt || "");
    const destination = String(req.body?.destination || "sovereign-local");
    const out = await gateway.runGateway({ prompt, destination, actor: actorLabel(req), role: req.role });
    if (!out.ok) return res.status(400).json(out);
    res.json(out);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Approving / rejecting a held high-risk request is Admin-only.
app.post("/api/gateway/requests/:id/approve", requireRole("admin"), async (req, res) => {
  try {
    const out = await gateway.approveRequest(req.params.id, { approver: actorLabel(req) });
    res.status(out.ok ? 200 : 400).json(out);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post("/api/gateway/requests/:id/reject", requireRole("admin"), (req, res) => {
  const out = gateway.rejectRequest(req.params.id, { approver: actorLabel(req), notes: req.body?.notes });
  res.status(out.ok ? 200 : 400).json(out);
});

// ─── WEMIK CHAT — the secure AI chat app (the product) ───────────────────────
app.get("/api/chat/conversations", (_req, res) => res.json({ conversations: chatStore.listConversations({}) }));
app.post("/api/chat/conversations", (_req, res) => res.json({ conversation: chatStore.createConversation({}) }));
app.get("/api/chat/conversations/:id", (req, res) => {
  const view = chat.getConversationView(req.params.id);
  if (!view) return res.status(404).json({ error: "Not found" });
  res.json(view);
});
app.delete("/api/chat/conversations/:id", (req, res) => res.json(chatStore.deleteConversation(req.params.id)));

app.post("/api/chat/message", async (req, res) => {
  try {
    const out = await chat.sendMessage({
      conversationId: req.body?.conversationId ? Number(req.body.conversationId) : null,
      text: String(req.body?.text || ""),
      providerCfg: chatSettings.getProviderCfg(),
      actor: actorLabel(req),
    });
    res.status(out.ok ? 200 : 400).json(out);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Secure file upload — bank portfolio demo: redact identity columns locally,
// regroup the redacted rows via the model, restore real names on-device.
app.post("/api/chat/upload", async (req, res) => {
  try {
    const { fileBase64, fileName, instruction } = req.body || {};
    if (!fileBase64) return res.status(400).json({ error: "file required" });
    const out = await files.processPortfolio({
      buffer: Buffer.from(String(fileBase64), "base64"),
      fileName: String(fileName || "upload.xlsx"),
      instruction: String(instruction || ""),
      providerCfg: chatSettings.getProviderCfg(),
      actor: actorLabel(req),
    });
    res.status(out.ok ? 200 : 400).json(out);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Org-admin model settings (which provider/key powers Wemik).
app.get("/api/chat/provider", (_req, res) => res.json(chatSettings.getProviderPublic()));
app.post("/api/chat/provider", requireRole("admin"), (req, res) => {
  const out = chatSettings.setProvider(req.body || {});
  res.status(out.ok ? 200 : 400).json(out);
});

// ─── SERVE PAGES ─────────────────────────────────────────────────────────────
// Public marketing site.
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "landing.html"));
});
// The Wemik secure chat app.
app.get("/chat", (_req, res) => {
  res.sendFile(path.join(__dirname, "chat.html"));
});
// The "how it works" gateway explainer.
app.get("/gateway", (_req, res) => {
  res.sendFile(path.join(__dirname, "gateway.html"));
});

// Global error fallback (keeps stack traces out of responses)
app.use((err, _req, res, _next) => {
  console.error("[wemik:dashboard]", err);
  res.status(500).json({ error: "Internal server error" });
});

// ─── START SERVER ────────────────────────────────────────────────────────────
export function startDashboard(autoOpen = true) {
  return new Promise((resolve) => {
    app.listen(PORT, HOST, () => {
      console.log(`\nWemik running at http://localhost:${PORT} (127.0.0.1-only)\n`);
      if (autoOpen) {
        open(`http://localhost:${PORT}`).catch(() => {});
      }
      resolve(PORT);
    });
  });
}

export { app };

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  startDashboard(process.env.WEMIK_NO_AUTO_OPEN !== "1").catch((err) => {
    console.error("[wemik:dashboard]", err);
    process.exit(1);
  });
}

// ─── HELPERS ────────────────────────────────────────────────────────────────
function clampInt(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.floor(n), min), max);
}
