/**
 * Run: node extension/test/discovery-edge-cases.mjs
 * Validates expanded SF + AI discovery (no Chrome required).
 */
import { discoverEventsWithStats } from "../lib/discovery.js";

const FEED_TOP = [];
let failed = 0;

function assert(name, condition) {
  console.log(condition ? `  PASS  ${name}` : `  FAIL  ${name}`);
  if (!condition) failed++;
  return condition;
}

async function main() {
  console.log("Fetching SF events (expanded discovery)…\n");

  const { events, stats } = await discoverEventsWithStats(25, FEED_TOP, new Set());

  console.log(
    `Stats: ${stats.totalSF} total · ${stats.freeRegisterable} registerable · ${stats.newRegisterable} new · ${stats.aiRegisterable} AI/tech\n`
  );
  console.log(`Top ${events.length} selected:`);
  events.forEach((e, i) => {
    console.log(
      `  ${i + 1}. ${e.title} [${e.slug}] score=${e.relevanceScore} ai=${e.isAi} reg=${e.registrationAvailability}`
    );
  });

  console.log("\nEdge-case checks:");

  const aiCount = events.filter((e) => e.isAi).length;
  const generalCount = events.length - aiCount;

  assert("Discovers more than SF feed page 1 (~40)", stats.totalSF > 40);
  assert("Includes AI/tech events", aiCount > 0);
  // Non-AI events are filler: they are only expected when AI events did not fill the batch.
  assert("Includes non-AI SF events when batch not full of AI", generalCount > 0 || events.length >= 25);
  assert(
    "Every selected item is a hydrated Luma event",
    events.every((event) => event.title && event.slug && event.url?.startsWith("https://luma.com/"))
  );
  const paidOnly = events.filter((e) => !e.isFree && !e.requireApproval && e.registrationAvailability === "open");
  assert("No unpaid-approval paid events in batch", paidOnly.length === 0);

  console.log("\nDone.");
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
