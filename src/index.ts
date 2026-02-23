import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod";
import { readFile, writeFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const SECTION_HEADER = "## Learned Rules";

// --- Types ---

interface RuleMetadata {
  date?: string; // YYYY-MM-DD
  category?: string; // e.g. "n8n", "bash", "google-workspace", "general"
}

interface ParsedRule {
  text: string; // rule text without metadata comment
  metadata: RuleMetadata;
}

interface ParsedSection {
  uncategorized: ParsedRule[]; // rules without ### heading (legacy)
  categories: Map<string, ParsedRule[]>; // category name -> rules
}

// --- Metadata Utilities ---

const METADATA_REGEX = /<!--\s*(.*?)\s*-->/;
const META_FIELD_REGEX = /@(\w+):(\S+)/g;

function parseMetadata(line: string): { text: string; metadata: RuleMetadata } {
  const match = line.match(METADATA_REGEX);
  if (!match) return { text: line.trim(), metadata: {} };

  const text = line.replace(METADATA_REGEX, "").trim();
  const metadata: RuleMetadata = {};
  let fieldMatch: RegExpExecArray | null;
  while ((fieldMatch = META_FIELD_REGEX.exec(match[1])) !== null) {
    if (fieldMatch[1] === "date") metadata.date = fieldMatch[2];
    if (fieldMatch[1] === "category") metadata.category = fieldMatch[2];
  }
  return { text, metadata };
}

function formatMetadata(meta: RuleMetadata): string {
  const parts: string[] = [];
  if (meta.date) parts.push(`@date:${meta.date}`);
  if (meta.category) parts.push(`@category:${meta.category}`);
  if (parts.length === 0) return "";
  return ` <!-- ${parts.join(" ")} -->`;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  n8n: ["n8n", "workflow", "n8n_"],
  bash: ["bash", "shell", "cli", "command", "terminal"],
  "google-workspace": [
    "google", "apps script", "workspace", "gmail", "sheets", "drive",
    "calendar", "confluence", "docs",
  ],
  atlassian: ["jira", "confluence", "atlassian", "bitbucket"],
  git: ["git", "commit", "branch", "merge", "rebase"],
  mcp: ["mcp", "tool", "server"],
};

function autoDetectCategory(text: string): string {
  const lower = text.toLowerCase();
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) return category;
  }
  return "general";
}

// Priority order for category headings in CLAUDE.md
const CATEGORY_ORDER = [
  "n8n",
  "bash",
  "google-workspace",
  "atlassian",
  "git",
  "mcp",
  "general",
];

/**
 * Find the appropriate CLAUDE.md file.
 * 1. If project_dir given: walk up looking for CLAUDE.md
 * 2. If found and NOT in home dir: use it (project-level)
 * 3. Fallback: ~/.claude/CLAUDE.md (global)
 */
async function findClaudeMd(projectDir?: string): Promise<string> {
  const home = homedir();
  const globalPath = join(home, ".claude", "CLAUDE.md");

  if (projectDir) {
    let dir = projectDir;
    while (true) {
      const candidate = join(dir, "CLAUDE.md");
      try {
        await access(candidate);
        // Found a CLAUDE.md - use it if it's not in the home directory itself
        if (dir !== home) {
          return candidate;
        }
        break;
      } catch {
        // Not found, go up
      }
      const parent = dirname(dir);
      if (parent === dir) break; // reached root
      dir = parent;
    }
  }

  return globalPath;
}

/**
 * Parse the Learned Rules section from file content.
 * Recognizes ### Category headings and metadata comments.
 */
function parseLearnedRulesSection(content: string): ParsedSection {
  const section: ParsedSection = {
    uncategorized: [],
    categories: new Map(),
  };

  const sectionIndex = content.indexOf(SECTION_HEADER);
  if (sectionIndex === -1) return section;

  const afterHeader = content.substring(sectionIndex + SECTION_HEADER.length);
  const lines = afterHeader.split("\n");

  let currentCategory: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    // Stop at next ## section header (not ### which is category)
    if (trimmed.startsWith("## ") && !trimmed.startsWith("### ")) break;

    // Detect ### Category heading
    if (trimmed.startsWith("### ")) {
      currentCategory = trimmed.substring(4).trim().toLowerCase();
      if (!section.categories.has(currentCategory)) {
        section.categories.set(currentCategory, []);
      }
      continue;
    }

    // Collect bullet points
    if (trimmed.startsWith("- ")) {
      const rawContent = trimmed.substring(2);
      const { text, metadata } = parseMetadata(rawContent);
      const rule: ParsedRule = { text, metadata };

      // If we're under a category heading, use that as category
      if (currentCategory) {
        if (!rule.metadata.category) {
          rule.metadata.category = currentCategory;
        }
        section.categories.get(currentCategory)!.push(rule);
      } else {
        section.uncategorized.push(rule);
      }
    }
  }

  return section;
}

/**
 * Get all rules as a flat array (backward-compatible wrapper).
 */
function getAllRules(section: ParsedSection): ParsedRule[] {
  const all: ParsedRule[] = [...section.uncategorized];
  for (const rules of section.categories.values()) {
    all.push(...rules);
  }
  return all;
}

/**
 * Read the Learned Rules section from a CLAUDE.md file.
 * Returns the full file content and the parsed section.
 */
async function readLearnedRules(
  filePath: string
): Promise<{ content: string; section: ParsedSection }> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    content = "";
  }

  const section = parseLearnedRulesSection(content);
  return { content, section };
}

/**
 * Title-case a category name for display as ### heading.
 */
function categoryDisplayName(cat: string): string {
  return cat
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("-");
}

/**
 * Render the complete Learned Rules section content (without the ## header).
 */
function renderLearnedRulesSection(rules: ParsedRule[]): string {
  const uncategorized: ParsedRule[] = [];
  const byCategory = new Map<string, ParsedRule[]>();

  for (const rule of rules) {
    const cat = rule.metadata.category;
    if (!cat) {
      uncategorized.push(rule);
    } else {
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat)!.push(rule);
    }
  }

  const lines: string[] = [];

  // Uncategorized rules first (legacy, no heading)
  for (const rule of uncategorized) {
    lines.push(`- ${rule.text}${formatMetadata(rule.metadata)}`);
  }

  // Sorted categories
  const sortedCats = [...byCategory.keys()].sort((a, b) => {
    const ai = CATEGORY_ORDER.indexOf(a);
    const bi = CATEGORY_ORDER.indexOf(b);
    const aIdx = ai === -1 ? CATEGORY_ORDER.length : ai;
    const bIdx = bi === -1 ? CATEGORY_ORDER.length : bi;
    if (aIdx !== bIdx) return aIdx - bIdx;
    return a.localeCompare(b);
  });

  for (const cat of sortedCats) {
    const catRules = byCategory.get(cat)!;
    if (lines.length > 0) lines.push(""); // blank line before heading
    lines.push(`### ${categoryDisplayName(cat)}`);
    lines.push(""); // blank line after heading
    for (const rule of catRules) {
      lines.push(`- ${rule.text}${formatMetadata(rule.metadata)}`);
    }
  }

  return lines.join("\n");
}

/**
 * Write the learned rules section back to a CLAUDE.md file.
 * Preserves all content outside the ## Learned Rules section.
 */
async function writeLearnedRulesSection(
  filePath: string,
  rules: ParsedRule[]
): Promise<void> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    content = "";
  }

  const sectionContent = renderLearnedRulesSection(rules);
  const sectionIndex = content.indexOf(SECTION_HEADER);

  if (sectionIndex === -1) {
    // Section doesn't exist - append it
    const separator =
      content.length > 0 && !content.endsWith("\n\n")
        ? content.endsWith("\n")
          ? "\n"
          : "\n\n"
        : "";
    content =
      content + separator + SECTION_HEADER + "\n\n" + sectionContent + "\n";
  } else {
    // Find the end of the section (next ## header or EOF)
    const afterHeader = content.substring(
      sectionIndex + SECTION_HEADER.length
    );
    const lines = afterHeader.split("\n");

    let sectionEnd = sectionIndex + SECTION_HEADER.length;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("## ") && !trimmed.startsWith("### ")) break;
      sectionEnd += line.length + 1; // +1 for newline
    }

    const before = content.substring(0, sectionIndex + SECTION_HEADER.length);
    const after = content.substring(sectionEnd);
    content = before + "\n\n" + sectionContent + "\n" + after;
  }

  await writeFile(filePath, content, "utf-8");
}

/**
 * Check if a new rule is a duplicate of existing rules.
 * Returns the matching rule or null.
 */
function isDuplicate(
  existingRules: ParsedRule[],
  newRuleText: string
): ParsedRule | null {
  const lower = newRuleText.toLowerCase();
  for (const existing of existingRules) {
    const existingLower = existing.text.toLowerCase();
    if (existingLower.includes(lower) || lower.includes(existingLower)) {
      return existing;
    }
  }
  return null;
}

// --- Helper: find rule by index or match ---

function findRule(
  allRules: ParsedRule[],
  index?: number,
  match?: string
): { rule: ParsedRule; idx: number } | { error: string } {
  if (index !== undefined && match !== undefined) {
    return { error: "Provide either `index` or `match`, not both." };
  }
  if (index === undefined && match === undefined) {
    return { error: "Provide either `index` (1-based) or `match` (substring)." };
  }

  if (index !== undefined) {
    if (index < 1 || index > allRules.length) {
      return {
        error: `Index ${index} out of range. There are ${allRules.length} rules.`,
      };
    }
    return { rule: allRules[index - 1], idx: index - 1 };
  }

  // match by substring
  const lower = match!.toLowerCase();
  const matches = allRules
    .map((r, i) => ({ rule: r, idx: i }))
    .filter((m) => m.rule.text.toLowerCase().includes(lower));

  if (matches.length === 0) {
    return { error: `No rule matching "${match}" found.` };
  }
  if (matches.length > 1) {
    const list = matches
      .map((m) => `  ${m.idx + 1}. ${m.rule.text}`)
      .join("\n");
    return {
      error: `Ambiguous match — ${matches.length} rules match "${match}":\n${list}\n\nUse \`index\` to specify which one.`,
    };
  }
  return matches[0];
}

// --- MCP Server Setup ---

const server = new McpServer(
  {
    name: "error-collector",
    version: "1.1.0",
  },
  {
    instructions:
      "When the user corrects you (e.g. \"that was wrong\", \"no, not like that\", \"that's incorrect\"), " +
      "derive a short, actionable rule from the correction. " +
      "Before calling `record_error`, review existing learned rules in CLAUDE.md and check if a semantically equivalent rule already exists. " +
      "If clearly new: call `record_error`. " +
      "If clearly a duplicate: skip silently. " +
      "If similar but not identical: ask the user whether to (a) add the new rule alongside the existing one, " +
      "(b) use `update_rule` to replace/consolidate the rules, or (c) skip. " +
      "Use `delete_rule` when a rule is no longer needed. " +
      "Use `review_rules` periodically to check for stale rules.",
  }
);

// --- Tool: record_error (extended with category) ---

server.tool(
  "record_error",
  "Record a correction from the user and save it as a learned rule in CLAUDE.md. Call this whenever the user corrects you.",
  {
    error_description: z.string().describe("What was wrong"),
    correction: z.string().describe("What is correct"),
    rule: z
      .string()
      .describe('Derived guideline, e.g. "ALWAYS use X instead of Y"'),
    category: z
      .string()
      .optional()
      .describe(
        'Rule category (e.g. "n8n", "bash", "google-workspace", "general"). Auto-detected if omitted.'
      ),
    project_dir: z
      .string()
      .optional()
      .describe("Current working directory (to find project CLAUDE.md)"),
  },
  async ({ error_description, correction, rule, category, project_dir }) => {
    const filePath = await findClaudeMd(project_dir);
    const { section } = await readLearnedRules(filePath);
    const allRules = getAllRules(section);

    const duplicate = isDuplicate(allRules, rule);
    if (duplicate) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Rule already exists in ${filePath}. No duplicate added.\nExisting: ${duplicate.text}`,
          },
        ],
      };
    }

    const resolvedCategory = category || autoDetectCategory(rule);
    const newRule: ParsedRule = {
      text: rule,
      metadata: { date: todayISO(), category: resolvedCategory },
    };

    allRules.push(newRule);
    await writeLearnedRulesSection(filePath, allRules);

    return {
      content: [
        {
          type: "text" as const,
          text: `Rule recorded in ${filePath} [${resolvedCategory}]:\n- ${rule}\n\nError: ${error_description}\nCorrection: ${correction}`,
        },
      ],
    };
  }
);

// --- Tool: list_errors (extended with category filter + grouped) ---

server.tool(
  "list_errors",
  "List all learned rules from the CLAUDE.md file. Optionally filter by category or show grouped by category.",
  {
    category: z
      .string()
      .optional()
      .describe("Filter rules by category (e.g. \"n8n\", \"bash\")"),
    grouped: z
      .boolean()
      .optional()
      .describe("Group rules by category with headings (default: false)"),
    project_dir: z
      .string()
      .optional()
      .describe("Current working directory (to find project CLAUDE.md)"),
  },
  async ({ category, grouped, project_dir }) => {
    const filePath = await findClaudeMd(project_dir);
    const { section } = await readLearnedRules(filePath);
    let allRules = getAllRules(section);

    if (category) {
      const lower = category.toLowerCase();
      allRules = allRules.filter(
        (r) => (r.metadata.category || "").toLowerCase() === lower
      );
    }

    if (allRules.length === 0) {
      const suffix = category ? ` in category "${category}"` : "";
      return {
        content: [
          {
            type: "text" as const,
            text: `No learned rules found${suffix} in ${filePath}.`,
          },
        ],
      };
    }

    if (grouped) {
      // Group by category
      const uncategorized: string[] = [];
      const byCategory = new Map<string, string[]>();

      for (const rule of allRules) {
        const cat = rule.metadata.category;
        const datePrefix = rule.metadata.date
          ? `[${rule.metadata.date}] `
          : "";
        const line = `- ${datePrefix}${rule.text}`;
        if (!cat) {
          uncategorized.push(line);
        } else {
          if (!byCategory.has(cat)) byCategory.set(cat, []);
          byCategory.get(cat)!.push(line);
        }
      }

      const parts: string[] = [];
      if (uncategorized.length > 0) {
        parts.push("### Uncategorized\n" + uncategorized.join("\n"));
      }
      const sortedCats = [...byCategory.keys()].sort((a, b) => {
        const ai = CATEGORY_ORDER.indexOf(a);
        const bi = CATEGORY_ORDER.indexOf(b);
        const aIdx = ai === -1 ? CATEGORY_ORDER.length : ai;
        const bIdx = bi === -1 ? CATEGORY_ORDER.length : bi;
        if (aIdx !== bIdx) return aIdx - bIdx;
        return a.localeCompare(b);
      });
      for (const cat of sortedCats) {
        parts.push(
          `### ${categoryDisplayName(cat)}\n` +
            byCategory.get(cat)!.join("\n")
        );
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Learned Rules from ${filePath}:\n\n${parts.join("\n\n")}`,
          },
        ],
      };
    }

    // Flat list with metadata
    const formatted = allRules
      .map((r, i) => {
        const dateStr = r.metadata.date ? `[${r.metadata.date}]` : "[no date]";
        const catStr = r.metadata.category || "uncategorized";
        return `${i + 1}. ${dateStr} [${catStr}] ${r.text}`;
      })
      .join("\n");

    return {
      content: [
        {
          type: "text" as const,
          text: `Learned Rules from ${filePath}:\n\n${formatted}`,
        },
      ],
    };
  }
);

// --- Tool: delete_rule ---

server.tool(
  "delete_rule",
  "Delete a learned rule from CLAUDE.md by index or substring match.",
  {
    index: z
      .number()
      .optional()
      .describe("1-based index of the rule to delete (use list_errors to see indices)"),
    match: z
      .string()
      .optional()
      .describe("Substring to match the rule text. Must match exactly one rule."),
    project_dir: z
      .string()
      .optional()
      .describe("Current working directory (to find project CLAUDE.md)"),
  },
  async ({ index, match, project_dir }) => {
    const filePath = await findClaudeMd(project_dir);
    const { section } = await readLearnedRules(filePath);
    const allRules = getAllRules(section);

    const result = findRule(allRules, index, match);
    if ("error" in result) {
      return {
        content: [{ type: "text" as const, text: result.error }],
      };
    }

    const deleted = allRules.splice(result.idx, 1)[0];
    await writeLearnedRulesSection(filePath, allRules);

    return {
      content: [
        {
          type: "text" as const,
          text: `Deleted rule from ${filePath}:\n- ${deleted.text}`,
        },
      ],
    };
  }
);

// --- Tool: update_rule ---

server.tool(
  "update_rule",
  "Update an existing learned rule in CLAUDE.md. Finds by index or substring match, replaces text, updates date.",
  {
    index: z
      .number()
      .optional()
      .describe("1-based index of the rule to update"),
    match: z
      .string()
      .optional()
      .describe("Substring to match the rule text. Must match exactly one rule."),
    new_rule: z.string().describe("The new rule text"),
    category: z
      .string()
      .optional()
      .describe("New category for the rule (keeps existing if omitted)"),
    project_dir: z
      .string()
      .optional()
      .describe("Current working directory (to find project CLAUDE.md)"),
  },
  async ({ index, match, new_rule, category, project_dir }) => {
    const filePath = await findClaudeMd(project_dir);
    const { section } = await readLearnedRules(filePath);
    const allRules = getAllRules(section);

    const result = findRule(allRules, index, match);
    if ("error" in result) {
      return {
        content: [{ type: "text" as const, text: result.error }],
      };
    }

    // Check for duplicates against OTHER rules
    const otherRules = allRules.filter((_, i) => i !== result.idx);
    const duplicate = isDuplicate(otherRules, new_rule);
    if (duplicate) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Cannot update: new rule text would duplicate existing rule:\n- ${duplicate.text}`,
          },
        ],
      };
    }

    const oldText = allRules[result.idx].text;
    allRules[result.idx].text = new_rule;
    allRules[result.idx].metadata.date = todayISO();
    if (category) {
      allRules[result.idx].metadata.category = category;
    }

    await writeLearnedRulesSection(filePath, allRules);

    return {
      content: [
        {
          type: "text" as const,
          text: `Updated rule in ${filePath}:\n- Old: ${oldText}\n- New: ${new_rule}`,
        },
      ],
    };
  }
);

// --- Tool: review_rules ---

server.tool(
  "review_rules",
  "Review all learned rules with their age. Shows old rules that may need updating or removal.",
  {
    older_than_days: z
      .number()
      .optional()
      .describe("Threshold in days to consider a rule 'old' (default: 30)"),
    project_dir: z
      .string()
      .optional()
      .describe("Current working directory (to find project CLAUDE.md)"),
  },
  async ({ older_than_days, project_dir }) => {
    const filePath = await findClaudeMd(project_dir);
    const { section } = await readLearnedRules(filePath);
    const allRules = getAllRules(section);

    if (allRules.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No learned rules found in ${filePath}.`,
          },
        ],
      };
    }

    const threshold = older_than_days ?? 30;
    const now = Date.now();
    const msPerDay = 86400000;

    const old: { rule: ParsedRule; days: number }[] = [];
    const recent: { rule: ParsedRule; days: number }[] = [];
    const undated: ParsedRule[] = [];

    for (const rule of allRules) {
      if (!rule.metadata.date) {
        undated.push(rule);
        continue;
      }
      const ruleDate = new Date(rule.metadata.date).getTime();
      const days = Math.floor((now - ruleDate) / msPerDay);
      if (days >= threshold) {
        old.push({ rule, days });
      } else {
        recent.push({ rule, days });
      }
    }

    const parts: string[] = [];

    if (old.length > 0) {
      parts.push(
        `### Old rules (>= ${threshold} days)\n` +
          old
            .map(
              (o) =>
                `- [${o.days}d] [${o.rule.metadata.category || "uncategorized"}] ${o.rule.text}`
            )
            .join("\n")
      );
    }

    if (recent.length > 0) {
      parts.push(
        `### Recent rules (< ${threshold} days)\n` +
          recent
            .map(
              (r) =>
                `- [${r.days}d] [${r.rule.metadata.category || "uncategorized"}] ${r.rule.text}`
            )
            .join("\n")
      );
    }

    if (undated.length > 0) {
      parts.push(
        `### Undated rules (no @date metadata)\n` +
          undated
            .map(
              (r) =>
                `- [${r.metadata.category || "uncategorized"}] ${r.text}`
            )
            .join("\n")
      );
    }

    const summary = `\n---\nSummary: ${allRules.length} total — ${old.length} old, ${recent.length} recent, ${undated.length} undated`;

    return {
      content: [
        {
          type: "text" as const,
          text: `Rule Review for ${filePath}:\n\n${parts.join("\n\n")}${summary}`,
        },
      ],
    };
  }
);

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
