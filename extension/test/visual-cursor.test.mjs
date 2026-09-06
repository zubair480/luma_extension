/**
 * Automated test: visual cursor + field fill UX
 * Run: npm run test:visual
 */
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "fixtures", "visual-cursor-fixture.html");
const EXTENSION_DIR = path.join(__dirname, "..");
const SYSTEM_CHROME = [
  process.env.PLAYWRIGHT_CHROME_PATH,
  chromium.executablePath(),
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
    : null,
].find((candidate) => candidate && fs.existsSync(candidate));
const browserLaunchOptions = SYSTEM_CHROME ? { executablePath: SYSTEM_CHROME } : {};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

async function testFixturePage() {
  const browser = await chromium.launch({ headless: true, ...browserLaunchOptions });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`file:///${FIXTURE.replace(/\\/g, "/")}`);

  const results = [];

  // 1. Cursor UI mounts on enable
  await page.evaluate(() => {
    enableAgentCursor("Test run");
  });
  const afterEnable = await page.evaluate(() => window.__testHarness.getUiState());
  assert(afterEnable.pointerExists, "Pointer element missing after enableAgentCursor");
  assert(afterEnable.ringExists, "Ring element missing");
  assert(afterEnable.statusExists, "Status bar missing");
  assert(afterEnable.highlightExists, "Field highlight missing");
  assert(afterEnable.cursorActive, "window.__lumaAgentCursorActive not set");
  assert(afterEnable.rootVisible, "Cursor root not visible");
  assert(afterEnable.statusText === "Test run", `Status text wrong: ${afterEnable.statusText}`);
  results.push("✓ Cursor UI mounts (pointer, ring, status, highlight)");

  // 2. Cursor moves to field center on visualFillField
  await page.evaluate(async () => {
    const el = document.getElementById("name");
    await visualFillField(el, "Filling: name");
  });
  await page.waitForTimeout(900);
  const afterFill = await page.evaluate(() => window.__testHarness.getUiState());
  assert(afterFill.highlightVisible, "Field highlight not visible after visualFillField");
  assert(afterFill.pointerLx && afterFill.pointerLy, "Pointer CSS vars not set");

  const ptrX = parseFloat(afterFill.pointerLx);
  const ptrY = parseFloat(afterFill.pointerLy);
  const nameCx = afterFill.nameCenter.x;
  const nameCy = afterFill.nameCenter.y;
  const pointerDist = Math.hypot(ptrX - nameCx, ptrY - nameCy);
  assert(pointerDist < 8, `Pointer not centered on field (dist=${pointerDist.toFixed(1)}px)`);

  const hl = afterFill.highlightBox;
  const nameRect = await page.evaluate(() => {
    const r = document.getElementById("name").getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  });
  assert(Math.abs(hl.left - (nameRect.left - 4)) < 2, "Highlight left misaligned");
  assert(Math.abs(hl.top - (nameRect.top - 4)) < 2, "Highlight top misaligned");
  assert(Math.abs(hl.width - (nameRect.width + 8)) < 2, "Highlight width wrong");
  assert(Math.abs(hl.height - (nameRect.height + 8)) < 2, "Highlight height wrong");
  results.push("✓ Cursor moves to field center; highlight aligns with input");

  // 3. Full demo fills all fields with values
  await page.evaluate(async () => disableAgentCursor());
  const filled = await page.evaluate(async () => window.__testHarness.runFullDemo());
  assert(filled.name === "Zubair Zafar", `Name not filled: ${filled.name}`);
  assert(filled.email === "zubairzafar480@gmail.com", `Email not filled: ${filled.email}`);
  assert(filled.company === "Eastern Illinois University", `Company not filled: ${filled.company}`);
  assert(filled.role === "engineer", `Role not filled: ${filled.role}`);
  assert(filled.bio === "Software Engineer", `Bio not filled: ${filled.bio}`);
  results.push("✓ Full fill demo sets all field values correctly");

  // 4. visualClick triggers click (register button handler)
  let clicked = false;
  await page.evaluate(() => {
    document.getElementById("register-btn").addEventListener("click", () => {
      window.__registerClicked = true;
    });
  });
  await page.evaluate(async () => {
    enableAgentCursor("Click test");
    await visualClick(document.getElementById("register-btn"), "Submitting…");
  });
  clicked = await page.evaluate(() => window.__registerClicked === true);
  assert(clicked, "visualClick did not fire element.click()");
  results.push("✓ visualClick performs real click on target");

  // 5. disable hides cursor
  await page.evaluate(() => disableAgentCursor());
  const afterDisable = await page.evaluate(() => window.__testHarness.getUiState());
  assert(!afterDisable.rootVisible, "Cursor root still visible after disable");
  assert(!afterDisable.cursorActive, "cursorActive still true after disable");
  results.push("✓ disableAgentCursor hides overlay");

  await browser.close();
  return results;
}

async function testExtensionContentScript() {
  const userDataDir = path.join(__dirname, ".pw-profile");
  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    ...browserLaunchOptions,
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
    ],
  });

  const results = [];
  const issues = [];

  try {
    // Load fixture in extension context via content scripts
    const page = context.pages()[0] || (await context.newPage());
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`file:///${FIXTURE.replace(/\\/g, "/")}`);

    // Content scripts may not inject on file:// — check manifest matches
    const hasContentScript = await page.evaluate(() => typeof enableAgentCursor === "function");
    if (!hasContentScript) {
      issues.push("Content script not injected on file:// (expected — only runs on luma.com)");
    } else {
      results.push("✓ Content script available on test page");
    }

    // Test on public luma event page (no login needed for cursor injection via evaluate)
    const lumaPage = await context.newPage();
    await lumaPage.goto("https://luma.com/sf", { waitUntil: "domcontentloaded", timeout: 45000 });

    // Inject cursor manually same as content script would
    await lumaPage.addScriptTag({ path: path.join(EXTENSION_DIR, "lib", "visual-cursor.js") });
    await lumaPage.evaluate(() => enableAgentCursor("Live Luma test"));

    const lumaUi = await lumaPage.evaluate(() => ({
      pointer: !!document.getElementById("luma-agent-cursor-pointer"),
      status: document.getElementById("luma-agent-status")?.textContent,
      active: window.__lumaAgentCursorActive,
    }));

    assert(lumaUi.pointer, "Cursor not visible on luma.com/sf");
    assert(lumaUi.active, "Cursor not active on luma.com");
    results.push("✓ Cursor renders on live luma.com/sf page");

    // Try filling first visible text input if any registration-like field exists
    const firstInput = lumaPage.locator("input[type='text'], input[type='email']").first();
    if (await firstInput.count()) {
      await lumaPage.evaluate(async () => {
        const input = document.querySelector("input[type='text'], input[type='email']");
        if (input) await visualFillField(input, "Test fill");
      });
      await lumaPage.waitForTimeout(900);
      const hl = await lumaPage.evaluate(() =>
        document.getElementById("luma-agent-field-highlight")?.classList.contains("luma-visible")
      );
      if (hl) results.push("✓ Field highlight works on live Luma page");
      else issues.push("No field highlight on Luma (may be no visible input in viewport)");
    } else {
      issues.push("No text inputs on /sf feed — field fill on event page not tested live");
    }
  } finally {
    await context.close();
  }

  return { results, issues };
}

async function auditContentScriptGaps() {
  const contentPath = path.join(EXTENSION_DIR, "content.js");
  const src = fs.readFileSync(contentPath, "utf8");
  const gaps = [];

  // fillNativeSelect direct value assignment without visualClick
  if (/if \(match\) \{\s*\n\s*select\.value = match\.value/.test(src)) {
    gaps.push("fillNativeSelect: matched options set value without visualClick/highlight");
  }
  if (/if \(fallback\) \{\s*\n\s*select\.value = fallback\.value/.test(src)) {
    gaps.push("fillNativeSelect: fallback options set value without visualClick/highlight");
  }

  return gaps;
}

async function main() {
  console.log("=== Visual Cursor & Field Fill Test ===\n");

  let passed = 0;
  let failed = 0;

  try {
    console.log("--- Fixture tests (visual-cursor.js) ---");
    const fixtureResults = await testFixturePage();
    fixtureResults.forEach((r) => console.log(r));
    passed += fixtureResults.length;
  } catch (err) {
    console.error("✗ Fixture test FAILED:", err.message);
    failed++;
  }

  try {
    console.log("\n--- Live page + extension smoke ---");
    const { results, issues } = await testExtensionContentScript();
    results.forEach((r) => { console.log(r); passed++; });
    issues.forEach((i) => console.log(`⚠ ${i}`));
  } catch (err) {
    console.error("✗ Extension smoke FAILED:", err.message);
    failed++;
  }

  const gaps = await auditContentScriptGaps();
  if (gaps.length) {
    console.log("\n--- Code gaps (visual fill not used everywhere) ---");
    gaps.forEach((g) => console.log(`⚠ ${g}`));
  }

  console.log(`\n=== Done: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
