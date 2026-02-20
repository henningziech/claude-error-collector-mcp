#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> Installing claude-error-collector..."

# 1. Install dependencies & build
cd "$SCRIPT_DIR"
npm install
npm run build

# 2. Register MCP server with Claude Code
if command -v claude &> /dev/null; then
  echo "==> Registering MCP server with Claude Code..."
  claude mcp add error-collector -s user -- node "$SCRIPT_DIR/dist/index.js"
  echo "    Done."
else
  echo "==> Claude Code CLI not found. Add manually to ~/.claude.json:"
  echo "    \"error-collector\": { \"type\": \"stdio\", \"command\": \"node\", \"args\": [\"$SCRIPT_DIR/dist/index.js\"] }"
fi

echo ""
echo "==> Installation complete!"
echo "    Restart Claude Code to activate the error-collector."
