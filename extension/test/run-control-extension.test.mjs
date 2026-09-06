/** Browser-level regression: a mirrored Skip survives navigation into an event page. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.join(__dirname, "..");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "luma-agent-skip-"));
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
  // Unpacked MV3 extensions are most reliable in headed test Chromium on Windows.
  headless: false,
  ...(chromeExecutable ? { executablePath: chromeExecutable } : {}),
  args: [
    "--window-position=-32000,-32000",
    "--window-size=800,600",
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
  ],
});

try {
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker", { timeout: 15000 }));

  const page = await context.newPage();
  await page.route("https://luma.com/test-skip", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><html><body><h1>Safe local skip fixture</h1><button>Register</button></body></html>",
    })
  );
  await page.goto("https://luma.com/test-skip", { waitUntil: "domcontentloaded" });

  const result = await worker.evaluate(async () => {
    let tab;
    for (let attempt = 0; attempt < 30; attempt++) {
      [tab] = await chrome.tabs.query({ url: "https://luma.com/test-skip*" });
      if (tab?.id) {
        try {
          const ping = await chrome.tabs.sendMessage(tab.id, { type: "PING" });
          if (ping?.ok) break;
        } catch {
          // Content scripts may still be starting after navigation.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (!tab?.id) throw new Error("Synthetic Luma tab was not found");
    await chrome.storage.session.set({
      runPaused: false,
      runStopRequested: false,
      runSkipRequested: true,
      runInProgress: true,
    });
    await chrome.storage.local.set({
      runControlMirror: {
        runPaused: false,
        runStopRequested: false,
        runSkipRequested: true,
        runInProgress: true,
        agentCursorActive: false,
        updatedAt: Date.now(),
      },
    });
    return chrome.tabs.sendMessage(tab.id, {
      type: "REGISTER",
      profile: {},
      keepCursor: false,
      event: { title: "Skip fixture", slug: "test-skip", url: "https://luma.com/test-skip" },
    });
  });

  assert.equal(result.status, "aborted");
  assert.equal(result.success, false);

  const prepared = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: "https://luma.com/test-skip*" });
    const event = {
      title: "Current synthetic event",
      slug: "test-skip",
      url: "https://luma.com/test-skip",
    };
    await chrome.storage.session.set({
      runPaused: false,
      runStopRequested: false,
      runSkipRequested: false,
      runInProgress: true,
      workTabId: tab.id,
      currentRunEvent: event,
    });
    await chrome.storage.local.set({
      runState: {
        phase: "registering",
        current: 1,
        total: 2,
        // Deliberately omit currentEvent to reproduce the stale panel/background mismatch.
        events: [event, { title: "Next", slug: "next", url: "https://luma.com/next" }],
        upcoming: [{ title: "Next", slug: "next", url: "https://luma.com/next" }],
        results: [],
        logs: [],
      },
      runControlMirror: {
        runPaused: false,
        runStopRequested: false,
        runSkipRequested: false,
        runInProgress: true,
        agentCursorActive: false,
        workTabId: tab.id,
        updatedAt: Date.now(),
      },
    });
    return { extensionId: new URL(chrome.runtime.getURL("/")).hostname };
  });

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${prepared.extensionId}/popup.html`, {
    waitUntil: "domcontentloaded",
  });
  await popup.locator("#skipBtn").waitFor({ state: "visible" });
  await assert.doesNotReject(() => popup.locator("#skipBtn").click());

  await worker.evaluate(async () => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const { runSkipRequested } = await chrome.storage.session.get("runSkipRequested");
      if (runSkipRequested) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Skip request did not reach the background worker");
  });
  const skipState = await worker.evaluate(async () => {
    const session = await chrome.storage.session.get(["runSkipRequested", "currentRunEvent"]);
    const { runState } = await chrome.storage.local.get("runState");
    return { session, runState };
  });
  assert.equal(skipState.session.runSkipRequested, true);
  assert.equal(skipState.runState.skipRequested, true);
  assert.equal(skipState.runState.logs.at(-1)?.step, "skip");
  assert.equal(skipState.runState.logs.at(-1)?.eventSlug, "test-skip");
  console.log("Browser-level skip regressions passed (navigation + panel click)");
} finally {
  await context.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
