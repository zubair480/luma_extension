import {
  discoverScrapedEventsWithStats,
  normalizeScrapedEventLinks,
} from "../lib/discovery.js";

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

console.log("=== Multi-source discovery tests ===\n");

const events = normalizeScrapedEventLinks([
  { url: "https://luma.com/ai-builders?tk=abc", title: "AI Builders", source: "luma-sf" },
  { url: "https://lu.ma/ai-builders", title: "Duplicate title", source: "bond-ai" },
  { url: "https://luma.com/founder-night", title: "Founder Night", source: "bond-ai" },
  { url: "https://luma.com/founder-night?from=cv", source: "cerebral-valley" },
  { url: "https://meetup.com/not-luma", title: "Meetup", source: "cerebral-valley" },
  { url: "https://luma.com/sf", title: "Not an event", source: "luma-sf" },
  { url: "https://luma.com/calendar/nested", title: "Nested", source: "luma-sf" },
]);

assert("De-duplicates the same Luma event across source pages", events.length === 2);
assert("Canonicalizes lu.ma links to luma.com", events[0]?.url === "https://luma.com/ai-builders");
assert("Keeps first-source page order", events[0]?.slug === "ai-builders");
assert("Tracks every source containing a duplicate", events[0]?.sources.join(",") === "luma-sf,bond-ai");
assert("Retains Cerebral Valley only when its outbound URL is Luma", events[1]?.sources.includes("cerebral-valley"));
assert("Rejects non-event Luma paths", !events.some((event) => event.slug === "sf"));
assert("Rejects non-Luma URLs", !events.some((event) => event.slug === "not-luma"));

const originalFetch = globalThis.fetch;
const fetchCounts = new Map();
const lookupTimes = [];
globalThis.fetch = async (url) => {
  const slug = new URL(url).searchParams.get("url");
  lookupTimes.push(Date.now());
  fetchCounts.set(slug, (fetchCounts.get(slug) || 0) + 1);
  if (slug === "genai-sf") {
    return { ok: true, json: async () => ({ kind: "calendar", data: {} }) };
  }
  if (slug === "lookup-down") {
    return { ok: false, status: 503 };
  }
  if (slug === "rate-limited-event" && fetchCounts.get(slug) === 1) {
    return {
      ok: false,
      status: 429,
      headers: { get: (name) => (name.toLowerCase() === "retry-after" ? "0.01" : null) },
    };
  }
  if (slug === "persistent-rate-limit") {
    return {
      ok: false,
      status: 429,
      headers: { get: (name) => (name.toLowerCase() === "retry-after" ? "0.01" : null) },
    };
  }
  return {
    ok: true,
    json: async () => ({
      kind: "event",
      data: {
        event: {
          api_id: `evt-${slug}`,
          url: slug,
          name: "Verified AI Event",
          start_at: "2026-08-01T18:00:00.000Z",
          geo_address_info: {
            city: "San Francisco",
            region: "California",
            address: "Market Street",
          },
        },
        ticket_info: { is_free: true, is_sold_out: false, require_approval: false },
        registration_availability: "open",
        waitlist_active: false,
        calendar: { name: "Test Calendar" },
      },
    }),
  };
};

try {
  const verified = await discoverScrapedEventsWithStats(
    [
      { url: "https://luma.com/verified-event", source: "luma-sf" },
      { url: "https://luma.com/genai-sf", source: "bond-ai" },
      { url: "https://luma.com/lookup-down", source: "cerebral-valley" },
      { url: "https://luma.com/rate-limited-event", source: "luma-sf" },
    ],
    25,
    new Set()
  );
  assert("Only positively verified events enter the queue", verified.events.length === 2);
  assert("Calendar pages are rejected by Luma kind", verified.stats.rejectedNonEvents === 1);
  assert("Lookup failures are not converted into fake events", verified.stats.lookupFailed === 1);
  assert("429 response is delayed and retried", verified.stats.rateLimitRetries === 1);
  assert("Recovered 429 does not trip the circuit breaker", verified.stats.rateLimitStopped === false);
  assert(
    "Luma lookups are serialized with a safe minimum gap",
    lookupTimes.slice(1).every((time, index) => time - lookupTimes[index] >= 1000)
  );

  const limited = await discoverScrapedEventsWithStats(
    [{ url: "https://luma.com/persistent-rate-limit", source: "luma-sf" }],
    25,
    new Set()
  );
  assert("Persistent 429 trips the discovery circuit breaker", limited.stats.rateLimitStopped);
  assert("Persistent 429 never enters the event queue", limited.events.length === 0);
  assert("Persistent 429 is attempted only once after cooldown", fetchCounts.get("persistent-rate-limit") === 2);
} finally {
  globalThis.fetch = originalFetch;
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed ? 1 : 0);
