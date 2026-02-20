#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_MD="$HOME/.claude/CLAUDE.md"
SECTION_MARKER="## Error Collector"

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

# 3. Add trigger instruction to CLAUDE.md
if [ ! -f "$CLAUDE_MD" ]; then
  mkdir -p "$HOME/.claude"
  touch "$CLAUDE_MD"
fi

if grep -qF "$SECTION_MARKER" "$CLAUDE_MD"; then
  echo "==> CLAUDE.md already contains Error Collector section. Skipping."
else
  echo "==> Adding Error Collector instruction to $CLAUDE_MD..."
  # Ensure file ends with a newline before appending
  [ -s "$CLAUDE_MD" ] && [ "$(tail -c1 "$CLAUDE_MD")" != "" ] && echo "" >> "$CLAUDE_MD"
  cat >> "$CLAUDE_MD" << 'EOF'

## Error Collector

When the user corrects you (e.g. "that was wrong", "no, not like that", "that's incorrect"),
ALWAYS call the `record_error` tool from the error-collector MCP server.
Derive a short, actionable rule from the correction.
EOF
  echo "    Done."
fi

echo ""
echo "==> Installation complete!"
echo "    Restart Claude Code to activate the error-collector."
