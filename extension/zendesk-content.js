// Content script injected into *.zendesk.com agent workspace on-demand.
// The critical field is the ticket id, taken from the URL — reliable.
// DOM text is a bonus preview; Claude Code re-fetches the full ticket +
// conversation via the Zendesk API (skills/zendesk-workflow.md).
// Returns structured data or null on failure.

(function () {
  try {
    const m = location.pathname.match(/\/agent\/tickets\/(\d+)/);
    const ticketId = m ? m[1] : null;

    const result = { thread: [], subject: null };

    // Subject: agent workspace sets document.title to the ticket subject;
    // fall back to the subject field in the DOM.
    const subjectEl = document.querySelector(
      '[data-test-id="omni-header-subject"], input[aria-label="Subject"]'
    );
    const domSubject =
      (subjectEl && (subjectEl.value || subjectEl.textContent || "").trim()) ||
      (document.title || "").replace(/\s*[-–|].*Zendesk.*$/i, "").trim();
    result.subject = ticketId
      ? `Zendesk #${ticketId}: ${domSubject || "(no subject)"}`
      : domSubject || null;

    if (ticketId) {
      result.zendesk_ticket_id = ticketId;
      result.hint =
        "Zendesk ticket. Fetch the FULL ticket + conversation via the " +
        "Zendesk API (skills/zendesk-workflow.md) with ticket_id=" + ticketId +
        ". The DOM preview below is partial — never act on it alone.";
    }

    // Preview: the conversation log if present, else visible page text
    const logEl = document.querySelector(
      '[data-test-id="omni-log-app"], [data-test-id="ticket-rich-log"]'
    );
    const src = logEl || document.querySelector("main") || document.body;
    const text = (src.innerText || "").trim();
    if (text.length > 100) {
      result.thread = [
        {
          from: "visible conversation (partial preview)",
          body: text.slice(0, 4000),
          timestamp: "",
        },
      ];
    }

    // A list/search view (no ticket id) with nothing readable → not forwardable
    if (!ticketId && result.thread.length === 0) return null;
    return result;
  } catch (err) {
    console.error("Claude Forwarder: Zendesk extraction failed:", err);
    return null;
  }
})();
