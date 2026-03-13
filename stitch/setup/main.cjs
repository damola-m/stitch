"use strict";

/* ===================================
   main.cjs
   -----------------------------------
   - Electron main process for the Stitch setup app.
   - Creates the setup window and handles all privileged file I/O
     (reading/writing .env and claude_desktop_config.json) via IPC.
   - The renderer (index.html) never touches the filesystem directly.
   =================================== */

const { app, BrowserWindow, ipcMain } = require("electron");
const { exec, spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

// =============================
// Part 1 — Path Resolution
// =============================

// Where the setup app stores the API key.
// Using APPDATA means it survives app re-installs and is writable by the user
// without requiring administrator rights.
const envDir = process.env.APPDATA
  ? path.join(process.env.APPDATA, "Stitch")
  : path.join(os.homedir(), ".stitch");

const envFilePath = path.join(envDir, ".env");

// Claude Desktop config — standard location on Windows.
const claudeConfigPath = path.join(
  process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
  "Claude",
  "claude_desktop_config.json"
);

// Claude Code config — stored in the user's home directory.
const claudeCodeConfigPath = path.join(os.homedir(), ".claude.json");

// Claude Desktop executable — standard install location on Windows.
const claudeExePath = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "AnthropicClaude",
  "Claude.exe"
);

// MCP server path: packaged app puts the bundled server in resources/server/,
// dev mode uses the TypeScript compile output directly.
const serverPath = app.isPackaged
  ? path.join(process.resourcesPath, "server", "index.mjs")
  : path.join(__dirname, "..", "build", "index.js");

// =============================
// Part 2 — Window
// =============================

function createWindow() {
  const win = new BrowserWindow({
    width: 420,
    height: 534,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "Stitch — Setup",
    backgroundColor: "#000000",
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#0d0d0d",
      symbolColor: "#7a7f96",
      height: 32,
    },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,  // Required — renderer cannot access Node.js APIs directly
      nodeIntegration: false,  // Security: no raw Node in renderer
    },
  });

  win.loadFile(path.join(__dirname, "index.html"));

  // Remove the default menu bar — this is a utility dialog, not a full app.
  win.setMenuBarVisibility(false);
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  app.quit();
});

// =============================
// Part 3 — IPC Handlers
// =============================

// Renderer → Main: read current state (existing API key + MCP registration).
// Uses sendSync / ipcMain.on so the response is returned synchronously —
// no Promise chain, no possibility of the call hanging on first load.
ipcMain.on("get-state", (event) => {
  let currentKey = "";
  if (fs.existsSync(envFilePath)) {
    const content = fs.readFileSync(envFilePath, "utf-8");
    const match = content.match(/^GEMINI_API_KEY\s*=\s*(.+)$/m);
    if (match) currentKey = match[1].trim();
  }

  let isRegistered = false;
  for (const cfgPath of [claudeConfigPath, claudeCodeConfigPath]) {
    if (fs.existsSync(cfgPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
        if (config?.mcpServers?.["stitch"]) { isRegistered = true; break; }
      } catch { /* Malformed JSON — skip */ }
    }
  }

  // event.returnValue is how sendSync returns data to the renderer.
  event.returnValue = { currentKey, isRegistered, serverPath, envFilePath, claudeConfigPath };
});

// Renderer → Main: save API key to .env and register MCP server.
ipcMain.on("save", (event, { apiKey, registerMcp }) => {
  try {
    // ── Write .env ────────────────────────────────────────────────────────────
    fs.mkdirSync(envDir, { recursive: true });
    fs.writeFileSync(envFilePath, `GEMINI_API_KEY=${apiKey}\n`, "utf-8");

    // ── Register in Claude Desktop + Claude Code configs ──────────────────────
    if (registerMcp) {
      const entry = { command: "node", args: [serverPath] };

      for (const cfgPath of [claudeConfigPath, claudeCodeConfigPath]) {
        let config = {};
        if (fs.existsSync(cfgPath)) {
          try {
            config = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
          } catch { /* Malformed — start fresh */ }
        }
        config.mcpServers = { ...(config.mcpServers || {}), "stitch": entry };
        fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
        fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2), "utf-8");
      }
    }

    event.returnValue = { ok: true };
  } catch (err) {
    event.returnValue = { ok: false, error: err.message };
  }
});

// Renderer → Main: kill Claude Desktop and relaunch it.
// Used after saving so the new MCP registration takes effect immediately.
ipcMain.handle("restart-claude", () => {
  return new Promise((resolve) => {
    exec('taskkill /IM "Claude.exe" /F', () => {
      // Give the process a moment to fully exit before relaunching.
      setTimeout(() => {
        try {
          spawn(claudeExePath, [], { detached: true, stdio: "ignore" }).unref();
          resolve({ ok: true });
        } catch (err) {
          resolve({ ok: false, error: err.message });
        }
      }, 1500);
    });
  });
});
