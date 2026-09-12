/**
 * Field classification regression tests — the cases behind "wrong value in the wrong field".
 * Run: npm run test:fields
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  discoverScrapedEventsWithStats,
  createStreamingVerifier,
  compareEligibleEvents,
  isPastEvent,
} from "../lib/discovery.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
function assert(name, condition) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}`);
    failed++;
  }
}

function loadFormIntelligence() {
  const src = fs.readFileSync(path.join(__dirname, "../lib/form-intelligence.js"), "utf8");
  const sandbox = {
    document: { body: { innerText: "" }, querySelector: () => null, querySelectorAll: () => [], title: "" },
    window: {},
  };
  sandbox.window = sandbox;
  const fn = new Function(
    "document",
    "window",
    src +
      "\nreturn { classifyQuestion, answerForQuestion, classifyByInputAttributes, isCustomSelectInput, valueFitsInput, labelSimilarity, cleanLabel, isAboutOthers, applyEventPersona };"
  );
  return fn(sandbox.document, sandbox.window);
}

/** Minimal element stand-in: attributes, tag, readOnly, closest(selector) via a flag. */
function el(attrs = {}, { tag = "INPUT", readOnly = false, insideCombobox = false } = {}) {
  return {
    tagName: tag,
    readOnly,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    closest: () => (insideCombobox ? {} : null),
  };
}

const fi = loadFormIntelligence();
const profile = {
  first_name: "Ada",
  last_name: "Lovelace",
  email: "ada@example.com",
  phone: "4155550123",
  job_title: "Software Engineer",
  company: "Analytical Engines",
  linkedin: "https://www.linkedin.com/in/ada",
  location: "San Francisco, CA",
  default_answers: {
    Company: "Analytical Engines",
    "What brings you to this event?": "Curious about difference engines.",
    "Tell us about yourself": "I write programs for machines that do not exist yet.",
  },
};

console.log("\nLabel classification (word boundaries)");
assert("'Tell us about yourself' is not a phone field", fi.classifyQuestion("Tell us about yourself") !== "phone");
assert("'Hotel name' is not a phone field", fi.classifyQuestion("Hotel name") !== "phone");
assert("'Intel or AMD?' is not a phone field", fi.classifyQuestion("Intel or AMD?") !== "phone");
assert("'Phone number' is a phone field", fi.classifyQuestion("Phone number") === "phone");
assert("'Mobile' is a phone field", fi.classifyQuestion("Mobile") === "phone");
assert("'WhatsApp number' is a phone field", fi.classifyQuestion("WhatsApp number") === "phone");
assert("'Velocity of your startup' is not a location", fi.classifyQuestion("Velocity of your startup") !== "location");
assert("'Which city are you based in?' is a location", fi.classifyQuestion("Which city are you based in?") === "location");
assert("'Anywhere else you want to go?' is not motivation", fi.classifyQuestion("Anywhere else you want to go?") !== "motivation");
assert("'Why do you want to attend?' is motivation", fi.classifyQuestion("Why do you want to attend?") === "motivation");

console.log("\nQuestions about other people (live Luma forms)");
assert("'Who else should we invite? Share the email / LinkedIn' is free text", fi.classifyQuestion("Who else in your network should we invite? Please share the email / LinkedIn with us.") === "custom");
assert("'Are you with a team? List their names/Luma emails' is free text", fi.classifyQuestion("Are you with a team? If so, please list their names/Luma emails") === "custom");
assert("'What's your work email?' is still an email field", fi.classifyQuestion("What’s your work email?") === "work_email");
assert("'What is your LinkedIn profile?' is still linkedin", fi.classifyQuestion("What is your LinkedIn profile?") === "linkedin");
assert("isAboutOthers flags 'their'", fi.isAboutOthers("please list their names"));
assert("isAboutOthers does not flag a plain question", !fi.isAboutOthers("What is your GitHub?"));

console.log("\nInvitation form (luma.com/baomaxxing)");
const inviteProfile = { ...profile, job_title: "Founding Software Engineer", company: "Andever", default_answers: {} };
assert("'current role or title' comes from the profile", fi.answerForQuestion("What is your current role or title?", inviteProfile) === "Founding Software Engineer");
assert("'current title/role' too", fi.classifyQuestion("What's your current title/role?") === "job_title");
assert("'company or organization you currently work with' is company", fi.answerForQuestion("What company or organization do you currently work with?", inviteProfile) === "Andever");
assert("'most hoping to find at the event' is motivation (AI with profile context)", fi.classifyQuestion("What are you most hoping to find at the event?") === "motivation");
assert("'what are you building… right now' has no canned hackathon answer", fi.answerForQuestion("What are you building, operating, researching, or exploring right now?", inviteProfile) === null);
assert("'how do you share context with AI' is free text for the AI", fi.classifyQuestion("How do you share context with AI & your team today?") === "custom");
assert("'X (Twitter) handle' returns the @handle", fi.answerForQuestion("What is your X (Twitter) handle?", { ...inviteProfile, twitter_handle: "ada_probe" }) === "@ada_probe");
assert("founder-flavoured page keeps the real title without an explicit persona", fi.applyEventPersona(inviteProfile, "Founders & investors night", "startup pitch").job_title === "Founding Software Engineer");

console.log("\nLabel cleaning");
assert("zero-width spaces are stripped", fi.cleanLabel("Email​ *") === "Email");
assert("word joiner and BOM are stripped", fi.cleanLabel("﻿Name⁠") === "Name");

console.log("\nAttribute classification");
assert("type=tel → phone", fi.classifyByInputAttributes(el({ type: "tel" })) === "phone");
assert("autocomplete=email → email", fi.classifyByInputAttributes(el({ type: "text", autocomplete: "email" })) === "email");
assert("autocomplete=given-name → first_name", fi.classifyByInputAttributes(el({ autocomplete: "given-name" })) === "first_name");
assert("autocomplete=organization → company", fi.classifyByInputAttributes(el({ autocomplete: "organization" })) === "company");
assert("type=url with linkedin name → linkedin", fi.classifyByInputAttributes(el({ type: "url", name: "linkedin_url" })) === "linkedin");
assert("type=url labelled GitHub → github, not website", fi.classifyByInputAttributes(el({ type: "url", name: "registration_answers.1.value" }), "What's your GitHub?") === "github");
assert("type=url labelled 'link to a project' → website", fi.classifyByInputAttributes(el({ type: "url" }), "Please link to a project you've built") === "website");
assert("plain text input → null", fi.classifyByInputAttributes(el({ type: "text" })) === null);

console.log("\nCustom select inputs are not text fields");
assert("readonly input is a custom select", fi.isCustomSelectInput(el({}, { readOnly: true })));
assert("role=combobox input is a custom select", fi.isCustomSelectInput(el({ role: "combobox" })));
assert("aria-autocomplete input is a custom select", fi.isCustomSelectInput(el({ "aria-autocomplete": "list" })));
assert("search box inside a combobox is a custom select", fi.isCustomSelectInput(el({ type: "search" }, { insideCombobox: true })));
assert("ordinary text input is not", !fi.isCustomSelectInput(el({ type: "text" })));
assert("a select element is not treated as an input", !fi.isCustomSelectInput(el({}, { tag: "SELECT" })));

console.log("\nValue fit");
assert("phone fits type=tel", fi.valueFitsInput(el({ type: "tel" }), "4155550123"));
assert("name does not fit type=tel", !fi.valueFitsInput(el({ type: "tel" }), "Ada Lovelace"));
assert("email fits type=email", fi.valueFitsInput(el({ type: "email" }), "ada@example.com"));
assert("phone does not fit type=email", !fi.valueFitsInput(el({ type: "email" }), "4155550123"));
assert("phone does not fit an unlabelled textarea", !fi.valueFitsInput(el({}, { tag: "TEXTAREA" }), "4155550123"));
assert("phone fits a text input whose name says phone", fi.valueFitsInput(el({ type: "text", name: "phone" }), "4155550123"));
assert("prose fits a textarea", fi.valueFitsInput(el({}, { tag: "TEXTAREA" }), "I build things."));
assert("maxlength is respected", !fi.valueFitsInput(el({ maxlength: "5" }), "too long value"));

console.log("\nAnswers");
assert("forced phone type returns the profile phone", fi.answerForQuestion("Contact", profile, "phone") === "4155550123");
assert("forced email ignores saved free-text answers", fi.answerForQuestion("Tell us about yourself", profile, "email") === "ada@example.com");
assert("'Company website' does not reuse the saved 'Company' answer", fi.answerForQuestion("Company website", profile) !== "Analytical Engines");
assert("exact saved key still matches", fi.answerForQuestion("Company", profile) === "Analytical Engines");
assert("near-identical wording still matches a saved question", fi.answerForQuestion("What brings you to this event", profile) === "Curious about difference engines.");
assert("'Tell us about yourself' returns the saved bio, not a phone", fi.answerForQuestion("Tell us about yourself", profile) === "I write programs for machines that do not exist yet.");
assert("similarity: unrelated labels score low", fi.labelSimilarity("Dietary restrictions", "What brings you to this event?") < 0.3);

console.log("\nStreaming verification hooks");
const realFetch = globalThis.fetch;
const nowIso = new Date(Date.now() + 86400000).toISOString();
globalThis.fetch = async (url) => {
  const slug = decodeURIComponent(String(url).split("url=")[1] || "");
  const free = !slug.includes("paid");
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({
      kind: "event",
      data: {
        event: { url: slug, api_id: `id-${slug}`, name: `Event ${slug}`, start_at: nowIso, geo_address_info: { city: "San Francisco", address: "1 Market St" } },
        ticket_info: { is_free: free, is_sold_out: false, require_approval: false },
        calendar: { name: "Host" },
        registration_availability: "open",
        waitlist_active: false,
      },
    }),
  };
};
const seen = [];
const progress = [];
const records = ["a-ai-meetup", "b-paid-gala", "c-tech-talk"].map((slug) => ({ url: `https://luma.com/${slug}`, source: "test" }));
const result = await discoverScrapedEventsWithStats(records, 10, new Set(), {
  onEvent: (e) => seen.push(e.slug),
  onProgress: async (p) => progress.push(p),
});
assert("onEvent receives only registerable events", seen.length === 2 && !seen.includes("b-paid-gala"));

// Known skips never cost a lookup
let lookups = 0;
const countingFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  lookups++;
  return countingFetch(url);
};
const skipResult = await discoverScrapedEventsWithStats(
  [...records, { url: "https://luma.com/d-done-before", source: "test" }],
  10,
  new Set(["slug:d-done-before"])
);
assert("history-excluded slug is not looked up", lookups === 3 && skipResult.stats.skippedKnown === 1);

lookups = 0;
const streaming = createStreamingVerifier({ maxResults: 10 });
streaming.push([{ url: "https://luma.com/e-going", source: "sf" }, { url: "https://luma.com/f-new", source: "sf" }]);
streaming.markSkipped(["slug:e-going"]);
streaming.finish();
const streamed = await streaming.done;
assert("feed-marked slug pushed before the skip is still dropped", lookups === 1 && streamed.stats.skippedKnown === 1);
assert("the remaining link is verified", streamed.events.length === 1 && streamed.events[0].slug === "f-new");

// Feed-page entries verify without a request
lookups = 0;
const pageEntry = {
  api_id: "id-g-page",
  event: { url: "g-page-event", api_id: "id-g-page", name: "Page Event", start_at: nowIso, geo_address_info: { city: "San Francisco", address: "2 Market St" } },
  ticket_info: { is_free: true, is_sold_out: false, require_approval: false },
  calendar: { name: "Host" },
  registration_availability: "open",
  waitlist_active: false,
};
const paidPageEntry = {
  ...pageEntry,
  api_id: "id-h-page",
  event: { ...pageEntry.event, url: "h-page-paid", api_id: "id-h-page", name: "Paid Page Event" },
  ticket_info: { is_free: false, is_sold_out: false, require_approval: false },
};
const pageVerifier = createStreamingVerifier({ maxResults: 10 });
pageVerifier.push([
  { url: "https://luma.com/g-page-event", source: "sf", entry: pageEntry },
  { url: "https://luma.com/h-page-paid", source: "sf", entry: paidPageEntry },
  { url: "https://luma.com/g-page-event", source: "sf" }, // scraped duplicate of the page entry
  { url: "https://luma.com/i-scraped", source: "sf" },
]);
pageVerifier.finish();
const pageResult = await pageVerifier.done;
assert("page entries cost no lookup; only the scraped link does", lookups === 1 && pageResult.stats.verifiedFromPage === 2);
assert("page entry is registerable straight from page data", pageResult.events.some((e) => e.slug === "g-page-event"));
assert("paid page entry is rejected without a request", !pageResult.events.some((e) => e.slug === "h-page-paid"));
assert("duplicate scraped link does not re-verify the page entry", pageResult.stats.totalScraped === 3);

console.log("\nOnly today's and upcoming events");
const H = 3600000;
const todayNoon = new Date();
todayNoon.setHours(12, 0, 0, 0);
const now = todayNoon.getTime();
assert("ended yesterday is past", isPastEvent({ start_at: new Date(now - 30 * H).toISOString(), end_at: new Date(now - 26 * H).toISOString() }, now));
assert("ended an hour ago today is past", isPastEvent({ start_at: new Date(now - 3 * H).toISOString(), end_at: new Date(now - 1 * H).toISOString() }, now));
assert("started this morning, ends tonight is not past", !isPastEvent({ start_at: new Date(now - 3 * H).toISOString(), end_at: new Date(now + 6 * H).toISOString() }, now));
assert("no end time, started earlier today is not past", !isPastEvent({ start_at: new Date(now - 3 * H).toISOString() }, now));
assert("no end time, started yesterday is past", isPastEvent({ start_at: new Date(now - 30 * H).toISOString() }, now));
assert("tomorrow is not past", !isPastEvent({ start_at: new Date(now + 24 * H).toISOString() }, now));
assert("parsed shape (startAt/endAt) is understood", isPastEvent({ startAt: new Date(now - 48 * H).toISOString(), endAt: new Date(now - 40 * H).toISOString() }, now));
assert("missing dates are not treated as past", !isPastEvent({}, now));

const pastEntry = {
  ...pageEntry,
  api_id: "id-p-past",
  event: { ...pageEntry.event, url: "p-past-event", api_id: "id-p-past", name: "Past Event", start_at: new Date(Date.now() - 3 * 86400000).toISOString(), end_at: new Date(Date.now() - 3 * 86400000 + 2 * H).toISOString() },
};
const dateVerifier = createStreamingVerifier({ maxResults: 10 });
dateVerifier.push([
  { url: "https://luma.com/p-past-event", source: "sf", entry: pastEntry },
  { url: "https://luma.com/g-page-event", source: "sf", entry: pageEntry },
]);
dateVerifier.finish();
const dateResult = await dateVerifier.done;
assert("a past event never reaches the queue", !dateResult.events.some((e) => e.slug === "p-past-event") && dateResult.stats.rejectedPast === 0 && dateResult.stats.rejectedIneligible === 1);
assert("the upcoming event still does", dateResult.events.some((e) => e.slug === "g-page-event"));

// A cached verdict that has aged into the past is dropped at verification time.
const staleOk = createStreamingVerifier({ maxResults: 10 });
const agedEvent = { id: "aged", slug: "aged-event", url: "https://luma.com/aged-event", startAt: new Date(Date.now() - 2 * 86400000).toISOString(), endAt: new Date(Date.now() - 86400000).toISOString(), registrationAvailability: "open", isFree: true, city: "San Francisco", title: "Aged" };
assert("isRegisterable rejects an aged parsed event", !(await import("../lib/discovery.js")).isRegisterable(agedEvent));
staleOk.finish();
await staleOk.done;
globalThis.fetch = realFetch;
assert("onEvent order matches the returned list", JSON.stringify(seen) === JSON.stringify(result.events.map((e) => e.slug)));
assert("onProgress fires once per lookup", progress.length === 3 && progress[2].verified === 3 && progress[2].total === 3);
assert("onProgress reports ready count", progress[2].ready === 2);
assert("return value still lists the events", result.events.length === 2 && result.stats.hydrated === 3);
assert("comparator ranks relevant events first", compareEligibleEvents({ relevanceScore: 30, sourceOrder: 5 }, { relevanceScore: 0, sourceOrder: 0 }) < 0);
assert("comparator falls back to source order", compareEligibleEvents({ relevanceScore: 0, sourceOrder: 2 }, { relevanceScore: 0, sourceOrder: 1 }) > 0);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed ? 1 : 0);
