# Claude Error Collector

An MCP server for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) that learns from your corrections. When you tell Claude "that was wrong" or "no, do it like this", it records the lesson as a rule in your `CLAUDE.md` - so the same mistake doesn't happen twice.

## How It Works

1. You correct Claude during a coding session
2. Claude recognizes the correction and calls the `record_error` tool
3. The server derives a rule and writes it to the appropriate `CLAUDE.md`
4. Claude reads that rule in future sessions and avoids repeating the mistake

The server automatically detects whether you're in a project directory (writes to project `CLAUDE.md`) or your home directory (writes to `~/.claude/CLAUDE.md`).

## Tools

### `record_error`

Records a correction and saves it as a learned rule.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `error_description` | string | yes | What was wrong |
| `correction` | string | yes | What is correct |
| `rule` | string | yes | Derived guideline, e.g. "ALWAYS use X instead of Y" |
| `project_dir` | string | no | Current working directory (for finding project CLAUDE.md) |

### `list_errors`

Lists all learned rules from the relevant `CLAUDE.md`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_dir` | string | no | Current working directory |

## Output Format

Rules are stored in a `## Learned Rules` section in your `CLAUDE.md`:

```markdown
## Learned Rules

- ALWAYS use async/await for API calls, NOT .then() chains
- Google Apps Script uses Logger.log(), NOT console.log()
- Confluence API expects ADF format, NOT Wiki markup
```

## Installation

```bash
git clone https://github.com/henningziech/claude-error-collector.git
cd claude-error-collector
./install.sh
```

The install script handles everything:
1. Installs dependencies and builds the project
2. Registers the MCP server with Claude Code (`claude mcp add`)

No manual `CLAUDE.md` editing needed — the server provides its own instructions to Claude via MCP server metadata.

Restart Claude Code after installation to activate.

### Manual Installation

If you prefer to set things up manually:

```bash
npm install && npm run build
claude mcp add error-collector -- node /path/to/claude-error-collector/dist/index.js
```

## CLAUDE.md Resolution

The server finds the right `CLAUDE.md` using this logic:

1. If `project_dir` is provided: walk up the directory tree looking for `CLAUDE.md`
2. If found and not in the home directory: use it (project-level rules)
3. Fallback: `~/.claude/CLAUDE.md` (global rules)

## Duplicate Detection

Before writing a rule, the server checks existing rules using case-insensitive substring matching. If the new rule is already covered by an existing one (or vice versa), it skips the write.

## License

MIT
