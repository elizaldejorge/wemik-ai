/**
 * Wemik Gateway — Model Providers
 * by Jorge Elizalde
 *
 * The model is called with REDACTED text only. Three providers:
 *   sovereign-echo — deterministic local responder, no network. Default, so
 *                    the demo runs fully offline / air-gapped.
 *   ollama         — local Llama via Ollama (truly sovereign, real generation)
 *   openai         — hosted GPT (only used for the "external-cloud" destination)
 *
 * Selected via WEMIK_GATEWAY_PROVIDER (auto|echo|ollama|openai). "auto" uses
 * Ollama if reachable, else the sovereign echo. Any failure falls back to echo
 * so a live demo never hard-fails.
 */

const OLLAMA_URL   = process.env.WEMIK_OLLAMA_URL   || "http://127.0.0.1:11434/api/chat";
const OLLAMA_MODEL = process.env.WEMIK_OLLAMA_MODEL || "llama3.1:8b";
const OPENAI_URL   = "https://api.openai.com/v1/responses";
const OPENAI_MODEL = process.env.WEMIK_GATEWAY_MODEL || "gpt-5.3-codex";

const SYSTEM = [
  "You are an assistant operating behind Wemik, a sovereign AI gateway for regulated organizations.",
  "All personal and sensitive data has already been redacted to typed placeholders like [NAME_1], [QID_1], [PAN_1], [IBAN_1].",
  "Treat each placeholder as a real value you must not try to guess or reconstruct. Keep placeholders verbatim in your reply.",
  "Be concise and professional; you are drafting for a bank/government/hospital staff member.",
].join(" ");

/** Deterministic, offline responder. Reads the redacted prompt and drafts a reply. */
export function sovereignEcho(redactedPrompt) {
  const ph = [...new Set((redactedPrompt.match(/\[[A-Z]+_\d+\]/g) || []))];
  const lower = redactedPrompt.toLowerCase();
  const who = ph.find((p) => p.startsWith("[NAME")) || "the customer";
  const lines = [];

  if (/dispute|chargeback|fraud|unauthor/i.test(lower)) {
    lines.push(`Draft response — transaction dispute:`);
    lines.push(`Dear ${who}, thank you for flagging this. I have opened a dispute case for the transaction you referenced` + (ph.find((p)=>p.startsWith("[PAN"))? ` on card ${ph.find((p)=>p.startsWith("[PAN"))}.`:`.`));
    lines.push(`Our fraud team will review and respond within 2 business days. No further action is needed from you at this time.`);
  } else if (/summar|explain|what.*say|review/i.test(lower)) {
    lines.push(`Summary of the request:`);
    lines.push(`The message concerns ${who}${ph.length>1?` and references ${ph.length-1} other sensitive field(s)`:``}. The core intent appears to be a service or account inquiry.`);
    lines.push(`Recommended next step: confirm identity through an approved channel before sharing any account detail.`);
  } else if (/eligib|approve|loan|credit|apply|application/i.test(lower)) {
    lines.push(`Assessment draft:`);
    lines.push(`Based on the information provided for ${who}, the application can proceed to standard verification. Confirm income documents and run the usual checks before a decision.`);
  } else {
    lines.push(`Acknowledged. I have read the request regarding ${who}.`);
    lines.push(ph.length ? `It references the following protected fields, which remain redacted end-to-end: ${ph.join(", ")}.` : `No sensitive fields were detected.`);
    lines.push(`Tell me what you'd like drafted or checked next and I'll continue.`);
  }
  return { text: lines.join("\n"), provider: "sovereign-echo", model: "wemik-local-demo" };
}

async function callOllama(redactedPrompt) {
  const res = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL, stream: false,
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: redactedPrompt }],
    }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  const data = await res.json();
  const text = data?.message?.content?.trim();
  if (!text) throw new Error("Ollama: empty response");
  return { text, provider: "ollama", model: OLLAMA_MODEL };
}

async function callOpenAI(redactedPrompt) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not set");
  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: OPENAI_MODEL, input: `${SYSTEM}\n\n${redactedPrompt}` }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}`);
  const data = await res.json();
  const text = data?.output_text
    || data?.output?.flatMap?.((o) => (o.content || []).map((c) => c.text)).filter(Boolean).join("\n")
    || "";
  if (!text.trim()) throw new Error("OpenAI: empty response");
  return { text: text.trim(), provider: "openai", model: OPENAI_MODEL };
}

/**
 * Generate from the REDACTED prompt. Picks provider by env + destination.
 * External-cloud destination may use OpenAI; sovereign-local never does.
 * Always falls back to the offline echo so the demo cannot hard-fail.
 * @returns {Promise<{text, provider, model, fellBack?:boolean, note?:string}>}
 */
export async function generate(redactedPrompt, { destination = "sovereign-local" } = {}) {
  const choice = (process.env.WEMIK_GATEWAY_PROVIDER || "auto").toLowerCase();

  const tryReal = async () => {
    if (choice === "openai" || (choice === "auto" && destination === "external-cloud" && process.env.OPENAI_API_KEY)) {
      if (destination !== "external-cloud") throw new Error("OpenAI only permitted for external-cloud destination");
      return await callOpenAI(redactedPrompt);
    }
    if (choice === "ollama" || choice === "auto") {
      return await callOllama(redactedPrompt);
    }
    throw new Error("echo");
  };

  if (choice === "echo") return sovereignEcho(redactedPrompt);
  try {
    return await tryReal();
  } catch (err) {
    const out = sovereignEcho(redactedPrompt);
    out.fellBack = true;
    out.note = `Live provider unavailable (${err.message}); used sovereign offline model.`;
    return out;
  }
}

export default { generate, sovereignEcho };
