# Claude Code Forwarder

Forward any web page — Gmail threads, Slack threads, Plaud recordings, Zendesk tickets, Jira issues, or anything else — with one keyboard shortcut. Choose **Claude Code Desktop**, **Codex Desktop**, or the original **Background Claude** runner each time.

Desktop mode opens the forwarded task in its own new interactive app session, ready for you to review and press Enter. Background mode processes it autonomously while a tiny menu bar item (`✳`) shows what's running, finished, or failed.

Interactive handoffs stay in the new desktop session you chose. Background jobs still place their output somewhere you review later: a Slack draft, Gmail draft, or published dashboard.

![Demo](demo.gif)

## How It Works

```
Any page (browser)
  → Cmd+Shift+F
  → Popup: choose Claude Code / Codex / Background
  → Pick a template button or type an instruction → Enter
  → Local webhook receives content
  ├→ Desktop: writes a private work packet → opens a new native app session
  │  (the prompt is prefilled, not auto-submitted; you review and press Enter)
  └→ Background: spawns headless Claude Code (claude -p) in tmux
     (max 2 in parallel; failures retry automatically up to 3 attempts)
  → ✳ menu bar item shows running / queued / done / error, with
    per-job Terminate / Cancel and View log
  → The result appears as a draft in Gmail / Slack, a dashboard
    update, etc. — open questions land at the top of the draft
```

One shortcut, with either an interactive handoff or autonomous delegation.

## Requirements

- **macOS** (launchd + menu bar app are macOS only)
- **Claude Desktop** for interactive Claude Code handoff
- **ChatGPT/Codex Desktop** for interactive Codex handoff
- **Claude Code CLI** for the optional Background mode — [install guide](https://docs.anthropic.com/en/docs/claude-code)
- **Chrome, Arc, or Chromium-based browser**
- **Slack in browser** (app.slack.com) — the standalone Slack desktop app won't work since Chrome extensions can't inject into it.

The setup script installs everything else automatically (tmux, a private Python venv with Flask + rumps, both background services).

## Setup

### Step 1: Run the installer

```bash
git clone https://github.com/dans-huang/claude-code-forwarder.git
cd claude-code-forwarder
./setup.sh
```

This installs tmux, creates a Python venv with the dependencies, starts the **webhook** and the **✳ menu bar app** as login services, and runs a smoke test (you'll see `✳ 1` appear in the menu bar for a few seconds, then flip back to `✳`).

### Step 2: Load the Chrome extension

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `extension/` folder from this repo

### Step 3: Set the keyboard shortcut to Global

This step is required — the shortcut won't work without it.

1. Go to `chrome://extensions/shortcuts`
2. Find **Claude Code Forwarder**
3. Click the pencil icon and press **Cmd+Shift+F** (or your preferred shortcut)
4. Change the dropdown from "In Chrome" to **Global**

That's it. Open any page and press **Cmd+Shift+F**.

## Usage

| Action | What happens |
|--------|-------------|
| **Cmd+Shift+F** in an email thread | Extracts full email thread |
| **Cmd+Shift+F** in a Slack thread | Extracts thread + thread ID; Claude always re-fetches the complete thread via MCP |
| **Hover** a Slack message + **Cmd+Shift+F** | Grabs that thread without opening it |
| **Hover** a Gmail inbox row + **Cmd+Shift+F** | Grabs that email without opening it |
| **Cmd+Shift+F** on a Plaud recording (`web.plaud.ai/file/...`) | Grabs the file id + title; Claude fetches the full transcript via the Plaud MCP |
| **Cmd+Shift+F** on a Zendesk ticket (`*.zendesk.com/agent/tickets/...`) | Grabs the ticket id + subject; Claude fetches the full ticket + conversation via the Zendesk API |
| **Cmd+Shift+F** on a Jira issue (`*.atlassian.net/browse/...` or a board with an issue selected) | Grabs the issue key; Claude fetches the full issue via the Jira MCP |
| **Cmd+Shift+F** on **any other page** | Grabs title + visible text; Claude re-fetches the URL itself if it needs more |
| **Select text** + **Cmd+Shift+F** | Sends only the selected text |

The hotkey always responds on http/https pages — unknown sites fall back to the generic extractor instead of doing nothing.

### The popup

Choose the destination at the top of the popup. Template buttons sit above the instruction box — click one (or press its number key) to fill the instruction, edit it if you want, then Enter. Or ignore them and type your own.

| Destination | Result |
|-------------|--------|
| **Claude Code** | Opens a new Claude Code Desktop session with the task prefilled |
| **Codex** | Opens a new Codex Desktop local session with the task prefilled |
| **Background** | Runs the existing autonomous `claude -p` job and reports through `✳` |

Desktop links deliberately do not auto-submit. This leaves one visible approval point: review the short packet instruction and press Enter. Full forwarded content is stored in a private local Markdown packet (`0600`) instead of being squeezed into the URL. Packets expire after 30 days by default.

| Key | Action |
|-----|--------|
| **1–9** | Pick a template (while the box is empty or holds an unedited template) |
| **Enter** | Send to Claude Code |
| **Shift+Enter** | New line |
| **Esc** | Cancel |

Edit the `TEMPLATES` list at the top of `extension/background.js` to customize the buttons (then reload the extension).

### The ✳ menu bar item

| Title | Meaning |
|-------|---------|
| `✳` | Idle — nothing running |
| `◐ 2` | 2 jobs running — the icon spins while anything runs |
| `◐ 2 +1` | 2 running, 1 waiting in the queue |
| `✳ ⚠1` | Idle, 1 recent job errored |
| `✳ ⌁` | Webhook unreachable |

Click it to see each job with elapsed time, **Terminate** (kills the tmux session), **Cancel** (drops a queued job), and **View log** (opens the job's output in Console). Finished jobs stay listed for 6 hours or until you **Clear finished**. Jobs run fully headless — there is nothing to interact with, by design.

### Queue and retry

At most `FORWARDER_MAX_CONCURRENT` (default 2) Claude sessions run at once; extra forwards wait in a FIFO queue and start automatically when a slot frees up. This prevents concurrent sessions from racing each other's OAuth token refresh and from hammering shared API rate limits.

A job that exits non-zero is retried automatically (up to 3 attempts, 30s/60s backoff). Deliverables are always drafts, so a duplicate from a partial first run is cheap — losing the forwarded content is not.

## Recommended: MCP Integrations

For Claude Code to complete the full workflow, configure MCP integrations in your Claude Code workspace:

- **Slack** — read threads, create drafts
- **Gmail** — read threads, create drafts
- **Plaud** — [`@plaud-ai/mcp`](https://www.npmjs.com/package/@plaud-ai/mcp) for transcripts and AI summaries
- **Jira (Atlassian)** — fetch full issues from a forwarded issue key
- **Zendesk** — API access (or a workspace skill wrapping it) to fetch full tickets from a forwarded ticket id

Without these, Claude Code can still read the forwarded DOM content, but won't be able to fetch full threads/transcripts/tickets or draft replies in place.

## Architecture

```
┌──────────────────────────┐
│   Chrome Extension        │
│  (Manifest V3)            │
│                           │
│  Content scripts:         │
│  • gmail-content.js       │
│  • slack-content.js       │
│  • plaud-content.js       │
│  • zendesk-content.js     │
│  • jira-content.js        │
│  • web-content.js (any)   │
│                           │
│  Cmd+Shift+F → extract →  │
│  popup (target+template) →│
│  POST /forward            │
└───────────┬──────────────┘
            │ localhost:5581
┌───────────▼──────────────┐      ┌──────────────────────────┐
│   Flask Webhook           │◄─────│   ✳ Menu Bar App (rumps)  │
│                           │ poll │                           │
│  POST /forward            │ 3s   │  • running/queued/done/err│
│    → private work packet  │      │  • Terminate / Cancel     │
│      + native deep link   │      │  • View job log           │
│    OR queue + claude -p   │      └──────────────────────────┘
│  GET  /status             │
│  POST /terminate/<id>     │
│  POST /clear-finished     │
└───────────┬──────────────┘
            │ headless tmux session (exits when done;
            │ auto-retry ×3 on failure)
┌───────────▼──────────────┐
│   Claude Code CLI (-p)    │
│                           │
│  Full workspace:          │
│  • CLAUDE.md, skills      │
│  • MCP tools              │
│  • Draft-first flow       │
│  • Result → draft/board,  │
│    never just the log     │
│  exit code → job status   │
└──────────────────────────┘
```

Job artifacts live in `/tmp/claude-forwarder-jobs/` (`<session>.log`, `<session>.exit`). If the webhook restarts mid-job, it re-adopts live `fwd-*` tmux sessions on the next status poll.

**Claude.ai Artifacts from headless jobs:** plain-CLI headless sessions don't get the Artifact tool, so jobs couldn't publish/update claude.ai artifact pages (e.g. a team dashboard). The launcher sets `CLAUDE_CODE_ENTRYPOINT=claude-desktop`, which enables the tool, and publishing works headlessly (verified end-to-end). This is an unofficial toggle — if a Claude Code update changes the gating, jobs will report the missing tool in their output and this is the knob to revisit.

## Configuration

Set env vars in `~/Library/LaunchAgents/com.claude-code-forwarder.webhook.plist` (then `launchctl unload` + `load`):

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | `5581` | Webhook port (menu bar app reads the same var) |
| `FORWARDER_WORKSPACE` | `~/claude` | Directory Claude Code runs in (your CLAUDE.md, skills, MCP config) |
| `FORWARDER_MODEL` | `opus` | Model for spawned sessions |
| `FORWARDER_EFFORT` | `high` | Effort level for spawned sessions |
| `FORWARDER_MAX_CONCURRENT` | `2` | Parallel Claude sessions; extra forwards queue FIFO |
| `FORWARDER_PACKETS_DIR` | `~/Library/Application Support/Claude Code Forwarder/Inbox` | Private interactive handoff packets |
| `FORWARDER_PACKET_TTL_DAYS` | `30` | Remove old packet files after this many days; `0` disables pruning |

**Keyboard shortcut:** change in `chrome://extensions/shortcuts`, keep scope **Global**.

**Services:**
```bash
# Stop / start
launchctl unload ~/Library/LaunchAgents/com.claude-code-forwarder.webhook.plist
launchctl load   ~/Library/LaunchAgents/com.claude-code-forwarder.webhook.plist
launchctl unload ~/Library/LaunchAgents/com.claude-code-forwarder.menubar.plist
launchctl load   ~/Library/LaunchAgents/com.claude-code-forwarder.menubar.plist

# Logs
tail -f /tmp/claude-forwarder-webhook.log
tail -f /tmp/claude-forwarder-menubar.log

# Smoke test (5-second fake job, no Claude involved)
curl -s -X POST http://localhost:5581/forward \
  -H "Content-Type: application/json" -d '{"_test": true}'
```

**Development tests:**
```bash
.venv/bin/python3 -m unittest discover -s tests -v
node tests/test_extension_service_worker.js
node --check extension/background.js
```

## Uninstall

```bash
launchctl unload ~/Library/LaunchAgents/com.claude-code-forwarder.webhook.plist
launchctl unload ~/Library/LaunchAgents/com.claude-code-forwarder.menubar.plist
rm ~/Library/LaunchAgents/com.claude-code-forwarder.{webhook,menubar}.plist

rm -rf ~/claude-code-forwarder  # or wherever you cloned it

# Remove the Chrome extension manually in chrome://extensions
```

## Troubleshooting

**Shortcut doesn't work**
Make sure the shortcut is set to **Global** in `chrome://extensions/shortcuts`. "In Chrome" / "In Arc" scope may not work reliably.

**Popup says "Connection failed"**
The webhook isn't running. Check `curl http://localhost:5581/status` or restart the service.

**✳ shows ⌁**
Same thing — the menu bar app can't reach the webhook. Check the webhook log.

**A job shows error**
Click the job → **View log** to see the Claude Code output, including the failure.

**Slack popup: can't type in the text field**
Reload the extension in `chrome://extensions`. The keyboard trap may need a fresh injection.

**Gmail/Slack/Plaud extraction returns 0 messages**
DOM selectors may be outdated. The extension falls back to URL-only mode; for Slack and Plaud, Claude Code re-fetches full content via MCP anyway. Open an issue if this happens consistently.

## License

MIT
