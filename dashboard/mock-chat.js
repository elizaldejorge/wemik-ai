const STORAGE_KEY = "wemik.mockChat.v3";

// ─── Inline SVG icons (no emoji, ever) ────────────────────────────────────────
const ICONS = {
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  close: '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  chevron: '<polyline points="9 6 15 12 9 18"/>',
  shield: '<path d="M12 3l7 3v5c0 4.4-3 7.4-7 8.6C8 21.4 5 18.4 5 14V6z"/><polyline points="9.2 12 11.3 14.2 15 10.3"/>',
  sheet: '<rect x="4" y="3" width="16" height="18" rx="2"/><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="12" y1="9" x2="12" y2="21"/>',
  doc: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 3 14 8 20 8"/>',
  sparkle: '<path d="M12 3l1.7 5L19 9.7l-5.3 1.7L12 17l-1.7-5.6L5 9.7l5.3-1.7z"/>',
  read: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  send: '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="6 11 12 5 18 11"/>',
};
function icon(name, cls = "") {
  return `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
}
function fileExt(name) { const m = /\.([a-z0-9]+)$/i.exec(String(name || "")); return (m ? m[1] : "file").toUpperCase(); }
function fileThumb(name) {
  const ext = fileExt(name);
  const isSheet = /^(xlsx|xls|csv)$/i.test(ext);
  return `<span class="file-thumb ${isSheet ? "sheet" : "doc"}">${icon(isSheet ? "sheet" : "doc")}<b>${escapeHtml(ext)}</b></span>`;
}

const quickPrompts = [
  "Draft bilingual (EN + AR) payment reminders for overdue customers.",
  "Summarise an uploaded loan application and flag what's missing.",
  "Group a customer portfolio by credit-risk tier.",
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
  const conversations = state.conversations.map((c) => ({
    ...c,
    messages: c.messages.filter((m) => !m.thinking && !m.progress),
  }));
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    conversations,
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
      ${fileThumb(state.pendingFile.name)}
      <span class="att-text"><strong>${escapeHtml(state.pendingFile.name)}</strong><small>${fileExt(state.pendingFile.name)} · ${kb} KB · guarded on device</small></span>
      <button class="remove-attach" type="button" id="removeAttach" aria-label="Remove file">${icon("close")}</button>
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
  const bubbleInner = message.progress
    ? `<span class="progress-row">${icon(message.icon || "sparkle")}<span class="prog-text">${escapeHtml(message.text || "")}</span><span class="prog-dots"><i></i><i></i><i></i></span></span>`
    : message.portfolio
      ? portfolioMarkup(message.portfolio, index)
      : message.sections
        ? sectionsMarkup(message.sections)
        : message.attachment
          ? `${attachmentMarkup(message.attachment)}${message.text ? `<div class="att-instruction">${escapeHtml(message.text)}</div>` : ""}`
          : escapeHtml(message.text);
  const showCopyRetry = isAssistant && !message.thinking && !message.progress && !message.portfolio;
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
  const replyText = restoredResponseText(userMessage.guard.redactedText, warning, userMessage.guard.findings);
  conversation.messages.push({
    role: "assistant",
    text: replyText,
    state: warning ? "warning" : "success",
    severity: warning ? "warning" : undefined,
    guard: { ...userMessage.guard, providerPrompt: userMessage.guard.redactedText },
  });
  setMascot(warning ? "warning" : "success");
  render();
  const bubble = chatContent.querySelector(".message.assistant:last-of-type .bubble");
  setComposerBusy(false);
  typeText(bubble, replyText, { ticks: 80 }); // non-blocking
  setTimeout(() => { state.mascot = "idle"; updateMascotStatus(); }, 900);
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
  setMascot("thinking");
  render();

  // Do the real work immediately, in parallel with the staged progress UI.
  const work = fetch("/api/chat/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileName: file.name, instruction: prompt, fileBase64: file.base64 }),
  }).then((r) => r.json().then((d) => ({ ok: r.ok, d }))).catch((e) => ({ ok: false, d: { error: e.message } }));

  // Staged, human-paced progress. Each line types out, dwells so it's readable,
  // and the heavy phases scale with how many messages are actually being produced.
  await progressStep("sheet", "Reading the spreadsheet…", 600);
  await progressStep("shield", "Redacting names, QIDs and account numbers on your device…", 800);

  const { ok, d } = await work;
  if (!ok || !d.ok) {
    clearProgress();
    conversation.messages.push({
      role: "assistant", state: "error", severity: "error",
      text: `Wemik could not process that file: ${escapeHtml(d.error || "unknown error")}. Nothing was sent off the device.`,
    });
    finishResponse("error", 1400);
    return;
  }

  if (d.mode === "draft") {
    const n = d.draftedCount || 0;
    await progressStep("read", "Finding the accounts that need a reminder…", 700);
    await progressStep("sparkle", `Drafting a personalised message for ${n} overdue account${n === 1 ? "" : "s"}…`, clamp(n * 110, 1800, 5500));
    await progressStep("sparkle", `Translating all ${n} message${n === 1 ? "" : "s"} into Arabic…`, clamp(n * 70, 1400, 3800));
    await progressStep("download", "Restoring the real names locally…", 700);
  } else {
    await progressStep("sparkle", "Sending only the redacted rows to the model…", clamp((d.rowCount || 0) * 30, 1800, 4200));
    await progressStep("download", "Restoring the real values locally…", 900);
  }
  clearProgress();
  conversation.messages.push({ role: "assistant", state: "success", portfolio: d });
  setMascot("success");
  render();
  const lineEl = chatContent.querySelector(".message.assistant:last-of-type .pf-line > span:last-child");
  const fullLine = lineEl ? lineEl.textContent : "";
  setComposerBusy(false);                          // release the composer right away
  if (lineEl) typeText(lineEl, fullLine, { ticks: 90 }); // cosmetic typing, non-blocking
  await delay(280);
  openArtifact(d);                                 // panel slides in a beat later
  setTimeout(() => { state.mascot = "idle"; updateMascotStatus(); }, 1200);
}

// Show a live status line — types out like a human, readable, dots keep pulsing.
async function showProgress(iconName, text) {
  const conversation = selectedConversation();
  if (!conversation) return;
  let msg = conversation.messages.find((m) => m.progress);
  if (!msg) {
    msg = { role: "assistant", progress: true, state: "thinking", icon: iconName, text: "" };
    conversation.messages.push(msg);
    render();
  }
  msg.icon = iconName;
  msg.text = text;
  let row = chatContent.querySelector(".progress-row");
  if (!row) { render(); row = chatContent.querySelector(".progress-row"); }
  if (!row) return;
  // rebuild in place (no full re-render → list doesn't re-animate), then type the line
  row.innerHTML = `${icon(iconName)}<span class="prog-text"></span><span class="prog-dots"><i></i><i></i><i></i></span>`;
  await typeText(row.querySelector(".prog-text"), text, { ticks: text.length, intervalMs: 30, caret: false });
}

// One readable status step: type the line, then dwell so the user can read it.
async function progressStep(iconName, text, dwellMs) {
  await showProgress(iconName, text);
  await delay(dwellMs);
}

function clearProgress() {
  const conversation = selectedConversation();
  if (conversation) conversation.messages = conversation.messages.filter((m) => !m.progress);
}

function attachmentMarkup(att) {
  return `<div class="file-card">${fileThumb(att.name)}<span class="att-text"><strong>${escapeHtml(att.name)}</strong><small>guarded locally</small></span></div>`;
}

function portfolioMarkup(p, index) {
  const tags = (p.protectedByType || []).map((t) =>
    `<span class="pf-tag"><b>${t.count}</b> ${escapeHtml(t.label)}</span>`).join("");

  if (p.mode === "draft") {
    const aiNote = p.aiUsed ? `drafted by ${escapeHtml(p.provider)}` : "drafted on-device";
    return `
      <div class="portfolio">
        <p class="pf-line"><span class="pf-shield">${icon("shield")}</span><span>${escapeHtml(p.headline || "Drafted messages.")} I protected <b>${p.protectedCount} sensitive values</b> on your device (${aiNote}); the model only ever saw placeholders, and the real names appear only in your copy.</span></p>
        <div class="pf-protected">${tags}</div>
        <button class="pf-open" type="button" data-pf-open="${index}">
          ${fileThumb(p.downloadFileName || "messages.xlsx")}
          <span class="pf-open-text"><strong>${escapeHtml(p.downloadFileName || "messages.xlsx")}</strong><small>${p.draftedCount} message${p.draftedCount === 1 ? "" : "s"} · click to preview &amp; download</small></span>
          ${icon("chevron", "pf-open-arrow")}
        </button>
      </div>`;
  }

  const aiNote = p.aiUsed ? `${escapeHtml(p.provider)} regrouped the redacted rows` : "grouped on-device";
  const counts = (p.groups || []).map((g) =>
    `<span class="pf-count-chip ${/high/i.test(g.tier) ? "high" : /med/i.test(g.tier) ? "medium" : "low"}">${g.count} ${escapeHtml(g.tier.replace(/ ?risk/i, ""))}</span>`).join("");
  return `
    <div class="portfolio">
      <p class="pf-line"><span class="pf-shield">${icon("shield")}</span><span>${escapeHtml(p.headline || "Customers grouped by risk.")} I protected <b>${p.protectedCount} sensitive values</b> on your device (${aiNote}) and restored the real names here.</span></p>
      <div class="pf-protected">${tags}</div>
      <div class="pf-counts">${counts}</div>
      <button class="pf-open" type="button" data-pf-open="${index}">
        ${fileThumb(p.downloadFileName || "reorganised.xlsx")}
        <span class="pf-open-text"><strong>${escapeHtml(p.downloadFileName || "reorganised.xlsx")}</strong><small>${p.rowCount} rows · click to preview &amp; download</small></span>
        ${icon("chevron", "pf-open-arrow")}
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
  const isDraft = p.mode === "draft";
  $("#artifactName").textContent = p.downloadFileName || "Output file";
  $("#artifactMeta").textContent = isDraft
    ? `${p.draftedCount} message${p.draftedCount === 1 ? "" : "s"} · ${p.protectedCount} values restored locally`
    : `${p.rowCount} rows · ${p.protectedCount} values restored locally`;

  const tab = state.artifactTab || "table";
  const tabs = $("#artifactTabs").querySelectorAll("[data-artifact-tab]");
  tabs[0].textContent = isDraft ? "Drafted messages" : "Reorganised sheet";
  tabs.forEach((b) => b.classList.toggle("active", b.dataset.artifactTab === tab));

  const body = $("#artifactBody");
  if (tab === "sent") {
    body.innerHTML = `
      <div class="artifact-sent">
        <p class="artifact-note">${isDraft
          ? "This is exactly what left your device — the message the model drafted, using placeholders only. The real name was filled in locally afterwards."
          : "This is exactly what left your device — identities replaced with placeholders, the financial figures kept so the model could still reason."}</p>
        <pre dir="auto">${escapeHtml(p.redactedPreview || "")}</pre>
      </div>`;
  } else {
    body.innerHTML = isDraft
      ? artifactLettersMarkup(p.letters || [])
      : artifactTableMarkup(p.preview || { headers: [], rows: [] });
  }
  $("#artifactFoot").innerHTML = `<span class="foot-dot"></span> Real values restored only on this machine — nothing identifying was sent to the model.`;
}

function artifactLettersMarkup(letters) {
  return `<div class="letters">${letters.map((l) => {
    const initial = (String(l.name || "?").trim()[0] || "?").toUpperCase();
    return `
      <div class="letter-card">
        <div class="letter-head"><span class="letter-avatar">${escapeHtml(initial)}</span><strong>${escapeHtml(l.name)}</strong></div>
        <div class="letter-pane"><span class="letter-lang">English</span><p>${escapeHtml(l.en || "")}</p></div>
        <div class="letter-pane ar" dir="rtl" lang="ar"><span class="letter-lang">العربية</span><p>${escapeHtml(l.ar || "")}</p></div>
      </div>`;
  }).join("")}</div>`;
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
  setComposerBusy(false);
  setMascot(mascotState);
  render();
  // reset the ambient mascot without a full re-render (keeps entrance animations from replaying)
  setTimeout(() => { state.mascot = "idle"; updateMascotStatus(); }, returnDelay || 900);
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

// Human-like typewriter — types `text` into `el`. `ticks` controls how many
// keystrokes; with ticks=text.length you get a constant readable speed.
function typeText(el, text, { ticks = 150, intervalMs = 17, caret = true } = {}) {
  return new Promise((resolve) => {
    if (!el) return resolve();
    const full = String(text ?? "");
    const step = Math.max(1, Math.ceil(full.length / ticks));
    el.textContent = "";
    if (caret) el.classList.add("type-caret");
    let i = 0;
    const tick = () => {
      i += step;
      el.textContent = full.slice(0, i);
      chatContent.scrollTop = chatContent.scrollHeight;
      if (i < full.length) setTimeout(tick, intervalMs);
      else { el.classList.remove("type-caret"); resolve(); }
    };
    tick();
  });
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

// Update the send button without re-rendering (so animations don't replay).
function setComposerBusy(isBusy) {
  state.busy = isBusy;
  sendButton.disabled = isBusy || (input.value.trim().length === 0 && !state.pendingFile);
  sendButton.classList.toggle("loading", isBusy);
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
    input.value = "Draft a short bilingual (English + Arabic) payment reminder for each overdue customer.";
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
  // update only the send button — avoid re-rendering (and re-animating) the chat on every keystroke
  sendButton.disabled = state.busy || (input.value.trim().length === 0 && !state.pendingFile);
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
