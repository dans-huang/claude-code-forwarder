#!/bin/bash
set -e

# ─────────────────────────────────────────────
#  Claude Code Forwarder — One-Click Setup
#  Installs: webhook service + menu bar app
#  Manual:   Chrome extension (2 steps, guided)
# ─────────────────────────────────────────────

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WEBHOOK_DIR="$SCRIPT_DIR/webhook"
MENUBAR_DIR="$SCRIPT_DIR/menubar"
WEBHOOK_PLIST_NAME="com.claude-code-forwarder.webhook"
MENUBAR_PLIST_NAME="com.claude-code-forwarder.menubar"
WEBHOOK_PLIST_PATH="$HOME/Library/LaunchAgents/$WEBHOOK_PLIST_NAME.plist"
MENUBAR_PLIST_PATH="$HOME/Library/LaunchAgents/$MENUBAR_PLIST_NAME.plist"
VENV_DIR="$SCRIPT_DIR/.venv"
PYTHON3="$VENV_DIR/bin/python3"

echo ""
echo -e "${BOLD}🚀 Claude Code Forwarder — Setup${NC}"
echo "─────────────────────────────────"
echo ""

# ─── Check Homebrew ──────────────────────────
if ! command -v brew &>/dev/null; then
    echo -e "${YELLOW}Installing Homebrew...${NC}"
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
else
    echo -e "${GREEN}✓${NC} Homebrew"
fi

# ─── Check Claude Code CLI ───────────────────
if ! command -v claude &>/dev/null; then
    echo -e "${RED}✗ Claude Code CLI not found${NC}"
    echo "  Install: npm install -g @anthropic-ai/claude-code"
    echo "  Or visit: https://docs.anthropic.com/en/docs/claude-code"
    exit 1
else
    echo -e "${GREEN}✓${NC} Claude Code CLI"
fi

# ─── Install tmux ────────────────────────────
if ! command -v tmux &>/dev/null; then
    echo -e "${YELLOW}Installing tmux...${NC}"
    brew install tmux
else
    echo -e "${GREEN}✓${NC} tmux"
fi

# ─── Python venv + deps ──────────────────────
# Own venv: avoids PEP 668 (externally-managed) errors on Homebrew Python
if [ ! -x "$PYTHON3" ]; then
    echo -e "${YELLOW}Creating Python venv...${NC}"
    python3 -m venv "$VENV_DIR"
fi
if ! "$PYTHON3" -c "import flask, rumps" &>/dev/null; then
    echo -e "${YELLOW}Installing Python deps (flask, rumps)...${NC}"
    "$PYTHON3" -m pip install -q --upgrade pip
    "$PYTHON3" -m pip install -q -r "$WEBHOOK_DIR/requirements.txt" -r "$MENUBAR_DIR/requirements.txt"
fi
echo -e "${GREEN}✓${NC} Python deps (venv: $VENV_DIR)"

# ─── Install webhook as launchd service ──────
echo ""
echo -e "${BOLD}Setting up webhook service...${NC}"

launchctl unload "$WEBHOOK_PLIST_PATH" 2>/dev/null || true

cat > "$WEBHOOK_PLIST_PATH" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${WEBHOOK_PLIST_NAME}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${PYTHON3}</string>
        <string>${WEBHOOK_DIR}/claude_forwarder_webhook.py</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${PATH}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/claude-forwarder-webhook.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/claude-forwarder-webhook.log</string>
</dict>
</plist>
PLIST

launchctl load "$WEBHOOK_PLIST_PATH"

sleep 2
if curl -s http://localhost:5581/status | grep -q '"ok":true'; then
    echo -e "${GREEN}✓${NC} Webhook running on localhost:5581 (auto-starts on login)"
else
    echo -e "${RED}✗${NC} Webhook failed to start. Check: /tmp/claude-forwarder-webhook.log"
    exit 1
fi

# ─── Install menu bar app as launchd service ─
echo ""
echo -e "${BOLD}Setting up menu bar app...${NC}"

launchctl unload "$MENUBAR_PLIST_PATH" 2>/dev/null || true

cat > "$MENUBAR_PLIST_PATH" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${MENUBAR_PLIST_NAME}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${PYTHON3}</string>
        <string>${MENUBAR_DIR}/claude_forwarder_menubar.py</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/claude-forwarder-menubar.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/claude-forwarder-menubar.log</string>
</dict>
</plist>
PLIST

launchctl load "$MENUBAR_PLIST_PATH"

sleep 2
if pgrep -f "claude_forwarder_menubar.py" &>/dev/null; then
    echo -e "${GREEN}✓${NC} Menu bar app running — look for ✳ in your menu bar"
else
    echo -e "${RED}✗${NC} Menu bar app failed. Check: /tmp/claude-forwarder-menubar.log"
    exit 1
fi

# ─── Smoke test ──────────────────────────────
echo ""
echo -e "${BOLD}Running smoke test...${NC}"
RESP=$(curl -s -X POST http://localhost:5581/forward \
    -H "Content-Type: application/json" -d '{"_test": true}')
if echo "$RESP" | grep -q '"ok":true'; then
    echo -e "${GREEN}✓${NC} Test job launched — watch ✳ in the menu bar show '✳ 1'"
    echo "  then flip back to ✳ (done) within ~10 seconds"
else
    echo -e "${RED}✗${NC} Smoke test failed: $RESP"
    exit 1
fi

# ─── Chrome Extension ────────────────────────
echo ""
echo -e "${BOLD}Two manual steps to finish:${NC}"
echo ""
echo -e "  ${BOLD}Step 1: Load the extension${NC}"
echo "  1. Opening chrome://extensions for you..."
echo -e "  2. Enable ${BOLD}Developer mode${NC} (top-right toggle)"
echo -e "  3. Click ${BOLD}Load unpacked${NC}"
echo "  4. Select: ${SCRIPT_DIR}/extension"
echo ""
echo -e "  ${BOLD}Step 2: Set the keyboard shortcut${NC}"
echo "  1. Go to chrome://extensions/shortcuts"
echo -e "  2. Find ${BOLD}Claude Code Forwarder${NC} → click the pencil icon"
echo -e "  3. Press ${BOLD}Cmd+Shift+F${NC} (or your preferred shortcut)"
echo -e "  4. Change the dropdown to ${BOLD}Global${NC}"
echo ""

# Open extensions page in default browser (must be Chromium-based)
DEFAULT_BROWSER=$(defaults read com.apple.LaunchServices/com.apple.launchservices.secure LSHandlers 2>/dev/null | \
    grep -B1 'https' | grep -o '"[^"]*"' | head -1 | tr -d '"' || true)

case "$DEFAULT_BROWSER" in
    com.google.chrome*)   BROWSER_APP="Google Chrome" ;;
    company.thebrowser.*) BROWSER_APP="Arc" ;;
    com.brave.browser*)   BROWSER_APP="Brave Browser" ;;
    com.microsoft.edge*)  BROWSER_APP="Microsoft Edge" ;;
    com.vivaldi.vivaldi*) BROWSER_APP="Vivaldi" ;;
    *)                    BROWSER_APP="" ;;
esac

if [ -n "$BROWSER_APP" ]; then
    open -a "$BROWSER_APP" "chrome://extensions" 2>/dev/null || \
    echo "  Open chrome://extensions manually in your browser"
else
    echo -e "  ${YELLOW}⚠${NC}  Could not detect a Chromium browser as default."
    echo "  Open chrome://extensions manually in Chrome, Arc, Brave, or Edge."
fi

# ─── Done ────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}✅ Setup complete!${NC}"
echo ""
echo "  Usage: Open Gmail, Slack, or a Plaud recording → Cmd+Shift+F"
echo ""
echo "  • Gmail/Slack thread → extracts thread, full content via MCP"
echo "  • Plaud recording    → file id via URL, transcript via plaud MCP"
echo "  • Select text        → sends only the selection"
echo "  • Choose Claude Code, Codex, or Background for each forward"
echo "  • Pick a template button or type your own instruction"
echo ""
echo "  Desktop handoffs open a new interactive session for review."
echo "  Background jobs run headless — watch the ✳ menu bar item for status."
echo ""
echo "  Config (env vars in the webhook plist):"
echo "    FORWARDER_MODEL=opus  FORWARDER_EFFORT=high  FORWARDER_WORKSPACE=~/claude"
echo "    FORWARDER_PROJECT_ROOTS=~/claude  FORWARDER_EXTRA_PROJECTS=  (project selector)"
echo ""
echo "  To stop everything:"
echo "    launchctl unload $WEBHOOK_PLIST_PATH"
echo "    launchctl unload $MENUBAR_PLIST_PATH"
echo ""
