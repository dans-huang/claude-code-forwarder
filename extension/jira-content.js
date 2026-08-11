// Content script injected into *.atlassian.net on-demand.
// The critical field is the Jira issue key, taken from the URL — reliable
// for /browse/KEY-123 and board views with ?selectedIssue=KEY-123.
// Claude Code re-fetches the issue via the Jira MCP; the DOM text is a
// bonus preview. Confluence pages (/wiki/) fall through as generic pages.
// Returns structured data or null on failure.

(function () {
  try {
    const href = location.href;
    const m = href.match(/(?:\/browse\/|selectedIssue=)([A-Z][A-Z0-9]+-\d+)/);
    const issueKey = m ? m[1] : null;

    const result = { thread: [], subject: null };

    // document.title: "[KEY-123] Summary - Jira" on issue views
    const title = (document.title || "")
      .replace(/\s*[-–]\s*Jira.*$/i, "")
      .trim();
    result.subject = issueKey
      ? (title.includes(issueKey) ? title : `${issueKey} ${title}`)
      : title || null;

    if (issueKey) {
      result.jira_issue_key = issueKey;
      result.hint =
        "Jira issue. Fetch the FULL issue via the Jira MCP (getJiraIssue) " +
        "with key=" + issueKey +
        ". The DOM preview below is partial — never act on it alone.";
    } else {
      result.hint =
        "Atlassian page with no issue key in the URL. Use the Jira/Confluence " +
        "MCP tools on the URL if the preview below is not enough.";
    }

    const src = document.querySelector("main") || document.body;
    const text = (src.innerText || "").trim();
    if (text.length > 100) {
      result.thread = [
        {
          from: "visible page text (partial preview)",
          body: text.slice(0, 4000),
          timestamp: "",
        },
      ];
    }

    if (!issueKey && result.thread.length === 0) return null;
    return result;
  } catch (err) {
    console.error("Claude Forwarder: Jira extraction failed:", err);
    return null;
  }
})();
