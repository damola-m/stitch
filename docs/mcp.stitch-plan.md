# Stitch — Architecture & Design Reference

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture Diagram](#2-architecture-diagram)
3. [Project Structure](#3-project-structure)
4. [Tool Reference](#4-tool-reference)
5. [Model Registry](#5-model-registry)
6. [Resilience & Retry Strategy](#6-resilience--retry-strategy)
7. [File Handling Pipeline](#7-file-handling-pipeline)
8. [Codebase Packing Algorithm](#8-codebase-packing-algorithm)
9. [Configuration Reference](#9-configuration-reference)
10. [Visual Studio Setup](#10-visual-studio-setup)
11. [Extension Points](#11-extension-points)

---

## 1. Project Overview

Stitch is a **stdio-transport MCP server** written in TypeScript (Node.js ESM). It implements the [Model Context Protocol](https://modelcontextprotocol.io/) so that any MCP-compatible AI client (Claude Desktop, Claude Code CLI, custom agents) can call Gemini API capabilities as native tools — without the client needing to know anything about the Gemini SDK.

**Why "Stitch":** it stitches the MCP protocol layer onto the Gemini API, making the two talk to each other seamlessly.

### Design Goals

- **Zero HTTP server overhead** — communicates over stdio only; no ports, no firewall rules.
- **One compiled artefact** — `build/index.js` is the only runtime output; no multi-process orchestration.
- **Fail-fast on misconfiguration** — exits at startup if `GEMINI_API_KEY` is missing, rather than crashing at the first tool call.
- **Centralised model control** — all model assignments live in one `MODELS` constant; swapping models never requires touching tool logic.
- **Resilient by default** — every Gemini API call goes through exponential-backoff retry without the tool author needing to think about it.

---

## 2. Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                      AI Client                              │
│  (Claude Desktop / Claude Code CLI / custom MCP consumer)   │
└──────────────────────────┬──────────────────────────────────┘
                           │ JSON-RPC 2.0 over stdio
                           │ (ListTools / CallTool requests)
┌──────────────────────────▼──────────────────────────────────┐
│                      Stitch Server                           │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  @modelcontextprotocol/sdk  (StdioServerTransport)  │    │
│  └──────────────────┬──────────────────────────────────┘    │
│                     │                                        │
│  ┌──────────────────▼──────────────────────────────────┐    │
│  │              Tool Dispatcher                         │    │
│  │  generate_content │ pdf_to_markdown                  │    │
│  │  search_web       │ analyse_codebase                 │    │
│  │  add_knowledge    │ search_knowledge                 │    │
│  │  list_knowledge                                      │    │
│  └──────────────────┬──────────────────────────────────┘    │
│                     │                                        │
│  ┌──────────────────▼──────────────────────────────────┐    │
│  │           withRetry() — exponential backoff          │    │
│  └──────────────────┬──────────────────────────────────┘    │
└─────────────────────┼───────────────────────────────────────┘
                      │ HTTPS (REST)
                      │ GEMINI_API_KEY
┌─────────────────────▼───────────────────────────────────────┐
│                    Google Gemini API                         │
│  gemini-2.5-flash  │  gemini-2.5-pro  │  gemini-2.0-flash   │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Project Structure

```
Stitch/
└── Project Codes/                  ← git root
    ├── Stitch.sln                  ← Visual Studio solution (open this)
    ├── .gitignore
    ├── README.md                   ← GitHub-facing documentation
    ├── docs/
    │   ├── quick.notes.md          ← Run commands cheat-sheet
    │   ├── mcp.connection.md       ← Connection guide (Claude Desktop + Code)
    │   └── mcp.stitch-plan.md      ← This file
    └── stitch/
        ├── stitch.esproj           ← Visual Studio JavaScript SDK project
        ├── package.json
        ├── tsconfig.json
        ├── .env                    ← Local secrets (git-ignored)
        ├── .env.example            ← Committed template
        ├── src/
        │   ├── index.ts            ← Entire server: init, tools, transport
        │   └── knowledge.ts        ← SQLite knowledge base (node:sqlite)
        ├── setup/
        │   ├── index.html          ← Setup UI
        │   ├── main.cjs            ← Electron main process
        │   └── preload.cjs         ← Electron preload bridge
        └── build/                  ← Compiled output (git-ignored)
            ├── index.js
            ├── index.d.ts
            └── *.map
```

---

## 4. Tool Reference

### 4.1 `generate_content`

**Purpose:** General-purpose multimodal generation. The default tool for any Gemini call.

**Model:** `gemini-2.5-flash` (default, overridable via `model` param)

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `prompt` | string | Yes | Main instruction |
| `system_instruction` | string | No | Persona / behaviour guide |
| `model` | string | No | Override model ID |
| `temperature` | number | No | 0–2, default 0.2 |
| `files` | array | No | File references (see below) |

**File reference shape:**
```json
{ "path": "/absolute/path/to/file.jpg" }
// OR
{ "base64": "...", "mimeType": "image/jpeg" }
```

**Flow:**
1. Build `Part[]` — text prompt first, then resolved file inline-data parts.
2. Wrap in `Content[]` with `role: "user"`.
3. Call `ai.models.generateContent()` via `withRetry()`.
4. Return `response.text`.

---

### 4.2 `pdf_to_markdown`

**Purpose:** Faithful PDF → Markdown conversion using Gemini's spatial vision reasoning.

**Model:** `gemini-2.5-pro` — deliberately uses the Pro quota here because layout parsing (multi-column, embedded tables, footnotes) benefits materially from better vision reasoning.

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `file_path` | string | Yes | Absolute path to PDF |
| `include_tables` | boolean | No | When true, forces GFM table syntax |

**Flow:**
1. `fs.readFile(filePath)` → base64 encode.
2. Build a strong system instruction with explicit formatting rules.
3. Send as `inlineData` with `mimeType: "application/pdf"`.
4. `temperature: 0.1` — minimises hallucination, maximises fidelity.

---

### 4.3 `search_web`

**Purpose:** Live, cited answers using Google Search as a grounding tool.

**Model:** `gemini-2.0-flash` — this model is explicitly tuned for Search grounding and has the highest free-tier daily token allowance (30M TPD).

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | Yes | Research question |

**Flow:**
1. Pass `contents: query` (bare string, valid `ContentListUnion`).
2. Set `config.tools: [{ googleSearch: {} }]`.
3. Extract `groundingMetadata.groundingChunks` from the first candidate.
4. Append a `**Sources**` block with Markdown links to the response text.

---

### 4.4 `analyse_codebase`

**Purpose:** Whole-repository analysis via Gemini's 1M-token context window.

**Model:** `gemini-2.5-pro` — provides large context capacity with superior reasoning for code review.

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `directory_path` | string | Yes | Absolute path to repo root |
| `analysis_prompt` | string | Yes | What to look for |
| `ignore_patterns` | string[] | No | Additional glob patterns to exclude |

**Flow:** see [Section 8 — Codebase Packing Algorithm](#8-codebase-packing-algorithm).

---

### 4.5 `add_knowledge` / `search_knowledge` / `list_knowledge`

**Purpose:** Persistent local knowledge base stored in SQLite (`node:sqlite`, no compilation needed).

**Storage:** `%APPDATA%\Stitch\knowledge.db` (Windows) or `~/.stitch/knowledge.db` (fallback).

| Tool | Key parameters | Description |
|---|---|---|
| `add_knowledge` | `title`, `content`, `tags[]`, `category` | Store a note or snippet |
| `search_knowledge` | `query`, `limit` | Full-text search with FTS5 Porter stemmer |
| `list_knowledge` | `category`, `tag`, `limit` | Browse entries by filter |

---

## 5. Model Registry

```typescript
const MODELS = {
  GENERATE:  "gemini-2.5-flash",   // 20K RPD / 20M TPD
  PDF:       "gemini-2.5-pro",     //  2K RPD /  8M TPD
  RESEARCH:  "gemini-2.0-flash",   // 30K RPD / 30M TPD
  ANALYZE:   "gemini-2.5-pro",     //  2K RPD /  8M TPD
  KNOWLEDGE: "gemini-2.5-flash",   // 20K RPD / 20M TPD
} as const;
```

**Available models on this API key** (as of 2026-03):

| Friendly Name | Expected API ID | RPD | TPD | Notes |
|---|---|---|---|---|
| Gemini 2.5 Flash | `gemini-2.5-flash` | 20K | 20M | Default workhorse |
| Gemini 2.5 Pro | `gemini-2.5-pro` | 2K | 8M | Best reasoning & vision |
| Gemini 2.5 Flash Lite | `gemini-2.5-flash-lite` | 30K | 30M | Highest throughput |
| Gemini 2.0 Flash | `gemini-2.0-flash` | 30K | 30M | Search grounding |
| Gemini 2.0 Flash Lite | `gemini-2.0-flash-lite` | 30K | 30M | Lightweight |
| Gemini 3 Flash | `gemini-3-flash` *(verify)* | 20K | 20M | Newest generation |
| Gemini 3.1 Flash Lite | `gemini-3.1-flash-lite` *(verify)* | 30K | 30M | Newest lite |
| Gemini 3.1 Pro | `gemini-3.1-pro` *(verify)* | 2K | 8M | Newest pro |

> **Verify Gemini 3.x IDs** at [aistudio.google.com](https://aistudio.google.com/app/apikey) — the API model identifiers for newer releases may differ from the dashboard friendly names.

> `gemini-1.5-pro` is **NOT available** on this API key. Do not use it.

---

## 6. Resilience & Retry Strategy

All Gemini calls are wrapped in `withRetry<T>()`:

```
Attempt 1 ──► success → return
              429/RESOURCE_EXHAUSTED → wait 1s
Attempt 2 ──► success → return
              429/RESOURCE_EXHAUSTED → wait 2s
Attempt 3 ──► success → return
              any error → throw
```

- Triggers on: `error.status === 429` OR `error.message.includes("RESOURCE_EXHAUSTED")`
- Does NOT retry on other errors (bad API key, invalid model, malformed request) — these are programming errors that retrying cannot fix.
- Delay: `2^(attempt-1) * 1000` ms → 1s, 2s, 4s.

---

## 7. File Handling Pipeline

`resolveFileToInlinePart()` converts any file reference into a `Part` the Gemini API accepts:

```
Input: { path: "/foo/bar.jpg" }
  → fs.readFile() → Buffer
  → .toString("base64")
  → mime.lookup("/foo/bar.jpg") → "image/jpeg"
  → { inlineData: { data: "...", mimeType: "image/jpeg" } }

Input: { base64: "...", mimeType: "application/pdf" }
  → passthrough
  → { inlineData: { data: "...", mimeType: "application/pdf" } }
```

**Gotcha:** The Gemini API validates `mimeType` strictly. `mime-types` falls back to `application/octet-stream` for unknown extensions — this will typically cause an API rejection. When sending unusual file types, provide the `base64 + mimeType` form explicitly.

---

## 8. Codebase Packing Algorithm

`analyse_codebase` traverses a local directory and builds a single context string:

```
1. Initialise `ignore` filter
   ├── Add hardcoded defaults (node_modules/**, .git/**, dist/**, *.lock, *.min.js, etc.)
   ├── Read .gitignore from directory_path if present → add to filter
   └── Add caller-supplied ignore_patterns

2. glob("**/*", { cwd: directory_path, nodir: true, dot: true })
   → all file paths relative to directory_path

3. Filter: allFiles.filter(f => !ig.ignores(f))

4. For each filtered file:
   ├── fs.readFile(absolutePath, "utf-8")
   ├── Skip if content contains "\0"  ← binary file detection
   ├── On read error → skip silently  ← permission errors, true binary
   └── Append:  "// File: {relPath}\n{content}\n\n"

5. Build preamble:
   "Analysing N files from: {path}"
   "Estimated tokens: ~{len/3.5}"
   "Skipped M binary/unreadable file(s)."

6. Final prompt: "{analysis_prompt}\n\n---\n\n{packed_context}"

7. Send to gemini-2.5-pro with:
   systemInstruction: "senior software architect, cite file paths..."
   temperature: 0.2
   maxOutputTokens: 8192
```

**Token estimation:** `characters / 3.5` ≈ tokens for mixed source code. This is a rough guide only — the actual tokeniser count will vary. For very large repos (> 500K estimated tokens), consider passing additional `ignore_patterns` to focus on the most relevant subsystems.

---

## 9. Configuration Reference

### `.env`

```env
# Required
GEMINI_API_KEY=AIza...
```

### `tsconfig.json` key settings

| Option | Value | Why |
|---|---|---|
| `module` | `Node16` | Required by `@modelcontextprotocol/sdk` — it uses explicit `.js` import extensions which only validate under Node16/NodeNext |
| `moduleResolution` | `Node16` | Matches the module mode |
| `target` | `ES2022` | Supports top-level await, modern class syntax |
| `outDir` | `./build` | Compiled JS output |
| `strict` | `true` | Full type safety |

### `stitch.esproj` key settings

| Property | Value |
|---|---|
| `StartupCommand` | `npm run dev` |
| `ShouldRunBuildScript` | `true` (runs `tsc` on VS Build) |
| `BuildOutputFolder` | `$(MSBuildProjectDirectory)\build` |

---

## 10. Visual Studio Setup

The solution uses the **Microsoft.VisualStudio.JavaScript.Sdk** — the same SDK used in Script.Manager's frontend project.

**To open:** Double-click `Stitch.sln` or use File → Open → Project/Solution in VS 2022.

**To build from VS:** Right-click `stitch` in Solution Explorer → Build. This runs `tsc` via the `npm run build` script.

**To run the dev watch compiler from VS:** Right-click → Start Without Debugging. This runs `npm run dev` (= `node --watch build/index.js`).

**Required VS component:** `Node.js development` workload (includes the JS SDK). Install via Visual Studio Installer if the `.esproj` fails to load.

---

## 11. Extension Points

### Adding a new tool

1. Add a new entry to the `tools` array in `ListToolsRequestSchema` handler.
2. Add a new `if (name === "your_tool")` block in `CallToolRequestSchema` handler.
3. Add a new entry to `MODELS` if the tool needs a dedicated model.
4. Rebuild: `npm run build`.

### Adding streaming support

The `@google/genai` SDK exposes `ai.models.generateContentStream()` which returns an `AsyncGenerator`. The MCP SDK supports streaming responses — replace the single `return { content: [...] }` with progressive yielding if needed for long-running analyses.

### Upgrading the MCP SDK

```powershell
cd path/to/stitch
npm update @modelcontextprotocol/sdk @google/genai
npm run build
```

Check the [MCP changelog](https://github.com/modelcontextprotocol/typescript-sdk) for breaking changes before upgrading.
