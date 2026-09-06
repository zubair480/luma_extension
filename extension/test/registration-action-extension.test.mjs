/** Browser-level regression for current-event action detection. Never clicks the action. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.join(__dirname, "..");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "luma-agent-action-"));
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
  await page.route("https://luma.com/test-request-action", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><html><body><main><h1>Physical AI Meetup</h1><p>Approval Required</p><button>Request to Join</button></main></body></html>",
    })
  );
  await page.goto("https://luma.com/test-request-action", { waitUntil: "domcontentloaded" });

  const result = await worker.evaluate(async () => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const [tab] = await chrome.tabs.query({ url: "https://luma.com/test-request-action*" });
      if (tab?.id) {
        try {
          const response = await chrome.tabs.sendMessage(tab.id, {
            type: "INSPECT_REGISTRATION_ACTION",
          });
          if (response) return response;
        } catch {
          // Content script can still be starting after navigation.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Registration action inspector did not respond");
  });

  assert.equal(result.mode, "request");
  assert.equal(result.action, "request to join");
  assert.equal(result.formOpen, false);

  const ratePage = await context.newPage();
  await ratePage.route("https://luma.com/test-rate-limit", (route) =>
    route.fulfill({
      status: 429,
      contentType: "text/html",
      body: "<!doctype html><html><head><title>Rate Limit Hit</title></head><body><h1>429 · Rate Limit Hit</h1><p>You run into a rate limit. Please slow down and try again in a bit.</p></body></html>",
    })
  );
  await ratePage.goto("https://luma.com/test-rate-limit", { waitUntil: "domcontentloaded" });

  const rateResult = await worker.evaluate(async () => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const [tab] = await chrome.tabs.query({ url: "https://luma.com/test-rate-limit*" });
      if (tab?.id) {
        try {
          const feed = await chrome.tabs.sendMessage(tab.id, { type: "SCAN_FEED" });
          const registration = await chrome.tabs.sendMessage(tab.id, {
            type: "REGISTER",
            profile: {},
            event: {
              title: "Rate limit fixture",
              slug: "test-rate-limit",
              url: "https://luma.com/test-rate-limit",
            },
          });
          if (registration) return { feed, registration };
        } catch {
          // Content script can still be starting after navigation.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Rate-limit fixture did not respond");
  });

  assert.equal(rateResult.feed.rateLimited, true);
  assert.equal(rateResult.feed.eventLinks.length, 0);
  assert.equal(rateResult.registration.status, "rate_limited");
  assert.equal(rateResult.registration.success, false);
  console.log("Browser-level registration action and 429 safety checks passed (no click performed)");
} finally {
  await context.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
