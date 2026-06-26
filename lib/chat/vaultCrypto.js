/**
 * Wemik — Local Vault Encryption
 * by Jorge Elizalde
 *
 * The real sensitive values that Wemik strips out of prompts are stored LOCALLY
 * and encrypted at rest with AES-256-GCM. The key is generated once and kept in
 * the local SQLite db (app_settings). Values never leave the machine, and even
 * on disk they are ciphertext. This is what lets Wemik claim "sensitive data
 * never leaves" literally — not even into our own audit trail.
 */

import crypto from "crypto";
import db from "../db.js";

const KEY_SETTING = "wemik_vault_key";

function getKey() {
  let row = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(KEY_SETTING);
  if (!row || !row.value) {
    const key = crypto.randomBytes(32).toString("hex");
    db.prepare(`INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)`).run(KEY_SETTING, key);
    row = { value: key };
  }
  return Buffer.from(row.value, "hex");
}

/** Encrypt a plaintext string → "iv:tag:ciphertext" (all base64). */
export function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

/** Decrypt "iv:tag:ciphertext" → plaintext (or "" if tampered/unreadable). */
export function decrypt(blob) {
  try {
    const [ivB, tagB, ctB] = String(blob).split(":");
    const key = getKey();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB, "base64"));
    decipher.setAuthTag(Buffer.from(tagB, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ctB, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

export default { encrypt, decrypt };
