/** Browser-level UI regression for the extension side panel. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.join(__dirname, "..");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "luma-agent-ui-"));
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
    "--window-size=500,980",
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
  ],
});

try {
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker", { timeout: 15000 }));
  const extensionId = new URL(worker.url()).hostname;
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 420, height: 900 });
  await page.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);

  assert.equal(await page.locator(".source-link").count(), 4, "Expected four source links");
  assert.equal(await page.locator("#runBtn").count(), 1, "Expected one combined start button");
  assert.equal(await page.locator("#inviteBtn").count(), 1, "Expected an accept-invitations button");
  assert.match(
    await page.locator("#inviteBtn").innerText(),
    /accept my invitations/i,
    "Invitations button label is unclear"
  );

  // A fresh install ships an empty profile: the setup banner shows and nothing can start.
  assert.equal(await page.locator("#setupBanner").isVisible(), true, "Setup banner hidden on a fresh install");
  assert.equal(await page.locator("#runBtn").isEnabled(), false, "Start button enabled without a profile");
  assert.equal(await page.locator("#inviteBtn").isEnabled(), false, "Invitations button enabled without a profile");
  const refused = await page.evaluate(() => chrome.runtime.sendMessage({ type: "START_RUN", source: "all" }));
  assert.equal(refused?.ok, false, "Background started a run without a profile");
  assert.equal(refused?.needsProfile, true, "Background refusal does not point at the profile");

  // Filling the required fields and saving unlocks both start buttons.
  await page.locator("#profileDetails").evaluate((el) => {
    el.open = true;
  });
  await page.fill("#firstName", "Ada");
  await page.fill("#lastName", "Probe");
  await page.fill("#email", "ada.probe@example.com");
  await page.fill("#jobTitle", "Engineer");
  await page.fill("#company", "Example Labs");
  await page.click("#saveProfile");
  await page.waitForTimeout(600);
  assert.equal(await page.locator("#setupBanner").isVisible(), false, "Setup banner still shown after saving a complete profile");
  assert.equal(await page.locator("#inviteBtn").isEnabled(), true, "Invitations button is disabled at idle");
  assert.equal(await page.locator("#runBtn").isEnabled(), true, "Combined start button is disabled at idle");
  const stored = await page.evaluate(() => chrome.storage.local.get("profile").then((r) => r.profile));
  assert.equal(stored?.company, "Example Labs", "Saved profile did not persist");
  assert.equal(stored?.instagram, "", "Saved profile carries a value the user never entered");
  assert.equal(Object.keys(stored?.default_answers || {}).length, 0, "Saved profile carries answers the user never entered");
  assert.equal(await page.locator("#runCvBtn").count(), 0, "Old second start button still exists");
  assert.equal(await page.locator("#workEmail").count(), 1, "Work email field is missing");
  assert.equal(
    await page.locator('.source-link[href="https://luma.com/genai-sf"]').count(),
    1,
    "Bond AI link is incorrect"
  );
  assert.equal(
    await page.locator('.source-link[href="https://bayareafoundersclub.substack.com/"]').count(),
    1,
    "Bay Area Founders Club link is missing"
  );
  assert.equal(pageErrors.length, 0, `Popup page errors: ${pageErrors.join("; ")}`);

  // The profile save above scrolled the panel and showed a toast; settle before the hit test.
  await page.waitForTimeout(1700);
  await page.locator("#runBtn").scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  const startHitTarget = await page.locator("#runBtn").evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return target === button || button.contains(target);
  });
  assert.equal(startHitTarget, true, "Another element is intercepting the start button");

  const layout = await page.evaluate(() => ({
    viewport: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    buttonText: document.getElementById("runBtn")?.innerText || "",
    offenders: [...document.querySelectorAll("*")]
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return { tag: element.tagName, id: element.id, cls: element.className, left: rect.left, right: rect.right, width: rect.width };
      })
      .filter((item) => item.right > window.innerWidth + 1 || item.left < -1)
      .slice(0, 8),
  }));
  assert.ok(
    layout.scrollWidth <= layout.viewport,
    `Popup has horizontal overflow (${layout.scrollWidth}px content / ${layout.viewport}px viewport): ${JSON.stringify(layout.offenders)}`
  );
  assert.match(layout.buttonText, /Scan all 4/i, "Combined button label is unclear");

  await page.setViewportSize({ width: 340, height: 900 });
  const compactLayout = await page.evaluate(() => ({
    viewport: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    visibleSources: [...document.querySelectorAll(".source-link")].filter(
      (link) => link.getBoundingClientRect().height > 0
    ).length,
  }));
  assert.ok(compactLayout.scrollWidth <= compactLayout.viewport, "Compact popup overflows horizontally");
  assert.equal(compactLayout.visibleSources, 4, "A source link disappears in compact mode");

  if (process.env.LUMA_POPUP_SCREENSHOT) {
    await page.setViewportSize({ width: 420, height: 900 });
    await page.screenshot({ path: process.env.LUMA_POPUP_SCREENSHOT, fullPage: true });
  }

  console.log("Popup UI regression passed (4 links, 2 start buttons, no overflow)");
} finally {
  await context.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
