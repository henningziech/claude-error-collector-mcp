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

Records a correction and saves it as a learned rule with metadata (date, category).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `error_description` | string | yes | What was wrong |
| `correction` | string | yes | What is correct |
| `rule` | string | yes | Derived guideline, e.g. "ALWAYS use X instead of Y" |
| `category` | string | no | Rule category (e.g. "n8n", "bash", "google-workspace"). Auto-detected if omitted. |
| `project_dir` | string | no | Current working directory (for finding project CLAUDE.md) |

### `list_errors`

Lists all learned rules from the relevant `CLAUDE.md`. Supports filtering and grouping.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `category` | string | no | Filter rules by category |
| `grouped` | boolean | no | Group rules by category with headings |
| `project_dir` | string | no | Current working directory |

### `delete_rule`

Deletes a learned rule by index or substring match.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `index` | number | no* | 1-based index of the rule to delete |
| `match` | string | no* | Substring to match (must match exactly one rule) |
| `project_dir` | string | no | Current working directory |

*Exactly one of `index` or `match` must be provided.

### `update_rule`

Updates an existing rule's text, date, and optionally category.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `index` | number | no* | 1-based index of the rule to update |
| `match` | string | no* | Substring to match (must match exactly one rule) |
| `new_rule` | string | yes | The new rule text |
| `category` | string | no | New category (keeps existing if omitted) |
| `project_dir` | string | no | Current working directory |

*Exactly one of `index` or `match` must be provided.

### `review_rules`

Reviews all rules with their age for lifecycle management.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `older_than_days` | number | no | Threshold in days to consider "old" (default: 30) |
| `project_dir` | string | no | Current working directory |

## Output Format

Rules are stored in a `## Learned Rules` section in your `CLAUDE.md` with metadata as HTML comments:

```markdown
## Learned Rules

- Legacy rule without metadata (still supported)

### N8n

- Bei n8n IMMER nodeId verwenden <!-- @date:2026-02-15 @category:n8n -->

### Bash

- NEVER embed large JSON inline in Bash commands <!-- @date:2026-02-20 @category:bash -->
```

Metadata fields:
- `@date:YYYY-MM-DD` — when the rule was created/updated
- `@category:name` — rule category for grouping

Rules without metadata (legacy format) remain fully supported and appear at the top of the section without a category heading.

## Installation

```bash
git clone https://github.com/henningziech/claude-error-collector-mcp.git
cd claude-error-collector-mcp
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

Duplicate detection works on two levels:

1. **Server-side**: Before writing a rule, the server checks existing rules using case-insensitive substring matching. If the new rule is already covered by an existing one (or vice versa), it skips the write.

2. **Semantic (via instructions)**: The server instructs Claude to review existing learned rules for semantic equivalence *before* calling `record_error` — even if the wording differs. Claude will:
   - **Skip silently** if the rule clearly already exists
   - **Record it** if the rule is clearly new
   - **Ask the user** if a similar rule exists but it's not 100% clear whether it's a duplicate, offering options to add alongside, consolidate, or skip

## License

MIT
