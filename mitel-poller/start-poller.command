#!/bin/bash
# Double-click this file to start the Mitel queue poller.
# Terminal will open and show live output. Close the window to stop it.

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo "============================================"
echo "  Mitel Queue Poller"
echo "  $(date)"
echo "============================================"
echo ""

# Check for Node
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js is not installed."
  echo ""
  echo "Install it from https://nodejs.org (LTS version)"
  echo ""
  read -p "Press Enter to close..."
  exit 1
fi

echo "Node $(node -v) found."
echo ""

# Install deps if needed
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
  echo ""
fi

# Check for .env
if [ ! -f ".env" ]; then
  echo "ERROR: .env file not found in $DIR"
  echo ""
  echo "Copy .env.example to .env and fill in MSSQL_PASS."
  echo ""
  read -p "Press Enter to close..."
  exit 1
fi

echo "Starting poller — press Ctrl+C or close this window to stop."
echo ""
node mitel-queue-poller.js
