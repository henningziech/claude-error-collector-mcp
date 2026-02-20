import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod";
import { readFile, writeFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const SECTION_HEADER = "## Learned Rules";

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
 * Read the Learned Rules section from a CLAUDE.md file.
 * Returns the full file content and the extracted rules.
 */
async function readLearnedRules(
  filePath: string
): Promise<{ content: string; rules: string[] }> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    content = "";
  }

  const rules: string[] = [];
  const sectionIndex = content.indexOf(SECTION_HEADER);
  if (sectionIndex === -1) return { content, rules };

  const afterHeader = content.substring(
    sectionIndex + SECTION_HEADER.length
  );
  const lines = afterHeader.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    // Stop at next section header
    if (trimmed.startsWith("## ") && trimmed !== SECTION_HEADER) break;
    // Collect bullet points
    if (trimmed.startsWith("- ")) {
      rules.push(trimmed.substring(2));
    }
  }

  return { content, rules };
}

/**
 * Check if a new rule is a duplicate of existing rules.
 * Uses case-insensitive substring matching.
 */
function isDuplicate(existingRules: string[], newRule: string): boolean {
  const lower = newRule.toLowerCase();
  return existingRules.some((existing) => {
    const existingLower = existing.toLowerCase();
    return existingLower.includes(lower) || lower.includes(existingLower);
  });
}

/**
 * Write a new rule to the Learned Rules section of CLAUDE.md.
 */
async function writeRule(filePath: string, rule: string): Promise<void> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    // File doesn't exist yet - create with section
    content = "";
  }

  const sectionIndex = content.indexOf(SECTION_HEADER);

  if (sectionIndex === -1) {
    // Section doesn't exist - append it
    const separator = content.length > 0 && !content.endsWith("\n\n")
      ? content.endsWith("\n") ? "\n" : "\n\n"
      : "";
    content = content + separator + SECTION_HEADER + "\n\n- " + rule + "\n";
  } else {
    // Section exists - find the end of existing rules to insert new one
    const afterHeader = content.substring(sectionIndex + SECTION_HEADER.length);
    const lines = afterHeader.split("\n");

    let insertOffset = sectionIndex + SECTION_HEADER.length;
    let lastRuleEnd = insertOffset;

    for (const line of lines) {
      insertOffset += line.length + 1; // +1 for newline
      const trimmed = line.trim();
      if (trimmed.startsWith("## ") && trimmed !== SECTION_HEADER) break;
      if (trimmed.startsWith("- ") || trimmed === "") {
        lastRuleEnd = insertOffset;
      }
    }

    // Insert the new rule at the end of the rules section
    const before = content.substring(0, lastRuleEnd);
    const after = content.substring(lastRuleEnd);
    const needsNewline = before.endsWith("\n") ? "" : "\n";
    content = before + needsNewline + "- " + rule + "\n" + after;
  }

  await writeFile(filePath, content, "utf-8");
}

// --- MCP Server Setup ---

const server = new McpServer({
  name: "error-collector",
  version: "1.0.0",
});

server.tool(
  "record_error",
  "Record a correction from the user and save it as a learned rule in CLAUDE.md. Call this whenever the user corrects you.",
  {
    error_description: z.string().describe("What was wrong"),
    correction: z.string().describe("What is correct"),
    rule: z
      .string()
      .describe(
        'Derived guideline, e.g. "IMMER X statt Y verwenden"'
      ),
    project_dir: z
      .string()
      .optional()
      .describe("Current working directory (to find project CLAUDE.md)"),
  },
  async ({ error_description, correction, rule, project_dir }) => {
    const filePath = await findClaudeMd(project_dir);
    const { rules: existingRules } = await readLearnedRules(filePath);

    if (isDuplicate(existingRules, rule)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Rule already exists in ${filePath}. No duplicate added.`,
          },
        ],
      };
    }

    await writeRule(filePath, rule);

    return {
      content: [
        {
          type: "text" as const,
          text: `Rule recorded in ${filePath}:\n- ${rule}\n\nError: ${error_description}\nCorrection: ${correction}`,
        },
      ],
    };
  }
);

server.tool(
  "list_errors",
  "List all learned rules from the CLAUDE.md file.",
  {
    project_dir: z
      .string()
      .optional()
      .describe("Current working directory (to find project CLAUDE.md)"),
  },
  async ({ project_dir }) => {
    const filePath = await findClaudeMd(project_dir);
    const { rules } = await readLearnedRules(filePath);

    if (rules.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No learned rules found in ${filePath}.`,
          },
        ],
      };
    }

    const formatted = rules.map((r) => `- ${r}`).join("\n");
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

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
