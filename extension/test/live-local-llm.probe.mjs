/**
 * Live probe (not part of test:all): load the extension in a fresh Chrome, warm the on-device
 * model (downloads it on first use), and ask it a registration question. Reports timing and the
 * answer's provenance.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.join(__dirname, "..");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "luma-agent-llm-probe-"));
const chromeExecutable = [process.env.PLAYWRIGHT_CHROME_PATH, chromium.executablePath()].find((c) => c && fs.existsSync(c));

const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  ...(chromeExecutable ? { executablePath: chromeExecutable } : {}),
  args: ["--window-position=-32000,-32000", "--window-size=500,900", `--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
});

try {
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker", { timeout: 15000 }));
  const extensionId = new URL(worker.url()).hostname;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);

  const t0 = Date.now();
  console.log("warming up…");
  const warm = await page.evaluate(() => chrome.runtime.sendMessage({ type: "WARMUP_LOCAL_LLM" }));
  console.log("warmup:", JSON.stringify(warm), "in", Math.round((Date.now() - t0) / 1000), "s");

  const status = await page.evaluate(() => chrome.runtime.sendMessage({ type: "LOCAL_LLM_STATUS" }));
  console.log("status:", JSON.stringify(status));
  const env = await page.evaluate(() => chrome.runtime.sendMessage({ type: "LOCAL_LLM_ENV" }));
  console.log("env:", JSON.stringify(env));

  await page.evaluate(() =>
    chrome.runtime.sendMessage({
      type: "SAVE_PROFILE",
      profile: { first_name: "Ada", last_name: "Probe", email: "ada.probe@example.com", job_title: "Founding AI Engineer", company: "Example Labs (Stealth)", location: "San Francisco, CA" },
    })
  );
  for (const q of [
    "What Claude Code features or capabilities are you most interested in discussing at this meetup?",
    "What are you building, operating, researching, or exploring right now?",
    "How do you share context with AI & your team today?",
    "What are you most hoping to find at the event?",
  ]) {
    const t1 = Date.now();
    const res = await page.evaluate((question) => chrome.runtime.sendMessage({ type: "TEST_LOCAL_LLM", question }), q);
    console.log(`Q: ${q}\n   A (${Math.round((Date.now() - t1) / 1000)}s): ${JSON.stringify(res)}`);
  }
} finally {
  await context.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
