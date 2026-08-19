# Claude Code Forwarder

Send the page you are looking at to a coding agent, with one keyboard shortcut.

Press **Cmd+Shift+F** on a Gmail thread, Slack thread, Zendesk ticket, Jira issue, Plaud recording, or any other web page. Pick where it goes, pick which project it lands in, add an instruction, press Enter.

| Destination | What happens |
|-------------|--------------|
| **Claude Code** | Opens a new Claude Code Desktop session, task prefilled |
| **Codex** | Opens a new Codex Desktop session, task prefilled |
| **Background** | Runs a headless `claude -p` job and notifies you when it finishes |

Desktop sessions open **inside a project directory you choose**, so the agent starts with that repository's `CLAUDE.md` / `AGENTS.md`, Git state, skills, and local context already loaded. The prompt is prefilled but never auto-submitted — you read it and press Enter.

![Demo](demo.gif)

## How it works

```
Any page (browser)
  → Cmd+Shift+F
  → Popup: destination + project + instruction → Enter
  → Local webhook (localhost:5581) receives the content
  │
  ├→ Desktop: validates the project, writes a private work packet,
  │  opens a new native session in that project
  │  (prefilled, not submitted — you review and press Enter)
  │
  └→ Background: queues a headless claude -p job in tmux
     (max 2 in parallel, auto-retry ×3 on failure)
     → result lands as a Gmail draft, Slack draft, or dashboard update
```

Nothing leaves your machine except what the agent itself does. The webhook binds to `127.0.0.1` and serves no CORS headers, so no web page can reach it.

## Requirements

- **macOS** — the launchd service and native notifications are macOS only
- **Chrome, Arc, Brave, Edge, or another Chromium browser**
- **Claude Desktop** for the Claude Code destination
- **ChatGPT/Codex Desktop** for the Codex destination
- **Claude Code CLI** for Background mode — [install guide](https://docs.anthropic.com/en/docs/claude-code)
- **Slack in the browser** (`app.slack.com`) — extensions cannot inject into the standalone Slack app

`setup.sh` installs the rest: tmux, a private Python venv with Flask, and the webhook login service.

## Install

### 1. Run the installer

```bash
git clone https://github.com/dans-huang/claude-code-forwarder.git
cd claude-code-forwarder
./setup.sh
```

This starts the webhook as a login service, then runs a smoke test — a 5-second fake job that posts a "Forwarded job done" notification when it finishes.

### 2. Load the extension

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `extension/` folder from this repo

### 3. Make the shortcut Global

Required. The shortcut does not work without it.

1. Open `chrome://extensions/shortcuts`
2. Find **Claude Code Forwarder**
3. Click the pencil icon, press **Cmd+Shift+F**
4. Change the dropdown from "In Chrome" to **Global**

Done. Open any page and press **Cmd+Shift+F**.

## Using it

### What gets extracted

| Where you press Cmd+Shift+F | What it sends |
|-----------------------------|---------------|
| A Gmail thread | The full email thread |
| A Slack thread | Thread text + thread ID; the agent re-fetches the complete thread via MCP |
| Hovering a Slack message | That thread, without opening it |
| Hovering a Gmail inbox row | That email, without opening it |
| A Plaud recording (`web.plaud.ai/file/...`) | File ID + title; the agent fetches the transcript via the Plaud MCP |
| A Zendesk ticket (`*.zendesk.com/agent/tickets/...`) | Ticket ID + subject; the agent fetches the full ticket via the Zendesk API |
| A Jira issue (`*.atlassian.net/browse/...`) | Issue key; the agent fetches the full issue via the Jira MCP |
| Any other page | Title + visible text; the agent re-fetches the URL if it needs more |
| Any page with text selected | Only the selected text |

The hotkey always responds on http/https pages. Unknown sites fall back to the generic extractor instead of doing nothing.

### The project selector

For Claude Code and Codex, a **Project** dropdown sits under the destination row. Whatever you pick is the directory the new session opens in. Claude Code and Codex share one list — this is task context, not app configuration.

| Option | Meaning |
|--------|---------|
| **Auto · \<project\>** | The default. No clicking needed. |
| **General workspace** | `FORWARDER_WORKSPACE`, the classic behavior |
| **Recent** | Projects you explicitly picked recently |
| **Projects** | Auto-discovered project directories |
| **Choose folder…** | Paste a path; the webhook validates it before accepting |

**How Auto decides.** If you have explicitly picked a project for this site before, Auto resolves to that project — forward a Jira issue once into `repo-a` and every later Jira forward defaults there. With no memory for the site, Auto resolves to the General workspace. It never guesses from page content. The exact folder that will open is always printed under the dropdown.

**How memory works.** Explicitly picking a project and forwarding remembers it for that domain. Forwarding on Auto never changes the memory. To stop remembering a site, select Auto and click **Forget for this site**; explicitly forwarding with **General workspace** clears it too. Memory lives in `chrome.storage.local` and is only ever a hint — the webhook re-validates every path.

**How discovery works.** The webhook scans up to two levels under `FORWARDER_PROJECT_ROOTS` and lists directories carrying a project marker (`.git`, `CLAUDE.md`, `AGENTS.md`, `.claude`, `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`). It never walks your whole home directory. Hidden dirs, `_`-prefixed dirs, `node_modules`, `venv`, `dist`, `build`, `tmp`, and `archive` are skipped, and symlinked directories are not followed.

Background mode hides the selector. Headless jobs always run in the General workspace, where the draft-first skills live.

### Instruction and keyboard

Template buttons sit above the instruction box. Click one, or press its number key, to fill the box — then edit it or send as is.

| Key | Action |
|-----|--------|
| **1–9** | Pick a template (while the box is empty or holds an unedited template) |
| **Enter** | Send to the selected destination |
| **Shift+Enter** | New line |
| **Esc** | Cancel |

Edit the `TEMPLATES` list at the top of `extension/background.js` to change the buttons, then reload the extension.

### Background jobs

Background jobs are headless by design — there is nothing to interact with mid-run — so they report in two places and nowhere else:

1. **A notification when each job finishes**, titled "Forwarded job done", "failed", or "terminated", with the task subject. This is the only thing that interrupts you. Set `FORWARDER_NOTIFY=0` to turn it off.
2. **A line in the popup** when something is in flight, so pressing Cmd+Shift+F also tells you what is still running.

Up to version 1.6 a `✳` menu bar app polled for this. It was removed in 1.7.0: it queried the webhook every 3 seconds — about 28,000 requests a day — to render an icon that was blank almost all of the time. The webhook now sweeps its own jobs on a timer, so nothing external has to poll it.

Inspect or control jobs directly when you need to:

```bash
curl -s http://localhost:5581/status | python3 -m json.tool   # running, queued, finished
curl -s -X POST http://localhost:5581/terminate/<job_id>      # kill a running or queued job
curl -s -X POST http://localhost:5581/clear-finished          # drop the recent-job list
```

`/status` carries each job's `log_path`; open it with `open -a Console <path>`. Finished jobs stay listed for 6 hours.

At most `FORWARDER_MAX_CONCURRENT` (default 2) jobs run at once; the rest wait in a FIFO queue. This keeps concurrent sessions from racing each other's OAuth token refresh and from exhausting shared API rate limits. A job that exits non-zero retries up to 3 times (30s, then 60s backoff). Deliverables are always drafts, so a duplicate from a partial run is cheap; losing the forwarded content is not.

## Security model

The forwarder opens native sessions and reads local directories on your behalf, so the trust boundary matters.

**The browser never picks a path.** The extension sends a workspace path, but the webhook treats it as a request, not an instruction. Every path is expanded, fully resolved with `realpath` (symlinks and `..` included), and then checked against the allowlist: the General workspace, anything inside `FORWARDER_PROJECT_ROOTS`, or an exact entry in `FORWARDER_EXTRA_PROJECTS`. Traversal attempts and symlinks pointing outside a root are rejected against their real target. A rejected workspace fails with a 400 before any packet is written or any app is opened.

**No web page can reach the webhook.** It binds to `127.0.0.1` and never emits CORS headers. Only the extension service worker talks to it. Page scripts cannot start a job or open a session.

**Forwarded content is private and stays local.** The full thread goes into a Markdown work packet at `0600` inside a `0700` directory, not into the URL. The deep link carries only a short pointer to that packet, which also avoids URL length limits on long threads. Packets are deleted after `FORWARDER_PACKET_TTL_DAYS` (default 30).

**Nothing is submitted for you.** Desktop links prefill the prompt and stop. That leaves exactly one visible approval point before an agent starts acting.

**Forwarded content is data, not instructions.** The packet tells the agent to treat quoted page, email, thread, and transcript content as untrusted, and that only your explicit instruction is the task.

## Configuration

Set env vars in `~/Library/LaunchAgents/com.claude-code-forwarder.webhook.plist`, then reload the service.

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | `5581` | Webhook port |
| `FORWARDER_WORKSPACE` | `~/claude` | General workspace: background jobs and the default desktop target |
| `FORWARDER_PROJECT_ROOTS` | `FORWARDER_WORKSPACE` | Colon-separated roots the project selector may open, scanned two levels deep |
| `FORWARDER_EXTRA_PROJECTS` | *(none)* | Colon-separated project dirs allowed outside the roots; exact match, subdirectories not included |
| `FORWARDER_MODEL` | `opus` | Model for background sessions |
| `FORWARDER_EFFORT` | `high` | Effort level for background sessions |
| `FORWARDER_MAX_CONCURRENT` | `2` | Parallel background jobs; the rest queue FIFO |
| `FORWARDER_NOTIFY` | `1` | Notify when a background job finishes; `0` disables |
| `FORWARDER_PACKETS_DIR` | `~/Library/Application Support/Claude Code Forwarder/Inbox` | Private work packets |
| `FORWARDER_PACKET_TTL_DAYS` | `30` | Delete packets older than this; `0` disables pruning |

If all your repos live under `~/claude`, you do not need to set anything. Point `FORWARDER_PROJECT_ROOTS` at your code directories if they live elsewhere, for example `~/code:~/work`.

**Upgrading to 1.7.0.** Re-run `./setup.sh`; it unloads and removes the retired menu bar service for you. Background jobs now notify you when they finish instead. Nothing else changes, and no config is needed.

**Upgrading from 1.5 or earlier.** No config change required. Restart the webhook service and reload the extension to get the project selector. Payloads without a `workspace` — old clients included — keep opening in `FORWARDER_WORKSPACE` exactly as before.

**Service:**
```bash
launchctl unload ~/Library/LaunchAgents/com.claude-code-forwarder.webhook.plist
launchctl load   ~/Library/LaunchAgents/com.claude-code-forwarder.webhook.plist
```

**Log:**
```bash
tail -f /tmp/claude-forwarder-webhook.log
```

**Smoke test** (5-second fake job, no Claude involved):
```bash
curl -s -X POST http://localhost:5581/forward -H "Content-Type: application/json" -d '{"_test": true}'
```

## Recommended MCP integrations

Configure these in your Claude Code workspace so the agent can finish the whole workflow:

- **Slack** — read threads, create drafts
- **Gmail** — read threads, create drafts
- **Plaud** — [`@plaud-ai/mcp`](https://www.npmjs.com/package/@plaud-ai/mcp) for transcripts and AI summaries
- **Jira (Atlassian)** — fetch full issues from a forwarded issue key
- **Zendesk** — API access, or a workspace skill wrapping it, to fetch full tickets

Without these the agent still reads the forwarded DOM content, but cannot fetch complete threads, transcripts, or tickets, and cannot draft replies in place.

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
│  popup (destination +     │
│  project + instruction) → │
│  service worker → POST    │
└───────────┬──────────────┘
            │ localhost:5581 (no CORS; extension only)
┌───────────▼──────────────┐
│   Flask Webhook           │
│                           │
│  POST /forward            │
│    → validate workspace   │
│    → private work packet  │
│      + native deep link   │
│    OR queue + claude -p   │
│  GET  /projects           │
│  POST /projects/validate  │
│  GET  /status             │
│  POST /terminate/<id>     │
│  POST /clear-finished     │
│                           │
│  sweeper thread (5s):     │
│    finish → notify        │
│    free slot → next job   │
└─────┬──────────────┬─────┘
      │              │ headless tmux session
      │              │ (auto-retry ×3)
      ▼              ▼
┌─────────────┐  ┌──────────────────────────┐
│  Codex /    │  │   Claude Code CLI (-p)    │
│  Claude     │  │                           │
│  Desktop    │  │  • CLAUDE.md, skills      │
│             │  │  • MCP tools              │
│  New session│  │  • Draft-first flow       │
│  in the     │  │  • Result → draft/board,  │
│  chosen     │  │    never just the log     │
│  project    │  │  exit code → notification │
└─────────────┘  └──────────────────────────┘
```

Job artifacts live in `/tmp/claude-forwarder-jobs/` (`<session>.log`, `<session>.exit`). If the webhook restarts mid-job, it re-adopts live `fwd-*` tmux sessions on the next status poll.

**Claude.ai Artifacts from headless jobs:** plain-CLI headless sessions do not get the Artifact tool, so jobs could not publish or update claude.ai artifact pages such as a team dashboard. The launcher sets `CLAUDE_CODE_ENTRYPOINT=claude-desktop`, which enables the tool, and publishing works headlessly (verified end to end). This is an unofficial toggle. If a Claude Code update changes the gating, jobs will report the missing tool in their output, and this is the knob to revisit.

## Development

```bash
.venv/bin/python3 -m unittest discover -s tests -v   # webhook: forwarding, projects, validation
node tests/test_extension_service_worker.js          # service worker relay
node tests/test_extension_projects.js                # project list, memory, payload, fallback
node --check extension/background.js
```

## Troubleshooting

**Shortcut does nothing**
Set the shortcut to **Global** in `chrome://extensions/shortcuts`. "In Chrome" / "In Arc" scope is unreliable.

**Popup says "Connection failed"**
The webhook is not running. Check `curl http://localhost:5581/status` and restart the service.

**No notification when a background job finishes**
Check that notifications are allowed for Script Editor in System Settings → Notifications, and that a Focus mode is not suppressing them. Verify the path directly:
```bash
osascript -e 'display notification "test" with title "Forwarder"'
```
`FORWARDER_NOTIFY=0` also disables them. The job itself is unaffected — its result still lands in the draft or dashboard, and `/status` shows the outcome.

**Project dropdown says "Project list unavailable"**
The webhook is unreachable. Forwards still work and open in the General workspace.

**A project is missing from the dropdown**
It is outside `FORWARDER_PROJECT_ROOTS`, deeper than two levels, has no project marker, or sits in a skipped directory (hidden, `_`-prefixed, `node_modules`, `archive`, …). Use **Choose folder…**, or add its root to `FORWARDER_PROJECT_ROOTS`.

**"workspace is outside the allowed project roots"**
Working as intended. Add the directory's root to `FORWARDER_PROJECT_ROOTS`, or the directory itself to `FORWARDER_EXTRA_PROJECTS`, then restart the webhook.

**A background job shows error**
Click the job → **View log** for the Claude Code output, including the failure.

**Slack popup: cannot type in the text field**
Reload the extension in `chrome://extensions`. The keyboard trap needs a fresh injection.

**Gmail/Slack/Plaud extraction returns 0 messages**
DOM selectors may be outdated. The extension falls back to URL-only mode; for Slack and Plaud the agent re-fetches full content via MCP anyway. Open an issue if it happens consistently.

## Uninstall

```bash
launchctl unload ~/Library/LaunchAgents/com.claude-code-forwarder.webhook.plist
rm ~/Library/LaunchAgents/com.claude-code-forwarder.webhook.plist

rm -rf ~/claude-code-forwarder   # or wherever you cloned it
```

Then remove the extension in `chrome://extensions`. Work packets, if you want them gone too:

```bash
rm -rf ~/Library/Application\ Support/Claude\ Code\ Forwarder
```

## License

MIT
