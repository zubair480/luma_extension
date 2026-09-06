/**
 * Cerebral Valley API discovery — parsing, pagination, fallback signalling, and a live smoke check.
 * Run: npm run test:cv-api
 */
import {
  buildCvApiUrl,
  parseCvApiEvents,
  discoverCerebralValleyViaApi,
  lumaSlugFromUrl,
  classifyCvEventUrl,
} from "../lib/cv-api-discovery.js";

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
function warn(name) {
  console.log(`  ⚠ ${name}`);
}

const sample = (n, offset = 0) => ({
  detail: "ok",
  totalCount: 120,
  limit: n,
  offset,
  events: Array.from({ length: n }, (_, i) => {
    const k = offset + i;
    const platforms = [
      `https://luma.com/ev-${k}`,
      `https://lu.ma/ev-${k}`,
      "https://cerebralvalley.ai/e/cv-hosted",
      "https://www.meetup.com/x/events/1",
      "https://www.eventbrite.com/e/abc-123",
    ];
    return { name: `Event ${k}`, url: platforms[k % platforms.length], startDateTime: "2026-09-08 16:00:00", timeZone: "America/Los_Angeles" };
  }),
});

console.log("\nURL building");
const url = buildCvApiUrl({ offset: 50, limit: 50, startDateTime: "2026-09-06T07:00:00.000Z" });
assert("hits the public pull endpoint", url.startsWith("https://api.cerebralvalley.ai/v1/public/event/pull?"));
assert("carries Bay Area, approval, paging and date", /approved=true/.test(url) && /locations=BAY_AREA/.test(url) && /limit=50/.test(url) && /offset=50/.test(url) && /startDateTime=2026-09-06/.test(url));

console.log("\nLink classification");
assert("luma.com single-segment is a Luma slug", lumaSlugFromUrl("https://luma.com/40ivcqxg?utm_source=cv") === "40ivcqxg");
assert("lu.ma is canonicalized", lumaSlugFromUrl("https://lu.ma/builders-night") === "builders-night");
assert("Luma calendar / user routes are rejected", lumaSlugFromUrl("https://luma.com/usr-abc") === null && lumaSlugFromUrl("https://luma.com/sf") === null);
assert("nested Luma paths are rejected", lumaSlugFromUrl("https://luma.com/a/b") === null);
assert("meetup classified", classifyCvEventUrl("https://www.meetup.com/x/events/1") === "meetup");
assert("cv-hosted classified", classifyCvEventUrl("https://cerebralvalley.ai/e/openai-gpt-6-astra-sf") === "cv");

console.log("\nPage parsing");
const parsed = parseCvApiEvents(sample(10));
assert("only Luma events are returned", parsed.events.length === 4 && parsed.events.every((e) => e.url.startsWith("https://luma.com/")));
assert("every platform is counted", parsed.counts.luma === 4 && parsed.counts.cv === 2 && parsed.counts.meetup === 2 && parsed.counts.eventbrite === 2);
assert("titles and start times carried", parsed.events[0].title === "Event 0" && parsed.events[0].startAt === "2026-09-08 16:00:00");
assert("total comes from totalCount", parsed.total === 120);
assert("malformed payload yields nothing", parseCvApiEvents({ nope: true }).events.length === 0);

console.log("\nPagination");
const calls = [];
const fetchImpl = async (u) => {
  calls.push(u);
  const offset = Number(new URL(u).searchParams.get("offset"));
  const limit = Number(new URL(u).searchParams.get("limit"));
  const remaining = Math.max(0, 120 - offset);
  return { ok: true, status: 200, json: async () => sample(Math.min(limit, remaining), offset) };
};
const result = await discoverCerebralValleyViaApi({ fetchImpl, maxEvents: 100, pageSize: 50 });
assert("pages until the total is exhausted", result.ok && calls.length === 3);
assert("dedupes and collects Luma events across pages", result.events.length === 48 && new Set(result.events.map((e) => e.slug)).size === 48);
assert("counts accumulate across pages", result.counts.luma === 48 && result.counts.cv === 24);

const early = await discoverCerebralValleyViaApi({ fetchImpl, maxEvents: 10, pageSize: 50 });
assert("stops once enough Luma events are in hand", early.ok && early.events.length === 10);

const short = await discoverCerebralValleyViaApi({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => sample(7) }), pageSize: 50 });
assert("a short page ends pagination", short.ok && short.pages === 1);

console.log("\nFallback signalling");
const bad = await discoverCerebralValleyViaApi({ fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
assert("HTTP error reports ok:false with the status", bad.ok === false && /503/.test(bad.error));
const thrown = await discoverCerebralValleyViaApi({ fetchImpl: async () => { throw new Error("offline"); } });
assert("network error reports ok:false and never throws", thrown.ok === false && thrown.error === "offline");
const notJson = await discoverCerebralValleyViaApi({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } }) });
assert("bad JSON reports ok:false", notJson.ok === false);

console.log("\nLive smoke check");
try {
  const live = await discoverCerebralValleyViaApi({ maxEvents: 30, pageSize: 20, maxPages: 2 });
  if (live.ok) {
    assert("live API answers with events", live.total > 0);
    assert("live payload contains Luma-hosted events", live.events.length > 0);
    assert("live Luma links are canonical", live.events.every((e) => /^https:\/\/luma\.com\/[\w-]+$/.test(e.url)));
    console.log(`    ${live.events.length} Luma events of ${live.total} listed (${live.pages} page(s)); counts: ${JSON.stringify(live.counts)}`);
  } else {
    warn(`live API unavailable (${live.error}) — tab fallback would be used`);
  }
} catch (err) {
  warn(`live check skipped: ${err.message}`);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed ? 1 : 0);
