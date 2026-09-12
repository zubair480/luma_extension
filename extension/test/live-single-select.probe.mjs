/**
 * Live probe (not part of test:all): pick an option in a Luma single-select and show where the
 * chosen value is rendered, and what the scanner thinks afterwards. Never submits.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.join(__dirname, "..");
const target = process.argv[2] || "https://luma.com/openmodelhack";
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "luma-agent-ss-probe-"));
const chromeExecutable = [process.env.PLAYWRIGHT_CHROME_PATH, chromium.executablePath()].find((c) => c && fs.existsSync(c));

const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  ...(chromeExecutable ? { executablePath: chromeExecutable } : {}),
  args: ["--window-position=-32000,-32000", "--window-size=1000,800"],
});

try {
  const page = await context.newPage();
  await page.goto(target, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  for (const lib of ["lib/form-intelligence.js", "lib/form-scanner.js"]) {
    await page.addScriptTag({ path: path.join(extensionDir, lib) });
  }
  const out = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const labels = ["Request to Join", "Register", "Join Waitlist", "Get Ticket", "RSVP"];
    [...document.querySelectorAll("button")].find((b) => labels.includes(b.textContent.trim()))?.click();
    await sleep(2500);
    const root = getRegistrationModalRoot();
    const combos = [...root.querySelectorAll('[role="combobox"]')];
    const combo = combos[0];
    const wrapper = combo.closest('[class*="trigger" i]') || combo.parentElement;
    const snap = (tag) => ({
      tag,
      comboHtml: combo.outerHTML.slice(0, 700),
      comboText: cleanLabel(combo.textContent),
      wrapperText: cleanLabel(wrapper.textContent).slice(0, 120),
      describedBy: combo.getAttribute("aria-describedby") ? cleanLabel(document.getElementById(combo.getAttribute("aria-describedby"))?.textContent) : null,
      labelledBy: combo.getAttribute("aria-labelledby") ? cleanLabel(document.getElementById(combo.getAttribute("aria-labelledby"))?.textContent) : null,
      triggers: findCustomDropdownTriggers().map((t) => getQuestionTextForElement(t)),
      unfilled: describeUnfilledFields(),
      scanned: scanRegistrationFields().filter((f) => f.kind.includes("select")).map((f) => ({ label: f.label, kind: f.kind, filled: f.filled })),
    });
    const before = snap("before");
    const pointer = (el, type, extra = {}) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", isPrimary: true, ...extra }));
    pointer(combo, "pointerdown"); pointer(combo, "pointerup"); combo.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await sleep(600);
    const listbox = controlledListbox(combo);
    const options = listbox ? [...listbox.querySelectorAll('[role="option"]')] : [];
    const targetOpt = options[Math.min(2, options.length - 1)];
    const wanted = targetOpt?.textContent.trim();
    if (targetOpt) { pointer(targetOpt, "pointerdown"); pointer(targetOpt, "pointerup"); targetOpt.dispatchEvent(new MouseEvent("click", { bubbles: true })); }
    await sleep(600);
    const after = snap("after");
    return { wanted, optionCount: options.length, before, after, formOpen: Boolean(getRegistrationModalRoot()) };
  });
  console.log(JSON.stringify(out, null, 2));
} finally {
  await context.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
