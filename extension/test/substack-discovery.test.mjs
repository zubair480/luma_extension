/**
 * Bay Area Founders Club (Substack) source tests.
 *
 * Offline checks run against a fixture that mirrors the real feed shape. The live check is
 * skipped automatically when the network is unavailable so the suite stays runnable offline.
 */
import {
  parseFeedItems,
  selectLatestEventsPost,
  extractLumaEvents,
  FOUNDERS_CLUB_FEED_URL,
} from "../lib/substack-discovery.js";

let passed = 0;
let failed = 0;
const assert = (name, condition) => {
  console.log(`  ${condition ? "✓" : "✗"} ${name}`);
  condition ? passed++ : failed++;
};

const FIXTURE = `<?xml version="1.0"?>
<rss xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
<title><![CDATA[Bay Area Founders Club]]></title>
<item>
  <title><![CDATA[Why VCs Say No]]></title>
  <link>https://bayareafoundersclub.substack.com/p/why-vcs-say-no</link>
  <pubDate>Wed, 12 Aug 2026 00:15:24 GMT</pubDate>
  <content:encoded><![CDATA[<p><a href="https://luma.com/promo-post">Our own event</a></p>]]></content:encoded>
</item>
<item>
  <title><![CDATA[Bay Area Events For The Week Of August 24]]></title>
  <link>https://bayareafoundersclub.substack.com/p/bay-area-events-week-august-24</link>
  <pubDate>Sun, 23 Aug 2026 01:00:41 GMT</pubDate>
  <content:encoded><![CDATA[
    <h3>Monday</h3>
    <p><a href="https://luma.com/n9qx3vly">How VCs Really Evaluate AI Startups &#8212; with Ray Wu</a></p>
    <p><a href="https://luma.com/n9qx3vly">Register</a></p>
    <p><a href="https://lu.ma/sghq-73rn">https://lu.ma/sghq-73rn</a></p>
    <h3>Tuesday</h3>
    <p><a href="https://lu.ma/h6kko30n?utm_source=substack&amp;utm_medium=email">Agent Builders Night</a></p>
    <p>Plain text link: https://lu.ma/StepSF26</p>
    <p><a href="https://lu.ma/sf">SF calendar</a> and <a href="https://lu.ma/usr-abc123">a profile</a></p>
    <p><a href="https://www.eventbrite.com/e/something">Eventbrite event</a></p>
    <p><a href="https://www.bayareafoundersclub.com/pricing">Membership</a></p>
  ]]></content:encoded>
</item>
<item>
  <title><![CDATA[Bay Area Events For The Week Of August 17]]></title>
  <link>https://bayareafoundersclub.substack.com/p/bay-area-events-week-august-17</link>
  <pubDate>Sun, 16 Aug 2026 01:00:07 GMT</pubDate>
  <content:encoded><![CDATA[<p><a href="https://lu.ma/old-week-event">Last week</a></p>]]></content:encoded>
</item>
</channel></rss>`;

console.log("\nFeed parsing");
const items = parseFeedItems(FIXTURE);
assert("Parses every <item> in the feed", items.length === 3);
assert("Unwraps CDATA titles", items[1].title === "Bay Area Events For The Week Of August 24");
assert("Reads pubDate into a sortable timestamp", items[1].publishedAt > items[2].publishedAt);
assert("Captures content:encoded body", items[1].body.includes("n9qx3vly"));
assert("Empty feed yields no items", parseFeedItems("").length === 0);

console.log("\nWeekly post selection");
const post = selectLatestEventsPost(items);
assert("Selects a weekly events round-up", Boolean(post));
assert("Picks the newest round-up, not the older one", post.title.includes("August 24"));
assert("Ignores non-events posts", !selectLatestEventsPost([items[0]]));
assert("Returns null when the feed has no round-up", selectLatestEventsPost([]) === null);
assert(
  "Selection is independent of feed ordering",
  selectLatestEventsPost([...items].reverse()).title.includes("August 24")
);

console.log("\nLuma link extraction");
const events = extractLumaEvents(post.body);
const slugs = events.map((event) => event.slug);
assert("Finds anchor-linked Luma events", slugs.includes("n9qx3vly"));
assert("Finds lu.ma links written as plain text", slugs.includes("StepSF26"));
assert("Strips query strings from hrefs", slugs.includes("h6kko30n"));
assert("De-duplicates a slug linked more than once", slugs.filter((s) => s === "n9qx3vly").length === 1);
assert("Canonicalizes lu.ma to luma.com", events.every((e) => e.url.startsWith("https://luma.com/")));
assert("Rejects the /sf calendar path", !slugs.includes("sf"));
assert("Rejects usr- profile links", !slugs.includes("usr-abc123"));
assert("Ignores non-Luma hosts", !slugs.some((s) => s.includes("eventbrite")));
assert("Ignores the club's own marketing links", !slugs.includes("pricing"));
assert("Keeps anchor text as a provisional title", events.find((e) => e.slug === "n9qx3vly")?.title.startsWith("How VCs"));
assert("Decodes entities in titles", !events.find((e) => e.slug === "n9qx3vly")?.title.includes("&#8212;"));
assert("Falls back to the slug when anchor text is the bare URL", events.find((e) => e.slug === "sghq-73rn")?.title === "sghq-73rn");
assert("Every event exposes slug + url + title", events.every((e) => e.slug && e.url && e.title));
assert("Empty body yields no events", extractLumaEvents("").length === 0);

console.log("\nLive feed");
try {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  const response = await fetch(FOUNDERS_CLUB_FEED_URL, { signal: controller.signal });
  clearTimeout(timer);
  const liveItems = parseFeedItems(await response.text());
  const livePost = selectLatestEventsPost(liveItems);
  assert("Live feed responds 200", response.ok);
  assert("Live feed contains posts", liveItems.length > 0);
  assert("Live feed contains a weekly round-up", Boolean(livePost));
  if (livePost) {
    const liveEvents = extractLumaEvents(livePost.body);
    console.log(`    → "${livePost.title}" (${livePost.pubDate}) — ${liveEvents.length} Luma links`);
    assert("Live round-up yields a realistic number of events", liveEvents.length >= 20);
    assert(
      "Every live event is a canonical Luma URL",
      liveEvents.every((e) => /^https:\/\/luma\.com\/[\w-]+$/.test(e.url))
    );
  }
} catch (error) {
  console.log(`  ⚠ Live feed check skipped (${error.message})`);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exitCode = failed ? 1 : 0;
