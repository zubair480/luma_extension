/**
 * Live dropdown probe (not part of test:all): on a real Luma form, open a custom select and try
 * each way of choosing an option, reporting whether the choice stuck and whether the registration
 * overlay survived. Never submits.
 *
 *   node test/live-dropdown.probe.mjs [https://luma.com/<slug>]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.join(__dirname, "..");
const target = process.argv[2] || "https://luma.com/uqxby9dm";
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "luma-agent-dd-probe-"));
const chromeExecutable = [
  process.env.PLAYWRIGHT_CHROME_PATH,
  chromium.executablePath(),
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].find((candidate) => candidate && fs.existsSync(candidate));

const LIBS = ["lib/form-intelligence.js", "lib/form-scanner.js"];

const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  ...(chromeExecutable ? { executablePath: chromeExecutable } : {}),
  args: ["--window-position=-32000,-32000", "--window-size=1000,800"],
});

try {
  const page = await context.newPage();
  await page.goto(target, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  for (const lib of LIBS) await page.addScriptTag({ path: path.join(extensionDir, lib) });

  const strategies = ["pointer", "mouse", "click", "full", "keyboard-enter", "keyboard-space"];
  const results = [];
  for (const strategy of strategies) {
    const r = await page.evaluate(async (strategy) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const openForm = async () => {
        if (getRegistrationModalRoot()) return true;
        const labels = ["Request to Join", "Register", "Join Waitlist", "Get Ticket", "RSVP"];
        const btn = [...document.querySelectorAll("button")].find((b) => labels.includes(b.textContent.trim()));
        btn?.click();
        await sleep(2500);
        return Boolean(getRegistrationModalRoot());
      };
      if (!(await openForm())) return { strategy, error: "form did not open" };

      const combo = getRegistrationModalRoot().querySelector('[role="combobox"]');
      if (!combo) return { strategy, error: "no combobox in form" };
      const label = getQuestionTextForElement(combo);

      // Open with the plain pointer sequence (known to work) and read the options.
      combo.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, pointerType: "mouse" }));
      combo.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, pointerType: "mouse" }));
      combo.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await sleep(600);
      const listbox = controlledListbox(combo);
      const options = listbox ? [...listbox.querySelectorAll('[role="option"]')] : [];
      const listboxInForm = listbox ? getRegistrationModalRoot().contains(listbox) : null;
      if (!options.length) return { strategy, error: "listbox did not open", expanded: combo.getAttribute("aria-expanded") };
      const target = options[Math.min(3, options.length - 1)];
      const wanted = target.textContent.trim();

      const rect = target.getBoundingClientRect();
      const pos = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
      const mouse = (type, extra = {}) => target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0, ...pos, ...extra }));
      const pointer = (type, extra = {}) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, view: window, button: 0, pointerId: 1, pointerType: "mouse", isPrimary: true, ...pos, ...extra }));

      if (strategy === "pointer") { pointer("pointerdown", { buttons: 1 }); pointer("pointerup"); mouse("click"); }
      else if (strategy === "mouse") { mouse("mousedown", { buttons: 1 }); mouse("mouseup"); mouse("click"); }
      else if (strategy === "click") { target.click(); }
      else if (strategy === "full") { pointer("pointerdown", { buttons: 1 }); mouse("mousedown", { buttons: 1 }); pointer("pointerup"); mouse("mouseup"); mouse("click"); }
      else if (strategy.startsWith("keyboard")) {
        combo.focus();
        for (let i = 0; i < 4; i++) {
          combo.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", keyCode: 40, bubbles: true }));
          await sleep(80);
        }
        const key = strategy === "keyboard-enter" ? { key: "Enter", code: "Enter", keyCode: 13 } : { key: " ", code: "Space", keyCode: 32 };
        combo.dispatchEvent(new KeyboardEvent("keydown", { ...key, bubbles: true }));
        combo.dispatchEvent(new KeyboardEvent("keyup", { ...key, bubbles: true }));
      }
      await sleep(600);

      const after = {
        strategy,
        label,
        wanted,
        listboxInForm,
        formStillOpen: Boolean(getRegistrationModalRoot()),
        comboText: cleanLabel(combo.textContent).slice(0, 80),
        expanded: combo.getAttribute("aria-expanded"),
        optionSelected: target.getAttribute("aria-selected"),
        selectedNow: listbox && document.contains(listbox) ? [...listbox.querySelectorAll('[aria-selected="true"]')].map((o) => o.textContent.trim()) : "listbox gone",
      };

      // Then see what Escape does to the overlay.
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
      await sleep(400);
      after.formOpenAfterEscape = Boolean(getRegistrationModalRoot());
      after.expandedAfterEscape = combo.getAttribute("aria-expanded");
      return after;
    }, strategy);
    results.push(r);
    console.log(JSON.stringify(r));
    await page.waitForTimeout(500);
  }
} finally {
  await context.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
