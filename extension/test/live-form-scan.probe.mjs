/**
 * Live probe (not part of test:all): open a real Luma registration form anonymously, inject the
 * extension's scanner libraries into the page, and report what they see. Used to check the
 * scanner against Luma's current markup without a login or any registration attempt.
 *
 *   node test/live-form-scan.probe.mjs [https://luma.com/<slug>]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.join(__dirname, "..");
const target = process.argv[2] || "https://luma.com/uqxby9dm";
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "luma-agent-probe-"));
const chromeExecutable = [
  process.env.PLAYWRIGHT_CHROME_PATH,
  chromium.executablePath(),
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].find((candidate) => candidate && fs.existsSync(candidate));

const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  ...(chromeExecutable ? { executablePath: chromeExecutable } : {}),
  args: ["--window-position=-32000,-32000", "--window-size=1000,800"],
});

try {
  const page = await context.newPage();
  await page.goto(target, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  const clicked = await page.evaluate(() => {
    const labels = ["Request to Join", "Register", "Join Waitlist", "Get Ticket", "RSVP"];
    const btn = [...document.querySelectorAll("button")].find((b) => labels.includes(b.textContent.trim()));
    btn?.click();
    return btn?.textContent.trim() || null;
  });
  await page.waitForTimeout(3500);

  await page.addScriptTag({ path: path.join(extensionDir, "lib/form-intelligence.js") });
  await page.addScriptTag({ path: path.join(extensionDir, "lib/form-scanner.js") });

  const report = await page.evaluate(() => {
    const describe = (el) =>
      el
        ? `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}.${String(el.className || "").trim().split(/\s+/).slice(0, 3).join(".")}`
        : null;
    const modal = getRegistrationModalRoot();
    const form = getFormRoot();
    const fields = scanRegistrationFields().map((f) => ({
      kind: f.kind,
      label: f.label,
      name: f.el.getAttribute("name"),
      type: f.el.getAttribute("type"),
      attrType: f.attrType || null,
      filled: f.filled,
      visible: isVisible(f.el),
      el: describe(f.el),
    }));
    const triggers = findCustomDropdownTriggers().map((t) => ({
      el: describe(t),
      text: (t.textContent || "").trim().slice(0, 60),
      label: getQuestionTextForElement(t),
      activator: describe(resolveDropdownActivator(t)),
      visible: isVisible(t),
    }));
    const combos = [...document.querySelectorAll('[role="combobox"], [aria-haspopup]')].map((c) => ({
      el: describe(c),
      rect: (() => {
        const r = c.getBoundingClientRect();
        return [Math.round(r.width), Math.round(r.height)];
      })(),
      text: (c.textContent || "").trim().slice(0, 60),
      ariaReq: c.getAttribute("aria-required"),
      html: c.outerHTML.slice(0, 500),
    }));
    return {
      modalRoot: describe(modal),
      modalIsHtmlOrBody: modal === document.documentElement || modal === document.body,
      formRoot: describe(form),
      fields,
      triggers,
      combos,
      hasUnfilled: hasUnfilledFormFields(),
      unfilled: describeUnfilledFields(),
      formOpen: isRegistrationFormOpen(),
    };
  });

  console.log("target:", target, "| clicked:", clicked);
  console.log(JSON.stringify(report, null, 2));

  // Try opening the first combobox the way the agent would, and list what options appear.
  const opened = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const combo = document.querySelector('[role="combobox"]');
    if (!combo) return { noCombo: true };
    const activator = resolveDropdownActivator(combo);
    const before = snapshotInteractiveTexts();
    simulatePointerClick(activator);
    await sleep(700);
    const options = collectDropdownOptions(activator, document, before).map((o) => o.text);
    const panels = [...document.querySelectorAll('[role="listbox"], [role="menu"], [role="option"], [role="menuitem"], [role="menuitemcheckbox"]')].map(
      (p) => `${p.tagName.toLowerCase()}[${p.getAttribute("role")}] ${(p.textContent || "").trim().slice(0, 40)}`
    );
    return {
      overlayOpen: isDropdownOverlayOpen(),
      options,
      panels: panels.slice(0, 20),
      discovery: describeDropdownDiscovery(activator),
      activatorHtml: activator.outerHTML.slice(0, 400),
    };
  });
  console.log("dropdown probe:", JSON.stringify(opened, null, 2));
} finally {
  await context.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
