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

  // An event page that already shows the user on the waitlist (Luma's wording) is recognised
  // as an existing state before anything is clicked.
  const waitPage = await context.newPage();
  await waitPage.route("https://luma.com/test-waitlisted", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body:
        "<!doctype html><html><body><main><h1>Claude Meetup</h1><p>Starting in 8d 17h</p>" +
        "<h2>You’re on the Waitlist</h2><p>We will let you know if you are admitted.</p>" +
        '<p>If you can no longer join, you can <a href="#">leave the waitlist</a>.</p>' +
        "<button type=\"button\">Contact the Host</button></main></body></html>",
    })
  );
  await waitPage.goto("https://luma.com/test-waitlisted", { waitUntil: "domcontentloaded" });
  const waitStatus = await worker.evaluate(async () => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const [tab] = await chrome.tabs.query({ url: "https://luma.com/test-waitlisted*" });
      if (tab?.id) {
        try {
          const res = await chrome.tabs.sendMessage(tab.id, { type: "CHECK_STATUS" });
          if (res) return res;
        } catch {
          // Content script can still be starting after navigation.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Waitlist fixture did not respond");
  });
  assert.equal(waitStatus.status, "on_waitlist", `Waitlisted page not recognised: ${JSON.stringify(waitStatus)}`);

  // Following the host: the button reads "Follow", flips to "Following" once clicked, and is
  // never clicked twice.
  const followPage = await context.newPage();
  await followPage.route("https://luma.com/test-follow", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body:
        "<!doctype html><html><body><main><h1>Follow fixture</h1><p>Presented by Example Calendar</p>" +
        '<button id="f" type="button"><div class="label">Follow</div></button>' +
        '<button type="button">Contact the Host</button>' +
        "<script>document.getElementById('f').addEventListener('click',()=>{document.getElementById('f').firstChild.textContent='Following';window.__followClicks=(window.__followClicks||0)+1;});</script>" +
        "</main></body></html>",
    })
  );
  await followPage.goto("https://luma.com/test-follow", { waitUntil: "domcontentloaded" });
  const followResult = await worker.evaluate(async () => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const [tab] = await chrome.tabs.query({ url: "https://luma.com/test-follow*" });
      if (tab?.id) {
        try {
          const first = await chrome.tabs.sendMessage(tab.id, { type: "FOLLOW_HOST" });
          const second = await chrome.tabs.sendMessage(tab.id, { type: "FOLLOW_HOST" });
          if (first) return { first, second };
        } catch {
          // Content script can still be starting after navigation.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Follow fixture did not respond");
  });
  assert.equal(followResult.first.followed, true, "Follow button was not followed");
  assert.equal(followResult.second.alreadyFollowing, true, "Second pass did not recognise the followed state");
  assert.equal(await followPage.evaluate(() => window.__followClicks), 1, "Follow was clicked more than once");
  console.log("Browser-level registration action, 429 safety and host-follow checks passed (no registration click performed)");
} finally {
  await context.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
