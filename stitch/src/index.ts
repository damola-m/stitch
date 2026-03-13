/* ===================================
   index.ts
   -----------------------------------
   - MCP server entry point. Bridges MCP-compatible AI clients (e.g. Claude)
     to the Gemini API via stdio transport.
   - Exposes seven tools: generate_content, pdf_to_markdown, search_web,
     analyse_codebase, log_solution, search_knowledge, update_knowledge.
   - Requires GEMINI_API_KEY in environment (via .env or shell export).
   =================================== */

// =============================
// Part 1 — Initialisation & Setup
// =============================

// dotenv must resolve the .env path explicitly — process.cwd() is unreliable
// when Claude Desktop or Claude Code spawns the server from their own CWD.
//
// Two search locations (checked in order):
//   1. %APPDATA%\Stitch\.env  — written by the packaged Electron setup app
//   2. ../.env relative to build/  — used in development (stitch/.env)
import { fileURLToPath } from "node:url";
import { config as dotenvConfig } from "dotenv";
import * as path from "path";
import { existsSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const packagedEnvPath = process.env.APPDATA
  ? path.join(process.env.APPDATA, "Stitch", ".env")
  : path.join(path.dirname(__dirname), ".stitch", ".env"); // non-Windows fallback

const devEnvPath = path.resolve(__dirname, "../.env");

dotenvConfig({ path: existsSync(packagedEnvPath) ? packagedEnvPath : devEnvPath });

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { GoogleGenAI, type Content, type Part } from "@google/genai";
import * as fs from "fs/promises";
import * as mime from "mime-types";
import { glob } from "glob";
// ignore is a CJS package; the d.ts ships `export default` but Node16 module
// resolution needs an explicit type import to keep the callable shape intact.
import ignore, { type Ignore } from "ignore";
import {
  initDb,
  insertSolution,
  searchSolutions,
  updateSolution,
  formatRow,
  type CodeSnippet,
  type UpdateFields,
} from "./knowledge.js";

// Fail early rather than surfacing a cryptic API error mid-request.
if (!process.env.GEMINI_API_KEY) {
  console.error("[server] Fatal: GEMINI_API_KEY is not set. Add it to .env or your shell environment.");
  process.exit(1);
}

// Initialise the SQLite knowledge base (creates file + tables on first run).
initDb();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ── Model Registry ────────────────────────────────────────────────────────────
// Each tool is pinned to the model that best fits its cost/quality trade-off
// given the available free-tier quota. Centralised here so a single-line
// edit can swap any model without hunting through tool handlers.
//
// Confirmed available on this API key (verified in AI Studio dashboard):
//   gemini-2.5-flash     → 20K RPD / 20M TPD  — fast workhorse, multimodal
//   gemini-2.5-pro       → 2K  RPD /  8M TPD  — highest reasoning quality, 1M ctx
//   gemini-2.5-flash-lite→ 30K RPD / 30M TPD  — highest throughput, lightest tasks
//   gemini-2.0-flash     → 30K RPD / 30M TPD  — search grounding, reliable
//   gemini-3-flash       → 20K RPD / 20M TPD  — newest generation flash (verify ID)
//   gemini-3.1-pro       → 2K  RPD /  8M TPD  — newest generation pro (verify ID)
//
// NOTE: Gemini 1.5 Pro is NOT available on this key — do not use it.
// NOTE: Gemini 3.x model API IDs should be verified at aistudio.google.com/apikey
//       if the default IDs below return 404/model-not-found errors.
const MODELS = {
  // generate_content default — 2.5 Flash has ample quota and full multimodal support
  GENERATE: "gemini-2.5-flash",

  // pdf_to_markdown — Pro-class vision/spatial reasoning gives the most faithful
  // Markdown extraction; worth spending the 2K/day PRO quota on document work
  PDF: "gemini-2.5-pro",

  // search_web — 2.0 Flash is explicitly optimised for Search grounding
  // and has the highest free-tier TPD (30M), ideal for frequent lookups
  RESEARCH: "gemini-2.0-flash",

  // analyse_codebase — 2.5 Pro has the deepest reasoning and a 1M-token context
  // window, making it the correct substitute for the unavailable gemini-1.5-pro
  ANALYZE: "gemini-2.5-pro",

  // search_knowledge — Flash is fast and cheap; used to semantically rank
  // FTS5 keyword candidates before surfacing results to the user
  KNOWLEDGE_AI: "gemini-2.5-flash",
} as const;

const server = new Server(
  {
    name: "stitch",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// =============================
// Part 2 — Resilience Utilities
// =============================

/**
 * Wraps an async operation with exponential backoff for rate-limit errors.
 *
 * Gemini returns HTTP 429 / RESOURCE_EXHAUSTED when the free-tier quota is
 * exceeded. Retrying with a delay is the correct response; hammering the API
 * immediately would just burn the quota faster.
 *
 * @param {() => Promise<T>} operation  The async call to retry.
 * @param {number}           maxAttempts  Maximum number of attempts (default 3).
 * @returns {Promise<T>}
 */
async function withRetry<T>(
  operation: () => Promise<T>,
  maxAttempts = 3
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error: unknown) {
      const isRateLimit =
        (error as { status?: number }).status === 429 ||
        (error instanceof Error &&
          error.message.toUpperCase().includes("RESOURCE_EXHAUSTED"));

      const isLastAttempt = attempt === maxAttempts;

      if (!isRateLimit || isLastAttempt) throw error;

      // Exponential backoff: 1 s, 2 s, 4 s …
      const delayMs = Math.pow(2, attempt - 1) * 1000;
      console.error(
        `[server] Rate limit hit (attempt ${attempt}/${maxAttempts}). Retrying in ${delayMs}ms…`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error("[server] withRetry: exhausted all attempts");
}

// =============================
// Part 3 — Tool Registration
// =============================

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "generate_content",
        description:
          "General-purpose multimodal generation. Supports text, images, audio, and video via local file paths or pre-encoded base64 data. Use this as the default workhorse for Gemini calls.",
        inputSchema: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "The main instruction or question.",
            },
            system_instruction: {
              type: "string",
              description: "Optional persona or behaviour guide for the model.",
            },
            model: {
              type: "string",
              description:
                "Gemini model to use. Defaults to gemini-2.5-flash (20K RPD). " +
                "Upgrade to gemini-2.5-pro for complex reasoning (2K RPD). " +
                "Use gemini-2.5-flash-lite or gemini-2.0-flash for high-volume lightweight tasks (30K RPD). " +
                "Try gemini-3-flash or gemini-3.1-pro for the newest generation (verify API IDs in AI Studio).",
            },
            temperature: {
              type: "number",
              description:
                "Sampling temperature (0–2). Lower = more deterministic. Defaults to 0.2.",
            },
            files: {
              type: "array",
              description:
                "Optional array of file references. Each item must have either 'path' (local absolute path) or both 'base64' and 'mimeType'.",
              items: {
                type: "object",
                properties: {
                  path: { type: "string" },
                  base64: { type: "string" },
                  mimeType: { type: "string" },
                },
              },
            },
          },
          required: ["prompt"],
        },
      },
      {
        name: "pdf_to_markdown",
        description:
          "Converts a local PDF to structured Markdown using Gemini 2.5 Pro's vision capabilities. " +
          "Pro-class spatial reasoning gives the most faithful extraction from scanned documents, " +
          "mixed-layout reports, and complex specifications.",
        inputSchema: {
          type: "object",
          properties: {
            file_path: {
              type: "string",
              description: "Absolute path to the PDF file.",
            },
            include_tables: {
              type: "boolean",
              description:
                "When true, the model is explicitly prompted to preserve tables in GitHub-Flavoured Markdown format.",
            },
          },
          required: ["file_path"],
        },
      },
      {
        name: "search_web",
        description:
          "Answers questions using Gemini 2.0 Flash with live Google Search grounding. " +
          "2.0 Flash is explicitly optimised for search synthesis and has the highest free-tier " +
          "daily token allowance (30M TPD) — use this freely for any question requiring current information.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The research question or topic.",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "analyse_codebase",
        description:
          "Recursively reads a local directory, packs all source files into a single context block, and delegates " +
          "analysis to Gemini 2.5 Pro's 1 M-token context window and deep reasoning capabilities. " +
          "Use for architecture reviews, security audits, refactoring suggestions, or any task requiring " +
          "whole-repository comprehension. (Uses the Pro quota: 2K RPD / 8M TPD.)",
        inputSchema: {
          type: "object",
          properties: {
            directory_path: {
              type: "string",
              description: "Absolute path to the root of the codebase.",
            },
            analysis_prompt: {
              type: "string",
              description:
                "Instructions for the analysis, e.g. 'Find all SQL injection risks' or 'Summarise the module architecture'.",
            },
            ignore_patterns: {
              type: "array",
              items: { type: "string" },
              description:
                "Additional glob patterns to exclude beyond .gitignore defaults (e.g. ['dist/**', '*.min.js']).",
            },
          },
          required: ["directory_path", "analysis_prompt"],
        },
      },
      {
        name: "log_solution",
        description:
          "Saves a problem and its solution to the persistent knowledge base. " +
          "IMPORTANT: Never call this automatically. Always ask the user first: " +
          "'The issue appears resolved — should I save this to the knowledge base?' " +
          "Only call this tool after the user explicitly confirms. " +
          "The user can also invoke it directly to feed in knowledge manually. " +
          "Entries are stored with full metadata (project, tags, date, environment) and are instantly " +
          "searchable via search_knowledge.",
        inputSchema: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "Short summary of the issue (e.g. 'Electron ipcRenderer.invoke hangs on first load').",
            },
            problem: {
              type: "string",
              description: "Full description of the problem, including context, symptoms, and any error messages observed.",
            },
            solution: {
              type: "string",
              description: "The fix or workaround that resolved the issue. Be specific — include what was changed and why.",
            },
            code_snippets: {
              type: "array",
              description: "Optional code examples illustrating the fix.",
              items: {
                type: "object",
                properties: {
                  language: { type: "string", description: "e.g. 'typescript', 'csharp', 'json'" },
                  code:     { type: "string", description: "The code snippet." },
                  description: { type: "string", description: "Brief label for the snippet." },
                },
                required: ["language", "code"],
              },
            },
            project: {
              type: "string",
              description: "Project name or path this issue occurred in (e.g. 'Stitch', 'CannonFly').",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Keywords for filtering (e.g. ['electron', 'ipc', 'typescript']).",
            },
            error_message: {
              type: "string",
              description: "The exact error text, stack trace, or compiler message if applicable.",
            },
            environment: {
              type: "string",
              description: "OS, runtime version, framework version, etc. (e.g. 'Windows 11, Node 22, Electron 35').",
            },
            source: {
              type: "string",
              enum: ["auto", "manual"],
              description: "'auto' when Claude logs this on its own; 'manual' when the user explicitly provides it.",
            },
          },
          required: ["title", "problem", "solution"],
        },
      },
      {
        name: "search_knowledge",
        description:
          "Searches the local knowledge base for previously logged solutions. " +
          "IMPORTANT: Never call this automatically. Only call this tool when the user explicitly asks, " +
          "e.g. 'check the knowledge base', 'search my database', or 'look in my notes for…'. " +
          "SQLite FTS5 does a fast keyword pass to find candidates; Gemini then ranks them semantically " +
          "so the most relevant solution is surfaced regardless of database size. " +
          "Supports optional filters for project, tags, and date range.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search terms (full-text, supports stemming — 'resolving' matches 'resolve').",
            },
            project: {
              type: "string",
              description: "Optional: filter results to a specific project name.",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Optional: filter to entries that contain ALL of the given tags.",
            },
            date_from: {
              type: "string",
              description: "Optional: ISO date string YYYY-MM-DD — only return entries on or after this date.",
            },
            date_to: {
              type: "string",
              description: "Optional: ISO date string YYYY-MM-DD — only return entries on or before this date.",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "update_knowledge",
        description:
          "Updates an existing knowledge base entry. Use this to correct outdated solutions, " +
          "improve descriptions, add missing code snippets, or mark an entry as outdated when " +
          "a better approach has been found. The entry ID is shown in search_knowledge results.",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "number",
              description: "ID of the entry to update (shown as 'ID: X' in search results).",
            },
            title:         { type: "string",  description: "Updated title." },
            problem:       { type: "string",  description: "Updated problem description." },
            solution:      { type: "string",  description: "Updated solution." },
            code_snippets: {
              type: "array",
              description: "Replacement code snippets (replaces the existing list entirely).",
              items: {
                type: "object",
                properties: {
                  language:    { type: "string" },
                  code:        { type: "string" },
                  description: { type: "string" },
                },
                required: ["language", "code"],
              },
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Replacement tag list.",
            },
            status: {
              type: "string",
              enum: ["active", "outdated"],
              description: "Mark as 'outdated' when the solution no longer applies.",
            },
          },
          required: ["id"],
        },
      },
    ],
  };
});

// =============================
// Part 4 — File Handling Helpers
// =============================

/**
 * Resolves a file reference to an inline-data Part for the Gemini API.
 *
 * The API strictly requires { inlineData: { data: base64, mimeType } }.
 * Mime type is detected from the file extension; falling back to
 * application/octet-stream prevents hard crashes on unusual formats.
 *
 * @param {{ path?: string; base64?: string; mimeType?: string }} file
 * @returns {Promise<Part>}
 */
async function resolveFileToInlinePart(
  file: { path?: string; base64?: string; mimeType?: string }
): Promise<Part> {
  if (file.path) {
    const buffer = await fs.readFile(file.path);
    const detectedMime = mime.lookup(file.path) || "application/octet-stream";
    return {
      inlineData: {
        data: buffer.toString("base64"),
        mimeType: detectedMime,
      },
    };
  }

  if (file.base64 && file.mimeType) {
    return {
      inlineData: {
        data: file.base64,
        mimeType: file.mimeType,
      },
    };
  }

  throw new Error(
    "Each file entry must have either 'path' or both 'base64' and 'mimeType'."
  );
}

// =============================
// Part 5 — Tool Execution
// =============================

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // ── Tool: generate_content ──────────────────────────────────────────────────
  if (name === "generate_content") {
    try {
      const prompt = args?.prompt as string;
      const systemInstruction = args?.system_instruction as string | undefined;
      const model = (args?.model as string) || MODELS.GENERATE;
      const temperature = (args?.temperature as number) ?? 0.2;
      const fileRefs = (args?.files as Array<{
        path?: string;
        base64?: string;
        mimeType?: string;
      }>) || [];

      // Build the parts array: text prompt first, then any attached files.
      // Order matters for Gemini — interleaving is supported but leading with
      // the instruction keeps context clear.
      const parts: Part[] = [{ text: prompt }];

      for (const fileRef of fileRefs) {
        parts.push(await resolveFileToInlinePart(fileRef));
      }

      // Wrap in a Content object so the role is explicit. Without 'role',
      // the API infers 'user' but the explicit form avoids ambiguity.
      const contents: Content[] = [{ role: "user", parts }];

      const response = await withRetry(() =>
        ai.models.generateContent({
          model,
          contents,
          config: {
            ...(systemInstruction && { systemInstruction }),
            temperature,
          },
        })
      );

      return {
        content: [{ type: "text", text: response.text ?? "" }],
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `generate_content error: ${message}` }],
        isError: true,
      };
    }
  }

  // ── Tool: pdf_to_markdown ───────────────────────────────────────────────────
  if (name === "pdf_to_markdown") {
    try {
      const filePath = args?.file_path as string;
      const includeTables = (args?.include_tables as boolean) ?? false;

      const buffer = await fs.readFile(filePath);
      const base64 = buffer.toString("base64");

      // The system instruction is the key driver here: an explicit persona that
      // prioritises fidelity over creativity gives far cleaner Markdown output
      // than a bare prompt alone.
      const systemInstruction = [
        "You are an expert document parser. Your sole task is to convert the provided PDF into clean, well-structured Markdown.",
        "Rules:",
        "- Preserve all headings using # / ## / ### hierarchy.",
        "- Preserve all lists (ordered and unordered).",
        "- Preserve all code blocks using triple-backtick fences with language hints where identifiable.",
        "- Preserve footnotes and captions as italicised text beneath their parent element.",
        includeTables
          ? "- Convert ALL tables to GitHub-Flavoured Markdown table syntax. Do not skip or summarise any table."
          : "- Represent tables as descriptive prose rather than attempting ASCII art.",
        "- Do NOT add commentary, preamble, or closing remarks — output ONLY the Markdown.",
      ].join("\n");

      const contents: Content[] = [
        {
          role: "user",
          parts: [
            {
              inlineData: {
                data: base64,
                mimeType: "application/pdf",
              },
            },
            {
              text: "Convert this PDF to structured Markdown per your instructions.",
            },
          ],
        },
      ];

      const response = await withRetry(() =>
        ai.models.generateContent({
          model: MODELS.PDF,
          contents,
          config: {
            systemInstruction,
            temperature: 0.1, // Low temperature for faithful extraction
          },
        })
      );

      return {
        content: [{ type: "text", text: response.text ?? "" }],
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `pdf_to_markdown error: ${message}` }],
        isError: true,
      };
    }
  }

  // ── Tool: search_web ─────────────────────────────────────────────────
  if (name === "search_web") {
    try {
      const query = args?.query as string;

      // googleSearch is a first-class config tool in the new GenAI SDK; it
      // instructs the model to issue real-time queries and cite sources inline.
      // gemini-2.0-flash is the recommended model for search grounding as of
      // mid-2025 — it balances speed with sufficient reasoning for synthesis.
      const response = await withRetry(() =>
        ai.models.generateContent({
          model: MODELS.RESEARCH,
          contents: query, // ContentListUnion accepts a bare string for simple prompts
          config: {
            tools: [{ googleSearch: {} }],
            temperature: 0.3,
          },
        })
      );

      // Surface grounding metadata so the caller can verify sources.
      // The SDK returns this on the first candidate's groundingMetadata field;
      // the type is intentionally loose here because the metadata shape varies.
      const candidate = response.candidates?.[0] as
        | {
            groundingMetadata?: {
              groundingChunks?: Array<{
                web?: { uri?: string; title?: string };
              }>;
            };
          }
        | undefined;

      const sources: string[] = [];

      if (candidate?.groundingMetadata?.groundingChunks) {
        for (const chunk of candidate.groundingMetadata.groundingChunks) {
          if (chunk.web?.uri) {
            sources.push(
              `- [${chunk.web.title ?? chunk.web.uri}](${chunk.web.uri})`
            );
          }
        }
      }

      const sourcesBlock =
        sources.length > 0
          ? `\n\n---\n**Sources**\n${sources.join("\n")}`
          : "";

      return {
        content: [
          { type: "text", text: (response.text ?? "") + sourcesBlock },
        ],
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          { type: "text", text: `search_web error: ${message}` },
        ],
        isError: true,
      };
    }
  }

  // ── Tool: analyse_codebase ──────────────────────────────────────────────────
  if (name === "analyse_codebase") {
    try {
      const directoryPath = args?.directory_path as string;
      const analysisPrompt = args?.analysis_prompt as string;
      const extraIgnorePatterns = (args?.ignore_patterns as string[]) || [];

      // ── Step 1 — Build the ignore filter ─────────────────────────────────
      // We use the `ignore` package to honour .gitignore semantics (e.g.
      // negation patterns, directory-level rules) rather than naive glob
      // exclusion, which would silently miss edge cases.
      //
      // Gotcha: `ignore` is a CJS package. Its TypeScript types declare
      // `export default` but Node16 module resolution makes the default
      // non-callable without an explicit cast. The cast is safe — verified
      // at runtime via require("ignore") which returns a callable factory.
      const ig = (ignore as unknown as () => Ignore)();

      // Sane defaults — these directories almost never contain meaningful
      // source code worth sending to the model, but they do contain massive
      // amounts of generated/vendor text that would waste context budget.
      ig.add([
        "node_modules/**",
        ".git/**",
        "dist/**",
        "build/**",
        "out/**",
        ".next/**",
        ".nuxt/**",
        "coverage/**",
        "*.lock",
        "package-lock.json",
        "yarn.lock",
        "pnpm-lock.yaml",
        "*.min.js",
        "*.min.css",
        "*.map",
      ]);

      // Honour the project's own .gitignore if present.
      const gitignorePath = path.join(directoryPath, ".gitignore");
      try {
        const gitignoreContent = await fs.readFile(gitignorePath, "utf-8");
        ig.add(gitignoreContent);
      } catch {
        // No .gitignore is fine — just continue with defaults.
      }

      if (extraIgnorePatterns.length > 0) {
        ig.add(extraIgnorePatterns);
      }

      // ── Step 2 — Traverse the directory ──────────────────────────────────
      // glob returns relative paths from cwd, which is what `ignore` expects.
      const allFiles = await glob("**/*", {
        cwd: directoryPath,
        nodir: true,    // Files only — directories themselves are not packable
        dot: true,      // Include dotfiles (e.g. .env.example, .eslintrc)
        follow: false,  // Never follow symlinks — avoids infinite loops
      });

      const filteredFiles = allFiles.filter((f) => !ig.ignores(f));

      // ── Step 3 — Pack source files into a single context block ────────────
      // All files are concatenated with a clear header comment so the model
      // can cross-reference filenames in its analysis output. Binary files
      // (images, fonts, etc.) are silently skipped — readFile with 'utf-8'
      // throws on them.
      let packedContext = "";
      let fileCount = 0;
      const skippedFiles: string[] = [];

      for (const relPath of filteredFiles) {
        const absolutePath = path.join(directoryPath, relPath);
        try {
          const content = await fs.readFile(absolutePath, "utf-8");

          // Skip files that contain null bytes — strong indicator of binary data.
          if (content.includes("\0")) {
            skippedFiles.push(relPath);
            continue;
          }

          packedContext += `// File: ${relPath}\n${content}\n\n`;
          fileCount++;
        } catch {
          // Unreadable files (binary, permission errors) are silently excluded.
          skippedFiles.push(relPath);
        }
      }

      // Rough token estimate: Gemini tokenises at ~3.5 chars/token on average
      // for mixed source code. We surface this so the caller can gauge whether
      // the context budget is at risk.
      const estimatedTokens = Math.round(packedContext.length / 3.5);
      const preamble = [
        `Analysing ${fileCount} files from: ${directoryPath}`,
        `Estimated tokens: ~${estimatedTokens.toLocaleString()}`,
        skippedFiles.length > 0
          ? `Skipped ${skippedFiles.length} binary/unreadable file(s).`
          : null,
        "─".repeat(60),
      ]
        .filter(Boolean)
        .join("\n");

      // ── Step 4 — Delegate to Gemini 2.5 Pro ──────────────────────────────
      // 2.5 Pro replaces the unavailable 1.5 Pro: it has a 1 M-token context
      // window and materially better reasoning, which produces more actionable
      // architectural observations. Flash would truncate large repos silently.
      const fullPrompt = `${analysisPrompt}\n\n---\n\n${packedContext}`;

      const response = await withRetry(() =>
        ai.models.generateContent({
          model: MODELS.ANALYZE,
          contents: fullPrompt,
          config: {
            systemInstruction:
              "You are a senior software architect conducting a thorough code review. Cite specific file paths and line content when making observations. Structure your response with clear headings.",
            temperature: 0.2, // Low temperature for analytical consistency
            maxOutputTokens: 8192,
          },
        })
      );

      return {
        content: [
          {
            type: "text",
            text: `${preamble}\n\n${response.text ?? ""}`,
          },
        ],
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          { type: "text", text: `analyse_codebase error: ${message}` },
        ],
        isError: true,
      };
    }
  }

  // ── Tool: log_solution ──────────────────────────────────────────────────────
  if (name === "log_solution") {
    try {
      const entry = {
        title:         args?.title         as string,
        problem:       args?.problem       as string,
        solution:      args?.solution      as string,
        code_snippets: args?.code_snippets as CodeSnippet[] | undefined,
        project:       args?.project       as string | undefined,
        tags:          args?.tags          as string[] | undefined,
        error_message: args?.error_message as string | undefined,
        environment:   args?.environment   as string | undefined,
        source:        (args?.source ?? "auto") as "auto" | "manual",
      };

      const { id } = insertSolution(entry);

      return {
        content: [
          {
            type: "text",
            text: [
              `Solution logged successfully.`,
              `ID:      ${id}`,
              `Title:   ${entry.title}`,
              `Project: ${entry.project || "(none)"}`,
              `Tags:    ${(entry.tags ?? []).join(", ") || "(none)"}`,
              ``,
              `Use search_knowledge to retrieve it later.`,
            ].join("\n"),
          },
        ],
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `log_solution error: ${message}` }],
        isError: true,
      };
    }
  }

  // ── Tool: search_knowledge ──────────────────────────────────────────────────
  if (name === "search_knowledge") {
    try {
      const opts = {
        query:     args?.query     as string,
        project:   args?.project   as string | undefined,
        tags:      args?.tags      as string[] | undefined,
        date_from: args?.date_from as string | undefined,
        date_to:   args?.date_to   as string | undefined,
      };

      const rows = searchSolutions(opts);

      if (rows.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No matching entries found for: "${opts.query}"\n\nTip: Try broader terms or remove project/tag filters.`,
            },
          ],
        };
      }

      // Format all candidates as readable text blocks for Gemini to reason over.
      // SQLite FTS already narrowed the field to the most keyword-relevant entries;
      // Gemini now applies semantic understanding to surface the best match(es).
      const formatted = rows
        .map((row, i) => formatRow(row, i + 1))
        .join("\n\n" + "═".repeat(60) + "\n\n");

      const rankingPrompt =
        `The user searched for: "${opts.query}"\n\n` +
        `Below are ${rows.length} knowledge base entr${rows.length === 1 ? "y" : "ies"} retrieved by keyword search. ` +
        `Identify which entr${rows.length === 1 ? "y" : "ies"} best address the query. ` +
        `Quote the ID and title of the best match(es), explain why they are relevant, ` +
        `and summarise the key solution steps in a clear, actionable way.\n\n` +
        `---\n\n` +
        formatted;

      const aiResponse = await withRetry(() =>
        ai.models.generateContent({
          model: MODELS.KNOWLEDGE_AI,
          contents: rankingPrompt,
          config: {
            systemInstruction:
              "You are a precise technical knowledge retrieval assistant. " +
              "Analyse the candidate entries and surface only what is genuinely relevant to the query. " +
              "If no entry is a good match, say so clearly rather than forcing a fit.",
            temperature: 0.1,
          },
        })
      );

      const header = `Found ${rows.length} candidate${rows.length === 1 ? "" : "s"} for: "${opts.query}"\n\n`;

      return {
        content: [
          {
            type: "text",
            text:
              header +
              `AI ANALYSIS\n` +
              `${"─".repeat(60)}\n` +
              (aiResponse.text ?? "") +
              `\n\n${"═".repeat(60)}\n\nRAW ENTRIES\n${"─".repeat(60)}\n\n` +
              formatted,
          },
        ],
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `search_knowledge error: ${message}` }],
        isError: true,
      };
    }
  }

  // ── Tool: update_knowledge ──────────────────────────────────────────────────
  if (name === "update_knowledge") {
    try {
      const id = args?.id as number;
      const updates: UpdateFields = {};

      if (args?.title         !== undefined) updates.title         = args.title         as string;
      if (args?.problem       !== undefined) updates.problem       = args.problem       as string;
      if (args?.solution      !== undefined) updates.solution      = args.solution      as string;
      if (args?.code_snippets !== undefined) updates.code_snippets = args.code_snippets as CodeSnippet[];
      if (args?.tags          !== undefined) updates.tags          = args.tags          as string[];
      if (args?.status        !== undefined) updates.status        = args.status        as "active" | "outdated";

      if (Object.keys(updates).length === 0) {
        return {
          content: [{ type: "text", text: "No fields to update were provided." }],
          isError: true,
        };
      }

      updateSolution(id, updates);

      const updatedFields = Object.keys(updates).join(", ");
      return {
        content: [
          {
            type: "text",
            text: `Entry ${id} updated successfully.\nFields changed: ${updatedFields}`,
          },
        ],
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `update_knowledge error: ${message}` }],
        isError: true,
      };
    }
  }

  // Unrecognised tool name — the MCP SDK will surface this to the client.
  throw new Error(`Unknown tool: ${name}`);
});

// =============================
// Part 6 — Transport Initialisation
// =============================

/**
 * Connects the MCP server to the stdio transport and starts listening.
 * All JSON-RPC messages flow over stdin/stdout; stderr is used for diagnostic
 * logging so it does not pollute the protocol stream.
 */
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[server] Stitch running on stdio — waiting for client requests.");
}

main().catch((error: unknown) => {
  console.error("[server] Fatal error:", error);
  process.exit(1);
});
