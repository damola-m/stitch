# Stitch

Stitch is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that gives Claude direct access to the Google Gemini API — and builds a persistent, searchable knowledge base of every problem you've solved together.

Most MCP servers extend Claude with a single capability: a web search tool, a database connector, or a file reader. Stitch takes a different approach. It combines seven purpose-built tools into one cohesive layer: Gemini's multimodal generation, live Google Search grounding, PDF parsing, large-scale codebase analysis, and a local knowledge base that grows with every project you work on. The result is a Claude that doesn't just answer questions in isolation — it remembers your stack, your past fixes, and your preferred patterns, and draws on that context every time you code.

---

## What It Does

Claude can call Gemini directly from within your conversation, choosing the right model and tool for each task automatically. You get the best of both: Claude's reasoning, planning, and context-awareness combined with Gemini's 1M-token context window, real-time Google Search grounding, and multimodal capabilities.

The knowledge base is what sets Stitch apart from a simple Gemini bridge. Every time you and Claude resolve a non-trivial problem — a tricky bug, an architectural decision, a working configuration — you can log it with full metadata: project, tags, environment, error messages, and code snippets. That solution is stored locally in a SQLite database and is instantly searchable from any future conversation. When Claude hits a similar problem, it can query your own history first, find the exact fix that worked in your environment, and apply it — rather than starting from scratch or suggesting generic solutions that may not fit your stack.

Over time, your knowledge base becomes a personal engineering library that Claude always has access to: faster debugging, fewer repeated mistakes, and solutions built on what has actually worked for you before.

---

## Prerequisites

- **Node.js 22.5+** — required for the built-in `node:sqlite` module
- A **Gemini API key** — free tier at [aistudio.google.com/api-keys](https://aistudio.google.com/api-keys)
- **Claude Desktop** or **Claude Code** as the MCP client

---

## Installation

### Option A — Installer (Windows)

Download the latest `.exe` from the [Releases](../../releases) page and run it. The setup wizard saves your API key and registers the MCP server with Claude automatically.

### Option B — Manual

```bash
# Clone the repository
git clone https://github.com/your-username/stitch.git
cd stitch

# Install dependencies
npm install

# Build the server
npm run build
```

Then add the following to your Claude Desktop config (`%APPDATA%\Claude\claude_desktop_config.json`) or Claude Code config (`~/.claude.json`):

```json
{
  "mcpServers": {
    "stitch": {
      "command": "node",
      "args": ["path/to/stitch/build/index.js"]
    }
  }
}
```

Or register via the Claude Code CLI:

```bash
claude mcp add stitch -s user -- node "path/to/stitch/build/index.js"
```

> The API key is read automatically from `%APPDATA%\Stitch\.env` (set by the installer) or a `.env` file in the project root. No `env` block needed in the Claude config.

---

## Tools

Stitch exposes seven tools. Claude selects the appropriate one automatically, or you can invoke them by name.

---

### `generate_content`
**Model:** Gemini 2.5 Flash

General-purpose multimodal generation. Accepts text, images, audio, and video via local file paths or base64-encoded data. The default tool for any task that benefits from Gemini's capabilities.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | ✓ | The instruction or question |
| `system_instruction` | string | | Optional persona or behaviour guide |
| `model` | string | | Override the default model |
| `temperature` | number | | Sampling temperature 0–2 (default 0.2) |
| `files` | array | | File references — `path` or `base64` + `mimeType` |

---

### `pdf_to_markdown`
**Model:** Gemini 2.5 Pro

Converts a local PDF to clean, structured Markdown. Pro-class vision and spatial reasoning gives faithful extraction from scanned documents, mixed-layout reports, and complex technical specifications.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | ✓ | Absolute path to the PDF file |
| `include_tables` | boolean | | Preserve tables in GitHub-Flavoured Markdown format |

---

### `search_web`
**Model:** Gemini 2.0 Flash + Google Search

Answers questions using live Google Search grounding. Returns cited sources alongside the response. Use for anything requiring up-to-date information that Claude's training data may not cover. Highest free-tier allowance (30M tokens/day).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | ✓ | The research question or topic |

---

### `analyse_codebase`
**Model:** Gemini 2.5 Pro

Recursively reads a local directory, packs all source files into a single context block, and delegates to Gemini's 1M-token context window for deep analysis. Use for architecture reviews, security audits, refactoring suggestions, or whole-repository comprehension.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `directory_path` | string | ✓ | Absolute path to the root of the codebase |
| `analysis_prompt` | string | ✓ | Instructions for the analysis |
| `ignore_patterns` | string[] | | Additional glob patterns to exclude |

Respects `.gitignore` automatically. Common directories (`node_modules`, `dist`, `build`, etc.) are always excluded.

---

### `log_solution`
**Model:** Local (SQLite — no API call)

Saves a resolved problem and its solution to your persistent local knowledge base. Claude will always ask for your confirmation before saving — nothing is stored without explicit approval. You can also feed in knowledge manually at any time.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | ✓ | Short summary of the issue |
| `problem` | string | ✓ | Full description of the problem |
| `solution` | string | ✓ | The fix or workaround |
| `code_snippets` | array | | Code examples with `language`, `code`, `description` |
| `project` | string | | Project name the issue occurred in |
| `tags` | string[] | | Keywords for filtering |
| `error_message` | string | | Exact error text or stack trace |
| `environment` | string | | OS, runtime, and framework versions |

---

### `search_knowledge`
**Model:** SQLite FTS5 + Gemini 2.5 Flash

Searches your local knowledge base for previously logged solutions. SQLite FTS5 performs a fast keyword pass; Gemini then ranks the candidates semantically so the most relevant result is surfaced regardless of how large the database grows. Only invoked when you explicitly ask.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | ✓ | Search terms (supports stemming — "resolving" matches "resolve") |
| `project` | string | | Filter by project name |
| `tags` | string[] | | Filter to entries containing all specified tags |
| `date_from` | string | | ISO date `YYYY-MM-DD` — entries on or after |
| `date_to` | string | | ISO date `YYYY-MM-DD` — entries on or before |

---

### `update_knowledge`
**Model:** Local (SQLite — no API call)

Updates an existing knowledge base entry by ID. Use this to correct a solution, add missing code snippets, or mark an entry as outdated when a better approach has been found. Entry IDs are shown in `search_knowledge` results.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | number | ✓ | ID of the entry to update |
| `title` | string | | Updated title |
| `problem` | string | | Updated problem description |
| `solution` | string | | Updated solution |
| `code_snippets` | array | | Replacement snippet list |
| `tags` | string[] | | Replacement tag list |
| `status` | string | | `"active"` or `"outdated"` |

---

## Knowledge Base

The knowledge base is a SQLite database stored locally:

- **Windows:** `%APPDATA%\Stitch\knowledge.db`
- **Other:** `~/.stitch/knowledge.db`

It persists across conversations and app reinstalls. Uses FTS5 with the Porter stemmer for fast full-text search at scale, with Gemini providing semantic ranking on top.

---

## Gemini Free-Tier Quotas

| Model | RPD | TPD | Used by |
|-------|-----|-----|---------|
| Gemini 2.5 Flash | 20K | 20M | `generate_content`, `search_knowledge` |
| Gemini 2.5 Pro | 2K | 8M | `pdf_to_markdown`, `analyse_codebase` |
| Gemini 2.0 Flash | 30K | 30M | `search_web` |

RPD = Requests per Day · TPD = Tokens per Day (free tier, as of 2026)

---

## Project Structure

```
stitch/
├── src/
│   ├── index.ts          # MCP server — all tool definitions and handlers
│   └── knowledge.ts      # SQLite knowledge base module
├── setup/
│   ├── main.cjs          # Electron main process
│   ├── preload.cjs       # Context bridge
│   └── index.html        # Setup UI
├── scripts/
│   └── release.mjs       # Release build script
├── RELEASE.json          # Edit this before running npm run release
├── package.json
└── tsconfig.json
```

---

## Development

```bash
# Compile TypeScript
npm run build

# Watch mode
npm run build:watch

# Run the setup UI (Electron)
npm run setup

# Bundle the server
npm run bundle

# Create a versioned release installer
# 1. Edit RELEASE.json — bump version and add release notes
# 2. Run:
npm run release
```

Releases are output to `../release/v{version}/` and logged to `../release/RELEASES.json`.