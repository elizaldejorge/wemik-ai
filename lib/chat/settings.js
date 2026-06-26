/**
 * Wemik — Chat Provider Settings (org admin)
 * by Jorge Elizalde
 *
 * The organization's admin chooses which model powers Wemik (OpenAI, Anthropic,
 * a local Ollama model, or the offline sovereign model) and supplies the API
 * key. Keys are stored locally and encrypted at rest (lib/chat/vaultCrypto.js),
 * and are masked when read back. Only redacted prompts are ever sent to them.
 */

import db from "../db.js";
import { encrypt, decrypt } from "./vaultCrypto.js";
import { PROVIDERS } from "./models.js";

const P = "wemik_chat_";
const get = (k) => db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(P + k)?.value || null;
const set = (k, v) => db.prepare(`INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)`).run(P + k, v);

const DEFAULT_MODELS = { openai: "gpt-5.3-codex", anthropic: "claude-sonnet-4-6", ollama: "llama3.1:8b", sovereign: "wemik-local" };

/** Public view for the settings UI — never returns raw keys. */
export function getProviderPublic() {
  const provider = get("provider") || process.env.WEMIK_CHAT_PROVIDER || "sovereign";
  return {
    provider,
    model: get("model") || DEFAULT_MODELS[provider] || "",
    defaultModels: DEFAULT_MODELS,
    providers: PROVIDERS,
    hasOpenAIKey: !!(get("openai_key_enc") || process.env.OPENAI_API_KEY),
    hasAnthropicKey: !!(get("anthropic_key_enc") || process.env.ANTHROPIC_API_KEY),
    ollamaUrl: get("ollama_url") || process.env.WEMIK_OLLAMA_URL || "http://127.0.0.1:11434/api/chat",
  };
}

/** Internal config (with decrypted key) used to actually call the model. */
export function getProviderCfg() {
  const provider = get("provider") || process.env.WEMIK_CHAT_PROVIDER || "sovereign";
  const model = get("model") || DEFAULT_MODELS[provider] || undefined;
  const cfg = { provider, model };
  if (provider === "openai")    cfg.apiKey = (get("openai_key_enc") && decrypt(get("openai_key_enc"))) || process.env.OPENAI_API_KEY || null;
  if (provider === "anthropic") cfg.apiKey = (get("anthropic_key_enc") && decrypt(get("anthropic_key_enc"))) || process.env.ANTHROPIC_API_KEY || null;
  if (provider === "ollama")    cfg.url = get("ollama_url") || process.env.WEMIK_OLLAMA_URL || undefined;
  return cfg;
}

/** Admin update. Empty/omitted keys are left unchanged. */
export function setProvider(input = {}) {
  const provider = String(input.provider || "").toLowerCase();
  if (!PROVIDERS.includes(provider)) return { ok: false, error: `Invalid provider. One of: ${PROVIDERS.join(", ")}` };
  set("provider", provider);
  if (input.model != null && String(input.model).trim()) set("model", String(input.model).trim());
  if (input.openaiKey && String(input.openaiKey).trim())    set("openai_key_enc", encrypt(String(input.openaiKey).trim()));
  if (input.anthropicKey && String(input.anthropicKey).trim()) set("anthropic_key_enc", encrypt(String(input.anthropicKey).trim()));
  if (input.ollamaUrl && String(input.ollamaUrl).trim())    set("ollama_url", String(input.ollamaUrl).trim());
  return { ok: true, ...getProviderPublic() };
}

export default { getProviderPublic, getProviderCfg, setProvider };
