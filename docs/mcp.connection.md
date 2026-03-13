# Connecting Stitch to Claude

This guide covers everything from first build to verified connection for both **Claude Desktop** and **Claude Code (CLI)**.

> **API key:** Your `GEMINI_API_KEY` is stored in `%APPDATA%\Stitch\.env` — it is **never** written to any Claude config file.

---

## Prerequisites

Before connecting, ensure:

- [ ] Node.js 22.5+ is installed (`node --version`)
- [ ] Dependencies are installed (`npm install` from the `stitch/` folder)
- [ ] The project has been built — `build/index.js` must exist

If you haven't built yet:
```powershell
cd path/to/stitch
npm install
npm run build
```

---

## Step 1 — Set your API key

Your Gemini API key is stored separately from any Claude config file. There are two ways to set it.

### Option A — Setup App (Recommended)

Run the Electron setup UI from the `stitch/` folder:

```powershell
npm run setup
```

The popup will:
- Let you enter (or update) your `GEMINI_API_KEY`
- Write it to `%APPDATA%\Stitch\.env` (survives reinstalls, never committed to git)
- Optionally auto-register the MCP server in Claude Desktop's config with one click

Get your free key at: <https://aistudio.google.com/api-keys> — no billing required for free-tier models.

> If you've built a packaged installer (`npm run release`), run the resulting `.exe` instead — the setup UI launches automatically on first install.

### Option B — Manual `.env` (Dev / Advanced)

Create `stitch/.env` in the project folder:

```
GEMINI_API_KEY=AIzaSy…
```

The server checks `%APPDATA%\Stitch\.env` first, then falls back to `stitch/.env` relative to `build/index.js`. Either location works; the setup app uses the APPDATA path.

---

## Step 2 — Connect to Claude

### Claude Desktop

If you used the Setup App with "Register with Claude Desktop" ticked, this is already done — skip to [Verify](#verify).

For manual registration, open:
```powershell
notepad "$env:APPDATA\Claude\claude_desktop_config.json"
```

Merge this into the JSON (create the `mcpServers` key if it isn't there yet):

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

> **No `env` block needed.** The server resolves the API key by its own file location at startup.

> **Windows path note:** JSON requires backslashes escaped as `\\`. Forward slashes also work in Node.js.

If you already have other MCP servers configured, add `stitch` alongside them inside the existing `mcpServers` object.

**Restart Claude Desktop** — fully quit (system tray → Quit, not just close the window) and reopen.

---

### Claude Code (CLI)

Run once from any terminal:

```powershell
# User-scoped / global — active in ALL projects (recommended for a shared utility like this)
claude mcp add stitch -s user -- node "path/to/stitch/build/index.js"

# Project-scoped — only active when Claude Code is run from a specific folder
claude mcp add stitch -- node "path/to/stitch/build/index.js"
```

> The `--` separator is required — it tells the CLI that everything after it is the server command, not a flag.

> **No `--env` flag needed.** The API key is read from `.env` automatically.

**Manual settings.json edit** (alternative): add the same `mcpServers` block to `C:\Users\<YourName>\.claude\settings.json` (user-scoped) or `<project>/.claude/settings.json` (project-scoped).

---

## Verify

### Claude Desktop

1. Open a new conversation.
2. Look for the **tools icon** (hammer/wrench) in the chat input bar — it should list the Stitch tools.
3. Or ask: *"What MCP tools do you have available?"*

Expected: `generate_content`, `pdf_to_markdown`, `search_web`, `analyse_codebase`, `log_solution`, `search_knowledge`, `update_knowledge`.

### Claude Code

```powershell
# Confirm the server is registered and connected
claude mcp list
```

You should see `stitch` with status `connected`. Then start a session and ask:

```
What MCP tools do you have available?
```

---

## Managing the Claude Code entry

```powershell
# Remove
claude mcp remove stitch -s user

# Check status
claude mcp list
```

---

## After Every Code Change

The server is compiled TypeScript. After editing `src/index.ts`, rebuild before Claude picks up the changes:

```powershell
cd path/to/stitch
npm run build
```

For active development, run the watch compiler in a background terminal:

```powershell
npm run build:watch
```

Claude Desktop requires a **restart** to reload the server after a rebuild. Claude Code will reconnect automatically when the server restarts, but restarting the CLI session is more reliable.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Tools don't appear in Claude Desktop | Check JSON syntax in the config file; fully quit and reopen Claude Desktop |
| `stitch` shows as `disconnected` in Claude Code | Run `npm start` manually in a terminal to see the startup error |
| `GEMINI_API_KEY is not set` | Run `npm run setup` to set the key, or check `%APPDATA%\Stitch\.env` |
| `Cannot find module` / `build/` missing | Rebuild: `npm run build` from the `stitch/` folder |
| Key not saving in setup app | Ensure the app has write access to `%APPDATA%`; try running as the current user (not admin) |

---

## Security Notes

- **Never commit your `.env` file** — it is listed in `.gitignore`.
- The API key lives in `%APPDATA%\Stitch\.env` (packaged) or `stitch/.env` (dev). It is never written to Claude Desktop's config or Claude Code's settings.
- Stitch reads local files when given paths (e.g., for `analyse_codebase`). Only give Claude paths you're comfortable with Gemini processing.
