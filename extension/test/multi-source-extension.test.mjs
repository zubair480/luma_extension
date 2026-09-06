/** Live extension discovery smoke test. Stops before any registration can be submitted. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.join(__dirname, "..");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "luma-agent-live-sources-"));
const chromeExecutable = [
  process.env.PLAYWRIGHT_CHROME_PATH,
  chromium.executablePath(),
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
    : null,
].find((candidate) => candidate && fs.existsSync(candidate));

const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  ...(chromeExecutable ? { executablePath: chromeExecutable } : {}),
  args: [
    "--window-position=-32000,-32000",
    "--window-size=900,700",
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
  ],
});

let popup;
try {
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker", { timeout: 15000 }));
  const extensionId = new URL(worker.url()).hostname;
  popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`, {
    waitUntil: "domcontentloaded",
  });
  await popup.locator("#runBtn").click();

  let state = null;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    state = await worker.evaluate(async () => (await chrome.storage.local.get("runState")).runState);
    if (
      state?.phase === "error" ||
      state?.phase === "done" ||
      (state?.phase === "registering" && state?.events?.length)
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const sourceCounts = state?.stats?.sourceCounts || {};
  console.log("Live source counts:", sourceCounts);
  for (const log of state?.logs || []) console.log(`${log.step}: ${log.message}`);
  assert.ok(state, "No run state was created");
  assert.notEqual(state.phase, "error", state.error || "Discovery failed");
  assert.ok(
    (state.events?.length || 0) > 0,
    state.error || `No events discovered; source counts=${JSON.stringify(sourceCounts)}`
  );
  assert.ok(
    state.events.every((event) => !["create", "genai-sf"].includes(event.slug)),
    "Calendar/system pages entered the registration queue"
  );
  assert.ok(
    (state.stats?.hydrated || 0) >= state.events.length,
    "Queued events were not positively verified through Luma"
  );
  console.log(`Live multi-source extension discovery passed (${state.events.length} queued)`);
} finally {
  if (popup) {
    await popup
      .evaluate(() => chrome.runtime.sendMessage({ type: "STOP_RUN" }))
      .catch(() => {});
  }
  await context.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
