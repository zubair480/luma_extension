/**
 * Bay Area Founders Club discovery — reads the weekly "Bay Area Events For The Week Of ..." post
 * from the publication's public RSS feed and harvests the Luma event links it lists.
 *
 * Unlike the Luma and Cerebral Valley sources this needs no tab and no content script: the feed
 * carries the full post HTML in <content:encoded>, so one background fetch returns everything.
 *
 * MV3 note: service workers have no DOMParser, so the feed is parsed with regexes. Only href/text
 * URLs are needed here — real titles come from the Luma API during hydration.
 */
import { isValidEventSlug } from "./constants.js";

export const FOUNDERS_CLUB_FEED_URL = "https://bayareafoundersclub.substack.com/feed";
export const FOUNDERS_CLUB_HOME_URL = "https://bayareafoundersclub.substack.com/";

/** Weekly round-up posts are titled "Bay Area Events For The Week Of <month> <day>". */
const EVENTS_POST_TITLE = /bay\s+area\s+events\s+for\s+the\s+week/i;

const FEED_TIMEOUT_MS = 20000;
const MAX_SUBSTACK_EVENTS = 80;
/** Past that age the newsletter has almost certainly been missed; hydration still filters events. */
const STALE_POST_DAYS = 14;
const CACHE_KEY = "substackFeedCache";

const LUMA_URL_RE = /https?:\/\/(?:www\.)?(?:lu\.ma|luma\.com)\/([A-Za-z0-9_-]+)/gi;
const ANCHOR_RE = /<a\b[^>]*?href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;

/** Minimal entity decoding — feed bodies use &amp; in hrefs and &#8212;/&nbsp; in link text. */
function decodeEntities(value = "") {
  return value
    .replace(/&(?:amp|#38|#x26);/gi, "&")
    .replace(/&(?:lt|#60|#x3c);/gi, "<")
    .replace(/&(?:gt|#62|#x3e);/gi, ">")
    .replace(/&(?:quot|#34|#x22);/gi, '"')
    .replace(/&(?:apos|#39|#x27);/gi, "'")
    .replace(/&(?:nbsp|#160);/gi, " ")
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number(code);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : " ";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const n = Number.parseInt(hex, 16);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : " ";
    });
}

/** Read a single tag out of one <item> block, unwrapping CDATA when present. */
function readTag(xml, tag) {
  const escaped = tag.replace(":", "\\:");
    const match = new RegExp(`<${escaped}[^>]*>([\\s\\S]*?)</${escaped}>`, "i").exec(xml);
  if (!match) return "";
  const raw = match[1];
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
  return cdata ? cdata[1] : raw;
}

function stripTags(html = "") {
  return decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

export function parseFeedItems(xml = "") {
  const items = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRe.exec(xml))) {
    const block = match[1];
    const pubDate = stripTags(readTag(block, "pubDate"));
    const published = pubDate ? Date.parse(pubDate) : NaN;
    items.push({
      title: stripTags(readTag(block, "title")),
      link: stripTags(readTag(block, "link")),
      pubDate,
      publishedAt: Number.isNaN(published) ? 0 : published,
      body: readTag(block, "content:encoded") || readTag(block, "description"),
    });
  }
  return items;
}

/** Newest weekly events round-up in the feed, or null when the feed has none. */
export function selectLatestEventsPost(items = []) {
  const posts = items.filter((item) => EVENTS_POST_TITLE.test(item.title || ""));
  if (!posts.length) return null;
  return posts.reduce((newest, item) => (item.publishedAt > newest.publishedAt ? item : newest));
}

/**
 * Pull every Luma event link out of a post body. Anchor text is used as a provisional title when
 * it is not just the bare URL; the Luma lookup replaces it with the real title during hydration.
 */
export function extractLumaEvents(bodyHtml = "") {
  const bySlug = new Map();

  const add = (slug, title = "") => {
    if (!isValidEventSlug(slug)) return;
    const existing = bySlug.get(slug);
    const clean = title && !/^https?:\/\//i.test(title) ? title.slice(0, 140) : "";
    if (existing) {
      if (!existing.title && clean) existing.title = clean;
      return;
    }
    bySlug.set(slug, { slug, url: `https://luma.com/${slug}`, title: clean });
  };

  let anchor;
  ANCHOR_RE.lastIndex = 0;
  while ((anchor = ANCHOR_RE.exec(bodyHtml))) {
    const href = decodeEntities(anchor[2] || "");
    const text = stripTags(anchor[3] || "");
    LUMA_URL_RE.lastIndex = 0;
    const hit = LUMA_URL_RE.exec(href);
    if (hit) add(hit[1], text);
  }

  // Second pass catches links that appear as plain text rather than anchors.
  const plain = decodeEntities(bodyHtml);
  LUMA_URL_RE.lastIndex = 0;
  let bare;
  while ((bare = LUMA_URL_RE.exec(plain))) add(bare[1]);

  return [...bySlug.values()]
    .slice(0, MAX_SUBSTACK_EVENTS)
    .map((event) => ({ ...event, title: event.title || event.slug }));
}

async function fetchFeed(url = FOUNDERS_CLUB_FEED_URL) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      credentials: "omit",
      cache: "no-cache",
    });
    if (!response.ok) throw new Error(`Feed returned HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function daysOld(publishedAt) {
  if (!publishedAt) return null;
  return Math.floor((Date.now() - publishedAt) / 86400000);
}

/**
 * Fetch + parse the newsletter. The parsed result is cached against the post's pubDate so repeat
 * runs in the same week skip the download entirely.
 */
export async function discoverFoundersClubEvents({ feedUrl = FOUNDERS_CLUB_FEED_URL } = {}) {
  const xml = await fetchFeed(feedUrl);
  const items = parseFeedItems(xml);
  const post = selectLatestEventsPost(items);

  if (!post) {
    return {
      events: [],
      postTitle: "",
      postUrl: FOUNDERS_CLUB_HOME_URL,
      pubDate: "",
      ageDays: null,
      stale: false,
      cached: false,
      feedItems: items.length,
    };
  }

  const cacheHit = await readCache(post);
  if (cacheHit) return { ...cacheHit, cached: true, feedItems: items.length };

  const events = extractLumaEvents(post.body);
  const ageDays = daysOld(post.publishedAt);
  const result = {
    events,
    postTitle: post.title,
    postUrl: post.link || FOUNDERS_CLUB_HOME_URL,
    pubDate: post.pubDate,
    ageDays,
    stale: ageDays !== null && ageDays > STALE_POST_DAYS,
    cached: false,
    feedItems: items.length,
  };

  await writeCache(result);
  return result;
}

async function readCache(post) {
  try {
    const { [CACHE_KEY]: cache } = await chrome.storage.local.get(CACHE_KEY);
    if (!cache || cache.pubDate !== post.pubDate) return null;
    if (!Array.isArray(cache.events) || !cache.events.length) return null;
    return { ...cache, ageDays: daysOld(post.publishedAt) };
  } catch {
    return null;
  }
}

async function writeCache(result) {
  try {
    await chrome.storage.local.set({
      [CACHE_KEY]: {
        pubDate: result.pubDate,
        postTitle: result.postTitle,
        postUrl: result.postUrl,
        events: result.events,
        stale: result.stale,
      },
    });
  } catch {
    /* Cache is an optimisation only — a failed write must not fail the run. */
  }
}
