/* ===================================
   knowledge.ts
   -----------------------------------
   - Persistent SQLite knowledge base for development problems and solutions.
   - Uses the built-in node:sqlite module (Node.js 22.5+) — zero native deps.
   - DB path: %APPDATA%\Stitch\knowledge.db  (same directory as .env)
   - FTS5 virtual table with Porter stemmer keeps full-text search fast at scale.
   =================================== */

import { DatabaseSync } from "node:sqlite";
import * as path from "path";
import * as os from "os";
import { mkdirSync } from "fs";

const dbDir = process.env.APPDATA
  ? path.join(process.env.APPDATA, "Stitch")
  : path.join(os.homedir(), ".stitch");

const dbPath = path.join(dbDir, "knowledge.db");

let db: DatabaseSync;

// =============================
// Part 1 — Types
// =============================

export interface CodeSnippet {
  language: string;
  code: string;
  description?: string;
}

export interface SolutionEntry {
  title: string;
  problem: string;
  solution: string;
  code_snippets?: CodeSnippet[];
  project?: string;
  tags?: string[];
  error_message?: string;
  environment?: string;
  source?: "auto" | "manual";
}

export interface SolutionRow {
  id: number;
  title: string;
  problem: string;
  solution: string;
  code_snippets: string; // JSON-encoded CodeSnippet[]
  project: string;
  tags: string;          // JSON-encoded string[]
  error_message: string;
  environment: string;
  source: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface SearchOptions {
  query: string;
  project?: string;
  tags?: string[];
  date_from?: string;
  date_to?: string;
}

export interface UpdateFields {
  title?: string;
  problem?: string;
  solution?: string;
  code_snippets?: CodeSnippet[];
  tags?: string[];
  status?: "active" | "outdated";
}

// =============================
// Part 2 — Schema Initialisation
// =============================

export function initDb(): void {
  mkdirSync(dbDir, { recursive: true });
  db = new DatabaseSync(dbPath);

  // WAL mode: better write concurrency, avoids blocking stdio reads
  db.exec("PRAGMA journal_mode = WAL");

  // Main solutions table
  db.exec(`
    CREATE TABLE IF NOT EXISTS solutions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      title         TEXT    NOT NULL,
      problem       TEXT    NOT NULL,
      solution      TEXT    NOT NULL,
      code_snippets TEXT    NOT NULL DEFAULT '[]',
      project       TEXT    NOT NULL DEFAULT '',
      tags          TEXT    NOT NULL DEFAULT '[]',
      error_message TEXT    NOT NULL DEFAULT '',
      environment   TEXT    NOT NULL DEFAULT '',
      source        TEXT    NOT NULL DEFAULT 'auto',
      status        TEXT    NOT NULL DEFAULT 'active',
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // FTS5 virtual table — Porter stemmer so "resolving" matches "resolve" etc.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS solutions_fts USING fts5(
      title,
      problem,
      solution,
      error_message,
      content     = 'solutions',
      content_rowid = 'id',
      tokenize    = 'porter ascii'
    )
  `);

  // Triggers keep the FTS index in sync automatically.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS solutions_ai AFTER INSERT ON solutions BEGIN
      INSERT INTO solutions_fts(rowid, title, problem, solution, error_message)
      VALUES (new.id, new.title, new.problem, new.solution, new.error_message);
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS solutions_ad AFTER DELETE ON solutions BEGIN
      INSERT INTO solutions_fts(solutions_fts, rowid, title, problem, solution, error_message)
      VALUES ('delete', old.id, old.title, old.problem, old.solution, old.error_message);
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS solutions_au AFTER UPDATE ON solutions BEGIN
      INSERT INTO solutions_fts(solutions_fts, rowid, title, problem, solution, error_message)
      VALUES ('delete', old.id, old.title, old.problem, old.solution, old.error_message);
      INSERT INTO solutions_fts(rowid, title, problem, solution, error_message)
      VALUES (new.id, new.title, new.problem, new.solution, new.error_message);
    END
  `);
}

// =============================
// Part 3 — CRUD Operations
// =============================

export function insertSolution(entry: SolutionEntry): { id: number } {
  const result = db.prepare(`
    INSERT INTO solutions
      (title, problem, solution, code_snippets, project, tags, error_message, environment, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.title,
    entry.problem,
    entry.solution,
    JSON.stringify(entry.code_snippets ?? []),
    entry.project ?? "",
    JSON.stringify(entry.tags ?? []),
    entry.error_message ?? "",
    entry.environment ?? "",
    entry.source ?? "auto"
  );
  return { id: Number(result.lastInsertRowid) };
}

export function searchSolutions(opts: SearchOptions): SolutionRow[] {
  // FTS MATCH handles full-text search; additional WHERE clauses narrow by
  // project and date. Tag filtering is done in JS (tags are JSON-encoded).
  const whereClauses: string[] = [
    "id IN (SELECT rowid FROM solutions_fts WHERE solutions_fts MATCH ?)",
  ];
  const params: (string | number | null)[] = [opts.query];

  if (opts.project) {
    whereClauses.push("project LIKE ?");
    params.push(`%${opts.project}%`);
  }
  if (opts.date_from) {
    whereClauses.push("created_at >= ?");
    params.push(opts.date_from);
  }
  if (opts.date_to) {
    whereClauses.push("created_at <= ?");
    params.push(`${opts.date_to}T23:59:59`);
  }

  const sql = `
    SELECT * FROM solutions
    WHERE ${whereClauses.join(" AND ")}
    ORDER BY created_at DESC
    LIMIT 50
  `;

  let rows = db.prepare(sql).all(...params) as unknown as SolutionRow[];

  // Tag filter in JS — tags are stored as a JSON array in the column.
  if (opts.tags && opts.tags.length > 0) {
    rows = rows.filter((row) => {
      const rowTags: string[] = JSON.parse(row.tags);
      return opts.tags!.every((t) =>
        rowTags.some((rt) => rt.toLowerCase().includes(t.toLowerCase()))
      );
    });
  }

  return rows;
}

export function getSolution(id: number): SolutionRow | undefined {
  return db.prepare("SELECT * FROM solutions WHERE id = ?").get(id) as unknown as
    | SolutionRow
    | undefined;
}

export function updateSolution(id: number, updates: UpdateFields): void {
  const setClauses: string[] = ["updated_at = datetime('now')"];
  const params: (string | number | null)[] = [];

  if (updates.title         !== undefined) { setClauses.push("title = ?");         params.push(updates.title); }
  if (updates.problem       !== undefined) { setClauses.push("problem = ?");       params.push(updates.problem); }
  if (updates.solution      !== undefined) { setClauses.push("solution = ?");      params.push(updates.solution); }
  if (updates.code_snippets !== undefined) { setClauses.push("code_snippets = ?"); params.push(JSON.stringify(updates.code_snippets)); }
  if (updates.tags          !== undefined) { setClauses.push("tags = ?");          params.push(JSON.stringify(updates.tags)); }
  if (updates.status        !== undefined) { setClauses.push("status = ?");        params.push(updates.status); }

  params.push(id);
  db.prepare(`UPDATE solutions SET ${setClauses.join(", ")} WHERE id = ?`).run(...params);
}

// =============================
// Part 4 — Formatting Helper
// =============================

/**
 * Renders a SolutionRow as a human-readable text block for MCP tool output.
 * @param {SolutionRow} row   The database row to format.
 * @param {number}      index Display index (1-based) shown in the header.
 * @returns {string}
 */
export function formatRow(row: SolutionRow, index: number): string {
  const tags: string[]           = JSON.parse(row.tags);
  const snippets: CodeSnippet[]  = JSON.parse(row.code_snippets);

  const lines: string[] = [
    `── [${index}] ID: ${row.id}  ${row.status === "outdated" ? "OUTDATED" : "ACTIVE"} ──`,
    `Title:       ${row.title}`,
    `Project:     ${row.project || "(none)"}`,
    `Source:      ${row.source}  |  Created: ${row.created_at}  |  Updated: ${row.updated_at}`,
  ];

  if (tags.length)          lines.push(`Tags:        ${tags.join(", ")}`);
  if (row.error_message)    lines.push(`Error:       ${row.error_message}`);
  if (row.environment)      lines.push(`Environment: ${row.environment}`);

  lines.push("", "Problem:", row.problem, "", "Solution:", row.solution);

  if (snippets.length) {
    lines.push("", "Code Snippets:");
    for (const s of snippets) {
      if (s.description) lines.push(`// ${s.description}`);
      lines.push(`\`\`\`${s.language}`, s.code, "```");
    }
  }

  return lines.join("\n");
}
