/**
 * Wemik — Chat Engine
 * by Jorge Elizalde
 *
 * The core loop:
 *   1. user types a message (may contain sensitive data)
 *   2. detect + redact LOCALLY, reusing this conversation's existing placeholders
 *      so the same real value always maps to the same token across turns
 *   3. store the real values in the encrypted local vault; store the message redacted
 *   4. send the REDACTED conversation to the org's chosen model
 *   5. store the assistant reply (redacted), then re-identify it LOCALLY
 *   6. return real values to the user — they never left the machine
 */

import { detect, maskValue, reidentify, topSensitivity } from "../gateway/pii.js";
import { generateChat } from "./models.js";
import store from "./store.js";
import { logAudit } from "../audit.js";

/**
 * Redact `text` against an existing per-conversation vault so repeated values
 * reuse their placeholder and new values continue the numbering.
 * @returns {{redacted, newEntries, usedPlaceholders}}
 */
function redactWithVault(text, vaultMap) {
  // reverse lookup: "TYPE:value" -> placeholder ; per-type max index
  const reverse = new Map();
  const counters = {};
  const known = [];
  for (const [placeholder, v] of Object.entries(vaultMap || {})) {
    reverse.set(`${v.type}:${v.value}`, placeholder);
    if (v.value) known.push({ value: v.value, placeholder });
    const m = placeholder.match(/\[([A-Z]+)_(\d+)\]/);
    if (m) counters[m[1]] = Math.max(counters[m[1]] || 0, Number(m[2]));
  }

  const used = new Set();

  // 1) The vault is authoritative: any value already protected in THIS
  // conversation is redacted in every later turn, even if it's phrased
  // differently and the detector wouldn't re-anchor on it. Longest first so
  // a longer value can't be partially clobbered by a shorter one.
  let work = text;
  known.sort((a, b) => b.value.length - a.value.length);
  for (const k of known) {
    if (work.includes(k.value)) {
      work = work.split(k.value).join(k.placeholder);
      used.add(k.placeholder);
    }
  }

  // 2) Detect NEW sensitive values in the residual text.
  const entities = detect(work);
  const out = [];
  const newEntries = [];
  let cursor = 0;
  for (const e of entities) {
    out.push(work.slice(cursor, e.start));
    const key = `${e.type}:${e.value}`;
    let placeholder = reverse.get(key);
    if (!placeholder) {
      counters[e.type] = (counters[e.type] || 0) + 1;
      placeholder = `[${e.type}_${counters[e.type]}]`;
      reverse.set(key, placeholder);
      newEntries.push({
        placeholder, type: e.type, cls: e.cls, sensitivity: e.sensitivity,
        label: e.label, masked: maskValue(e.type, e.value), value: e.value,
      });
    }
    out.push(placeholder);
    used.add(placeholder);
    cursor = e.end;
  }
  out.push(work.slice(cursor));
  return { redacted: out.join(""), newEntries, usedPlaceholders: [...used] };
}

function countPlaceholders(text) {
  return new Set(text.match(/\[[A-Z]+_\d+\]/g) || []).size;
}

/**
 * Send a user message in a conversation. Creates a conversation if needed.
 * @param {object} args
 * @param {number} [args.conversationId]
 * @param {string} args.text
 * @param {object} [args.providerCfg]  { provider, apiKey, model, url }
 * @param {string} [args.actor]
 */
export async function sendMessage({ conversationId, text, providerCfg = {}, actor = "user" } = {}) {
  const userText = String(text || "").trim();
  if (!userText) return { ok: false, error: "Empty message" };

  let conv = conversationId ? store.getConversation(conversationId) : null;
  if (!conv) conv = store.createConversation({ provider: providerCfg.provider || null });
  const cid = conv.id;

  // 1–3. redact against the conversation vault, persist new values (encrypted)
  const vaultMap = store.getVaultMap(cid);
  const { redacted, newEntries, usedPlaceholders } = redactWithVault(userText, vaultMap);
  if (newEntries.length) store.addVaultEntries(cid, newEntries);
  store.addMessage(cid, { role: "user", contentRedacted: redacted, protectedCount: usedPlaceholders.length });

  // first user message → title from the REDACTED text (never contains raw PII)
  if (conv.title === "New chat") {
    const t = redacted.replace(/\s+/g, " ").trim().slice(0, 60) || "New chat";
    store.renameConversation(cid, t);
  }

  // 4. send the redacted history to the chosen model
  const history = store.listMessages(cid).map((m) => ({ role: m.role, content: m.content_redacted }));
  const gen = await generateChat(history, providerCfg);

  // 5. persist assistant reply (redacted) and re-identify locally
  store.addMessage(cid, { role: "assistant", contentRedacted: gen.text, protectedCount: countPlaceholders(gen.text), provider: gen.provider, model: gen.model });
  store.touchConversation(cid, { secure: newEntries.length > 0 || conv.secure === 1 });

  const fullVault = store.getVaultMap(cid);
  const assistantReal = reidentify(gen.text, fullVault);

  logAudit({
    actor, action: "chat-message", target: `conversation:${cid}`,
    meta: { provider: gen.provider, model: gen.model, protectedNew: newEntries.length, protectedTotal: Object.keys(fullVault).length, sensitivity: topSensitivity(Object.values(fullVault)) },
  });

  return {
    ok: true,
    conversationId: cid,
    title: store.getConversation(cid).title,
    secure: store.getConversation(cid).secure === 1,
    user: { real: userText, redacted, protectedCount: usedPlaceholders.length, entities: usedPlaceholders.map((p) => ({ placeholder: p, ...fullVault[p] })) },
    assistant: { real: assistantReal, redacted: gen.text, provider: gen.provider, model: gen.model },
    note: gen.fellBack ? gen.note : undefined,
  };
}

/** Load a conversation with every message re-identified for local display. */
export function getConversationView(conversationId) {
  const conv = store.getConversation(conversationId);
  if (!conv) return null;
  const vaultMap = store.getVaultMap(conversationId);
  const messages = store.listMessages(conversationId).map((m) => ({
    id: m.id, role: m.role,
    real: reidentify(m.content_redacted, vaultMap),
    redacted: m.content_redacted,
    protectedCount: m.protected_count,
    provider: m.provider, model: m.model, createdAt: m.created_at,
  }));
  // Protected fields summary (masked — safe to show in a privacy panel)
  const protectedFields = Object.entries(vaultMap).map(([placeholder, v]) => ({
    placeholder, label: v.label, sensitivity: v.sensitivity, masked: v.masked,
  }));
  return { conversation: conv, messages, protectedFields };
}

export default { sendMessage, getConversationView };
