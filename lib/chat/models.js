/**
 * Wemik — Model Router (chat)
 * by Jorge Elizalde
 *
 * Sends a REDACTED conversation to whichever model the organization's admin has
 * configured. The model only ever sees placeholders like [NAME_1], [QID_1].
 *
 * Providers: sovereign (offline, default), openai, anthropic, ollama.
 * Selected by the admin in Settings (persisted) or via env:
 *   WEMIK_CHAT_PROVIDER = sovereign | openai | anthropic | ollama
 *   OPENAI_API_KEY / WEMIK_OPENAI_MODEL
 *   ANTHROPIC_API_KEY / WEMIK_ANTHROPIC_MODEL
 *   WEMIK_OLLAMA_URL / WEMIK_OLLAMA_MODEL
 *
 * Any failure falls back to the offline sovereign model so the app never hard-fails.
 */

const SYSTEM = [
  "You are Wemik, a helpful AI assistant used inside a regulated organization.",
  "Sensitive values have been replaced with typed placeholders like [NAME_1], [QID_1], [PAN_1], [IBAN_1], [EMAIL_1].",
  "Treat each placeholder as a real value you must NOT guess, expand, or reconstruct. Keep placeholders verbatim in your reply so they can be restored.",
  "Otherwise answer normally, helpfully and concisely.",
].join(" ");

export const PROVIDERS = ["sovereign", "openai", "anthropic", "ollama"];

export function resolveProvider(explicit) {
  const p = (explicit || process.env.WEMIK_CHAT_PROVIDER || "sovereign").toLowerCase();
  return PROVIDERS.includes(p) ? p : "sovereign";
}

/** Offline, deterministic assistant. Reads the latest user turn, preserves placeholders. */
export function sovereignReply(messages) {
  const last = [...messages].reverse().find((m) => m.role === "user")?.content || "";
  const ph = [...new Set((messages.map((m) => m.content).join(" ").match(/\[[A-Z]+_\d+\]/g) || []))];
  const who = ph.find((p) => p.startsWith("[NAME")) || "there";
  const lower = last.toLowerCase();
  const out = [];
  if (/dispute|chargeback|fraud|unauthor/i.test(lower)) {
    out.push(`Hi ${who}, I've drafted a response for the disputed transaction${ph.find((p)=>p.startsWith("[PAN"))?` on card ${ph.find((p)=>p.startsWith("[PAN"))}`:""}. A case has been opened and the fraud team will follow up within 2 business days.`);
  } else if (/summar|explain|review|what.*mean/i.test(lower)) {
    out.push(`Here's a short summary: the message concerns ${who}${ph.length>1?` and ${ph.length-1} other protected field(s)`:""}. Tell me what angle you'd like and I'll go deeper.`);
  } else if (/draft|write|email|reply|letter|message/i.test(lower)) {
    out.push(`Draft for ${who}:`, `Thank you for getting in touch. We've received your request and will get back to you shortly with the next steps.`);
  } else if (/eligib|loan|credit|approve|apply|assess/i.test(lower)) {
    out.push(`Based on the details for ${who}, the request can proceed to standard verification. Confirm the supporting documents and run the usual checks before deciding.`);
  } else {
    out.push(`Got it${who!=="there"?`, regarding ${who}`:""}. ${ph.length?`I can see ${ph.length} protected field(s) (${ph.join(", ")}) which stay redacted end-to-end. `:""}How would you like me to help?`);
  }
  return { text: out.join("\n\n"), provider: "sovereign", model: "wemik-local" };
}

async function callOpenAI(messages, cfg) {
  const key = cfg.apiKey || process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not set");
  const model = cfg.model || process.env.WEMIK_OPENAI_MODEL || "gpt-5.3-codex";
  const input = [{ role: "system", content: SYSTEM }, ...messages.map((m) => ({ role: m.role, content: m.content }))];
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, input }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}`);
  const data = await res.json();
  const text = data?.output_text
    || data?.output?.flatMap?.((o) => (o.content || []).map((c) => c.text)).filter(Boolean).join("\n") || "";
  if (!text.trim()) throw new Error("OpenAI: empty");
  return { text: text.trim(), provider: "openai", model };
}

async function callAnthropic(messages, cfg) {
  const key = cfg.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");
  const model = cfg.model || process.env.WEMIK_ANTHROPIC_MODEL || "claude-sonnet-4-6";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model, max_tokens: 1024, system: SYSTEM,
      messages: messages.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })),
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}`);
  const data = await res.json();
  const text = (data?.content || []).map((c) => c.text).filter(Boolean).join("\n");
  if (!text.trim()) throw new Error("Anthropic: empty");
  return { text: text.trim(), provider: "anthropic", model };
}

async function callOllama(messages, cfg) {
  const url = cfg.url || process.env.WEMIK_OLLAMA_URL || "http://127.0.0.1:11434/api/chat";
  const model = cfg.model || process.env.WEMIK_OLLAMA_MODEL || "llama3.1:8b";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: false, messages: [{ role: "system", content: SYSTEM }, ...messages] }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  const data = await res.json();
  const text = data?.message?.content?.trim();
  if (!text) throw new Error("Ollama: empty");
  return { text, provider: "ollama", model };
}

/**
 * Generate the next assistant turn from a REDACTED message history.
 * @param {{role:'user'|'assistant', content:string}[]} messages  (redacted)
 * @param {object} [cfg]  { provider, apiKey, model, url }
 */
export async function generateChat(messages, cfg = {}) {
  const provider = resolveProvider(cfg.provider);
  try {
    if (provider === "openai")    return await callOpenAI(messages, cfg);
    if (provider === "anthropic") return await callAnthropic(messages, cfg);
    if (provider === "ollama")    return await callOllama(messages, cfg);
    return sovereignReply(messages);
  } catch (err) {
    const out = sovereignReply(messages);
    out.fellBack = true;
    out.note = `Configured provider (${provider}) unavailable: ${err.message}. Used local sovereign model.`;
    return out;
  }
}

export default { generateChat, sovereignReply, resolveProvider, PROVIDERS };
