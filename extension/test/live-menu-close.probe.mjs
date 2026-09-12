/**
 * Live probe (not part of test:all): after picking in a Luma multi-select, find which action
 * closes the list without closing the registration overlay. Never submits.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.join(__dirname, "..");
const target = process.argv[2] || "https://luma.com/uqxby9dm";
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "luma-agent-close-probe-"));
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
  const strategies = ["escape-active", "escape-listbox", "tab-active", "blur-active", "click-heading", "click-combo", "escape-combo"];
  for (const strategy of strategies) {
    const r = await page.evaluate(async (strategy) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const pointerClick = (el) => {
        const o = { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", isPrimary: true };
        el.dispatchEvent(new PointerEvent("pointerdown", o));
        el.dispatchEvent(new PointerEvent("pointerup", o));
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      };
      const key = (el, k, code, keyCode) => {
        el.dispatchEvent(new KeyboardEvent("keydown", { key: k, code, keyCode, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent("keyup", { key: k, code, keyCode, bubbles: true }));
      };
      if (!getRegistrationModalRoot()) {
        [...document.querySelectorAll("button")].find((b) => ["Request to Join", "Register", "Join Waitlist"].includes(b.textContent.trim()))?.click();
        await sleep(2500);
      }
      const root = getRegistrationModalRoot();
      if (!root) return { strategy, error: "form not open" };
      const combo = root.querySelector('div[role="combobox"]') || root.querySelector('[role="combobox"]');
      pointerClick(combo);
      await sleep(600);
      const listbox = controlledListbox(combo);
      const opts = listbox ? [...listbox.querySelectorAll('[role="option"]')] : [];
      if (!opts.length) return { strategy, error: "did not open" };
      const alreadySelected = opts.find((o) => o.getAttribute("aria-selected") === "true");
      if (!alreadySelected) pointerClick(opts[3] || opts[0]);
      await sleep(400);
      const state = () => ({
        expanded: combo.getAttribute("aria-expanded"),
        listOpen: Boolean(listbox && document.contains(listbox) && isElementInteractable(listbox)),
        formOpen: Boolean(getRegistrationModalRoot()),
        active: document.activeElement ? `${document.activeElement.tagName.toLowerCase()}[${document.activeElement.getAttribute("role") || ""}]` : null,
        comboText: cleanLabel(combo.textContent).slice(0, 70),
      });
      const before = state();
      const active = document.activeElement;
      if (strategy === "escape-active") key(active, "Escape", "Escape", 27);
      else if (strategy === "escape-listbox") key(listbox, "Escape", "Escape", 27);
      else if (strategy === "escape-combo") key(combo, "Escape", "Escape", 27);
      else if (strategy === "tab-active") key(active, "Tab", "Tab", 9);
      else if (strategy === "blur-active") active?.blur?.();
      else if (strategy === "click-heading") {
        const heading = [...root.querySelectorAll("h1,h2,h3,div,p,span")].find((el) => /your info/i.test(el.textContent || "") && el.children.length < 3);
        if (heading) pointerClick(heading);
      } else if (strategy === "click-combo") pointerClick(combo);
      await sleep(500);
      return { strategy, before, after: state() };
    }, strategy);
    console.log(JSON.stringify(r));
    // re-open the form if the strategy closed it, for the next strategy
    await page.waitForTimeout(300);
  }
} finally {
  await context.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
