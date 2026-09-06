/**
 * Full extension audit — unit + integration tests (no Chrome login required).
 * Run: npm run test:audit
 */
import { isRegisterable, scoreEvent, isExcludedFromHistory } from "../lib/discovery.js";
import { buildHistoryExcludeIds, shouldExcludeFromDiscoveryHistory } from "../lib/history.js";
import {
  isValidEventHref,
  isValidEventSlug,
  isWomenOnlyEvent,
  isVirtualEventFromApi,
  isVirtualEvent,
  isVirtualEventText,
  hasPhysicalGeo,
  SF_REGION_CITIES,
} from "../lib/constants.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
const failures = [];
const warnings = [];

function assert(name, condition) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}`);
    failed++;
    failures.push(name);
  }
}

function warn(name) {
  console.log(`  ⚠ ${name}`);
  warnings.push(name);
}

function loadFormIntelligence() {
  const src = fs.readFileSync(path.join(__dirname, "../lib/form-intelligence.js"), "utf8");
  const sandbox = {
    document: {
      body: { innerText: "" },
      querySelector: () => null,
      querySelectorAll: () => [],
      title: "",
    },
    window: {},
  };
  sandbox.window = sandbox;
  const fn = new Function(
    "document",
    "window",
    src +
      "\nreturn { classifyQuestion, answerForQuestion, isPaymentRequired, isPaidEventPage, needsSmartAnswer, isValidEventHref, requiresWallet, pickBestSelectOption };"
  );
  return fn(sandbox.document, sandbox.window);
}

function mockEvent(overrides = {}) {
  return {
    id: "evt-1",
    slug: "test-event",
    title: "AI Meetup",
    city: "San Francisco",
    isFree: true,
    isSoldOut: false,
    requireApproval: false,
    registrationAvailability: "open",
    waitlistActive: false,
    userRsvpStatus: null,
    relevanceScore: 50,
    ...overrides,
  };
}

console.log("=== Luma Agent Full Audit ===\n");

// ── URL & slug validation ──
console.log("URL & slug validation");
assert("Valid event href lu.ma", isValidEventHref("https://lu.ma/my-event"));
assert("Valid event href luma.com", isValidEventHref("https://luma.com/ai-summit"));
assert("Rejects /user/ profile", !isValidEventHref("https://luma.com/user/host123"));
assert("Rejects /sf feed", !isValidEventHref("https://luma.com/sf"));
assert("Rejects /create system page", !isValidEventHref("https://luma.com/create"));
assert("Rejects multi-segment path", !isValidEventHref("https://luma.com/cal/foo"));
assert("Rejects usr- prefix slug", !isValidEventSlug("usr-abc123"));
assert("Accepts normal slug", isValidEventSlug("agentic-engineering-summit"));

// ── Discovery registerability ──
console.log("\nDiscovery registerability");
assert("Free open event registerable", isRegisterable(mockEvent()));
assert("Paid open NOT registerable", !isRegisterable(mockEvent({ isFree: false, requireApproval: false })));
assert("Free + approval registerable", isRegisterable(mockEvent({ requireApproval: true, isFree: false })));
assert("Waitlist registerable", isRegisterable(mockEvent({ registrationAvailability: "waitlist" })));
assert("Sold out without waitlist NOT registerable", !isRegisterable(mockEvent({ isSoldOut: true, registrationAvailability: "sold-out" })));
assert("Sold out WITH waitlist registerable", isRegisterable(mockEvent({ isSoldOut: true, waitlistActive: true, registrationAvailability: "sold-out" })));
assert("Already going NOT registerable", !isRegisterable(mockEvent({ userRsvpStatus: "going" })));
assert("Closed registration NOT registerable", !isRegisterable(mockEvent({ registrationAvailability: "closed" })));

// ── Scoring & women-only ──
console.log("\nScoring & filtering");
const aiScore = scoreEvent(mockEvent({ title: "AI Agent Summit", query: "AI" }));
assert("AI event scores high", aiScore.score >= 20 && !aiScore.excluded);
const yogaScore = scoreEvent(mockEvent({ title: "Sunset Yoga in SF" }));
assert("Yoga event excluded", yogaScore.excluded);
assert("Women-only event excluded", isWomenOnlyEvent({ title: "Women in Tech Breakfast" }));

console.log("\nVirtual event filtering");
assert("Zoom in title is virtual", isVirtualEventText("AI Talk on Zoom — online only"));
assert("Google Meet is virtual", isVirtualEventText("Join us on Google Meet — online only"));
assert("YouTube-only stream is virtual", isVirtualEventText("Live on YouTube — streaming only"));
assert("In-person SF meetup not virtual", !isVirtualEventText("DevTools Meetup @ Humanmade, SF"));
assert(
  "Hybrid livestream + in-person not virtual",
  !isVirtualEventText(
    "Show & Tell AI for GTM Notion HQ San Francisco Livestream In Person 685 Market St San Francisco CA"
  )
);
assert(
  "YouTube in description not virtual when SF venue present",
  !isVirtualEventFromApi(
    { name: "Show & Tell", description: "Past talks on youtube.com/playlist" },
    { city: "San Francisco", address: "685 Market St" }
  )
);
assert("Empty geo is not physical", !hasPhysicalGeo({}));
assert("City geo is physical", hasPhysicalGeo({ city: "San Francisco" }));
assert("API: empty geo rejected", isVirtualEventFromApi({ name: "AI Summit" }, {}));
assert(
  "API: zoom-only description rejected",
  isVirtualEventFromApi({ name: "Tech Talk", description: "Join via Zoom — online only" }, {})
);
assert(
  "API: SF physical venue accepted",
  !isVirtualEventFromApi({ name: "Hardware Meetup" }, { city: "San Francisco", address: "123 Main St" })
);
assert("Virtual text detected", isVirtualEventText("Weekly Webinar on Zoom — remote only"));
if (isWomenOnlyEvent({ title: "Women in AI Leadership Panel" })) {
  warn("'Women in AI' in title triggers women-only skip (may be intentional)");
}

// ── History exclusion ──
console.log("\nHistory exclusion");
const excludeSet = new Set(["evt-1", "slug:done-slug"]);
assert("Successful event excluded", isExcludedFromHistory(mockEvent({ id: "evt-1" }), excludeSet));
assert("New event not excluded", !isExcludedFromHistory(mockEvent({ id: "evt-new" }), excludeSet));

// ── Form intelligence (DOM sandbox) ──
console.log("\nForm intelligence");
const fi = loadFormIntelligence();
assert("Classifies city question", fi.classifyQuestion("Which city are you based in?") === "location");
assert("Classifies community question", fi.classifyQuestion("Are you a member of our community?") === "community_member");
assert("Classifies admission question", fi.classifyQuestion("Why should we allow you to come?") === "admission");
assert("Classifies referral", fi.classifyQuestion("How did you hear about this event?") === "referral");
assert("needsSmartAnswer for custom", fi.needsSmartAnswer("custom", "What is your favorite tool?"));

const profile = {
  first_name: "Test",
  last_name: "User",
  location: "San Francisco, CA",
  job_title: "Engineer",
  company: "Test Co",
  default_answers: {},
};
assert("Location answer from profile", fi.answerForQuestion("Which city?", profile) === "San Francisco, CA");

// Payment detection with mock DOM
function payDoc(html) {
  const fi2 = loadFormIntelligence();
  const el = {
    innerHTML: html,
    innerText: html.replace(/<[^>]+>/g, " "),
    body: null,
    querySelector(sel) {
      if (sel.includes("cc-number")) return html.includes("cc-number") ? { tagName: "INPUT" } : null;
      if (sel.includes("stripe")) return html.includes("stripe") ? { tagName: "IFRAME" } : null;
      return null;
    },
    querySelectorAll(sel) {
      if (sel.includes("button")) {
        const buttons = [];
        if (/pay now|complete purchase/i.test(html)) buttons.push({ textContent: "Pay now" });
        return buttons.map((b) => ({
          ...b,
          getAttribute: () => "",
          textContent: b.textContent,
        }));
      }
      return [];
    },
  };
  el.body = el;
  const fn = new Function(
    "document",
    "window",
    fs.readFileSync(path.join(__dirname, "../lib/form-intelligence.js"), "utf8") +
      "\nreturn { isPaymentRequired, isPaidEventPage };"
  );
  // Re-load with visibility stub
  const fullSrc =
    fs.readFileSync(path.join(__dirname, "../lib/form-intelligence.js"), "utf8") +
    `
    function isVisible(el) { return true; }
    return { isPaymentRequired, isPaidEventPage };
  `;
  return new Function("document", fullSrc)(el);
}

const pay = payDoc('<input autocomplete="cc-number" /><p>Enter credit card</p>');
assert("Detects credit card form", pay.isPaymentRequired());
const free = payDoc("<p>Free ticket $0.00</p><button>Register</button>");
assert("Free $0 not payment required", !free.isPaymentRequired());
const hybridFree = payDoc(
  "<p>Livestream</p><p>In Person</p><p>Free</p><button>Register</button><div class='stripe-hidden'>stripe</div>"
);
assert("Hybrid free tickets not payment required", !hybridFree.isPaymentRequired());
assert("Hybrid free not paid event page", !hybridFree.isPaidEventPage());

// ── SF region constants ──
console.log("\nSF region config");
assert("SF in region list", SF_REGION_CITIES.some((c) => c.includes("san francisco")));
assert("Oakland in region list", SF_REGION_CITIES.includes("oakland"));

// ── History exclusion (retry vs permanent) ──
console.log("\nHistory exclusion");
assert(
  "Retryable virtual skip not excluded",
  !shouldExcludeFromDiscoveryHistory({
    event: { id: "evt-virtual", slug: "bad-skip" },
    status: "skipped_virtual",
    skipped: true,
  })
);
assert(
  "Retryable paid skip not excluded",
  !shouldExcludeFromDiscoveryHistory({
    event: { id: "evt-paid", slug: "paid-skip" },
    status: "skipped_paid",
    skipped: true,
  })
);
assert(
  "Registered events stay excluded",
  shouldExcludeFromDiscoveryHistory({
    event: { id: "evt-reg", slug: "registered-ok" },
    status: "registered",
  })
);
assert(
  "Ended and cancelled events stay excluded",
  shouldExcludeFromDiscoveryHistory({ event: { slug: "ended" }, status: "event_ended" }) &&
    shouldExcludeFromDiscoveryHistory({ event: { slug: "cancelled" }, status: "event_cancelled" })
);
assert(
  "Closed registration stays excluded",
  shouldExcludeFromDiscoveryHistory({ event: { slug: "closed" }, status: "registration_closed" })
);
const excludeIds = buildHistoryExcludeIds([
  { event: { id: "evt-virtual", slug: "bad-skip" }, status: "skipped_virtual" },
  { event: { id: "evt-reg", slug: "registered-ok" }, status: "registered" },
]);
assert(
  "Exclude ids omit retryable skips",
  excludeIds.has("evt-reg") && !excludeIds.has("bad-skip")
);

// The live network pass is intentionally centralized in discovery-edge-cases.mjs.
// Calling Luma twice in test:all can trigger a transient 403 rate limit.
console.log("\nLive discovery API");
console.log("  ↪ Covered by npm run test:discovery");

// ── Static vulnerability checks ──
console.log("\nStatic security checks");
const popupSrc = fs.readFileSync(path.join(__dirname, "../popup.js"), "utf8");
const popupHtml = fs.readFileSync(path.join(__dirname, "../popup.html"), "utf8");
const devReload = fs.readFileSync(path.join(__dirname, "../dev-reload.js"), "utf8");
const bgSrc = fs.readFileSync(path.join(__dirname, "../background.js"), "utf8");

const contentSrc = fs.readFileSync(path.join(__dirname, "../content.js"), "utf8");
const fiSrc = fs.readFileSync(path.join(__dirname, "../lib/form-intelligence.js"), "utf8");
const visualSrc = fs.readFileSync(path.join(__dirname, "../lib/visual-cursor.js"), "utf8");
const discoverySrc = fs.readFileSync(path.join(__dirname, "../lib/discovery.js"), "utf8");
const manifestSrc = fs.readFileSync(path.join(__dirname, "../manifest.json"), "utf8");

assert("Popup uses safe DOM for results", !popupSrc.includes('li.innerHTML = `\n      <span class="result-title"'));
assert("UI exposes exactly four source links", (popupHtml.match(/class="source-link"/g) || []).length === 4);
assert("Founders Club source is linked in the UI", popupHtml.includes("https://bayareafoundersclub.substack.com/"));
assert("Founders Club feed is reachable by host permission", manifestSrc.includes("https://bayareafoundersclub.substack.com/*"));
assert("Founders Club source is wired into the scan fan-out", bgSrc.includes("scanFoundersClub(sessionId)"));
assert("Founders Club source is a declared event source", bgSrc.includes('key: "founders-club"'));
assert(
  "Feed parsing avoids DOMParser (unavailable in MV3 service workers)",
  !/new\s+DOMParser/.test(
    fs.readFileSync(path.join(__dirname, "../lib/substack-discovery.js"), "utf8")
  )
);
assert(
  "Discovery ranks on interleaved source position",
  discoverySrc.includes("sourceOrder: takeIndex++") && discoverySrc.includes("function takeNext()")
);
assert("Verification is streamable", discoverySrc.includes("export function createStreamingVerifier"));
assert("Background streams sources into the verifier", bgSrc.includes("verifier.push(sourceEvents)"));
assert("Registration starts before scans finish", bgSrc.includes("processRun(queue, profile, null, sessionId, { workTabReady })"));
assert("CV detail pages resolve by fetch, not tab hops", bgSrc.includes("async function resolveCvDetailByFetch"));
assert("Cerebral Valley is read from its public API first", bgSrc.includes("discoverCerebralValleyViaApi({"));
assert("Cerebral Valley tab is created only for the fallback", bgSrc.includes("const getCvTabId = async () =>"));

// Performance
assert("Verified lookups are cached across runs", discoverySrc.includes("LOOKUP_CACHE_KEY"));
assert("Transient lookup failures are never cached", discoverySrc.includes('CACHEABLE_LOOKUP_STATUSES = new Set(["event", "not_event", "ineligible"])'));
assert("Cached lookups expire on a TTL", discoverySrc.includes("LOOKUP_CACHE_TTL_MS"));
assert("Cache degrades to a no-op without chrome.storage", discoverySrc.includes("function lookupCacheAvailable()"));
assert("Page readiness is polled, not slept through", bgSrc.includes("async function waitForPageSettled"));
assert("No fixed 3s settle sleep remains before registering", !bgSrc.includes("await interruptibleSleep(3000)"));
assert("Cerebral Valley hops are bounded to a fair share", bgSrc.includes("const cvTarget = Math.max(8, Math.ceil(MAX_EVENTS / SOURCE_COUNT))"));

// Exclusions outlive the capped display history
const historySrc = fs.readFileSync(path.join(__dirname, "../lib/history.js"), "utf8");
assert("A durable exclusion index exists", historySrc.includes("EXCLUDE_INDEX_KEY"));
assert("The exclusion index is far larger than the display cap", historySrc.includes("EXCLUDE_INDEX_MAX = 5000"));
assert("The exclusion index expires on age, not count", historySrc.includes("EXCLUDE_INDEX_TTL_MS"));
assert("Exclusions are written on every history append", bgSrc.includes("addToExcludeIndex(index, entry)"));
assert("The display history is still capped at 100", bgSrc.includes("history: history.slice(0, 100)"));
assert("Exclusion ids come from the index, not just history", bgSrc.includes("excludeIdsFromIndex(index)"));
assert("Prior verdicts fall back to the index", bgSrc.includes("findExcludeEntry(await readExcludeIndex(), event)"));
assert("Existing history is migrated into the index once", bgSrc.includes("buildExcludeIndexFromHistory"));

// Invitation acceptance
assert("Invite mode is resolved before waitlist/request", contentSrc.includes('if (isInvitedEvent()) return "invite";'));
assert("Accept labels are defined", contentSrc.includes("const INVITE_LABELS"));
assert("Decline labels are defined", contentSrc.includes("const DECLINE_LABELS"));
assert("Decline controls are filtered out of every clickable lookup", contentSrc.includes("!isDeclineControl(el)"));
assert(
  "No code path clicks a decline control",
  !/agentClick\([^)]*decline/i.test(contentSrc) && !/clickPrimaryAction\(\s*["']decline/i.test(contentSrc)
);
assert("Invited guests bypass public sold-out state", contentSrc.includes("findClickable([...INVITE_LABELS, ...WAITLIST_LABELS"));
assert("Home page is scanned for invitations", contentSrc.includes("SCAN_INVITES"));
assert("Invitation run is wired in the background", bgSrc.includes("async function startInviteRun()"));
assert("Invitation run reuses the shared registration loop", bgSrc.includes("processRun(invites, profile, workTab.id, sessionId)"));
assert("Invitations are read from the signed-in home page", bgSrc.includes('const INVITES_URL = "https://luma.com/home"'));
assert("Panel exposes an accept-invitations button", popupHtml.includes('id="inviteBtn"'));
assert("Both start buttons share one disabled lifecycle", popupSrc.includes("function setStartButtonsDisabled"));
assert("UI has one combined start button", popupHtml.includes('id="runBtn"') && !popupHtml.includes('id="runCvBtn"'));
assert("Bond AI uses confirmed calendar URL", popupHtml.includes("https://luma.com/genai-sf"));
assert("Background scans sources concurrently", bgSrc.includes("Promise.allSettled(["));
assert("Luma API requests use one serialized lane", discoverySrc.includes("lumaFetchQueue"));
assert("Luma API honors Retry-After", discoverySrc.includes('headers?.get?.("retry-after")'));
assert("Persistent discovery 429 stops safely", bgSrc.includes("stats.rateLimitStopped"));
assert("Registration page detects visible 429", contentSrc.includes("function isRateLimitPage"));
assert("Source scan reports visible 429", contentSrc.includes("rateLimited: true"));
assert("Event navigation has a rate-limit cooldown", bgSrc.includes("PAGE_RATE_LIMIT_COOLDOWN_MS"));
assert("Unverified scrape never enters registration queue", !discoverySrc.includes("fallbackScrapedEvent"));
assert("Calendar lookup kinds are rejected", discoverySrc.includes('status: "not_event"'));
assert("Opening CTA bypasses pre-modal form scope", contentSrc.includes('{ checkFormScope: false }'));
assert(
  "Visual click preserves pre-modal form-scope override",
  visualSrc.includes("opts.checkFormScope !== false")
);
const actionMatchSource = contentSrc.slice(
  contentSrc.indexOf("function actionLabelMatches"),
  contentSrc.indexOf("function findClickable", contentSrc.indexOf("function actionLabelMatches"))
);
const actionLabelMatches = new Function(`${actionMatchSource}\nreturn actionLabelMatches;`)();
assert("Request-to-join CTA matches exactly", actionLabelMatches("request to join", "request to join"));
assert("Generic submit does not match Submit Event", !actionLabelMatches("submit event", "submit"));
assert("Profile exposes work email", popupHtml.includes('id="workEmail"'));
assert("History excludes only handled events", bgSrc.includes("buildHistoryExcludeIds"));
assert("Run skips align with discovery history", bgSrc.includes("shouldExcludeFromDiscoveryHistory"));
assert("Feed scan scrolls to load events", contentSrc.includes("scanDiscoverPageFeedWithScroll"));
assert("Feed scan accepts relative Luma links", contentSrc.includes('querySelectorAll("a[href]")'));
assert("Registration pipeline logs steps", contentSrc.includes("sendRunLog"));
assert("Submit blocked while dropdown open", contentSrc.includes("isDropdownOverlayOpen"));
assert("Panel activity log UI", popupHtml.includes("runLogList"));
assert("Run log handler in background", bgSrc.includes('message.type === "RUN_LOG"'));
assert("Copy logs handler", bgSrc.includes('message.type === "COPY_RUN_LOGS"'));
assert("Unsafe click guard", fiSrc.includes("isUnsafeClickTarget"));
assert("No form/dropdown recursion", (() => {
  const formOpenBody = fiSrc.slice(fiSrc.indexOf("function isRegistrationFormOpen"), fiSrc.indexOf("function hasUnfilledFormFields"));
  return !formOpenBody.includes("getOpenDropdownTriggers(") && !formOpenBody.includes("isUnsafeClickTarget(");
})());
assert("Registration modal scoping", fiSrc.includes("getRegistrationModalRoot"));
assert("Payment scan uses panel root", fiSrc.includes("getPaymentScanRoot"));
assert("API free trust signal", fiSrc.includes("isPaidEventPageWithTrust"));
assert("Form agent pipeline", fs.readFileSync(path.join(__dirname, "../lib/form-agent.js"), "utf8").includes("runFormAgent"));
assert("Form scanner pipeline", fs.readFileSync(path.join(__dirname, "../lib/form-scanner.js"), "utf8").includes("scanRegistrationFields"));
assert("Ticket before payment check", contentSrc.indexOf("selectTicketType") < contentSrc.indexOf("Checking payment required"));
assert("Discovery flags passed to content", bgSrc.includes("isFree: event.isFree"));
assert("Registration panel for ticket step", fiSrc.includes("getRegistrationPanelRoot"));
assert("Ticket step uses panel not modal-only root", contentSrc.includes("getRegistrationPanelRoot()"));
assert("Error logs include phase", contentSrc.includes("phase=${runPhase}"));
assert("Profile-based category prefs", fiSrc.includes("profileCategoryPrefs"));
assert("Multi-select option picker", fiSrc.includes("pickMultipleSelectOptions"));
assert("Field-scoped dropdown options", fiSrc.includes("collectFieldScopedOptions"));
assert("Dropdown activator resolution", fiSrc.includes("resolveDropdownActivator"));
assert("Snapshot diff option discovery", fiSrc.includes("collectOptionsFromSnapshotDiff"));
assert("Sequential multi-select fill", fs.readFileSync(path.join(__dirname, "../lib/form-agent.js"), "utf8").includes("fillMultiSelectSequential"));
assert("Multi-select reopens dropdown", fs.readFileSync(path.join(__dirname, "../lib/form-agent.js"), "utf8").includes("Re-opening dropdown for next option"));
assert("Pointer click for React dropdowns", fiSrc.includes("simulatePointerClick"));
assert(
  "Registration actions keep navigation safety checks",
  contentSrc.includes("isUnsafeClickTarget(el, { checkFormScope })")
);
assert("Content script avoids session storage", !contentSrc.includes("storage.session"));
assert("Visual cursor avoids session storage", !visualSrc.includes("storage.session"));
assert("Run control mirrored for content scripts", bgSrc.includes("mirrorRunControlToLocal"));
assert(
  "Session storage opened for content scripts",
  fs.readFileSync(path.join(__dirname, "../lib/run-control-mirror.js"), "utf8").includes("TRUSTED_AND_UNTRUSTED_CONTEXTS")
);
assert("Run control content helper in manifest", manifestSrc.includes("run-control-content.js"));
if (devReload.includes("DEV_RELOAD = true")) {
  warn("dev-reload.js has DEV_RELOAD=true (disable for production)");
}
assert("Checkbox consent handler", contentSrc.includes("fillConsentCheckboxes"));
assert("Virtual skip on registration page", contentSrc.includes("skipped_virtual"));
assert("Offscreen bundle exists", fs.existsSync(path.join(__dirname, "../offscreen/offscreen.bundle.js")));
assert("Manifest has offscreen permission", manifestSrc.includes('"offscreen"'));

// ── Known gaps (documented, not failures) ──
console.log("\nKnown gaps (documented)");
warn("Checkbox/TOS — fillConsentCheckboxes added; CAPTCHA still manual");
warn("CAPTCHA — no automated handling");
warn("MV3 service worker may sleep during long discovery");
warn("LLM first answer may take up to 120s on cold start");

console.log(`\n=== Results: ${passed} passed, ${failed} failed, ${warnings.length} warnings ===`);
if (failures.length) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log(`  - ${f}`));
}
process.exit(failed > 0 ? 1 : 0);
