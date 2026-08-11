// Content script injected into app.slack.com on-demand
// Extracts Slack thread from DOM or provides thread identifiers for MCP fallback
// Returns structured data or null on failure

(function () {
  try {
    const result = { thread: [], subject: null };

    // Priority: thread flexpane > hovered message > main channel
    const threadPanel = document.querySelector('[data-qa="threads_flexpane"]');
    const flexpaneBody = threadPanel
      ? threadPanel.querySelector('[data-qa="flexpane_body"]')
      : null;

    // Check if user is hovering over a message (for hover+shortcut flow)
    const hoveredMsg = document.querySelector(
      '[data-qa="message_container"]:hover, [data-qa="virtual-list-item"]:hover [data-qa="message_container"]'
    );

    // If hovering a message and no thread panel open, extract thread ID for MCP
    if (hoveredMsg && !flexpaneBody) {
      const channelId = hoveredMsg.getAttribute("data-msg-channel-id");
      const msgTs = hoveredMsg.getAttribute("data-msg-ts");

      if (channelId && msgTs) {
        // Check if this message has replies (is a thread parent)
        const hasReplies = hoveredMsg.querySelector('[data-qa="reply_bar_count"]');

        // Extract the visible message content as context
        const senderEl = hoveredMsg.querySelector('[data-qa="message_sender_name"]');
        const textEl = hoveredMsg.querySelector('[data-qa="message-text"]');

        result.subject = "Slack: thread in #" + (
          document.querySelector('[data-qa="channel_name"]')?.textContent.trim() || channelId
        );
        result.thread_id = { channel_id: channelId, thread_ts: msgTs };
        result.thread = [{
          from: senderEl ? senderEl.textContent.trim() : "unknown",
          body: textEl ? textEl.innerText.trim() : "(hover preview)",
          timestamp: msgTs,
        }];
        result.hint =
          "Always fetch the complete thread with slack_read_thread MCP before acting" +
          (hasReplies ? " — this message has replies." : " — replies may exist beyond this preview.");
        return result;
      }
    }

    // Thread panel is open — extract from it
    const container = flexpaneBody ||
      document.querySelector('[data-qa="message_pane"]') ||
      document.querySelector('[role="main"]');

    if (!container) return null;

    // Extract channel/thread name for subject
    if (flexpaneBody) {
      result.subject = "Slack: Thread";
      // Get thread_id from first message in thread panel
      const firstMsg = flexpaneBody.querySelector('[data-qa="message_container"]');
      if (firstMsg) {
        const channelId = firstMsg.getAttribute("data-msg-channel-id");
        const msgTs = firstMsg.getAttribute("data-msg-ts");
        if (channelId && msgTs) {
          result.thread_id = { channel_id: channelId, thread_ts: msgTs };
        }
      }
    } else {
      const channelNameEl =
        document.querySelector('[data-qa="channel_name"]') ||
        document.querySelector('.p-view_header__channel_title');
      if (channelNameEl) {
        result.subject = "Slack: #" + channelNameEl.textContent.trim();
      }
    }

    // Find all message containers within the target container
    const messageEls = container.querySelectorAll('[data-qa="message_container"]');

    if (messageEls.length === 0) {
      const text = container.innerText.trim();
      if (text.length > 30) {
        result.thread = [{ from: "unknown", body: text, timestamp: "" }];
        return result;
      }
      return null;
    }

    for (const msgEl of messageEls) {
      const msg = { from: "", body: "", timestamp: "" };

      // Sender
      const senderEl = msgEl.querySelector('[data-qa="message_sender_name"]');
      if (senderEl) {
        msg.from = senderEl.textContent.trim();
      }

      // Timestamp
      msg.timestamp = msgEl.getAttribute("data-msg-ts") || "";

      // Body — message text + any attachment text
      const parts = [];
      const textEl = msgEl.querySelector('[data-qa="message-text"]');
      if (textEl) {
        parts.push(textEl.innerText.trim());
      }
      const attachments = msgEl.querySelectorAll('[data-qa="message_attachment_text"]');
      for (const att of attachments) {
        parts.push(att.innerText.trim());
      }
      msg.body = parts.join("\n");

      if (msg.body) {
        result.thread.push(msg);
      }
    }

    if (result.thread.length === 0) return null;
    return result;
  } catch (err) {
    console.error("Claude Forwarder: Slack extraction failed:", err);
    return null;
  }
})();
