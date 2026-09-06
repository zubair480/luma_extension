import {
  SF_PLACE_ID,
  SEARCH_QUERIES,
  DISCOVER_CATEGORIES,
  SF_REGION_CITIES,
  TECH_KEYWORDS,
  EXCLUDE_KEYWORDS,
  MIN_RELEVANCE_SCORE,
  MAX_DISCOVERY_PAGES,
  QUERY_MAX_PAGES,
  LUMA_HEADERS,
  isValidEventSlug,
  isWomenOnlyEvent,
  isVirtualEventFromApi,
  isVirtualEvent,
  hasPhysicalGeo,
} from "./constants.js";

/**
 * Verified-lookup cache.
 *
 * Every scraped link is verified against the Luma API one at a time with a mandatory 1.2s gap, so
 * a full discovery pass can spend well over a minute waiting on requests whose answers rarely
 * change within a day. Caching the verdict per slug lets repeat runs — and the heavy overlap
 * between the four sources across a week — skip both the request and its rate-limit gap.
 *
 * Only settled verdicts are cached. "unavailable" is transient (network error, 429, 5xx) and is
 * always retried. The cache degrades to a no-op outside the extension (tests, Node), so it never
 * changes behaviour under test.
 */
const LOOKUP_CACHE_KEY = "lumaLookupCache";
const LOOKUP_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const LOOKUP_CACHE_MAX_ENTRIES = 400;
const CACHEABLE_LOOKUP_STATUSES = new Set(["event", "not_event", "ineligible"]);

let lookupCache = null;
let lookupCacheDirty = false;

function lookupCacheAvailable() {
  return typeof chrome !== "undefined" && Boolean(chrome?.storage?.local);
}

export async function loadLookupCache() {
  if (!lookupCacheAvailable()) {
    lookupCache = null;
    return;
  }
  if (lookupCache) return;
  try {
    const stored = await chrome.storage.local.get(LOOKUP_CACHE_KEY);
    const raw = stored?.[LOOKUP_CACHE_KEY] || {};
    const now = Date.now();
    lookupCache = {};
    for (const [slug, entry] of Object.entries(raw)) {
      if (entry?.savedAt && now - entry.savedAt < LOOKUP_CACHE_TTL_MS) lookupCache[slug] = entry;
    }
  } catch {
    lookupCache = {};
  }
}

export function readLookupCache(slug) {
  const entry = lookupCache?.[slug];
  if (!entry) return null;
  if (Date.now() - entry.savedAt >= LOOKUP_CACHE_TTL_MS) return null;
  return entry.lookup;
}

export function writeLookupCache(slug, lookup) {
  if (!lookupCache || !CACHEABLE_LOOKUP_STATUSES.has(lookup?.status)) return;
  // rateLimitRetries describes one request, not the event — replaying it would inflate stats.
  const { rateLimitRetries, httpStatus, ...settled } = lookup;
  lookupCache[slug] = { savedAt: Date.now(), lookup: settled };
  lookupCacheDirty = true;
}

export async function flushLookupCache() {
  if (!lookupCacheAvailable() || !lookupCacheDirty || !lookupCache) return;
  lookupCacheDirty = false;
  try {
    const entries = Object.entries(lookupCache)
      .sort((a, b) => b[1].savedAt - a[1].savedAt)
      .slice(0, LOOKUP_CACHE_MAX_ENTRIES);
    lookupCache = Object.fromEntries(entries);
    await chrome.storage.local.set({ [LOOKUP_CACHE_KEY]: lookupCache });
  } catch {
    /* Cache is an optimisation only — a failed write must never fail discovery. */
  }
}

const API_BASE = "https://api2.luma.com/discover/get-paginated-events";
const URL_LOOKUP_BASE = "https://api2.luma.com/url";
const REQUEST_DELAY_MS = 1200;
const MAX_FEED_HYDRATE = 80;
const LUMA_MIN_REQUEST_INTERVAL_MS = 1200;
const LUMA_DEFAULT_RETRY_AFTER_MS = 15000;
const LUMA_MAX_RETRY_AFTER_MS = 120000;

// All Luma API access shares one serial lane. This prevents simultaneous source discovery from
// creating a burst of /url and discover API requests under the same browser/IP session.
let lumaFetchQueue = Promise.resolve();
let lumaNextRequestAt = 0;
let lumaBlockedUntil = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(response, fallbackMs = LUMA_DEFAULT_RETRY_AFTER_MS) {
  const raw = response?.headers?.get?.("retry-after");
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(LUMA_MAX_RETRY_AFTER_MS, Math.max(0, seconds * 1000));
    }
    const dateMs = Date.parse(raw);
    if (Number.isFinite(dateMs)) {
      return Math.min(LUMA_MAX_RETRY_AFTER_MS, Math.max(0, dateMs - Date.now()));
    }
  }
  return fallbackMs;
}

function extendLumaCooldown(ms) {
  lumaBlockedUntil = Math.max(lumaBlockedUntil, Date.now() + Math.max(0, ms));
}

async function scheduleLumaFetch(url, options) {
  const task = lumaFetchQueue.then(async () => {
    const waitMs = Math.max(0, lumaNextRequestAt - Date.now(), lumaBlockedUntil - Date.now());
    if (waitMs) await sleep(waitMs);

    const startedAt = Date.now();
    lumaNextRequestAt = startedAt + LUMA_MIN_REQUEST_INTERVAL_MS;
    const response = await fetch(url, options);
    if (response?.status === 429) {
      extendLumaCooldown(retryAfterMs(response));
    }
    return response;
  });

  // Keep the lane usable after a network failure while preserving call order.
  lumaFetchQueue = task.then(
    () => undefined,
    () => undefined
  );
  return task;
}

async function fetchLumaWithBackoff(url, options, { max429Retries = 1 } = {}) {
  let rateLimitRetries = 0;
  let serverRetries = 0;
  let networkRetries = 0;

  while (true) {
    let response;
    try {
      response = await scheduleLumaFetch(url, options);
    } catch (error) {
      if (networkRetries++ < 1) {
        extendLumaCooldown(2000);
        continue;
      }
      throw error;
    }

    if (response.ok) return { response, rateLimitRetries };

    if (response.status === 429 && rateLimitRetries < max429Retries) {
      rateLimitRetries++;
      // scheduleLumaFetch already honored Retry-After or applied the safe default cooldown.
      continue;
    }

    if (response.status >= 500 && serverRetries++ < 1) {
      extendLumaCooldown(2000);
      continue;
    }

    return { response, rateLimitRetries };
  }
}

function parseEvent(entry, query = "", source = "") {
  const event = entry.event || {};
  const ticket = entry.ticket_info || {};
  const geo = event.geo_address_info || {};
  const calendar = entry.calendar || {};

  const slug = event.url;
  if (!slug || !event.start_at || !isValidEventSlug(slug)) return null;

  if (isVirtualEventFromApi(event, geo)) return null;

  if (!hasPhysicalGeo(geo)) return null;

  const city = (geo.city || geo.city_state || "").toLowerCase();
  const region = (geo.region || geo.state || "").toLowerCase();
  const inSfRegion =
    SF_REGION_CITIES.some((c) => city.includes(c)) ||
    city.includes("san francisco") ||
    region.includes("california");

  if (!inSfRegion) return null;

  const locationLabel = [geo.address, geo.full_address, geo.city_state].filter(Boolean).join(", ");

  return {
    id: event.api_id || entry.api_id || slug,
    title: event.name || "Untitled",
    slug,
    url: `https://luma.com/${slug}`,
    altUrl: `https://lu.ma/${slug}`,
    startAt: event.start_at,
    city: geo.city || geo.city_state || "San Francisco",
    location: locationLabel,
    address: geo.address || geo.full_address || "",
    isVirtual: false,
    organizer: calendar.name || "",
    isFree: Boolean(ticket.is_free),
    isSoldOut: Boolean(ticket.is_sold_out),
    requireApproval: Boolean(ticket.require_approval),
    registrationAvailability: entry.registration_availability || "unknown",
    waitlistActive: Boolean(entry.waitlist_active),
    userRsvpStatus: parseUserRsvpStatus(entry),
    query,
    source,
  };
}

function toStr(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.toLowerCase();
  if (typeof value === "number" || typeof value === "boolean") return String(value).toLowerCase();
  if (typeof value === "object") {
    return toStr(value.type || value.role || value.status || value.name || "");
  }
  return "";
}

function parseUserRsvpStatus(entry) {
  const role = toStr(entry.role);
  const guest = entry.guest_info || {};
  const approval = toStr(guest.approval_status || guest.status);

  if (approval === "pending" || approval === "waitlist_pending") return "pending";
  if (approval === "waitlist") return "waitlist";
  if (role === "guest" || approval === "approved" || approval === "going") return "going";
  return null;
}

function scoreEvent(event) {
  const text = [event.title, event.organizer, event.city, event.query, event.source]
    .join(" ")
    .toLowerCase();

  if (isWomenOnlyEvent(event)) {
    return { score: -1, matched: [], excluded: true, reason: "women_only" };
  }

  if (isVirtualEvent(event)) {
    return { score: -1, matched: [], excluded: true, reason: "virtual" };
  }

  for (const kw of EXCLUDE_KEYWORDS) {
    if (text.includes(kw)) return { score: -1, matched: [], excluded: true };
  }

  const matched = [];
  let score = 0;

  for (const kw of TECH_KEYWORDS) {
    const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(text)) {
      matched.push(kw);
      score += 12;
    }
  }

  if (event.query) score += 5;
  if (event.source === "category:ai") score += 15;
  if (event.source === "category:tech") score += 8;
  if (text.includes("san francisco")) score += 5;

  return { score: Math.min(score, 100), matched, excluded: false };
}

function isRegisterable(event) {
  if (["going", "pending", "waitlist"].includes(event.userRsvpStatus)) return false;

  const reg = event.registrationAvailability || "unknown";

  if (reg === "waitlist" || event.waitlistActive) return true;

  if (reg === "sold-out") {
    return event.waitlistActive;
  }

  if (reg !== "open") return false;
  if (event.isSoldOut && !event.waitlistActive) return false;

  if (event.isFree || event.requireApproval) return true;

  return false;
}

function feedBoostForSlug(slug, feedPrioritySlugs = []) {
  const index = feedPrioritySlugs.indexOf(slug);
  if (index < 0) return 0;
  return Math.max(1, 100 - index);
}

function isExcludedFromHistory(event, excludeIds = new Set()) {
  if (!excludeIds.size) return false;
  return (
    excludeIds.has(event.id) ||
    excludeIds.has(event.slug) ||
    excludeIds.has(`slug:${event.slug}`)
  );
}

async function fetchEventLookupBySlug(slug) {
  if (!slug || !isValidEventSlug(slug)) return { status: "not_event", kind: "invalid" };

  try {
    const { response, rateLimitRetries } = await fetchLumaWithBackoff(
      `${URL_LOOKUP_BASE}?url=${encodeURIComponent(slug)}`,
      {
        headers: LUMA_HEADERS,
        credentials: "include",
      }
    );
    if (!response.ok) {
      return { status: "unavailable", httpStatus: response.status, rateLimitRetries };
    }

    const payload = await response.json();
    if (payload?.kind !== "event") {
      return { status: "not_event", kind: payload?.kind || "unknown", rateLimitRetries };
    }

    const event = parseEventFromUrlLookup(payload, slug);
    return event
      ? { status: "event", event, rateLimitRetries }
      : { status: "ineligible", kind: "event", rateLimitRetries };
  } catch (error) {
    return { status: "unavailable", error: error?.message || String(error), rateLimitRetries: 0 };
  }
}

async function fetchEventBySlug(slug) {
  const lookup = await fetchEventLookupBySlug(slug);
  return lookup.status === "event" ? lookup.event : null;
}

/** Parse GET /url?url={slug} — fills gaps vs discover API (visible on luma.com/sf). */
function parseEventFromUrlLookup(payload, slug = "") {
  const data = payload?.data;
  if (payload?.kind !== "event" || !data?.event) return null;

  const entry = {
    event: data.event,
    ticket_info: data.ticket_info || {},
    calendar: data.calendar || {},
    registration_availability: data.registration_availability,
    waitlist_active: data.waitlist_active,
    role: data.role,
    guest_info: data.guest_info || data.guest_data || {},
  };

  return parseEvent(entry, "", `feed:${slug || data.event.url || ""}`);
}

async function hydrateEventsFromFeedSlugs(allEvents, feedSlugs = []) {
  if (!feedSlugs?.length) return allEvents;

  const seenIds = new Set(allEvents.map((e) => e.id));
  const seenSlugs = new Set(allEvents.map((e) => e.slug));
  const merged = [...allEvents];
  let fetched = 0;

  for (const raw of feedSlugs) {
    if (fetched >= MAX_FEED_HYDRATE) break;
    const slug = String(raw || "").replace(/^slug:/, "");
    if (!slug || seenSlugs.has(slug)) continue;

    const event = await fetchEventBySlug(slug);
    fetched++;

    if (!event || seenIds.has(event.id)) continue;
    seenIds.add(event.id);
    seenSlugs.add(event.slug);
    merged.push(event);
  }

  return merged;
}

/**
 * Canonicalize and de-duplicate Luma event links scraped from one or more source pages.
 * The first source controls ordering, while `sources` keeps all pages that contained the event.
 */
export function normalizeScrapedEventLinks(records = []) {
  const eventsBySlug = new Map();

  for (const raw of records) {
    const record = typeof raw === "string" ? { url: raw } : raw || {};
    try {
      const parsed = new URL(record.url || "", "https://luma.com");
      const host = parsed.hostname.replace(/^www\./, "");
      const parts = parsed.pathname.split("/").filter(Boolean);
      if ((host !== "luma.com" && host !== "lu.ma") || parts.length !== 1) continue;

      const slug = parts[0];
      if (!isValidEventSlug(slug)) continue;

      const source = record.source || "scraped";
      const existing = eventsBySlug.get(slug);
      if (existing) {
        if (!existing.sources.includes(source)) existing.sources.push(source);
        if ((!existing.title || existing.title === slug) && record.title) {
          existing.title = record.title;
        }
        continue;
      }

      eventsBySlug.set(slug, {
        slug,
        url: `https://luma.com/${slug}`,
        title: record.title || slug,
        source,
        sources: [source],
        sourceOrder: eventsBySlug.size,
      });
    } catch {
      /* Ignore malformed and non-Luma URLs from source pages. */
    }
  }

  return [...eventsBySlug.values()];
}

/** Fairly mix sources so an early-stop verification pass still samples all three pages. */
function interleaveRecordsBySource(records = []) {
  const buckets = new Map();
  for (const record of records) {
    const key = record.source || "scraped";
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(record);
  }

  const mixed = [];
  let offset = 0;
  while (mixed.length < records.length) {
    let added = false;
    for (const bucket of buckets.values()) {
      if (offset < bucket.length) {
        mixed.push(bucket[offset]);
        added = true;
      }
    }
    if (!added) break;
    offset++;
  }
  return mixed;
}

/**
 * Hydrate the exact event links scraped from the configured source pages. Only URLs positively
 * verified by Luma as registerable events enter the queue. Calendar/community/system routes and
 * unavailable/closed/virtual/out-of-region events are rejected here instead of failing later.
 */
export async function discoverScrapedEventsWithStats(
  records = [],
  maxResults = 25,
  excludeIds = new Set()
) {
  await loadLookupCache();
  const allNormalized = normalizeScrapedEventLinks(records);
  // Re-key sourceOrder to the interleaved position. normalizeScrapedEventLinks numbers records in
  // the order sources were concatenated, which would make the final sort prefer whichever source
  // was scanned first and starve the later ones — badly so once one source contributes many more
  // links than the others. Ranking on the round-robin position keeps every source represented.
  const normalized = interleaveRecordsBySource(allNormalized)
    .slice(0, MAX_FEED_HYDRATE)
    .map((record, index) => ({ ...record, sourceOrder: index }));
  const hydrated = [];
  const lookupCounts = { event: 0, not_event: 0, ineligible: 0, unavailable: 0 };
  let cacheHits = 0;
  let rateLimitRetries = 0;
  let rateLimitStopped = false;
  const verifiedTarget = Math.min(normalized.length, maxResults + Math.max(8, Math.ceil(maxResults / 3)));

  for (const record of normalized) {
    const cached = readLookupCache(record.slug);
    const lookup = cached || (await fetchEventLookupBySlug(record.slug));
    if (cached) cacheHits++;
    else writeLookupCache(record.slug, lookup);

    lookupCounts[lookup.status] = (lookupCounts[lookup.status] || 0) + 1;
    rateLimitRetries += lookup.rateLimitRetries || 0;

    if (lookup.status === "event") {
      hydrated.push({
        ...lookup.event,
        source: record.source,
        sources: record.sources,
        sourceOrder: record.sourceOrder,
      });
    }

    if (lookup.httpStatus === 429) {
      rateLimitStopped = true;
      break;
    }

    // Stop making lookups once there is enough verified, registerable inventory for this run.
    // Source records are interleaved, so this remains representative of all configured pages.
    if (hydrated.filter(isRegisterable).length >= verifiedTarget) break;
  }

  const eligible = applyScores(hydrated)
    .filter(isRegisterable)
    .filter((event) => !isExcludedFromHistory(event, excludeIds));

  eligible.sort(
    (a, b) =>
      Number(b.relevanceScore >= MIN_RELEVANCE_SCORE) -
        Number(a.relevanceScore >= MIN_RELEVANCE_SCORE) ||
      a.sourceOrder - b.sourceOrder ||
      String(a.startAt || "9999").localeCompare(String(b.startAt || "9999"))
  );

  await flushLookupCache();

  const registerable = hydrated.filter(isRegisterable);
  return {
    events: eligible.slice(0, maxResults),
    stats: {
      totalSF: allNormalized.length,
      totalScraped: allNormalized.length,
      lookupAttempted: Object.values(lookupCounts).reduce((sum, count) => sum + count, 0),
      cacheHits,
      hydrated: hydrated.length,
      rejectedNonEvents: lookupCounts.not_event,
      rejectedIneligible: lookupCounts.ineligible,
      lookupFailed: lookupCounts.unavailable,
      rateLimitRetries,
      rateLimitStopped,
      pageCheckRequired: 0,
      freeRegisterable: registerable.length,
      newRegisterable: eligible.length,
      techRegisterable: eligible.filter((e) => e.relevanceScore >= MIN_RELEVANCE_SCORE).length,
      aiRegisterable: eligible.filter((e) => e.relevanceScore >= MIN_RELEVANCE_SCORE).length,
    },
  };
}

async function fetchPage({ query = "", cursor = null, limit = 40, category = null } = {}) {
  const params = new URLSearchParams({
    discover_place_api_id: SF_PLACE_ID,
    pagination_limit: String(limit),
  });
  if (query) params.set("query", query);
  if (category) params.set("category", category);
  if (cursor) params.set("pagination_cursor", cursor);

  const { response } = await fetchLumaWithBackoff(
    `${API_BASE}?${params}`,
    { headers: LUMA_HEADERS, credentials: "include" }
  );
  if (!response.ok) throw new Error(`Luma API error: ${response.status}`);
  return response.json();
}

async function paginateEvents(query = "", maxPages = MAX_DISCOVERY_PAGES, source = "feed") {
  const events = [];
  let cursor = null;

  for (let page = 0; page < maxPages; page++) {
    const data = await fetchPage({ query, cursor });
    for (const entry of data.entries || []) {
      const parsed = parseEvent(entry, query, source);
      if (parsed) events.push(parsed);
    }
    if (!data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
    await sleep(REQUEST_DELAY_MS);
  }

  return events;
}

function mergeEvents(seen, all, batch) {
  for (const event of batch) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    all.push(event);
  }
}

function applyScores(events) {
  return events
    .map((event) => {
      const { score, matched, excluded } = scoreEvent(event);
      return { ...event, relevanceScore: score, matchedKeywords: matched, excluded };
    })
    .filter((e) => !e.excluded);
}

function rankForRegistration(events, maxResults, feedPrioritySlugs = [], excludeIds = new Set()) {
  const registerable = applyScores(events)
    .filter(isRegisterable)
    .filter((e) => !isExcludedFromHistory(e, excludeIds))
    .map((event) => ({
      ...event,
      feedBoost: feedBoostForSlug(event.slug, feedPrioritySlugs),
      isAi: event.relevanceScore >= MIN_RELEVANCE_SCORE,
    }));

  const sortFn = (a, b) =>
    b.feedBoost - a.feedBoost ||
    Number(b.isAi) - Number(a.isAi) ||
    b.relevanceScore - a.relevanceScore ||
    a.startAt.localeCompare(b.startAt);

  return registerable.sort(sortFn).slice(0, maxResults);
}

async function paginateCategory(category, maxPages = MAX_DISCOVERY_PAGES) {
  const events = [];
  let cursor = null;
  const source = `category:${category}`;

  for (let page = 0; page < maxPages; page++) {
    const data = await fetchPage({ category, cursor });
    for (const entry of data.entries || []) {
      const parsed = parseEvent(entry, category, source);
      if (parsed) events.push(parsed);
    }
    if (!data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
    await sleep(REQUEST_DELAY_MS);
  }

  return events;
}

async function paginateQueriesParallel(queries, maxPages, seen, all) {
  const batchSize = 4;
  for (let i = 0; i < queries.length; i += batchSize) {
    const batch = queries.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map((query) => paginateEvents(query, maxPages, `query:${query}`))
    );
    for (const events of results) mergeEvents(seen, all, events);
    if (i + batchSize < queries.length) await sleep(REQUEST_DELAY_MS);
  }
}

/** Browse SF + AI/tech searches + category filters from Luma API */
export async function discoverAllSFEvents() {
  const seen = new Set();
  const all = [];

  mergeEvents(seen, all, await paginateEvents("", MAX_DISCOVERY_PAGES, "sf-feed"));

  for (const category of DISCOVER_CATEGORIES) {
    mergeEvents(seen, all, await paginateCategory(category, MAX_DISCOVERY_PAGES));
    await sleep(REQUEST_DELAY_MS);
  }

  await paginateQueriesParallel(SEARCH_QUERIES, QUERY_MAX_PAGES, seen, all);

  return applyScores(all).sort(
    (a, b) => b.relevanceScore - a.relevanceScore || a.startAt.localeCompare(b.startAt)
  );
}

/** Find up to maxResults registerable SF events — AI/tech first, then all other SF events */
export async function discoverEvents(maxResults = 25, excludeIds = new Set()) {
  const { events } = await discoverEventsWithStats(maxResults, [], excludeIds);
  return events;
}

export async function discoverEventsWithStats(
  maxResults = 25,
  feedPrioritySlugs = [],
  excludeIds = new Set()
) {
  let all = await discoverAllSFEvents();
  const apiCount = all.length;
  all = await hydrateEventsFromFeedSlugs(all, feedPrioritySlugs);
  const scored = applyScores(all);
  const registerable = scored.filter(isRegisterable);
  const registerableNew = registerable.filter((e) => !isExcludedFromHistory(e, excludeIds));
  const ai = registerableNew.filter((e) => e.relevanceScore >= MIN_RELEVANCE_SCORE);
  const events = rankForRegistration(all, maxResults, feedPrioritySlugs, excludeIds);

  return {
    events,
    stats: {
      totalSF: all.length,
      feedHydrated: Math.max(0, all.length - apiCount),
      freeRegisterable: registerable.length,
      newRegisterable: registerableNew.length,
      techRegisterable: ai.length,
      aiRegisterable: ai.length,
    },
  };
}

export async function getDiscoveryStats(excludeIds = new Set()) {
  const all = await discoverAllSFEvents();
  const registerable = applyScores(all).filter(isRegisterable);
  const registerableNew = registerable.filter((e) => !isExcludedFromHistory(e, excludeIds));
  const ai = registerableNew.filter((e) => e.relevanceScore >= MIN_RELEVANCE_SCORE);

  return {
    totalSF: all.length,
    freeRegisterable: registerable.length,
    newRegisterable: registerableNew.length,
    techRegisterable: ai.length,
    aiRegisterable: ai.length,
  };
}

export { isRegisterable, scoreEvent, isExcludedFromHistory, parseEvent, applyScores, isVirtualEventFromApi };
