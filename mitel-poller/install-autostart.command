#!/bin/bash
# Run this ONCE on the office Mac to make the poller start automatically on login.

DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST="$HOME/Library/LaunchAgents/com.answeringlegal.mitelpoller.plist"

echo "============================================"
echo "  Mitel Poller — Auto-Start Installer"
echo "  $(date)"
echo "============================================"
echo ""

# Check for Node
NODE_PATH="$(command -v node 2>/dev/null)"
if [ -z "$NODE_PATH" ]; then
  for p in /usr/local/bin/node /opt/homebrew/bin/node; do
    [ -x "$p" ] && NODE_PATH="$p" && break
  done
fi
if [ -z "$NODE_PATH" ]; then
  echo "ERROR: Node.js not found. Install from https://nodejs.org first."
  read -p "Press Enter to close..."
  exit 1
fi
echo "Node found at: $NODE_PATH"

# Install npm deps
cd "$DIR"
if [ ! -d "node_modules" ]; then
  echo "Installing npm dependencies..."
  npm install
fi

# Write the LaunchAgent plist
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.answeringlegal.mitelpoller</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_PATH}</string>
    <string>${DIR}/mitel-queue-poller.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${DIR}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${DIR}/poller.log</string>
  <key>StandardErrorPath</key>
  <string>${DIR}/poller.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
PLIST

# Load it now (no reboot needed)
launchctl unload "$PLIST" 2>/dev/null
launchctl load "$PLIST"

echo ""
echo "✓ Auto-start installed and poller is now running."
echo ""
echo "  Starts automatically every time this Mac logs in."
echo "  Logs: ${DIR}/poller.log"
echo ""
echo "  To uninstall auto-start:"
echo "    launchctl unload ~/Library/LaunchAgents/com.answeringlegal.mitelpoller.plist"
echo ""
read -p "Press Enter to close..."
