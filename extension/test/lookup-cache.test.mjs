/**
 * Verified-lookup cache tests.
 *
 * Discovery verifies every scraped link against the Luma API one at a time behind a 1.2s gap, so
 * the cache is the difference between a minute of waiting and none. These run against a fake
 * chrome.storage so the cache path is exercised the way it is in the extension, and measure the
 * wall-clock saving directly.
 *
 * Run: node test/lookup-cache.test.mjs
 */
let passed = 0;
let failed = 0;
const assert = (name, condition) => {
  console.log(`  ${condition ? "✓" : "✗"} ${name}`);
  condition ? passed++ : failed++;
};

// Installed before importing discovery.js so the module sees a storage-capable environment.
const store = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (key) => (key in store ? { [key]: store[key] } : {}),
      set: async (obj) => Object.assign(store, obj),
    },
  },
};

const { discoverScrapedEventsWithStats } = await import("../lib/discovery.js");

let fetchCount = 0;
globalThis.fetch = async (url) => {
  const slug = new URL(url).searchParams.get("url");
  fetchCount++;
  if (slug.startsWith("broken")) return { ok: false, status: 503 };
  if (slug.startsWith("calendar")) return { ok: true, json: async () => ({ kind: "calendar", data: {} }) };
  return {
    ok: true,
    json: async () => ({
      kind: "event",
      data: {
        event: {
          api_id: `evt-${slug}`,
          url: slug,
          name: "AI Builders Meetup",
          start_at: new Date(Date.now() + 7 * 86400000).toISOString(),
          geo_address_info: { city: "San Francisco", region: "California", address: "Market St" },
        },
        ticket_info: { is_free: true, is_sold_out: false, require_approval: false },
        registration_availability: "open",
        waitlist_active: false,
        calendar: { name: "Test Calendar" },
      },
    }),
  };
};

const records = [
  ...Array.from({ length: 6 }, (_, i) => ({ url: `https://luma.com/ev-${i}`, source: "luma-sf" })),
  { url: "https://luma.com/calendar-page", source: "bond-ai" },
  { url: "https://luma.com/broken-lookup", source: "cerebral-valley" },
];

console.log("=== Verified-lookup cache ===\n");

const t0 = Date.now();
const first = await discoverScrapedEventsWithStats(records, 25, new Set());
const coldMs = Date.now() - t0;
const coldFetches = fetchCount;

fetchCount = 0;
const t1 = Date.now();
const second = await discoverScrapedEventsWithStats(records, 25, new Set());
const warmMs = Date.now() - t1;
const warmFetches = fetchCount;

console.log(
  `  → cold: ${coldFetches} requests in ${coldMs}ms · warm: ${warmFetches} requests in ${warmMs}ms\n`
);

assert("Cold run queries the API for every link", coldFetches >= records.length);
assert("Cold run reports no cache hits", (first.stats.cacheHits || 0) === 0);
assert("Warm run finds the same events", second.events.length === first.events.length);
assert("Warm run reports cache hits", second.stats.cacheHits > 0);
assert("Warm run skips most requests", warmFetches < coldFetches);
assert("Warm run is materially faster", warmMs < coldMs / 2);

assert(
  "Settled verdicts are cached",
  Object.keys(store.lumaLookupCache || {}).some((slug) => slug === "ev-0")
);
assert(
  "Calendar pages (not_event) are cached too",
  Boolean(store.lumaLookupCache?.["calendar-page"])
);
assert(
  "Transient failures are never cached",
  !store.lumaLookupCache?.["broken-lookup"]
);
assert("A failed lookup is retried on the warm run", warmFetches >= 1);
assert(
  "Cached entries carry no per-request rate-limit stats",
  Object.values(store.lumaLookupCache || {}).every(
    (entry) => entry.lookup?.rateLimitRetries === undefined
  )
);
assert(
  "Cached entries are timestamped for TTL expiry",
  Object.values(store.lumaLookupCache || {}).every((entry) => typeof entry.savedAt === "number")
);

// Expired entries must not be served.
for (const entry of Object.values(store.lumaLookupCache)) {
  entry.savedAt = Date.now() - 7 * 60 * 60 * 1000;
}
const { loadLookupCache, readLookupCache } = await import("../lib/discovery.js");
await loadLookupCache();
assert("Entries past the TTL are dropped on load", readLookupCache("ev-0") === null);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exitCode = failed ? 1 : 0;
