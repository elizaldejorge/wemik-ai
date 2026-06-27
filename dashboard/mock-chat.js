const STORAGE_KEY = "wemik.mockChat.v2";

const quickPrompts = [
  "Upload a customer portfolio and group it by credit-risk tier.",
  "Summarise a loan book and flag accounts 90+ days overdue.",
  "Draft a collections message for an overdue customer — keep names on-device.",
  "How does Wemik keep sensitive data on this machine?",
];

const starterConversations = [
  {
    id: crypto.randomUUID(),
    title: "Customer portfolio triage",
    group: "Today",
    updatedAt: Date.now() - 1000 * 60 * 12,
    messages: [
      {
        role: "assistant",
        text: "Attach a customer spreadsheet and tell me how to organise it — by credit-risk tier, overdue accounts, branch, anything. Names, QIDs and account numbers are redacted on this device; only placeholders reach the model, and the real values are restored right here for you.",
        state: "idle",
      },
    ],
  },
  {
    id: crypto.randomUUID(),
    title: "Loan book review",
    group: "Previous 7 Days",
    updatedAt: Date.now() - 1000 * 60 * 60 * 30,
    messages: [
      {
        role: "assistant",
        text: "Drop in a loan book and I can summarise total exposure, flag accounts past due, and group by segment — without your customers' identities ever leaving the machine.",
        state: "success",
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
  mode: "Banking Assistant",
  pendingFile: null, // { name, base64 } staged for the secure upload flow
  artifact: null,    // active portfolio result shown in the right-side panel
  artifactTab: "table",
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
  state.mode = stored?.mode ?? "Banking Assistant";

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
      state.artifact = null;
      closeArtifact();
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

  chatContent.querySelectorAll("[data-pf-open]").forEach((button) => {
    button.addEventListener("click", () => {
      const conversation = selectedConversation();
      const portfolio = conversation?.messages[Number(button.dataset.pfOpen)]?.portfolio;
      if (portfolio) openArtifact(portfolio);
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
    openArtifact(data);
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
  const aiNote = p.aiUsed ? `${escapeHtml(p.provider)} regrouped the redacted rows` : "grouped on-device";
  const counts = (p.groups || []).map((g) =>
    `<span class="pf-count-chip ${/high/i.test(g.tier) ? "high" : /med/i.test(g.tier) ? "medium" : "low"}">${g.count} ${escapeHtml(g.tier.replace(/ ?risk/i, ""))}</span>`).join("");
  const tags = (p.protectedByType || []).map((t) =>
    `<span class="pf-tag"><b>${t.count}</b> ${escapeHtml(t.label)}</span>`).join("");
  return `
    <div class="portfolio">
      <p class="pf-line">${escapeHtml(p.headline || "Customers grouped by risk.")} I protected <b>${p.protectedCount} sensitive values</b> on your device (${aiNote}) and restored the real names here.</p>
      <div class="pf-protected">${tags}</div>
      <div class="pf-counts">${counts}</div>
      <button class="pf-open" type="button" data-pf-open="${index}">
        <span class="pf-open-icon" aria-hidden="true"></span>
        <span class="pf-open-text"><strong>${escapeHtml(p.downloadFileName || "reorganised.xlsx")}</strong><small>${p.rowCount} rows · click to preview &amp; download</small></span>
        <span class="pf-open-arrow" aria-hidden="true">›</span>
      </button>
    </div>`;
}

// ─── Right-side artifact panel (the reorganised spreadsheet preview) ───────────
function openArtifact(portfolio) {
  state.artifact = portfolio;
  state.artifactTab = "table";
  appShell.dataset.artifact = "open";
  renderArtifact();
}

function closeArtifact() {
  appShell.dataset.artifact = "closed";
}

function renderArtifact() {
  const p = state.artifact;
  if (!p) { appShell.dataset.artifact = "closed"; return; }
  $("#artifactName").textContent = p.downloadFileName || "Reorganised file";
  $("#artifactMeta").textContent = `${p.rowCount} rows · ${p.protectedCount} values restored locally`;

  const tab = state.artifactTab || "table";
  $("#artifactTabs").querySelectorAll("[data-artifact-tab]").forEach((b) =>
    b.classList.toggle("active", b.dataset.artifactTab === tab));

  const body = $("#artifactBody");
  if (tab === "sent") {
    body.innerHTML = `
      <div class="artifact-sent">
        <p class="artifact-note">This is exactly what left your device — identities replaced with placeholders, the financial figures kept so the model could still reason.</p>
        <pre>${escapeHtml(p.redactedPreview || "")}</pre>
      </div>`;
  } else {
    body.innerHTML = artifactTableMarkup(p.preview || { headers: [], rows: [] });
  }
  $("#artifactFoot").innerHTML = `<span class="foot-dot"></span> Real values restored only on this machine — nothing identifying was sent to the model.`;
}

function artifactTableMarkup(preview) {
  const headers = preview.headers || [];
  const tierCol = preview.tierColumn;
  const tierClass = (t) => /high/i.test(t) ? "t-high" : /med/i.test(t) ? "t-med" : /low/i.test(t) ? "t-low" : "";
  const head = `<tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr>`;
  const rows = (preview.rows || []).map((r) => `<tr>${headers.map((h) => {
    const v = r[h];
    if (h === tierCol) return `<td class="tier-cell ${tierClass(v)}">${escapeHtml(String(v ?? ""))}</td>`;
    return `<td>${escapeHtml(String(v ?? ""))}</td>`;
  }).join("")}</tr>`).join("");
  return `<div class="artifact-table-wrap"><table class="artifact-table"><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
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
  return /phishing|malware|ransomware|breach|exfiltration/i.test(text);
}

function responseSections(redactedPrompt) {
  return [
    { title: "What the model received", body: redactedPrompt },
    { title: "Privacy", body: "Sensitive values were replaced with placeholders before this was sent, and restored only here on your device." },
  ];
}

function restoredResponseText(redactedPrompt, warning, findings) {
  const restored = findings.map((finding) => finding.value);
  return restored.length
    ? `Done — I worked on the guarded version and restored your local values here: ${restored.join(", ")}.`
    : "Done. No sensitive values were detected, so nothing needed to be guarded.";
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
  state.artifact = null;
  closeArtifact();
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

// Artifact panel controls
$("#artifactClose").addEventListener("click", closeArtifact);
$("#artifactDownload").addEventListener("click", () => {
  const p = state.artifact;
  if (p?.downloadXlsxBase64) downloadBase64(p.downloadXlsxBase64, p.downloadFileName || "wemik-reorganised.xlsx");
});
$("#artifactTabs").addEventListener("click", (event) => {
  const btn = event.target.closest("[data-artifact-tab]");
  if (!btn) return;
  state.artifactTab = btn.dataset.artifactTab;
  renderArtifact();
});

boot();
