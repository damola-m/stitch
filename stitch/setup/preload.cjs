"use strict";

/* ===================================
   preload.cjs
   -----------------------------------
   - Runs in a privileged context between the main process and the renderer.
   - Exposes a safe, narrow API to the renderer via contextBridge.
   - This is the only correct way to give the renderer IPC access without
     enabling nodeIntegration (which would expose all Node.js APIs to the page).
   =================================== */

const { contextBridge, ipcRenderer, shell } = require("electron");

// =============================
// Part 1 — Bridge Exposure
// =============================

contextBridge.exposeInMainWorld("mcpSetup", {
  // Read current saved state from the main process (API key + registration).
  // Uses sendSync so the call returns immediately without a Promise — avoids
  // any IPC invoke/handle timing issues on first load.
  getState: () => ipcRenderer.sendSync("get-state"),

  // Save the API key and optionally register the MCP server.
  save: (payload) => ipcRenderer.sendSync("save", payload),

  // Kill Claude Desktop and relaunch it so the new config takes effect.
  restartClaude: () => ipcRenderer.invoke("restart-claude"),

  // Open a URL in the user's default browser.
  // shell.openExternal is only available in main/preload — not in renderer.
  openExternal: (url) => shell.openExternal(url),
});
