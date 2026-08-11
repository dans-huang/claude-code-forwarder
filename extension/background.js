const WEBHOOK_URL = "http://localhost:5581/forward";

// Template prompts shown as quick-select buttons in the popup, in priority
// order. Click one to fill the instruction box (still editable), then Enter
// to send. Edit this list to customize.
const TEMPLATES = [
  {
    label: "Research → Slack draft",
    text: "Research this thoroughly, then draft a response right back in Slack for my later review. Draft only — never send.",
  },
  {
    label: "Update QA dashboard",
    text: "Update this task into the QA dashboard. Ensure highest clarity and reduce noise — keep only what matters, remove anything stale it supersedes.",
  },
  {
    label: "Draft email reply",
    text: "Research context as needed and draft a reply email for my later review. Draft only — never send.",
  },
];

// Listen for keyboard shortcut (Cmd+Shift+F)
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "forward-to-claude") return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  const url = tab.url || "";
  let source = null;
  if (url.includes("mail.google.com")) source = "gmail";
  else if (url.includes("app.slack.com")) source = "slack";
  else if (url.includes("web.plaud.ai")) source = "plaud";
  if (!source) return;

  const scriptFile = {
    gmail: "gmail-content.js",
    slack: "slack-content.js",
    plaud: "plaud-content.js",
  }[source];

  try {
    // Capture selected text first
    const selResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.getSelection().toString().trim(),
    });
    const selectedText = selResults?.[0]?.result || "";

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: [scriptFile],
    });

    let extracted = results?.[0]?.result;
    // If text is selected, ONLY send the selection — skip thread extraction
    if (selectedText) {
      extracted = {
        thread: [{ from: "", body: selectedText, timestamp: "" }],
        subject: extracted?.subject || null,
        plaud_file_id: extracted?.plaud_file_id || undefined,
        hint: extracted?.hint || undefined,
        selectedOnly: true,
      };
    }
    // Build a better URL if we have thread_id (Slack)
    let finalUrl = url;
    if (extracted?.thread_id) {
      const { channel_id, thread_ts } = extracted.thread_id;
      const tsNoDot = thread_ts.replace(".", "");
      finalUrl = url.replace(/\/client\/[^/]+.*/, `/client/${url.match(/T[A-Z0-9]+/)?.[0] || ""}/` + channel_id + "/thread/" + channel_id + "-" + thread_ts);
    }

    showPopup(tab.id, source, finalUrl, extracted || null);
  } catch (err) {
    console.error("Content script injection failed:", err);
    showPopup(tab.id, source, url, null);
  }
});

function showPopup(tabId, source, url, extracted) {
  chrome.scripting.executeScript({
    target: { tabId },
    func: injectInstructionPopup,
    args: [source, url, extracted, WEBHOOK_URL, TEMPLATES],
  });
}

function injectInstructionPopup(source, url, extracted, webhookUrl, templates) {
  // Remove existing popup if any
  const existing = document.getElementById("claude-forwarder-popup");
  if (existing) existing.remove();

  // Use Shadow DOM to isolate styles from host page (Slack dark mode etc.)
  const host = document.createElement("div");
  host.id = "claude-forwarder-popup";
  host.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;z-index:999999;";
  const shadow = host.attachShadow({ mode: "open" });

  const msgCount = extracted?.thread?.length || 0;
  const statusText = extracted?.selectedOnly
    ? `Selected text (${extracted.thread[0]?.body.length || 0} chars)`
    : extracted
      ? `${msgCount} message${msgCount !== 1 ? "s" : ""} extracted`
      : "Will fetch via MCP (DOM extraction failed)";

  shadow.innerHTML = `
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      .overlay {
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0,0,0,0.5);
        display: flex; align-items: center; justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        color: #333;
      }
      .card {
        background: white; border-radius: 12px; padding: 24px;
        width: 420px; max-width: 90vw;
        box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      }
      .header { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }
      .header span { font-size: 20px; }
      .header h3 { font-size: 16px; font-weight: 600; color: #111; }
      .meta { font-size: 13px; color: #666; margin-bottom: 12px; }
      .meta strong { color: #333; }
      .subject {
        font-size: 13px; color: #333; margin-bottom: 12px;
        padding: 8px; background: #f5f5f5; border-radius: 6px;
      }
      .templates {
        display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px;
      }
      .tpl {
        padding: 5px 10px; border: 1px solid #e5d5bd; border-radius: 14px;
        background: #fdf8f0; color: #92600a; cursor: pointer;
        font-size: 12px; font-family: inherit; line-height: 1.3;
      }
      .tpl:hover { background: #f7ecd9; }
      .tpl.active { background: #D97706; border-color: #D97706; color: white; }
      textarea {
        width: 100%; height: 80px; border: 1px solid #ddd; border-radius: 8px;
        padding: 10px; font-size: 14px; resize: vertical;
        font-family: inherit; color: #333; background: white;
      }
      textarea::placeholder { color: #999; }
      .hints {
        display: flex; gap: 12px; margin-top: 6px; font-size: 11px; color: #999;
      }
      .hints kbd {
        background: #f0f0f0; border: 1px solid #ddd; border-radius: 3px;
        padding: 1px 4px; font-family: inherit; font-size: 10px;
      }
      .buttons { display: flex; gap: 8px; margin-top: 12px; justify-content: flex-end; }
      .btn-cancel {
        padding: 8px 16px; border: 1px solid #ddd; border-radius: 6px;
        background: white; cursor: pointer; font-size: 14px; color: #333;
      }
      .btn-send {
        padding: 8px 16px; border: none; border-radius: 6px;
        background: #D97706; color: white; cursor: pointer;
        font-size: 14px; font-weight: 500;
      }
      .btn-send:disabled { opacity: 0.6; cursor: default; }
      .status { margin-top: 12px; font-size: 13px; display: none; }
    </style>
    <div class="overlay">
      <div class="card">
        <div class="header">
          <span>&#x1F4E8;</span>
          <h3>Send to Claude Code</h3>
        </div>
        <div class="meta">
          Source: <strong>${source}</strong> &middot; ${statusText}
        </div>
        ${extracted?.subject ? `<div class="subject">${extracted.subject}</div>` : ""}
        <div class="templates" id="templates"></div>
        <textarea id="instruction" placeholder="Add instruction (e.g. draft reply, summarize, research this...)"></textarea>
        <div class="hints">
          <span><kbd>1</kbd>–<kbd>${Math.min(templates?.length || 0, 9)}</kbd> template</span>
          <span><kbd>Enter</kbd> send</span>
          <span><kbd>Shift+Enter</kbd> new line</span>
          <span><kbd>Esc</kbd> cancel</span>
        </div>
        <div class="buttons">
          <button class="btn-cancel" id="cancel">Cancel</button>
          <button class="btn-send" id="send">Send</button>
        </div>
        <div class="status" id="status"></div>
      </div>
    </div>
  `;

  document.body.appendChild(host);

  const overlay = shadow.querySelector(".overlay");
  const cancelBtn = shadow.getElementById("cancel");
  const sendBtn = shadow.getElementById("send");
  const statusEl = shadow.getElementById("status");
  const textarea = shadow.getElementById("instruction");

  // Template quick-select buttons
  const tplRow = shadow.getElementById("templates");
  const tplButtons = [];
  (templates || []).forEach((tpl, i) => {
    const btn = document.createElement("button");
    btn.className = "tpl";
    btn.textContent = (i < 9 ? `${i + 1} · ` : "") + tpl.label;
    btn.title = tpl.text;
    btn.addEventListener("click", () => selectTemplate(i));
    tplRow.appendChild(btn);
    tplButtons.push(btn);
  });

  function selectTemplate(i) {
    const tpl = (templates || [])[i];
    if (!tpl) return;
    textarea.value = tpl.text;
    tplButtons.forEach((b, j) => b.classList.toggle("active", i === j));
    textarea.focus();
  }

  // Digit 1-9 picks a template while the instruction box is still empty
  // or holds an unedited template (typing a real instruction disables it)
  function digitPicksTemplate(e) {
    if (e.key < "1" || e.key > "9" || e.metaKey || e.ctrlKey || e.altKey) return false;
    const v = textarea.value;
    if (v !== "" && !(templates || []).some((t) => t.text === v)) return false;
    const i = parseInt(e.key, 10) - 1;
    if (!(templates || [])[i]) return false;
    selectTemplate(i);
    return true;
  }

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) host.remove();
  });

  cancelBtn.addEventListener("click", () => host.remove());

  document.addEventListener("keydown", function escHandler(e) {
    if (e.key === "Escape") {
      host.remove();
      document.removeEventListener("keydown", escHandler);
    }
  });

  // Force focus into shadow DOM textarea — Slack aggressively reclaims focus
  textarea.focus();
  setTimeout(() => textarea.focus(), 50);
  setTimeout(() => textarea.focus(), 200);

  // Block all keyboard events from reaching the host page while popup is open
  function trapKeyboard(e) {
    e.stopPropagation();
  }
  host.addEventListener("keydown", trapKeyboard, true);
  host.addEventListener("keyup", trapKeyboard, true);
  host.addEventListener("keypress", trapKeyboard, true);

  // Also intercept at document level to prevent Slack from stealing keys
  function blockSlackKeys(e) {
    if (!document.getElementById("claude-forwarder-popup")) return;
    if (e.key === "Escape") {
      host.remove();
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // Enter = send (Shift+Enter = newline)
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      shadow.getElementById("send")?.click();
      return;
    }
    if (e.type === "keydown" && digitPicksTemplate(e)) {
      e.preventDefault();
    }
    e.stopPropagation();
  }
  document.addEventListener("keydown", blockSlackKeys, true);
  document.addEventListener("keyup", blockSlackKeys, true);
  document.addEventListener("keypress", blockSlackKeys, true);

  // Clean up event listeners when popup is removed
  const observer = new MutationObserver(() => {
    if (!document.getElementById("claude-forwarder-popup")) {
      document.removeEventListener("keydown", blockSlackKeys, true);
      document.removeEventListener("keyup", blockSlackKeys, true);
      document.removeEventListener("keypress", blockSlackKeys, true);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true });

  sendBtn.addEventListener("click", async () => {
    const instruction = textarea.value.trim();

    sendBtn.disabled = true;
    sendBtn.textContent = "Sending...";
    statusEl.style.display = "block";
    statusEl.style.color = "#666";
    statusEl.textContent = "Forwarding to Claude Code...";

    const payload = {
      source,
      url,
      extraction_method: extracted ? "dom" : "url_only",
      instruction: instruction || "",
    };

    if (extracted) {
      if (extracted.subject) payload.subject = extracted.subject;
      if (extracted.thread) payload.thread = extracted.thread;
      if (extracted.thread_id) payload.thread_id = extracted.thread_id;
      if (extracted.gmail_thread_id) payload.gmail_thread_id = extracted.gmail_thread_id;
      if (extracted.plaud_file_id) payload.plaud_file_id = extracted.plaud_file_id;
      if (extracted.hint) payload.hint = extracted.hint;
    }

    try {
      const resp = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await resp.json();

      if (data.ok) {
        statusEl.style.color = "#16a34a";
        statusEl.textContent = `Sent! Session: ${data.session_name}`;
        setTimeout(() => host.remove(), 1500);
      } else {
        statusEl.style.color = "#dc2626";
        statusEl.textContent = `Error: ${data.error}`;
        sendBtn.disabled = false;
        sendBtn.textContent = "Send";
      }
    } catch (err) {
      statusEl.style.color = "#dc2626";
      statusEl.textContent = `Connection failed. Is the webhook running? (localhost:5581)`;
      sendBtn.disabled = false;
      sendBtn.textContent = "Send";
    }
  });

  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendBtn.click();
    }
  });
}
