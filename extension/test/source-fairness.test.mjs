/**
 * Four-source fairness regression.
 *
 * Sources contribute wildly different numbers of links — the Founders Club newsletter alone lists
 * ~60 events per week, against a handful from Cerebral Valley. Discovery must still verify and
 * select across every source rather than exhausting the first one it was handed.
 */
import { discoverScrapedEventsWithStats } from "../lib/discovery.js";

let passed = 0;
let failed = 0;
const assert = (name, condition) => {
  console.log(`  ${condition ? "✓" : "✗"} ${name}`);
  condition ? passed++ : failed++;
};

const SOURCES = {
  "luma-sf": 30,
  "bond-ai": 3,
  "cerebral-valley": 3,
  "founders-club": 40,
};

// Concatenated per source, exactly as background.js accumulates scan results.
const records = [];
for (const [source, count] of Object.entries(SOURCES)) {
  for (let i = 0; i < count; i++) {
    records.push({ url: `https://luma.com/${source}-${i}`, source });
  }
}

const originalFetch = globalThis.fetch;
let lookups = 0;
globalThis.fetch = async (url) => {
  const slug = new URL(url).searchParams.get("url");
  lookups++;
  return {
    ok: true,
    json: async () => ({
      kind: "event",
      data: {
        event: {
          api_id: `evt-${slug}`,
          url: slug,
          name: "AI Builders Meetup",
          start_at: "2026-09-01T18:00:00.000Z",
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

console.log("=== Four-source fairness ===\n");

try {
  const maxResults = 8;
  const result = await discoverScrapedEventsWithStats(records, maxResults, new Set());
  const sourcesInResult = new Set(result.events.map((event) => event.source));
  console.log(
    `  → ${records.length} links in · ${lookups} verified · ${result.events.length} selected ` +
      `(${[...sourcesInResult].sort().join(", ")})\n`
  );

  assert("Selection is capped at maxResults", result.events.length <= maxResults);
  assert("Selection is not empty", result.events.length > 0);
  assert(
    "Every configured source appears in the selection",
    Object.keys(SOURCES).every((source) => sourcesInResult.has(source))
  );
  assert(
    "The largest source does not monopolise the selection",
    result.events.filter((event) => event.source === "founders-club").length <= Math.ceil(maxResults / 2)
  );
  assert(
    "A small source is not starved by a large one",
    result.events.some((event) => event.source === "cerebral-valley")
  );
  assert("Verification stops early rather than hydrating every link", lookups < records.length);
  assert("Stats count every scraped link", result.stats.totalScraped === records.length);
  assert("Every selected event carries its source", result.events.every((event) => event.source));
  assert("Selected events keep a canonical Luma URL", result.events.every((event) => event.url.startsWith("https://luma.com/")));
  assert("Interleaved ranking positions are unique", new Set(result.events.map((e) => e.sourceOrder)).size === result.events.length);
  assert(
    "No source is represented by a single token event",
    Object.keys(SOURCES).every(
      (source) => result.events.filter((event) => event.source === source).length >= 2
    )
  );
} finally {
  globalThis.fetch = originalFetch;
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exitCode = failed ? 1 : 0;
