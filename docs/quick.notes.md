# Quick Notes — Stitch

## Setup (first time only)

```powershell
cd "D:\Software DevOp\3. Javascript\MCP.Stitch\Project Codes\stitch"
npm install
npm run build

# Launch the setup UI — enter your API key and register with Claude Desktop
npm run setup
```

> Get your free Gemini API key at: <https://aistudio.google.com/api-keys>
> The key is saved to `%APPDATA%\Stitch\.env` — never committed to git or exposed in Claude config files.

---

## Build

```powershell
# One-shot compile
cd "D:\Software DevOp\3. Javascript\MCP.Stitch\Project Codes\stitch"
npm run build

# Watch mode — recompiles on every .ts save (run in a dedicated terminal)
npm run build:watch
```

> **Important:** Claude loads `build/index.js`. Always rebuild after editing `src/index.ts`.

---

## Update API key

```powershell
cd "D:\Software DevOp\3. Javascript\MCP.Stitch\Project Codes\stitch"
npm run setup
```

The setup UI lets you enter a new key at any time. It overwrites `%APPDATA%\Stitch\.env`.

---

## Test the server manually

```powershell
cd "D:\Software DevOp\3. Javascript\MCP.Stitch\Project Codes\stitch"
npm start
# Server prints: "Stitch running on stdio — waiting for client requests."
# Ctrl+C to exit
```

---

## Add / remove from Claude Code (CLI)

```powershell
# Add globally (active in all projects — recommended)
claude mcp add stitch -s user -- node "D:/Software DevOp/3. Javascript/MCP.Stitch/Project Codes/stitch/build/index.js"

# Add project-scoped (only active in current directory)
claude mcp add stitch -- node "D:/Software DevOp/3. Javascript/MCP.Stitch/Project Codes/stitch/build/index.js"

# API key is read from %APPDATA%\Stitch\.env automatically — no --env flag needed

# List configured servers
claude mcp list

# Remove
claude mcp remove stitch -s user
```

---

## Claude Desktop config file location

```
%APPDATA%\Claude\claude_desktop_config.json
```

Open quickly:
```powershell
notepad "$env:APPDATA\Claude\claude_desktop_config.json"
```

> The setup app writes this file for you when "Register with Claude Desktop" is ticked. Manual edits are only needed if you skip the setup UI.

---

## Verify tools are visible in Claude

After connecting, ask Claude:
> *"What MCP tools do you have available?"*

You should see: `generate_content`, `pdf_to_markdown`, `search_web`, `analyse_codebase`, `log_solution`, `search_knowledge`, `update_knowledge`.

---

## Swap a model

Edit the `MODELS` constant in `src/index.ts` (top of file), then rebuild:

```powershell
npm run build
```

Available models on this API key:

| Model ID | RPD | Best for |
|---|---|---|
| `gemini-2.5-flash` | 20K | Default workhorse, multimodal |
| `gemini-2.5-pro` | 2K | Complex reasoning, document parsing, code review |
| `gemini-2.5-flash-lite` | 30K | High-volume lightweight tasks |
| `gemini-2.0-flash` | 30K | Search grounding |
| `gemini-3-flash` | 20K | Newest generation (verify API ID) |
| `gemini-3.1-pro` | 2K | Newest generation pro (verify API ID) |
