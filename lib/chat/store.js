/**
 * Wemik — Chat Store
 * by Jorge Elizalde
 *
 * Conversations and messages are stored locally. Messages are stored REDACTED
 * (placeholders only). The real values live in the `chat_vault` table, encrypted
 * at rest (lib/chat/vaultCrypto.js), keyed per conversation. Re-identification
 * happens in memory when a conversation is opened — the cleartext is never
 * persisted and never sent to a model.
 */

import db from "../db.js";
import { encrypt, decrypt } from "./vaultCrypto.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS chat_conversations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL DEFAULT 'New chat',
    provider    TEXT,
    model       TEXT,
    secure      INTEGER NOT NULL DEFAULT 0,   -- 1 once any value has been protected
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    role            TEXT NOT NULL,             -- user | assistant
    content_redacted TEXT NOT NULL,
    protected_count INTEGER NOT NULL DEFAULT 0,
    provider        TEXT,
    model           TEXT,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_chat_msg_conv ON chat_messages(conversation_id, id);

  CREATE TABLE IF NOT EXISTS chat_vault (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    placeholder     TEXT NOT NULL,
    type            TEXT, cls TEXT, sensitivity TEXT, label TEXT, masked TEXT,
    value_enc       TEXT NOT NULL,             -- AES-256-GCM ciphertext
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(conversation_id, placeholder)
  );
  CREATE INDEX IF NOT EXISTS idx_chat_vault_conv ON chat_vault(conversation_id);
`);

// ─── CONVERSATIONS ────────────────────────────────────────────────────────────
export function createConversation({ title = "New chat", provider = null, model = null } = {}) {
  const info = db.prepare(`INSERT INTO chat_conversations (title, provider, model) VALUES (?, ?, ?)`).run(title, provider, model);
  return getConversation(Number(info.lastInsertRowid));
}

export function getConversation(id) {
  return db.prepare(`SELECT * FROM chat_conversations WHERE id = ?`).get(Number(id)) || null;
}

export function listConversations({ limit = 100 } = {}) {
  return db.prepare(
    `SELECT c.*,
            (SELECT COUNT(*) FROM chat_messages m WHERE m.conversation_id = c.id) AS message_count,
            (SELECT COUNT(*) FROM chat_vault v WHERE v.conversation_id = c.id)    AS protected_count
     FROM chat_conversations c
     ORDER BY c.updated_at DESC, c.id DESC
     LIMIT ?`
  ).all(Math.min(Math.max(Number(limit) || 100, 1), 500));
}

export function renameConversation(id, title) {
  db.prepare(`UPDATE chat_conversations SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(String(title).slice(0, 120), Number(id));
  return getConversation(id);
}

export function touchConversation(id, { secure } = {}) {
  if (secure) db.prepare(`UPDATE chat_conversations SET secure = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(Number(id));
  else db.prepare(`UPDATE chat_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(Number(id));
}

export function deleteConversation(id) {
  const cid = Number(id);
  db.prepare(`DELETE FROM chat_vault    WHERE conversation_id = ?`).run(cid);
  db.prepare(`DELETE FROM chat_messages WHERE conversation_id = ?`).run(cid);
  db.prepare(`DELETE FROM chat_conversations WHERE id = ?`).run(cid);
  return { ok: true };
}

// ─── MESSAGES ─────────────────────────────────────────────────────────────────
export function addMessage(conversationId, { role, contentRedacted, protectedCount = 0, provider = null, model = null }) {
  const info = db.prepare(
    `INSERT INTO chat_messages (conversation_id, role, content_redacted, protected_count, provider, model)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(Number(conversationId), role, contentRedacted, protectedCount, provider, model);
  return Number(info.lastInsertRowid);
}

export function listMessages(conversationId) {
  return db.prepare(
    `SELECT id, role, content_redacted, protected_count, provider, model, created_at
     FROM chat_messages WHERE conversation_id = ? ORDER BY id ASC`
  ).all(Number(conversationId));
}

// ─── VAULT (encrypted, local-only) ────────────────────────────────────────────
/** @returns {{[placeholder]: {value, type, cls, sensitivity, label, masked}}} */
export function getVaultMap(conversationId) {
  const rows = db.prepare(`SELECT * FROM chat_vault WHERE conversation_id = ?`).all(Number(conversationId));
  const map = {};
  for (const r of rows) {
    map[r.placeholder] = {
      value: decrypt(r.value_enc),
      type: r.type, cls: r.cls, sensitivity: r.sensitivity, label: r.label, masked: r.masked,
    };
  }
  return map;
}

/** Insert new placeholder→value mappings (encrypting the value). Ignores dups. */
export function addVaultEntries(conversationId, entries = []) {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO chat_vault (conversation_id, placeholder, type, cls, sensitivity, label, masked, value_enc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const tx = db.transaction((list) => {
    for (const e of list) {
      stmt.run(Number(conversationId), e.placeholder, e.type, e.cls, e.sensitivity, e.label, e.masked, encrypt(e.value));
    }
  });
  tx(entries);
}

export default {
  createConversation, getConversation, listConversations, renameConversation,
  touchConversation, deleteConversation, addMessage, listMessages, getVaultMap, addVaultEntries,
};
