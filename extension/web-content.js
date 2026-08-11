// Generic fallback content script — injected into any site without a
// dedicated extractor. Grabs title, meta description, and visible text so
// the hotkey ALWAYS produces something; Claude Code can re-fetch the URL
// itself (WebFetch / browser tools) when the preview is not enough.
// Returns structured data (never null — the URL alone is forwardable).

(function () {
  try {
    const result = { thread: [], subject: null };

    result.subject = (document.title || "").trim() || location.hostname;

    const metaDesc = document.querySelector('meta[name="description"]');
    const desc = metaDesc ? (metaDesc.content || "").trim() : "";

    const src =
      document.querySelector("article") ||
      document.querySelector("main") ||
      document.body;
    let text = (src.innerText || "").trim();
    if (desc && !text.startsWith(desc)) text = desc + "\n\n" + text;

    if (text.length > 50) {
      result.thread = [
        {
          from: "visible page text (partial preview)",
          body: text.slice(0, 6000),
          timestamp: "",
        },
      ];
    }

    result.hint =
      "Generic web page. The preview below may be partial — use WebFetch or " +
      "browser tools on the URL if you need the full page.";

    return result;
  } catch (err) {
    console.error("Claude Forwarder: generic extraction failed:", err);
    return { thread: [], subject: document.title || null };
  }
})();
