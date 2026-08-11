// Content script injected into web.plaud.ai on-demand
// Extracts the Plaud file id from the URL + recording title/summary from DOM.
// Selectors verified against the live app 2026-08-11:
//   .file-name       — title of the currently open recording
//   .summary-module  — AI summary panel (when Summary tab is active)
// document.title is always "Plaud Web" — useless.
// Full transcript is fetched later by Claude Code via the plaud MCP
// (get_transcript / get_note); the DOM preview here is partial by design.
// Returns structured data or null on failure.

(function () {
  try {
    const m = location.pathname.match(/\/file\/([0-9a-f]{16,})/i);
    const fileId = m ? m[1] : null;

    const result = { thread: [], subject: null };

    // Recording title
    const fileNameEl = document.querySelector(".file-name");
    const h1 = document.querySelector("h1");
    const title =
      (fileNameEl && fileNameEl.textContent.trim()) ||
      (h1 && h1.textContent.trim()) ||
      "recording";
    result.subject = "Plaud: " + title;

    if (fileId) {
      result.plaud_file_id = fileId;
      result.hint =
        "Plaud recording. Fetch full content via plaud MCP: " +
        "get_note (AI summary) or get_transcript (verbatim) with file_id=" +
        fileId + ". The DOM preview below is partial — never treat it as complete.";
    }

    // Preview: prefer the AI summary panel; fall back to visible page text
    const summaryEl = document.querySelector(".summary-module");
    let previewText = summaryEl ? (summaryEl.innerText || "").trim() : "";
    let previewLabel = "AI summary (visible panel)";
    if (previewText.length < 100) {
      const main = document.querySelector("main") || document.body;
      previewText = (main.innerText || "").trim();
      previewLabel = "visible page text (partial preview)";
    }
    if (previewText.length > 100) {
      result.thread = [
        { from: previewLabel, body: previewText.slice(0, 4000), timestamp: "" },
      ];
    }

    // A list page (no /file/<id>) with nothing readable is not forwardable
    if (!fileId && result.thread.length === 0) return null;
    return result;
  } catch (err) {
    console.error("Claude Forwarder: Plaud extraction failed:", err);
    return null;
  }
})();
