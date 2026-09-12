/**
 * Live probe (not part of test:all): on a form with several single-selects, pick the first, then
 * try each step the agent uses to open the second and report which one closes the overlay.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.join(__dirname, "..");
const target = process.argv[2] || "https://luma.com/openmodelhack";
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "luma-agent-open2-probe-"));
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
  const steps = ["click-input", "focus-then-click-input", "click-parent", "arrowdown", "space", "click-input-again"];
  const out = await page.evaluate(async (steps) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const pointerClick = (el) => {
      const o = { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", isPrimary: true };
      el.dispatchEvent(new PointerEvent("pointerdown", o));
      el.dispatchEvent(new PointerEvent("pointerup", o));
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      if (typeof el.click === "function") el.click();
    };
    const openForm = async () => {
      if (getRegistrationModalRoot()) return true;
      [...document.querySelectorAll("button")].find((b) => ["Request to Join", "Register", "Join Waitlist"].includes(b.textContent.trim()))?.click();
      await sleep(2500);
      return Boolean(getRegistrationModalRoot());
    };
    const state = (combo) => ({
      formOpen: Boolean(getRegistrationModalRoot()),
      expanded: combo?.getAttribute("aria-expanded"),
      listOpen: Boolean(combo && controlledListbox(combo) && isElementInteractable(controlledListbox(combo))),
      value: combo?.value?.slice(0, 40),
      active: document.activeElement ? `${document.activeElement.tagName.toLowerCase()}#${document.activeElement.id}` : null,
    });
    const results = [];
    // Pick in combo #1 the way the agent does.
    if (!(await openForm())) return [{ error: "form not open" }];
    let combos = [...getRegistrationModalRoot().querySelectorAll('[role="combobox"]')];
    pointerClick(combos[0]);
    await sleep(600);
    let lb = controlledListbox(combos[0]);
    const first = lb ? lb.querySelector('[role="option"]') : null;
    if (first) pointerClick(first);
    await sleep(500);
    results.push({ step: "pick-first", ...state(combos[0]) });

    for (const step of steps) {
      if (!(await openForm())) { results.push({ step, error: "form not open" }); continue; }
      combos = [...getRegistrationModalRoot().querySelectorAll('[role="combobox"]')];
      const combo = combos[1];
      if (!combo) { results.push({ step, error: "no second combo" }); continue; }
      const input = combo.tagName === "INPUT" ? combo : combo.querySelector("input") || combo;
      if (step === "click-input") pointerClick(input);
      else if (step === "focus-then-click-input") { input.focus(); await sleep(80); pointerClick(input); }
      else if (step === "click-parent") pointerClick(combo.parentElement);
      else if (step === "arrowdown") { input.focus(); input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", keyCode: 40, bubbles: true })); }
      else if (step === "space") { input.focus(); input.dispatchEvent(new KeyboardEvent("keydown", { key: " ", code: "Space", keyCode: 32, bubbles: true })); }
      else if (step === "click-input-again") pointerClick(input);
      await sleep(500);
      const s = state(combo);
      results.push({ step, ...s });
      // close the list again if it opened, via Escape on the active element
      if (s.listOpen) { document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true })); await sleep(300); results.push({ step: step + ":after-escape", ...state(combo) }); }
    }
    return results;
  }, steps);
  for (const r of out) console.log(JSON.stringify(r));
} finally {
  await context.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
