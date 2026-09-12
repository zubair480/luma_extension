/**
 * Live fill probe (not part of test:all): open real Luma registration forms anonymously, inject
 * the extension's form stack with a stubbed `chrome` API and a fake profile, run the real
 * fillAllFields pipeline, and report what every field holds afterwards. Never submits.
 *
 *   node test/live-form-fill.probe.mjs [url ...]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.join(__dirname, "..");
const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["https://luma.com/uqxby9dm", "https://luma.com/openmodelhack", "https://luma.com/coreweavehacks"];
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "luma-agent-fill-probe-"));
const chromeExecutable = [
  process.env.PLAYWRIGHT_CHROME_PATH,
  chromium.executablePath(),
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].find((candidate) => candidate && fs.existsSync(candidate));

const FAKE_PROFILE = {
  first_name: "Ada",
  last_name: "Probe",
  email: "ada.probe@example.com",
  phone: "4155550100",
  location: "San Francisco, CA",
  job_title: "Software Engineer",
  company: "Example Labs",
  linkedin: "https://www.linkedin.com/in/ada-probe",
  github: "https://github.com/ada-probe",
  website: "https://ada-probe.example.com",
  twitter_handle: "ada_probe",
  x: "https://x.com/ada_probe",
  dietary: "None",
  default_answers: {
    "What are you building?": "A probe that fills forms.",
    "How did you hear about the event?": "Luma",
  },
};

const LIBS = [
  "lib/run-control-content.js",
  "lib/form-intelligence.js",
  "lib/form-scanner.js",
  "lib/form-agent.js",
  "lib/visual-cursor.js",
  "content.js",
];

const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  ...(chromeExecutable ? { executablePath: chromeExecutable } : {}),
  args: ["--window-position=-32000,-32000", "--window-size=1000,800"],
});

try {
  for (const target of targets) {
    const page = await context.newPage();
    const logs = [];
    page.on("console", (msg) => {
      const text = msg.text();
      if (text.startsWith("[Luma Agent]")) logs.push(text.slice(0, 160));
    });
    await page.goto(target, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);

    const clicked = await page.evaluate(() => {
      const labels = ["Request to Join", "Register", "Join Waitlist", "Get Ticket", "RSVP"];
      const btn = [...document.querySelectorAll("button")].find((b) => labels.includes(b.textContent.trim()));
      btn?.click();
      return btn?.textContent.trim() || null;
    });
    await page.waitForTimeout(3500);

    // Stub the extension APIs the content stack touches, then load the real files.
    await page.evaluate(() => {
      window.chrome = {
        runtime: {
          sendMessage: async (msg) =>
            msg?.type === "ANSWER_QUESTION" ? { answer: `AI answer for: ${String(msg.question).slice(0, 40)}` } : { ok: true },
          onMessage: { addListener() {} },
        },
        storage: {
          local: { get: async () => ({ runControlMirror: {} }), set: async () => {} },
          session: { get: async () => ({}), set: async () => {} },
          onChanged: { addListener() {} },
        },
      };
    });
    for (const lib of LIBS) await page.addScriptTag({ path: path.join(extensionDir, lib) });

    const report = await page.evaluate(async (profile) => {
      const describe = (el) => `${el.tagName.toLowerCase()}[name=${el.getAttribute("name") || ""}]`;
      const before = scanRegistrationFields().map((f) => ({ label: f.label, kind: f.kind }));
      const fillLog = [];
      const log = (step, message, level) => fillLog.push(`${step}:${level || "info"} ${message}`);
      const started = Date.now();
      let error = null;
      try {
        await fillAllFields(profile, log, document.title);
      } catch (err) {
        error = err?.message || String(err);
      }
      const elapsedMs = Date.now() - started;
      const after = scanRegistrationFields().map((f) => ({
        label: f.label.slice(0, 60),
        kind: f.kind,
        el: describe(f.el),
        value:
          f.kind === "multi-select" || f.kind === "custom-select"
            ? (f.el.textContent || "").trim().slice(0, 60)
            : f.kind === "checkbox" || f.kind === "radio"
              ? String(f.el.checked)
              : (f.el.value || "").slice(0, 60),
        filled: fieldHasValue(f.el, f.kind),
      }));
      return {
        modalRoot: (() => {
          const m = getRegistrationModalRoot();
          return m ? `${m.tagName.toLowerCase()}.${String(m.className).split(/\s+/).slice(0, 2).join(".")}` : null;
        })(),
        before,
        after,
        hasUnfilled: hasUnfilledFormFields(),
        unfilled: describeUnfilledFields(),
        submitButton: (() => {
          const btn = findSubmitButton(getRegistrationMode());
          return btn ? btn.textContent.trim().slice(0, 40) : null;
        })(),
        mode: getRegistrationMode(),
        elapsedMs,
        error,
        fillLog: fillLog.slice(0, 60),
      };
    }, FAKE_PROFILE);

    console.log(`\n==== ${target} (clicked: ${clicked}) ====`);
    console.log("modal root:", report.modalRoot, "| mode:", report.mode, "| took", report.elapsedMs, "ms", report.error ? `| ERROR: ${report.error}` : "");
    console.log("fields before:", report.before.length);
    for (const f of report.after) console.log(`  ${f.filled ? "✓" : "✗"} [${f.kind}] ${f.label} → ${JSON.stringify(f.value)}`);
    console.log("hasUnfilled:", report.hasUnfilled, "| unfilled:", report.unfilled);
    console.log("submit button:", report.submitButton);
    console.log("fill log:");
    for (const line of report.fillLog) console.log("   ", line);
    await page.close();
  }
} finally {
  await context.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
