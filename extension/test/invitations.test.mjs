/**
 * Invitation acceptance tests.
 *
 * The invite logic is DOM logic, so it runs in a real browser: the manifest's content scripts are
 * injected into a blank page and pointed at synthetic invitation markup. Covers the accept path,
 * the home-page scanner, and the guarantee that nothing ever clicks a decline control.
 *
 * Run: node test/invitations.test.mjs
 */
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(__dirname, "..");
const SYSTEM_CHROME = [
  process.env.PLAYWRIGHT_CHROME_PATH,
  chromium.executablePath(),
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
    : null,
].find((candidate) => candidate && fs.existsSync(candidate));

let passed = 0;
let failed = 0;
const assert = (name, condition) => {
  console.log(`  ${condition ? "✓" : "✗"} ${name}`);
  condition ? passed++ : failed++;
};

const CONTENT_SCRIPTS = JSON.parse(
  fs.readFileSync(path.join(EXT, "manifest.json"), "utf8")
).content_scripts[0].js;

const SOURCES = CONTENT_SCRIPTS.map((file) => fs.readFileSync(path.join(EXT, file), "utf8"));

/** Minimal chrome stub — content.js registers listeners and reads session flags on load. */
const CHROME_STUB = `
  window.chrome = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage: () => Promise.resolve({}),
      id: "test",
    },
    storage: {
      session: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
      local: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
    },
  };
`;

const browser = await chromium.launch({
  headless: true,
  ...(SYSTEM_CHROME ? { executablePath: SYSTEM_CHROME } : {}),
});

async function pageWith(bodyHtml) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto("about:blank");
  await page.addScriptTag({ content: CHROME_STUB });
  await page.setContent(`<body>${bodyHtml}</body>`);
  await page.addScriptTag({ content: CHROME_STUB });
  for (const source of SOURCES) await page.addScriptTag({ content: source });
  return page;
}

const INVITE_PAGE = `
  <h1>Agentic AI Builders Night</h1>
  <p>Vikram invited you to this event. Accept your invitation to confirm your spot.</p>
  <p>Thursday, September 4 · 6:00 PM · 500 Howard St, San Francisco</p>
  <button>Accept Invitation</button>
  <button>Decline</button>
`;

const PLAIN_EVENT_PAGE = `
  <h1>Open AI Meetup</h1>
  <p>Wednesday, September 10 · 6:00 PM · 1 Market St, San Francisco</p>
  <button>Register</button>
`;

try {
  console.log("\nDecline safety");
  {
    const page = await pageWith(INVITE_PAGE);
    const res = await page.evaluate(() => ({
      declineIsDecline: isDeclineControl([...document.querySelectorAll("button")][1]),
      acceptIsNotDecline: isDeclineControl([...document.querySelectorAll("button")][0]),
      askingForDeclineReturnsNothing: findClickable(["decline"], { checkFormScope: false }) === null,
      askingForAcceptWorks:
        findClickable(["accept invitation"], { checkFormScope: false })?.textContent ===
        "Accept Invitation",
    }));
    assert("A decline button is recognised as a decline control", res.declineIsDecline);
    assert("An accept button is not treated as a decline control", !res.acceptIsNotDecline);
    assert("findClickable refuses to return a decline control", res.askingForDeclineReturnsNothing);
    assert("findClickable still returns the accept control", res.askingForAcceptWorks);
    await page.close();
  }

  {
    const page = await pageWith(`
      <p>You're invited</p>
      <button>Decline invitation</button><button>Not going</button>
      <button>Can't go</button><button>No thanks</button><button>Maybe</button>
    `);
    const anyClickable = await page.evaluate(() =>
      ["decline invitation", "not going", "can't go", "no thanks", "maybe"].some((label) =>
        Boolean(findClickable([label], { checkFormScope: false }))
      )
    );
    assert("No decline phrasing is ever clickable", !anyClickable);
    await page.close();
  }

  console.log("\nInvitation detection");
  {
    const page = await pageWith(INVITE_PAGE);
    const res = await page.evaluate(() => ({
      invited: isInvitedEvent(),
      mode: getRegistrationMode(),
      openLabels: labelsForMode("invite", "open").slice(0, 3),
    }));
    assert("An invitation page is detected as invited", res.invited);
    assert("Registration mode resolves to invite", res.mode === "invite");
    assert("Accept labels are tried before register labels", res.openLabels[0] === "accept invitation");
    await page.close();
  }

  {
    const page = await pageWith(PLAIN_EVENT_PAGE);
    const res = await page.evaluate(() => ({
      invited: isInvitedEvent(),
      mode: getRegistrationMode(),
    }));
    assert("A plain event page is not treated as an invitation", !res.invited);
    assert("A plain event page keeps standard mode", res.mode === "standard");
    await page.close();
  }

  {
    // A bare "Accept" (cookie/terms banners) must not turn an event into an invitation.
    const page = await pageWith(`
      <h1>Some Event</h1><p>We use cookies.</p>
      <button>Accept</button><button>Register</button>
    `);
    const invited = await page.evaluate(() => isInvitedEvent());
    assert("A lone Accept button is not mistaken for an invitation", !invited);
    await page.close();
  }

  console.log("\nCriteria still apply on invitations");
  {
    const page = await pageWith(`
      <h1>Women in AI — Builders Dinner</h1>
      <p>Priya invited you to this event.</p>
      <button>Accept Invitation</button><button>Decline</button>
    `);
    const res = await page.evaluate(() => ({ invited: isInvitedEvent(), women: isWomenOnlyEventPage() }));
    assert("A women-only invitation is still detected as women-only", res.women);
    assert("…while still being recognised as an invitation", res.invited);
    await page.close();
  }

  {
    // Documents a real limit: the women-only filter reads the title, not the body. An event whose
    // title gives no signal is not caught here — same as for discovered events.
    const page = await pageWith(`
      <h1>Builders Dinner</h1>
      <p>Priya invited you. This is a women-only event.</p>
      <button>Accept Invitation</button><button>Decline</button>
    `);
    const women = await page.evaluate(() => isWomenOnlyEventPage());
    assert("Known scope: women-only is detected from the title, not the body", !women);
    await page.close();
  }

  {
    const page = await pageWith(`
      <h1>Virtual AI Roundtable</h1>
      <p>Someone invited you to this event.</p>
      <p>This is an online event. A Zoom link will be sent to registered guests.</p>
      <button>Accept Invitation</button><button>Decline</button>
    `);
    const res = await page.evaluate(() => ({ invited: isInvitedEvent(), virtual: isVirtualEventPage() }));
    assert("An online invitation is still detected as virtual", res.virtual);
    assert("…and is still recognised as an invitation", res.invited);
    await page.close();
  }

  {
    const page = await pageWith(`
      <h1>Sold Out Summit</h1>
      <p>You have been invited to this event.</p>
      <p>This event is sold out.</p>
      <button>Accept Invitation</button><button>Decline</button>
    `);
    const res = await page.evaluate(() => ({
      blocked: isBlockedByCapacity(),
      canJoin: canJoinDespiteCapacity(),
    }));
    assert("An invited guest is not blocked by public sold-out state", !res.blocked);
    assert("The accept control counts as a way to join", res.canJoin);
    await page.close();
  }

  console.log("\nHome page scanner");
  {
    const page = await pageWith(`
      <div class="card"><a href="https://luma.com/invited-one">AI Agents Night</a><span>Invited</span></div>
      <div class="card"><a href="https://luma.com/invited-two">Founders Dinner</a>
        <p>Sam invited you to this event</p></div>
      <div class="card"><a href="https://luma.com/already-going">Robotics Demo</a><span>Going</span></div>
      <div class="card"><a href="https://luma.com/is-pending">Closed Door</a><span>Pending</span></div>
      <div class="card"><a href="https://luma.com/just-listed">Public Meetup</a><span>Free</span></div>
      <div class="card"><a href="https://luma.com/sf">SF calendar</a><span>Invited</span></div>
    `);
    const res = await page.evaluate(() => {
      const out = scanInvitationCards();
      return { slugs: out.invites.map((i) => i.slug), skipUrls: out.skipUrls, rateLimited: out.rateLimited };
    });
    assert("Finds a card with an Invited badge", res.slugs.includes("invited-one"));
    assert("Finds a card with invitation wording", res.slugs.includes("invited-two"));
    assert("Skips a card already marked Going", !res.slugs.includes("already-going"));
    assert("Skips a card already marked Pending", !res.slugs.includes("is-pending"));
    assert("Ignores a card with no invitation signal", !res.slugs.includes("just-listed"));
    assert("Rejects the /sf calendar path", !res.slugs.includes("sf"));
    assert(
      "Records Going as an already-registered skip",
      res.skipUrls["slug:already-going"] === "already_registered"
    );
    assert(
      "Records Pending as a pending-approval skip",
      res.skipUrls["slug:is-pending"] === "pending_approval"
    );
    assert("Every invite carries slug, url and title", res.slugs.length === 2);
    await page.close();
  }

  {
    const page = await pageWith(`
      <div class="card"><a href="https://luma.com/dup">Dup Event</a><span>Invited</span></div>
      <div class="card"><a href="https://luma.com/dup?ref=email">Dup Event</a><span>Invited</span></div>
    `);
    const slugs = await page.evaluate(() => scanInvitationCards().invites.map((i) => i.slug));
    assert("De-duplicates the same invitation linked twice", slugs.length === 1);
    await page.close();
  }
  console.log("\nPre-filter before any tab is opened");
  {
    const { EXCLUDE_KEYWORDS, isWomenOnlyEvent } = await import("../lib/constants.js");
    const pick = (title) =>
      !EXCLUDE_KEYWORDS.some((word) => title.toLowerCase().includes(word)) &&
      !isWomenOnlyEvent({ title });

    assert("Keeps an AI invitation", pick("Agentic AI Builders Night"));
    assert("Drops a yoga invitation", !pick("Sunrise Yoga in the Park"));
    assert("Drops a wine invitation", !pick("Founders Wine Tasting"));
    assert("Drops a dating invitation", !pick("Tech Singles Dating Mixer"));
    assert("Drops a real estate invitation", !pick("Real Estate Investor Brunch"));
    assert("Drops a women-only invitation by title", !pick("Women in AI Dinner"));
    assert("Keeps a neutral tech invitation", pick("Rust Systems Meetup"));
  }
} finally {
  await browser.close();
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exitCode = failed ? 1 : 0;
