const WEBHOOK_URL = "http://localhost:5581/forward";
const PROJECTS_URL = "http://localhost:5581/projects";
const VALIDATE_URL = "http://localhost:5581/projects/validate";
const STATUS_URL = "http://localhost:5581/status";

const DESTINATIONS = [
  {
    id: "claude",
    name: "Claude Code",
    detail: "New interactive desktop session",
    mark: "C",
  },
  {
    id: "codex",
    name: "Codex",
    detail: "New interactive desktop session",
    mark: "X",
  },
  {
    id: "claude_headless",
    name: "Background",
    detail: "Runs headless; notifies when done",
    mark: "↗",
  },
];

const MAX_RECENT_PROJECTS = 6;
const MAX_RECENTS_SHOWN = 4;

// ── Project memory ───────────────────────────────────────────────
// One chrome.storage.local key remembers project choices:
//   { last, recents: [path], byDomain: { hostname: path } }
// The stored paths are hints for the popup only — the webhook re-validates
// every workspace server-side before opening anything.

function normalizeProjectMemory(raw) {
  const memory = raw && typeof raw === "object" ? raw : {};
  return {
    last: typeof memory.last === "string" ? memory.last : null,
    recents: Array.isArray(memory.recents)
      ? memory.recents
          .filter((path) => typeof path === "string" && path)
          .slice(0, MAX_RECENT_PROJECTS)
      : [],
    byDomain:
      memory.byDomain && typeof memory.byDomain === "object"
        ? { ...memory.byDomain }
        : {},
  };
}

async function getProjectMemory() {
  const stored = await chrome.storage.local.get("projectMemory");
  return normalizeProjectMemory(stored?.projectMemory);
}

async function saveProjectMemory(memory) {
  await chrome.storage.local.set({ projectMemory: memory });
}

// Pure: fold one successful forward into the remembered state.
// Explicit choices update the per-site mapping; picking the general
// workspace explicitly clears the mapping (back to the default).
function applyProjectSelection(rawMemory, selection) {
  const memory = normalizeProjectMemory(rawMemory);
  const { path, domain, explicit, generalPath } = selection || {};
  if (typeof path !== "string" || !path) return memory;
  memory.last = path;
  if (path !== generalPath) {
    memory.recents = [
      path,
      ...memory.recents.filter((recent) => recent !== path),
    ].slice(0, MAX_RECENT_PROJECTS);
  }
  if (explicit && domain) {
    if (path === generalPath) delete memory.byDomain[domain];
    else memory.byDomain[domain] = path;
  }
  return memory;
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function findProjectIn(list, path) {
  if (!list || !path) return null;
  if (list.general?.path === path) {
    return { path, name: list.general.name };
  }
  const hit = (list.projects || []).find((project) => project.path === path);
  return hit ? { path: hit.path, name: hit.name } : null;
}

async function fetchProjectList() {
  const response = await fetch(PROJECTS_URL);
  const data = await response.json();
  if (!data?.ok) throw new Error(data?.error || "project list unavailable");
  return data;
}

async function validateWorkspace(path) {
  try {
    const response = await fetch(VALIDATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    return await response.json();
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

// Everything the popup needs to render the project selector. When the
// webhook is unreachable this resolves to {available:false}: the popup then
// pins the selector to the general workspace and omits `workspace` from the
// payload (the exact pre-1.6 behavior).
async function buildProjectContext(pageUrl) {
  const domain = hostnameOf(pageUrl);
  let list;
  try {
    list = await fetchProjectList();
  } catch {
    return { available: false, domain };
  }
  const memory = await getProjectMemory();
  let auto = {
    path: list.general.path,
    name: list.general.name,
    source: "default",
  };
  const mapped = memory.byDomain[domain];
  if (mapped) {
    const known = findProjectIn(list, mapped);
    if (known) {
      auto = { ...known, source: "site" };
    } else {
      // A remembered custom folder: confirm it is still valid before
      // trusting it. Uncertain → stay on the general workspace.
      const checked = await validateWorkspace(mapped);
      if (checked?.ok) {
        auto = { path: checked.path, name: checked.name, source: "site" };
      }
    }
  }
  const recents = memory.recents
    .filter((path) => path !== list.general.path)
    .map(
      (path) =>
        findProjectIn(list, path) || {
          path,
          name: path.split("/").filter(Boolean).pop() || path,
        },
    )
    .slice(0, MAX_RECENTS_SHOWN);
  return {
    available: true,
    domain,
    general: list.general,
    projects: list.projects || [],
    recents,
    auto,
  };
}

// Background jobs are headless and finish with a system notification. The
// popup only reports what is in flight right now, so a running job is still
// visible at a glance without a permanently polling menu bar app.
async function fetchBackgroundJobs() {
  try {
    const response = await fetch(STATUS_URL);
    const data = await response.json();
    if (!data?.ok) return null;
    return {
      running: data.active_jobs || 0,
      queued: data.queued_jobs || 0,
      errors: data.error_jobs || 0,
    };
  } catch {
    return null;
  }
}

// Keep localhost access in the extension service worker. Page scripts never
// receive direct CORS access to the Forwarder, so an arbitrary website cannot
// start a background job or open desktop sessions on the user's behalf.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "forward-request" && message.payload) {
    (async () => {
      try {
        const response = await fetch(WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(message.payload),
        });
        const data = await response.json();
        if (data?.ok && message.project?.path) {
          const memory = await getProjectMemory();
          await saveProjectMemory(
            applyProjectSelection(memory, message.project),
          );
        }
        sendResponse({ transportOk: true, data });
      } catch (error) {
        sendResponse({ transportOk: false, error: String(error) });
      }
    })();
    return true;
  }

  if (message?.type === "validate-workspace") {
    validateWorkspace(message.path).then(sendResponse);
    return true;
  }

  if (message?.type === "clear-project-mapping") {
    (async () => {
      const memory = await getProjectMemory();
      delete memory.byDomain[message.domain];
      await saveProjectMemory(memory);
      sendResponse({ ok: true });
    })().catch(() => sendResponse({ ok: false }));
    return true;
  }

  return false;
});

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
  // Extensions can't inject into chrome:// pages, the Web Store, etc.
  if (!/^https?:/.test(url)) return;

  // Dedicated extractors for known sites; everything else falls back to the
  // generic web extractor so the hotkey always responds.
  let source = "web";
  if (url.includes("mail.google.com")) source = "gmail";
  else if (url.includes("app.slack.com")) source = "slack";
  else if (url.includes("web.plaud.ai")) source = "plaud";
  else if (/\.zendesk\.com\/agent\//.test(url)) source = "zendesk";
  else if (/\.atlassian\.net\//.test(url)) source = "jira";

  const scriptFile = {
    gmail: "gmail-content.js",
    slack: "slack-content.js",
    plaud: "plaud-content.js",
    zendesk: "zendesk-content.js",
    jira: "jira-content.js",
    web: "web-content.js",
  }[source];

  // Resolve the project selector and background-job state up front so the
  // popup renders complete. Both degrade cleanly when the webhook is down,
  // and they run together so the popup is not delayed twice.
  const [projectContext, backgroundJobs] = await Promise.all([
    buildProjectContext(url),
    fetchBackgroundJobs(),
  ]);

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
        zendesk_ticket_id: extracted?.zendesk_ticket_id || undefined,
        jira_issue_key: extracted?.jira_issue_key || undefined,
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

    showPopup(tab.id, source, finalUrl, extracted || null, projectContext, backgroundJobs);
  } catch (err) {
    console.error("Content script injection failed:", err);
    showPopup(tab.id, source, url, null, projectContext, backgroundJobs);
  }
});

function showPopup(tabId, source, url, extracted, projectContext, backgroundJobs) {
  chrome.scripting.executeScript({
    target: { tabId },
    func: injectInstructionPopup,
    args: [
      source, url, extracted, TEMPLATES, DESTINATIONS,
      projectContext || null, backgroundJobs || null,
    ],
  });
}

function injectInstructionPopup(source, url, extracted, templates, destinations, projectContext, backgroundJobs) {
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

  // Only worth showing when something is actually in flight; an idle line
  // would just be noise on every forward.
  const jobParts = [];
  if (backgroundJobs?.running) jobParts.push(`${backgroundJobs.running} running`);
  if (backgroundJobs?.queued) jobParts.push(`${backgroundJobs.queued} queued`);
  if (backgroundJobs?.errors) jobParts.push(`${backgroundJobs.errors} failed`);
  const jobsText = jobParts.length ? `Background: ${jobParts.join(" · ")}` : "";

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;",
    })[char]);
  }

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
        background: #fcfbf8; border: 1px solid rgba(255,255,255,0.7);
        border-radius: 18px; padding: 22px;
        width: 460px; max-width: 92vw;
        max-height: 92vh; overflow-y: auto;
        box-shadow: 0 24px 80px rgba(17,24,39,0.28);
      }
      .header { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
      .header-mark {
        width: 30px; height: 30px; border-radius: 9px; display: grid;
        place-items: center; background: #171717; color: #fff;
        font-size: 15px; font-weight: 700;
      }
      .header h3 { font-size: 17px; font-weight: 650; letter-spacing: -0.01em; color: #171717; }
      .meta { font-size: 13px; color: #666; margin-bottom: 12px; }
      .meta strong { color: #333; }
      .subject {
        font-size: 13px; color: #333; margin-bottom: 12px;
        padding: 8px; background: #f5f5f5; border-radius: 6px;
      }
      .section-label {
        color: #73706a; font-size: 11px; font-weight: 700;
        letter-spacing: .08em; text-transform: uppercase; margin: 14px 0 7px;
      }
      .destinations {
        display: grid; grid-template-columns: repeat(3, 1fr); gap: 7px;
      }
      .destination {
        min-width: 0; padding: 10px; border: 1px solid #ddd9d1;
        border-radius: 10px; background: rgba(255,255,255,.72); color: #292724;
        cursor: pointer; text-align: left; font: inherit;
        transition: border-color 120ms ease, background 120ms ease, transform 120ms ease;
      }
      .destination:hover { border-color: #b9b3a8; transform: translateY(-1px); }
      .destination[aria-pressed="true"] {
        background: #171717; border-color: #171717; color: #fff;
      }
      .destination-top { display: flex; align-items: center; gap: 6px; }
      .destination-mark {
        width: 20px; height: 20px; border-radius: 6px; display: grid;
        place-items: center; background: #eeeae3; color: #292724;
        font-size: 10px; font-weight: 800; flex: 0 0 auto;
      }
      .destination[aria-pressed="true"] .destination-mark {
        background: #fff; color: #171717;
      }
      .destination-name { font-size: 13px; font-weight: 700; white-space: nowrap; }
      .destination-detail {
        display: block; margin-top: 5px; color: #77726a;
        font-size: 11px; line-height: 1.3;
      }
      .destination[aria-pressed="true"] .destination-detail { color: #cfcac1; }
      .project-select {
        width: 100%; padding: 7px 9px; font: inherit; font-size: 13px;
        color: #292724; background: rgba(255,255,255,.85);
        border: 1px solid #ddd9d1; border-radius: 9px; cursor: pointer;
      }
      .project-select:disabled { color: #8a857c; cursor: default; }
      .project-select:focus-visible { outline: 2px solid #171717; outline-offset: 1px; }
      .project-info {
        display: flex; align-items: baseline; justify-content: space-between;
        gap: 10px; margin-top: 5px; min-height: 15px;
      }
      .project-path {
        font-size: 11px; color: #8a857c; overflow: hidden;
        text-overflow: ellipsis; white-space: nowrap;
      }
      .project-clear {
        flex: 0 0 auto; font-family: inherit; font-size: 11px; color: #92600a;
        background: none; border: none; padding: 0; cursor: pointer;
        text-decoration: underline;
      }
      .project-clear:hover { color: #6d4707; }
      .project-custom { margin-top: 6px; }
      .project-custom input {
        width: 100%; padding: 7px 9px; font-size: 12px; color: #333;
        font-family: ui-monospace, Menlo, monospace;
        border: 1px solid #ddd9d1; border-radius: 8px; background: white;
      }
      .project-custom input::placeholder { color: #999; font-family: inherit; }
      .project-error {
        display: none; margin-top: 4px; font-size: 11px; color: #dc2626;
      }
      .jobs-note {
        display: flex; align-items: center; gap: 6px; margin-bottom: 12px;
        padding: 7px 9px; border-radius: 8px;
        background: #f4f1ea; color: #6b675f;
        font-size: 12px; line-height: 1.3;
      }
      .jobs-note .dot {
        width: 6px; height: 6px; border-radius: 50%; background: #92600a;
        flex: 0 0 auto;
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
        padding: 9px 16px; border: none; border-radius: 8px;
        background: #171717; color: white; cursor: pointer;
        font-size: 13px; font-weight: 650;
      }
      .btn-send:disabled { opacity: 0.6; cursor: default; }
      .status { margin-top: 12px; font-size: 13px; display: none; }
      @media (max-width: 520px) {
        .destinations { grid-template-columns: 1fr; }
        .destination { padding: 9px 10px; }
        .destination-detail { margin: 2px 0 0 26px; }
      }
    </style>
    <div class="overlay">
      <div class="card">
        <div class="header">
          <span class="header-mark">F</span>
          <h3>Forward this work</h3>
        </div>
        <div class="meta">
          Source: <strong>${escapeHtml(source)}</strong> &middot; ${escapeHtml(statusText)}
        </div>
        ${extracted?.subject ? `<div class="subject">${escapeHtml(extracted.subject)}</div>` : ""}
        ${jobsText ? `<div class="jobs-note"><span class="dot"></span>${escapeHtml(jobsText)}</div>` : ""}
        <div class="section-label">Open in</div>
        <div class="destinations" id="destinations"></div>
        <div id="project-section">
          <div class="section-label">Project</div>
          <select class="project-select" id="project-select" aria-label="Project to open the session in"></select>
          <div class="project-custom" id="project-custom" style="display:none">
            <input id="project-custom-input" type="text" spellcheck="false"
              placeholder="/path/to/project — Enter to confirm"
              aria-label="Project folder path">
            <div class="project-error" id="project-error" role="alert"></div>
          </div>
          <div class="project-info">
            <span class="project-path" id="project-path"></span>
            <button type="button" class="project-clear" id="project-clear"
              style="display:none" title="Stop remembering this project for this site">Forget for this site</button>
          </div>
        </div>
        <div class="section-label">Instruction</div>
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
          <button class="btn-send" id="send">Open new Claude Code session</button>
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
  let selectedDestination = "claude";

  // ── Project selector ───────────────────────────────────────────
  const ctx = projectContext && projectContext.available ? projectContext : null;
  const projectSection = shadow.getElementById("project-section");
  const projectSelect = shadow.getElementById("project-select");
  const customBox = shadow.getElementById("project-custom");
  const customInput = shadow.getElementById("project-custom-input");
  const projectErrorEl = shadow.getElementById("project-error");
  const projectPathEl = shadow.getElementById("project-path");
  const projectClearBtn = shadow.getElementById("project-clear");
  const projectNames = {};
  let autoOption = null;
  let chooseOption = null;

  function shortenPath(path) {
    return String(path || "").replace(/^\/Users\/[^/]+/, "~");
  }

  if (!ctx) {
    projectSelect.appendChild(new Option("General workspace (default)", "__general__"));
    projectSelect.disabled = true;
    projectPathEl.textContent = "Project list unavailable — opens in the general workspace";
  } else {
    autoOption = new Option(`Auto · ${ctx.auto.name}`, "__auto__");
    projectSelect.appendChild(autoOption);
    projectSelect.appendChild(new Option(ctx.general.name, "__general__"));
    projectNames[ctx.general.path] = ctx.general.name;
    const recentPaths = new Set();
    if (ctx.recents.length) {
      const group = document.createElement("optgroup");
      group.label = "Recent";
      ctx.recents.forEach((project) => {
        recentPaths.add(project.path);
        projectNames[project.path] = project.name;
        group.appendChild(new Option(project.name, project.path));
      });
      projectSelect.appendChild(group);
    }
    const discovered = (ctx.projects || []).filter(
      (project) => !recentPaths.has(project.path),
    );
    if (discovered.length) {
      const group = document.createElement("optgroup");
      group.label = "Projects";
      discovered.forEach((project) => {
        projectNames[project.path] = project.name;
        group.appendChild(new Option(project.name, project.path));
      });
      projectSelect.appendChild(group);
    }
    chooseOption = new Option("Choose folder…", "__choose__");
    projectSelect.appendChild(chooseOption);
  }

  function currentProject() {
    if (!ctx) return null;
    const value = projectSelect.value;
    if (value === "__auto__") {
      return { path: ctx.auto.path, name: ctx.auto.name, explicit: false };
    }
    if (value === "__general__") {
      return { path: ctx.general.path, name: ctx.general.name, explicit: true };
    }
    if (value === "__choose__") return null;
    return { path: value, name: projectNames[value] || value, explicit: true };
  }

  function updateProjectDisplay() {
    if (!ctx) return;
    const choosing = projectSelect.value === "__choose__";
    customBox.style.display = choosing ? "block" : "none";
    if (choosing) {
      projectPathEl.textContent = "Paste a project folder path, then press Enter";
      projectPathEl.removeAttribute("title");
      projectClearBtn.style.display = "none";
      customInput.focus();
      return;
    }
    projectErrorEl.style.display = "none";
    const project = currentProject();
    projectPathEl.textContent = project ? `Opens in ${shortenPath(project.path)}` : "";
    if (project) projectPathEl.title = project.path;
    projectClearBtn.style.display =
      projectSelect.value === "__auto__" && ctx.auto.source === "site" ? "" : "none";
  }

  async function confirmCustomPath() {
    const raw = customInput.value.trim();
    if (!raw) return;
    projectErrorEl.style.display = "none";
    customInput.disabled = true;
    let result;
    try {
      result = await chrome.runtime.sendMessage({
        type: "validate-workspace",
        path: raw,
      });
    } catch (error) {
      result = { ok: false, error: "Forwarder unavailable (localhost:5581)" };
    }
    customInput.disabled = false;
    if (!result?.ok) {
      projectErrorEl.textContent = result?.error || "Folder not allowed";
      projectErrorEl.style.display = "block";
      customInput.focus();
      return;
    }
    projectNames[result.path] = result.name;
    let option = Array.from(projectSelect.options).find(
      (candidate) => candidate.value === result.path,
    );
    if (!option) {
      option = new Option(result.name, result.path);
      projectSelect.insertBefore(option, chooseOption);
    }
    projectSelect.value = result.path;
    customInput.value = "";
    updateProjectDisplay();
    projectSelect.focus();
  }

  projectSelect.addEventListener("change", updateProjectDisplay);

  projectClearBtn.addEventListener("click", async () => {
    try {
      await chrome.runtime.sendMessage({
        type: "clear-project-mapping",
        domain: ctx.domain,
      });
    } catch (error) {
      // Memory clearing is best-effort; the visible state still resets.
    }
    ctx.auto = { path: ctx.general.path, name: ctx.general.name, source: "default" };
    if (autoOption) autoOption.textContent = `Auto · ${ctx.auto.name}`;
    updateProjectDisplay();
  });

  updateProjectDisplay();

  // ── Destinations ───────────────────────────────────────────────
  const destinationRow = shadow.getElementById("destinations");
  const destinationButtons = [];
  (destinations || []).forEach((destination) => {
    const btn = document.createElement("button");
    btn.className = "destination";
    btn.type = "button";
    btn.dataset.destination = destination.id;
    btn.setAttribute("aria-pressed", String(destination.id === selectedDestination));

    const top = document.createElement("span");
    top.className = "destination-top";
    const mark = document.createElement("span");
    mark.className = "destination-mark";
    mark.textContent = destination.mark;
    const name = document.createElement("span");
    name.className = "destination-name";
    name.textContent = destination.name;
    top.append(mark, name);

    const detail = document.createElement("span");
    detail.className = "destination-detail";
    detail.textContent = destination.detail;
    btn.append(top, detail);
    btn.addEventListener("click", () => selectDestination(destination.id));
    destinationRow.appendChild(btn);
    destinationButtons.push(btn);
  });

  function selectDestination(id) {
    if (!(destinations || []).some((destination) => destination.id === id)) return;
    selectedDestination = id;
    destinationButtons.forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.destination === id));
    });
    const selected = (destinations || []).find((destination) => destination.id === id);
    sendBtn.textContent = id === "claude_headless"
      ? "Run in background"
      : `Open new ${selected?.name || "desktop"} session`;
    // Background jobs always run in the general workspace — the project
    // selector only applies to desktop sessions.
    projectSection.style.display = id === "claude_headless" ? "none" : "";
  }

  selectDestination(selectedDestination);

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
    const target = e.composedPath ? e.composedPath()[0] : e.target;
    if (e.key === "Escape") {
      host.remove();
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // Enter = send (Shift+Enter = newline); in the folder-path box it
    // confirms the typed path instead.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      if (e.type === "keydown") {
        if (target === customInput) confirmCustomPath();
        else shadow.getElementById("send")?.click();
      }
      return;
    }
    const typingContext = target === customInput || target === projectSelect;
    if (e.type === "keydown" && !typingContext && digitPicksTemplate(e)) {
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
    const isDesktop = selectedDestination !== "claude_headless";

    let project = null;
    if (isDesktop && ctx) {
      project = currentProject();
      if (!project) {
        statusEl.style.display = "block";
        statusEl.style.color = "#dc2626";
        statusEl.textContent = "Confirm the folder path first (press Enter in the path box), or pick a project.";
        return;
      }
    }

    sendBtn.disabled = true;
    sendBtn.textContent = selectedDestination === "claude_headless" ? "Starting..." : "Opening...";
    statusEl.style.display = "block";
    statusEl.style.color = "#666";
    const destination = (destinations || []).find((item) => item.id === selectedDestination);
    statusEl.textContent = selectedDestination === "claude_headless"
      ? "Starting background Claude..."
      : `Opening a new ${destination?.name || "desktop"} session...`;

    const payload = {
      source,
      url,
      extraction_method: extracted ? "dom" : "url_only",
      instruction: instruction || "",
      destination: selectedDestination,
    };
    if (project) payload.workspace = project.path;

    if (extracted) {
      if (extracted.subject) payload.subject = extracted.subject;
      if (extracted.thread) payload.thread = extracted.thread;
      if (extracted.thread_id) payload.thread_id = extracted.thread_id;
      if (extracted.gmail_thread_id) payload.gmail_thread_id = extracted.gmail_thread_id;
      if (extracted.plaud_file_id) payload.plaud_file_id = extracted.plaud_file_id;
      if (extracted.zendesk_ticket_id) payload.zendesk_ticket_id = extracted.zendesk_ticket_id;
      if (extracted.jira_issue_key) payload.jira_issue_key = extracted.jira_issue_key;
      if (extracted.hint) payload.hint = extracted.hint;
    }

    const message = { type: "forward-request", payload };
    if (project) {
      message.project = {
        domain: ctx.domain,
        path: project.path,
        explicit: project.explicit,
        generalPath: ctx.general.path,
      };
    }

    try {
      const relay = await chrome.runtime.sendMessage(message);
      if (!relay?.transportOk) {
        throw new Error(relay?.error || "Forwarder service worker unavailable");
      }
      const data = relay.data;

      if (data.ok) {
        statusEl.style.color = "#16a34a";
        const openedIn = data.workspace
          ? ` in ${data.workspace.split("/").filter(Boolean).pop()}`
          : "";
        statusEl.textContent = selectedDestination === "claude_headless"
          ? `Started in background · ${data.session_name}`
          : `${destination?.name || "Desktop"} opened${openedIn} · review and press Enter`;
        setTimeout(() => host.remove(), 1500);
      } else {
        statusEl.style.color = "#dc2626";
        statusEl.textContent = `Error: ${data.error}`;
        sendBtn.disabled = false;
        selectDestination(selectedDestination);
      }
    } catch (err) {
      statusEl.style.color = "#dc2626";
      statusEl.textContent = `Connection failed. Is the webhook running? (localhost:5581)`;
      sendBtn.disabled = false;
      selectDestination(selectedDestination);
    }
  });

  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendBtn.click();
    }
  });
}
