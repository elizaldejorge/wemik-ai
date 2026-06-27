const STORAGE_KEY = "wemik.mockChat.v2";

const quickPrompts = [
  "Analyze login alert for Ahmed Khan at ahmed.khan@acme.com from 203.0.113.14.",
  "Draft a breach update for Maria Lopez, SSN 123-45-6789, account 4111 1111 1111 1111.",
  "Run a security scan summary for payroll-api.acme.com and classify risk.",
  "Assess this phishing email and recommend next steps.",
];

const starterConversations = [
  {
    id: crypto.randomUUID(),
    title: "Sensitive alert review",
    group: "Today",
    updatedAt: Date.now() - 1000 * 60 * 12,
    messages: [
      {
        role: "assistant",
        text: "Share a prompt with real operational context. Wemik will scan it locally, replace sensitive values with placeholders before provider handoff, then restore values in the response you see here.",
        state: "idle",
      },
    ],
  },
  {
    id: crypto.randomUUID(),
    title: "Incident update",
    group: "Previous 7 Days",
    updatedAt: Date.now() - 1000 * 60 * 60 * 30,
    messages: [
      guardedUserMessage("Draft a ransomware update for Maria Lopez at maria.lopez@acme.com about host FIN-441."),
      {
        role: "assistant",
        text: "Wemik restored the local values after receiving a provider-safe response. The incident note should mention Maria Lopez and host FIN-441 only inside your local workspace.",
        state: "success",
        sections: responseSections("Draft a ransomware update for [PERSON_1] at [EMAIL_1] about host FIN-441.", true),
        guard: {
          protectedCount: 2,
          providerPrompt: "Draft a ransomware update for [PERSON_1] at [EMAIL_1] about host FIN-441.",
          restoredValues: ["Maria Lopez", "maria.lopez@acme.com"],
        },
      },
    ],
  },
];

const state = {
  conversations: [],
  selectedId: null,
  mascot: "idle",
  busy: false,
  persist: true,
  mode: "Security Copilot",
  pendingFile: null, // { name, base64 } staged for the secure upload flow
};

const $ = (selector) => document.querySelector(selector);
const appShell = $(".app-shell");
const conversationNav = $("#conversationNav");
const chatContent = $("#chatContent");
const conversationTitle = $("#conversationTitle");
const quickPromptBar = $("#quickPrompts");
const form = $("#composer");
const input = $("#messageInput");
const sendButton = $("#sendButton");
const settingsModal = $("#settingsModal");

function boot() {
  const stored = readStorage();
  state.conversations = stored?.conversations?.length ? stored.conversations : starterConversations;
  state.selectedId = stored?.selectedId ?? null;
  state.persist = stored?.persist ?? true;
  state.mode = stored?.mode ?? "Security Copilot";

  $("#persistToggle").checked = state.persist;
  $("#modeSelect").value = state.mode;
  render();
}

function readStorage() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

function saveStorage() {
  if (!state.persist) {
    localStorage.removeItem(STORAGE_KEY);
    return;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    conversations: state.conversations,
    selectedId: state.selectedId,
    persist: state.persist,
    mode: state.mode,
  }));
}

function selectedConversation() {
  return state.conversations.find((conversation) => conversation.id === state.selectedId) ?? null;
}

function render() {
  renderSidebar();
  renderQuickPrompts();
  renderChat();
  renderAttachment();
  updateMascotStatus();
  sendButton.disabled = state.busy || (input.value.trim().length === 0 && !state.pendingFile);
  sendButton.classList.toggle("loading", state.busy);
  saveStorage();
}

function renderAttachment() {
  const host = $("#attachmentPreview");
  const attachBtn = $("#attachButton");
  if (!state.pendingFile) {
    host.hidden = true; host.innerHTML = "";
    attachBtn.classList.remove("has-file");
    return;
  }
  attachBtn.classList.add("has-file");
  host.hidden = false;
  const kb = Math.max(1, Math.round((state.pendingFile.base64.length * 0.75) / 1024));
  host.innerHTML = `
    <div class="attachment-chip">
      <span class="ui-icon icon-settings" aria-hidden="true"></span>
      <span><strong>${escapeHtml(state.pendingFile.name)}</strong> <small>${kb} KB · guarded on device</small></span>
      <button class="remove-attach" type="button" id="removeAttach" aria-label="Remove file">&times;</button>
    </div>`;
  $("#removeAttach").addEventListener("click", () => { state.pendingFile = null; render(); });
}

function renderSidebar() {
  const groups = ["Today", "Previous 7 Days"];
  conversationNav.innerHTML = groups.map((group) => {
    const items = state.conversations.filter((conversation) => conversation.group === group);
    if (!items.length) return "";
    return `
      <section class="conversation-group">
        <h3>${group}</h3>
        ${items.map((conversation) => {
          const protectedCount = conversation.messages.reduce((count, message) => count + (message.guard?.protectedCount || 0), 0);
          return `
            <button class="conversation-button ${conversation.id === state.selectedId ? "active" : ""}" type="button" data-conversation-id="${conversation.id}">
              <span>${escapeHtml(conversation.title)}</span>
              <small>${conversation.messages.length} messages ${protectedCount ? `+ ${protectedCount} guarded` : ""}</small>
            </button>
          `;
        }).join("")}
      </section>
    `;
  }).join("");

  conversationNav.querySelectorAll("[data-conversation-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedId = button.dataset.conversationId;
      closeSidebar();
      setMascot("idle");
      render();
    });
  });
}

function renderQuickPrompts() {
  quickPromptBar.innerHTML = quickPrompts.map((prompt) => `<button class="chip" type="button">${escapeHtml(prompt)}</button>`).join("");
  quickPromptBar.querySelectorAll(".chip").forEach((button) => {
    button.addEventListener("click", () => {
      input.value = button.textContent;
      autogrow();
      render();
      input.focus();
    });
  });
}

function renderChat() {
  const conversation = selectedConversation();
  conversationTitle.textContent = conversation?.title ?? "New chat";

  if (!conversation) {
    chatContent.innerHTML = `
      <div class="chat-inner">
        <div class="empty-state">
          <div class="mascot-stage">${mascotMarkup("idle")}</div>
          <h1>Use outside AI without exposing sensitive data.</h1>
          <p>Wemik scans your prompt locally, swaps sensitive values for placeholders, sends only the guarded prompt, then restores the real values back on your machine.</p>
          <div class="privacy-flow" aria-label="Wemik privacy flow">
            <span>Local scan</span>
            <span>Placeholder prompt</span>
            <span>Provider response</span>
            <span>Local restore</span>
          </div>
          <div class="quick-grid">
            ${quickPrompts.map((prompt) => `
              <button class="prompt-card" type="button" data-empty-prompt="${escapeHtml(prompt)}">
                <strong>${escapeHtml(prompt.split(" ").slice(0, 5).join(" "))}</strong>
                <span>${escapeHtml(prompt)}</span>
              </button>
            `).join("")}
          </div>
        </div>
      </div>
    `;
    chatContent.querySelectorAll("[data-empty-prompt]").forEach((button) => {
      button.addEventListener("click", () => {
        input.value = button.dataset.emptyPrompt;
        autogrow();
        render();
        input.focus();
      });
    });
    return;
  }

  const messages = conversation.messages.map((message, index) => messageTemplate(message, index)).join("");
  chatContent.innerHTML = `<div class="chat-inner"><div class="message-list">${messages}</div></div>`;
  attachMessageActions();
  chatContent.scrollTop = chatContent.scrollHeight;
}

function messageTemplate(message, index) {
  const isAssistant = message.role === "assistant";
  const severity = message.severity ? ` severity-${message.severity}` : "";
  const bubbleInner = message.portfolio
    ? portfolioMarkup(message.portfolio, index)
    : message.sections
      ? sectionsMarkup(message.sections)
      : message.attachment
        ? `${attachmentMarkup(message.attachment)}${message.text ? `<div class="att-instruction">${escapeHtml(message.text)}</div>` : ""}`
        : escapeHtml(message.text);
  const showCopyRetry = isAssistant && !message.thinking && !message.portfolio;
  return `
    <article class="message ${message.role}${severity}">
      ${isAssistant ? `<div class="message-avatar">${mascotMarkup(message.state || "idle")}</div>` : ""}
      <div class="message-body">
        <div class="bubble">${bubbleInner}</div>
        <div class="message-meta">
          <span>${isAssistant ? state.mode : "You"}</span>
          ${guardBadge(message, index)}
          ${message.severity === "warning" ? "<span>Security warning</span>" : ""}
          ${message.severity === "error" ? "<span>Blocked before handoff</span>" : ""}
          ${showCopyRetry ? `<button class="mini-action" type="button" data-copy-message="${index}">Copy</button><button class="mini-action" type="button" data-retry-message="${index}">Retry</button>` : ""}
        </div>
        ${guardPanel(message, index)}
      </div>
      ${isAssistant ? "" : `<div class="message-avatar user-avatar">J</div>`}
    </article>
  `;
}

function sectionsMarkup(sections) {
  return `
    <div class="response-sections">
      ${sections.map((section) => `
        <section>
          <strong>${escapeHtml(section.title)}</strong>
          <p>${escapeHtml(section.body)}</p>
        </section>
      `).join("")}
    </div>
  `;
}

function guardBadge(message, index) {
  if (!message.guard) return "";
  const count = message.guard.protectedCount;
  const label = count ? `${count} guarded locally` : "No sensitive data found";
  return `<button class="guard-badge" type="button" data-toggle-guard="${index}">${label}</button>`;
}

function guardPanel(message, index) {
  if (!message.guard) return "";
  const findings = message.guard.findings || [];
  const findingRows = findings.length
    ? findings.map((finding) => `
        <li>
          <span>${escapeHtml(finding.placeholder)}</span>
          <strong>${escapeHtml(finding.type)}</strong>
          <em>${escapeHtml(finding.value)}</em>
        </li>
      `).join("")
    : `<li><span>None</span><strong>Clean</strong><em>No sensitive values detected locally.</em></li>`;

  return `
    <div class="guard-panel" data-guard-panel="${index}" hidden>
      <div class="guard-panel-head">
        <strong>Wemik guarded this locally</strong>
        <span>${message.guard.protectedCount} protected value${message.guard.protectedCount === 1 ? "" : "s"}</span>
      </div>
      <div class="guard-columns">
        <div>
          <h4>Detected on device</h4>
          <ul class="finding-list">${findingRows}</ul>
        </div>
        <div>
          <h4>Sent to provider</h4>
          <pre>${escapeHtml(message.guard.providerPrompt || message.guard.redactedText || message.text)}</pre>
        </div>
      </div>
      <p class="guard-note">Real values stay in local memory for this prototype. The provider-safe prompt uses placeholders only.</p>
    </div>
  `;
}

function attachMessageActions() {
  chatContent.querySelectorAll("[data-toggle-guard]").forEach((button) => {
    button.addEventListener("click", () => {
      const panel = chatContent.querySelector(`[data-guard-panel="${button.dataset.toggleGuard}"]`);
      if (!panel) return;
      panel.hidden = !panel.hidden;
    });
  });

  chatContent.querySelectorAll("[data-copy-message]").forEach((button) => {
    button.addEventListener("click", async () => {
      const conversation = selectedConversation();
      const message = conversation?.messages[Number(button.dataset.copyMessage)];
      if (!message) return;
      await navigator.clipboard?.writeText(message.text);
      button.textContent = "Copied";
      setTimeout(() => { button.textContent = "Copy"; }, 1200);
    });
  });

  chatContent.querySelectorAll("[data-retry-message]").forEach((button) => {
    button.addEventListener("click", () => {
      input.value = "Retry with a shorter incident note.";
      autogrow();
      render();
      input.focus();
    });
  });

  chatContent.querySelectorAll("[data-pf-seen]").forEach((button) => {
    button.addEventListener("click", () => {
      const panel = button.closest(".portfolio")?.querySelector("[data-pf-seen-panel]");
      if (panel) panel.hidden = !panel.hidden;
    });
  });

  chatContent.querySelectorAll("[data-pf-download]").forEach((button) => {
    button.addEventListener("click", () => {
      const conversation = selectedConversation();
      const portfolio = conversation?.messages[Number(button.dataset.pfDownload)]?.portfolio;
      if (!portfolio?.downloadXlsxBase64) return;
      downloadBase64(portfolio.downloadXlsxBase64, portfolio.downloadFileName || "wemik-reorganised.xlsx");
    });
  });
}

function downloadBase64(base64, fileName) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = fileName;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function mascotMarkup(stateName) {
  return `<div class="mascot ${stateName}" role="img" aria-label="Wemik assistant ${stateName}"></div>`;
}

async function sendMessage(text) {
  const conversation = ensureConversation(text);
  const userMessage = guardedUserMessage(text);
  conversation.messages.push(userMessage);
  conversation.updatedAt = Date.now();
  input.value = "";
  autogrow();
  state.busy = true;
  setMascot("waiting");
  render();

  await delay(450);
  setMascot("scanning");
  appendThinking("Scanning locally and replacing sensitive values...");

  await delay(650);
  removeThinking();
  appendThinking("Sending provider-safe prompt with placeholders only...");

  await delay(850 + Math.floor(Math.random() * 450));
  removeThinking();

  if (text.trim().toLowerCase() === "/error") {
    conversation.messages.push({
      role: "assistant",
      text: "Test error triggered. Wemik stopped before provider handoff and kept the original prompt local.",
      state: "error",
      severity: "error",
      guard: userMessage.guard,
    });
    finishResponse("error", 1200);
    return;
  }

  const warning = isWarningPrompt(text);
  conversation.messages.push({
    role: "assistant",
    text: restoredResponseText(userMessage.guard.redactedText, warning, userMessage.guard.findings),
    state: warning ? "warning" : "success",
    severity: warning ? "warning" : undefined,
    sections: responseSections(userMessage.guard.redactedText, warning),
    guard: {
      ...userMessage.guard,
      providerPrompt: userMessage.guard.redactedText,
    },
  });
  finishResponse(warning ? "warning" : "success", warning ? 1600 : 900);
}

async function sendPortfolio(instruction) {
  const file = state.pendingFile;
  if (!file) return;
  const prompt = instruction || "Group these customers into credit-risk tiers and summarise each.";
  const conversation = ensureConversation(file.name.replace(/\.[^.]+$/, ""));
  conversation.messages.push({ role: "user", text: prompt, attachment: { name: file.name } });
  conversation.updatedAt = Date.now();

  state.pendingFile = null;
  input.value = "";
  autogrow();
  state.busy = true;
  setMascot("scanning");
  render();

  appendThinking("Reading the file and redacting sensitive columns on your device…");

  try {
    const res = await fetch("/api/chat/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: file.name, instruction: prompt, fileBase64: file.base64 }),
    });
    const data = await res.json();
    removeThinking();
    if (!res.ok || !data.ok) {
      conversation.messages.push({
        role: "assistant", state: "error", severity: "error",
        text: `Wemik could not process that file: ${escapeHtml(data.error || res.statusText)}. Nothing was sent off the device.`,
      });
      finishResponse("error", 1400);
      return;
    }
    conversation.messages.push({ role: "assistant", state: "success", portfolio: data });
    finishResponse("success", 1100);
  } catch (err) {
    removeThinking();
    conversation.messages.push({
      role: "assistant", state: "error", severity: "error",
      text: `Wemik stopped before any handoff (${escapeHtml(err.message)}). Your file never left this machine.`,
    });
    finishResponse("error", 1400);
  }
}

function attachmentMarkup(att) {
  return `<div class="file-line"><span class="ui-icon icon-settings" aria-hidden="true"></span><strong>${escapeHtml(att.name)}</strong><small>guarded locally</small></div>`;
}

function portfolioMarkup(p, index) {
  const tierClass = (t) => /high/i.test(t) ? "high" : /med/i.test(t) ? "medium" : "low";
  const aiPill = p.aiUsed
    ? `<span class="pf-pill ai">✦ ${escapeHtml(p.provider)} regrouped it</span>`
    : `<span class="pf-pill">On-device grouping</span>`;
  const tags = (p.protectedByType || []).map((t) =>
    `<span class="pf-tag"><b>${t.count}</b> ${escapeHtml(t.label)}</span>`).join("");
  const tiers = (p.groups || []).map((g) => `
    <div class="pf-tier ${tierClass(g.tier)}">
      <div class="pf-tier-head"><strong>${escapeHtml(g.tier)}</strong><span class="pf-count">${g.count} customer${g.count === 1 ? "" : "s"}</span></div>
      ${g.rule ? `<div class="pf-rule">${escapeHtml(g.rule)}</div>` : ""}
      ${g.summary ? `<p class="pf-summary">${escapeHtml(g.summary)}</p>` : ""}
      <div class="pf-members">${(g.members || []).slice(0, 12).map((m) => `<span>${escapeHtml(m)}</span>`).join("")}${g.members.length > 12 ? `<span>+${g.members.length - 12} more</span>` : ""}</div>
    </div>`).join("");

  return `
    <div class="portfolio">
      <div class="portfolio-head">
        <span class="pf-pill">🔒 ${p.protectedCount} values protected locally</span>
        ${aiPill}
      </div>
      <div class="portfolio-headline">${escapeHtml(p.headline || "")}</div>
      <div class="pf-protected">${tags}</div>
      <div class="pf-tiers">${tiers}</div>
      <div class="pf-actions">
        <button class="pf-download" type="button" data-pf-download="${index}">⬇ Download reorganised Excel</button>
        <button class="pf-seen" type="button" data-pf-seen>👁 What the model saw</button>
      </div>
      <div class="pf-seen-panel" data-pf-seen-panel hidden>
        <pre>${escapeHtml(p.redactedPreview || "")}</pre>
      </div>
    </div>`;
}

function guardedUserMessage(text) {
  const guard = scanSensitiveInfo(text);
  return {
    role: "user",
    text,
    guard,
  };
}

function scanSensitiveInfo(text) {
  const patterns = [
    { type: "EMAIL", regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
    { type: "SSN", regex: /\b\d{3}-\d{2}-\d{4}\b/g },
    { type: "CARD", regex: /\b(?:\d[ -]*?){13,16}\b/g },
    { type: "IP", regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
    { type: "PHONE", regex: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g },
    { type: "PERSON", regex: /\b[A-Z][a-z]+(?:\s[A-Z][a-z]+)+\b/g },
  ];

  const matches = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern.regex)) {
      const value = match[0].trim();
      if (!value || isLikelyFalsePositive(pattern.type, value)) continue;
      matches.push({ type: pattern.type, value, index: match.index ?? 0 });
    }
  }

  const unique = [];
  for (const match of matches.sort((a, b) => a.index - b.index)) {
    const overlaps = unique.some((item) => match.index < item.index + item.value.length && item.index < match.index + match.value.length);
    if (!overlaps) unique.push(match);
  }

  const counters = {};
  let redactedText = text;
  const findings = unique.map((match) => {
    counters[match.type] = (counters[match.type] || 0) + 1;
    const placeholder = `[${match.type}_${counters[match.type]}]`;
    redactedText = replaceFirst(redactedText, match.value, placeholder);
    return { ...match, placeholder };
  });

  return {
    protectedCount: findings.length,
    findings,
    redactedText,
    providerPrompt: redactedText,
  };
}

function isLikelyFalsePositive(type, value) {
  if (type === "PERSON") {
    return /^(Analyze|Draft|Run|Assess|Create|Review|Security|Wemik|Previous|New Chat|Security Copilot)$/i.test(value);
  }
  if (type === "IP") {
    return value.split(".").some((part) => Number(part) > 255);
  }
  return false;
}

function replaceFirst(source, target, replacement) {
  const index = source.indexOf(target);
  if (index === -1) return source;
  return `${source.slice(0, index)}${replacement}${source.slice(index + target.length)}`;
}

function ensureConversation(seedText) {
  let conversation = selectedConversation();
  if (conversation) return conversation;

  conversation = {
    id: crypto.randomUUID(),
    title: titleFrom(seedText),
    group: "Today",
    updatedAt: Date.now(),
    messages: [],
  };
  state.conversations.unshift(conversation);
  state.selectedId = conversation.id;
  return conversation;
}

function titleFrom(text) {
  return text.replace(/^\/\w+\s*/, "").split(/\s+/).slice(0, 6).join(" ") || "New security chat";
}

function appendThinking(text) {
  const conversation = selectedConversation();
  conversation.messages.push({
    role: "assistant",
    text,
    state: "thinking",
    thinking: true,
  });
  render();
  const bubble = chatContent.querySelector(".message-list .message:last-child .bubble");
  if (bubble) bubble.innerHTML = `${escapeHtml(text)} <span class="typing-dots"><i></i><i></i><i></i></span>`;
}

function removeThinking() {
  const conversation = selectedConversation();
  conversation.messages = conversation.messages.filter((message) => !message.thinking);
}

function finishResponse(mascotState, returnDelay) {
  state.busy = false;
  setMascot(mascotState);
  render();
  setTimeout(() => {
    setMascot("idle");
    render();
  }, returnDelay);
}

function isWarningPrompt(text) {
  return /phishing|malware|ransomware|credential|breach|exfiltration|warning|critical|cve|ssn|card|account/i.test(text);
}

function responseSections(redactedPrompt, warning) {
  if (warning) {
    return [
      { title: "Risk", body: "High sensitivity or security-risk language was detected. Treat links, attachments, credentials, and identity data as untrusted until validated." },
      { title: "What provider saw", body: redactedPrompt },
      { title: "Recommended action", body: "Preserve evidence, isolate suspicious indicators, verify domains out of band, and assign an owner before user-facing communication." },
      { title: "Audit note", body: "The prompt was transformed locally before provider handoff; real values are restored only in this workspace." },
    ];
  }

  return [
    { title: "Risk", body: "No critical threat language was detected, but operational context should still be reviewed against policy." },
    { title: "What provider saw", body: redactedPrompt },
    { title: "Recommended action", body: "Confirm scope, assign an owner, document evidence, and convert the response into a tracked security task if needed." },
    { title: "Audit note", body: "Wemik can show the exact guarded prompt for review before this flow connects to a real provider." },
  ];
}

function restoredResponseText(redactedPrompt, warning, findings) {
  const restoredValues = findings.map((finding) => finding.value);
  const restoredSuffix = restoredValues.length
    ? ` Restored local values for your workspace: ${restoredValues.join(", ")}.`
    : " No sensitive values needed restoration.";
  return `${warning ? "Warning response prepared." : "Provider-safe response prepared."} The provider prompt was: ${redactedPrompt}.${restoredSuffix}`;
}

function setMascot(nextState) {
  state.mascot = nextState;
}

function updateMascotStatus() {
  document.body.dataset.mascot = state.mascot;
}

function autogrow() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 156)}px`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;",
  }[char]));
}

function openSidebar() {
  appShell.dataset.sidebar = "open";
}

function closeSidebar() {
  appShell.dataset.sidebar = "closed";
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (state.busy) return;
  if (state.pendingFile) { sendPortfolio(text); return; }
  if (!text) return;
  sendMessage(text);
});

// ─── File attach (secure portfolio upload) ────────────────────────────────────
const fileInput = $("#fileInput");
$("#attachButton").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  fileInput.value = "";
  if (!file) return;
  const base64 = await fileToBase64(file);
  state.pendingFile = { name: file.name, base64 };
  if (!input.value.trim()) {
    input.value = "Group these customers into Low / Medium / High credit-risk tiers and summarise each tier.";
    autogrow();
  }
  render();
  input.focus();
});

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

input.addEventListener("input", () => {
  autogrow();
  render();
});

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

$("#newChatButton").addEventListener("click", () => {
  state.selectedId = null;
  setMascot("idle");
  closeSidebar();
  render();
  input.focus();
});

$("#menuButton").addEventListener("click", openSidebar);
document.querySelector("[data-close-sidebar]").addEventListener("click", closeSidebar);
$("#settingsButton").addEventListener("click", () => settingsModal.classList.add("open"));
$("#closeSettingsButton").addEventListener("click", () => settingsModal.classList.remove("open"));
settingsModal.addEventListener("click", (event) => {
  if (event.target === settingsModal) settingsModal.classList.remove("open");
});

$("#persistToggle").addEventListener("change", (event) => {
  state.persist = event.target.checked;
  saveStorage();
});

$("#motionToggle").addEventListener("change", (event) => {
  document.body.classList.toggle("reduce-motion", event.target.checked);
});

$("#modeSelect").addEventListener("change", (event) => {
  state.mode = event.target.value;
  render();
});

boot();
