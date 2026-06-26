/**
 * Wemik Gateway — Orchestrator
 * by Jorge Elizalde
 *
 * The control plane the deck describes. For every request it:
 *   1. detects + redacts sensitive data (lib/gateway/pii.js)
 *   2. classifies the data and applies destination policy (lib/gateway/policy.js)
 *   3. enforces RBAC at the route (lib/auth.js) — handled by the server
 *   4. holds high-risk requests for human approval
 *   5. calls the model with REDACTED text only (lib/gateway/providers.js)
 *   6. writes a hash-chained, tamper-evident audit record
 *
 * No raw sensitive values are ever persisted: the audit record stores only the
 * redacted prompt and MASKED entity metadata. Re-identification happens in the
 * caller's memory, inside the perimeter, and is never written to disk.
 */

import crypto from "crypto";
import db from "../db.js";
import { logAudit } from "../audit.js";
import { redact, reidentify, topSensitivity } from "./pii.js";
import { decide } from "./policy.js";
import { generate } from "./providers.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS gateway_requests (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    actor           TEXT,
    role            TEXT,
    destination     TEXT NOT NULL,
    provider        TEXT,
    model           TEXT,
    prompt_redacted TEXT NOT NULL,
    entities        TEXT NOT NULL,   -- JSON: masked summary, NO raw values
    classes         TEXT NOT NULL,   -- JSON array
    sensitivity     TEXT,
    decision        TEXT NOT NULL,   -- allow | require-approval | block
    status          TEXT NOT NULL,   -- completed | pending | blocked | rejected
    reason          TEXT,
    approver        TEXT,
    output_redacted TEXT,
    prev_hash       TEXT,
    hash            TEXT             -- set when the record is finalized (terminal)
  );
  CREATE INDEX IF NOT EXISTS idx_gateway_created ON gateway_requests(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_gateway_status  ON gateway_requests(status);
`);

const GENESIS = "0".repeat(64);

function sha256(s) { return crypto.createHash("sha256").update(s).digest("hex"); }

function canonical(row) {
  // The immutable facts a regulator audits. Order is fixed and explicit.
  return JSON.stringify({
    id: row.id, created_at: row.created_at, actor: row.actor, role: row.role,
    destination: row.destination, decision: row.decision, status: row.status,
    sensitivity: row.sensitivity, classes: JSON.parse(row.classes || "[]").slice().sort(),
    prompt_redacted: row.prompt_redacted, entities: row.entities,
    output_redacted: row.output_redacted || null, approver: row.approver || null,
    prev_hash: row.prev_hash || GENESIS,
  });
}

/** Compute & store the chained hash for a row that has reached a terminal state. */
function finalize(id) {
  const row = db.prepare(`SELECT * FROM gateway_requests WHERE id = ?`).get(id);
  if (!row) return null;
  const last = db.prepare(`SELECT hash FROM gateway_requests WHERE hash IS NOT NULL AND id < ? ORDER BY id DESC LIMIT 1`).get(id);
  const prev = last?.hash || GENESIS;
  const hash = sha256(canonical({ ...row, prev_hash: prev }));
  db.prepare(`UPDATE gateway_requests SET prev_hash = ?, hash = ? WHERE id = ?`).run(prev, hash, id);
  return { ...row, prev_hash: prev, hash };
}

function publicRow(row, { map } = {}) {
  if (!row) return null;
  const entities = JSON.parse(row.entities || "[]");
  const out = {
    id: row.id, createdAt: row.created_at, actor: row.actor, role: row.role,
    destination: row.destination, provider: row.provider, model: row.model,
    promptRedacted: row.prompt_redacted, entities,
    classes: JSON.parse(row.classes || "[]"), sensitivity: row.sensitivity,
    decision: row.decision, status: row.status, reason: row.reason,
    approver: row.approver, outputRedacted: row.output_redacted,
    hash: row.hash, prevHash: row.prev_hash,
  };
  // Re-identify for local display ONLY when the caller still holds the map.
  if (map) {
    out.outputClear = row.output_redacted ? reidentify(row.output_redacted, map) : null;
    out.promptClear = reidentify(row.prompt_redacted, map);
  }
  return out;
}

/**
 * Run a prompt through the gateway.
 * @param {object} args
 * @param {string} args.prompt
 * @param {'sovereign-local'|'external-cloud'} [args.destination]
 * @param {string} args.actor
 * @param {string} args.role
 * @returns {Promise<{ok, request, map, needsApproval?}>}
 */
export async function runGateway({ prompt, destination = "sovereign-local", actor = "operator", role = "operator" }) {
  const text = String(prompt || "").trim();
  if (!text) return { ok: false, error: "Empty prompt" };

  const { redacted, entities, map } = redact(text);
  const classes = [...new Set(entities.map((e) => e.cls))];
  const sensitivity = topSensitivity(entities);
  const verdict = decide({ destination, sensitivity, classes });

  const base = {
    actor, role, destination, prompt_redacted: redacted,
    entities: JSON.stringify(entities), classes: JSON.stringify(classes),
    sensitivity: sensitivity || null, decision: verdict.decision, reason: verdict.reason,
  };

  // BLOCK — never call the model.
  if (verdict.decision === "block") {
    const info = db.prepare(
      `INSERT INTO gateway_requests (actor, role, destination, prompt_redacted, entities, classes, sensitivity, decision, status, reason)
       VALUES (@actor,@role,@destination,@prompt_redacted,@entities,@classes,@sensitivity,@decision,'blocked',@reason)`
    ).run(base);
    const row = finalize(Number(info.lastInsertRowid));
    logAudit({ actor, action: "gateway-block", target: destination, meta: { id: row.id, classes, sensitivity, reason: verdict.reason } });
    return { ok: true, request: publicRow(row, { map }), map };
  }

  // REQUIRE-APPROVAL — record pending, do not call the model yet.
  if (verdict.decision === "require-approval") {
    const info = db.prepare(
      `INSERT INTO gateway_requests (actor, role, destination, prompt_redacted, entities, classes, sensitivity, decision, status, reason)
       VALUES (@actor,@role,@destination,@prompt_redacted,@entities,@classes,@sensitivity,@decision,'pending',@reason)`
    ).run(base);
    const row = db.prepare(`SELECT * FROM gateway_requests WHERE id = ?`).get(Number(info.lastInsertRowid));
    logAudit({ actor, action: "gateway-hold", target: destination, meta: { id: row.id, classes, sensitivity } });
    return { ok: true, needsApproval: true, request: publicRow(row, { map }), map };
  }

  // ALLOW — call the model with redacted text, then finalize.
  const gen = await generate(redacted, { destination });
  const info = db.prepare(
    `INSERT INTO gateway_requests (actor, role, destination, provider, model, prompt_redacted, entities, classes, sensitivity, decision, status, reason, output_redacted)
     VALUES (@actor,@role,@destination,@provider,@model,@prompt_redacted,@entities,@classes,@sensitivity,@decision,'completed',@reason,@output_redacted)`
  ).run({ ...base, provider: gen.provider, model: gen.model, output_redacted: gen.text });
  const row = finalize(Number(info.lastInsertRowid));
  logAudit({ actor, action: "gateway-query", target: destination, meta: { id: row.id, provider: gen.provider, classes, sensitivity, decision: verdict.decision } });
  const out = { ok: true, request: publicRow(row, { map }), map };
  if (gen.fellBack) out.note = gen.note;
  return out;
}

/** Approve a pending request (Admin) and execute it with redacted text. */
export async function approveRequest(id, { approver = "admin" } = {}) {
  const row = db.prepare(`SELECT * FROM gateway_requests WHERE id = ?`).get(Number(id));
  if (!row) return { ok: false, error: "Request not found" };
  if (row.status !== "pending") return { ok: false, error: `Request is '${row.status}', not pending` };

  const gen = await generate(row.prompt_redacted, { destination: row.destination });
  db.prepare(
    `UPDATE gateway_requests SET status='completed', approver=?, provider=?, model=?, output_redacted=? WHERE id=?`
  ).run(approver, gen.provider, gen.model, gen.text, row.id);
  const finalRow = finalize(row.id);
  logAudit({ actor: approver, action: "gateway-approve", target: row.destination, meta: { id: row.id, provider: gen.provider } });
  // No map available here (raw values were never stored) — caller re-identifies client-side.
  const out = { ok: true, request: publicRow(finalRow) };
  if (gen.fellBack) out.note = gen.note;
  return out;
}

/** Reject a pending request (Admin). */
export function rejectRequest(id, { approver = "admin", notes = null } = {}) {
  const row = db.prepare(`SELECT * FROM gateway_requests WHERE id = ?`).get(Number(id));
  if (!row) return { ok: false, error: "Request not found" };
  if (row.status !== "pending") return { ok: false, error: `Request is '${row.status}', not pending` };
  db.prepare(`UPDATE gateway_requests SET status='rejected', approver=?, reason=? WHERE id=?`)
    .run(approver, notes || row.reason, row.id);
  const finalRow = finalize(row.id);
  logAudit({ actor: approver, action: "gateway-reject", target: row.destination, meta: { id: row.id, notes } });
  return { ok: true, request: publicRow(finalRow) };
}

export function listRequests({ limit = 50 } = {}) {
  const rows = db.prepare(
    `SELECT * FROM gateway_requests ORDER BY id DESC LIMIT ?`
  ).all(Math.min(Math.max(Number(limit) || 50, 1), 500));
  return rows.map((r) => publicRow(r));
}

export function getRequest(id) {
  return publicRow(db.prepare(`SELECT * FROM gateway_requests WHERE id = ?`).get(Number(id)));
}

/**
 * Verify the tamper-evident hash chain over all finalized records.
 * @returns {{ok, total, brokenAt:null|number, message}}
 */
export function verifyChain() {
  const rows = db.prepare(`SELECT * FROM gateway_requests WHERE hash IS NOT NULL ORDER BY id ASC`).all();
  let prev = GENESIS;
  for (const row of rows) {
    const expected = sha256(canonical({ ...row, prev_hash: prev }));
    if (expected !== row.hash || (row.prev_hash || GENESIS) !== prev) {
      return { ok: false, total: rows.length, brokenAt: row.id, message: `Integrity check FAILED at record #${row.id} — the audit log has been altered.` };
    }
    prev = row.hash;
  }
  return { ok: true, total: rows.length, brokenAt: null, message: rows.length ? `Verified ${rows.length} records — chain intact, no tampering detected.` : "No records yet." };
}

export default { runGateway, approveRequest, rejectRequest, listRequests, getRequest, verifyChain };
