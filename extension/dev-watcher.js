/**
 * Watches extension files and tells Chrome to reload via WebSocket.
 * Run: npm run dev
 */
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const chokidar = require("chokidar");

const PORT = 9090;
const ROOT = __dirname;
const DEBOUNCE_MS = 300;

const wss = new WebSocketServer({ port: PORT });
let clients = new Set();
let debounceTimer = null;

wss.on("connection", (ws) => {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
  console.log("Chrome connected — watching for changes…");
});

function broadcastReload() {
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send("reload");
  }
  console.log(`Reload signal sent (${clients.size} client(s))`);
}

const watcher = chokidar.watch(ROOT, {
  ignored: [
    /node_modules/,
    /package-lock\.json/,
    /dev-watcher\.js/,
    /icons\/.*\.png$/,
  ],
  ignoreInitial: true,
});

watcher.on("all", (_event, filePath) => {
  const rel = path.relative(ROOT, filePath);
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    console.log(`Changed: ${rel}`);
    broadcastReload();
  }, DEBOUNCE_MS);
});

console.log(`Dev watcher on ws://127.0.0.1:${PORT}`);
console.log("Edit extension files to auto-reload in Chrome.");
