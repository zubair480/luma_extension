/**
 * Durable exclusion index tests.
 *
 * Regression: `history` is capped at 100 entries and used to be the only source of exclusions, so
 * past 100 processed events the oldest verdicts fell off and the agent reopened events it had
 * already ruled out. The index must outlive the display cap.
 *
 * Run: node test/exclude-index.test.mjs
 */
import {
  buildHistoryExcludeIds,
  addToExcludeIndex,
  pruneExcludeIndex,
  excludeIdsFromIndex,
  findExcludeEntry,
  buildExcludeIndexFromHistory,
  EXCLUDE_INDEX_MAX,
  EXCLUDE_INDEX_TTL_MS,
} from "../lib/history.js";

let passed = 0;
let failed = 0;
const assert = (name, condition) => {
  console.log(`  ${condition ? "✓" : "✗"} ${name}`);
  condition ? passed++ : failed++;
};

const entry = (slug, status, extra = {}) => ({
  event: { slug, id: `evt-${slug}`, url: `https://luma.com/${slug}`, title: slug },
  status,
  message: `${status} — skipped`,
  ...extra,
});

console.log("=== Durable exclusion index ===\n");

console.log("Recording verdicts");
{
  const index = {};
  addToExcludeIndex(index, entry("women-thing", "skipped_women_only"));
  addToExcludeIndex(index, entry("over", "event_ended"));
  addToExcludeIndex(index, entry("signed-up", "registered"));
  addToExcludeIndex(index, entry("try-again", "error"));
  addToExcludeIndex(index, entry("paid-one", "skipped_paid"));

  assert("Records a women-only verdict", Boolean(index["women-thing"]));
  assert("Records an ended-event verdict", Boolean(index["over"]));
  assert("Records a successful registration", Boolean(index["signed-up"]));
  assert("Ignores retryable errors", !index["try-again"]);
  assert("Ignores retryable paid skips", !index["paid-one"]);
  assert("Keeps the verdict status", index["over"].status === "event_ended");
  assert("Keeps the message for replay", index["over"].message.includes("event_ended"));
  assert("Stamps each entry for TTL expiry", typeof index["over"].savedAt === "number");
  assert("Entries with no identifier are ignored", (() => {
    const empty = {};
    addToExcludeIndex(empty, { event: {}, status: "event_ended" });
    return Object.keys(empty).length === 0;
  })());
}

console.log("\nThe 100-entry regression");
{
  // Reproduce the real sequence: 150 events processed, the first one ruled out.
  const processed = [];
  const index = {};
  for (let i = 0; i < 150; i++) {
    const e = entry(`event-${i}`, i === 0 ? "skipped_women_only" : "registered");
    processed.unshift(e); // newest first, as appendHistory does
    addToExcludeIndex(index, e);
  }
  const displayHistory = processed.slice(0, 100);
  const oldEvent = { slug: "event-0", id: "evt-event-0", url: "https://luma.com/event-0" };

  assert(
    "The old verdict has fallen out of the capped display history",
    !displayHistory.some((h) => h.event.slug === "event-0")
  );
  assert(
    "…so the old behaviour would have reopened it",
    !buildHistoryExcludeIds(displayHistory).has("event-0")
  );
  assert("The index still holds the verdict", Boolean(index["event-0"]));
  assert("The exclusion id set still contains it", excludeIdsFromIndex(index).has("event-0"));
  assert("A prior verdict is still findable", findExcludeEntry(index, oldEvent)?.status === "skipped_women_only");
  assert("Index size is not capped at 100", Object.keys(index).length === 150);
}

console.log("\nIdentifier matching");
{
  const index = {};
  addToExcludeIndex(index, entry("meetup", "event_cancelled"));
  const ids = excludeIdsFromIndex(index);

  assert("Exposes the bare slug", ids.has("meetup"));
  assert("Exposes the slug: prefixed form", ids.has("slug:meetup"));
  assert("Exposes the API id", ids.has("evt-meetup"));
  assert("Matches by slug", Boolean(findExcludeEntry(index, { slug: "meetup" })));
  assert("Matches by API id alone", Boolean(findExcludeEntry(index, { id: "evt-meetup" })));
  assert("Matches by URL alone", Boolean(findExcludeEntry(index, { url: "https://luma.com/meetup" })));
  assert("Does not match an unrelated event", !findExcludeEntry(index, { slug: "something-else" }));
  assert("Empty index matches nothing", !findExcludeEntry({}, { slug: "meetup" }));
}

console.log("\nPruning");
{
  const now = Date.now();
  const index = {
    fresh: { status: "event_ended", savedAt: now - 1000 },
    stale: { status: "event_ended", savedAt: now - EXCLUDE_INDEX_TTL_MS - 1000 },
  };
  const pruned = pruneExcludeIndex(index, { now });
  assert("Keeps entries inside the TTL", Boolean(pruned.fresh));
  assert("Drops entries past the TTL", !pruned.stale);

  const many = {};
  for (let i = 0; i < EXCLUDE_INDEX_MAX + 50; i++) {
    many[`e-${i}`] = { status: "registered", savedAt: now - (EXCLUDE_INDEX_MAX + 50 - i) * 1000 };
  }
  const capped = pruneExcludeIndex(many, { now });
  assert("Caps the index at its maximum", Object.keys(capped).length === EXCLUDE_INDEX_MAX);
  assert("Keeps the newest entries when capping", Boolean(capped[`e-${EXCLUDE_INDEX_MAX + 49}`]));
  assert("Drops the oldest entries when capping", !capped["e-0"]);
  assert("The cap is far above the display history cap", EXCLUDE_INDEX_MAX > 100);
}

console.log("\nMigration from existing history");
{
  const history = [
    entry("newest", "registered"),
    entry("cancelled-one", "event_cancelled"),
    entry("retryable", "error"),
  ];
  const seeded = buildExcludeIndexFromHistory(history);

  assert("Seeds excludable verdicts from existing history", Boolean(seeded["cancelled-one"]));
  assert("Seeds registrations too", Boolean(seeded["newest"]));
  assert("Does not seed retryable statuses", !seeded["retryable"]);
  assert("An empty history seeds an empty index", Object.keys(buildExcludeIndexFromHistory([])).length === 0);

  // History is stored newest-first; the newest verdict for a slug must win.
  const rewritten = buildExcludeIndexFromHistory([
    entry("same", "event_ended"),
    entry("same", "registered"),
  ]);
  assert("The newest verdict for a slug wins", rewritten["same"].status === "event_ended");
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exitCode = failed ? 1 : 0;
