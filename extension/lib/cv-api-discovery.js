/**
 * Cerebral Valley discovery over its public event API.
 *
 * The events page at cerebralvalley.ai renders client-side from
 * `api.cerebralvalley.ai/v1/public/event/pull`, which answers plain GET requests with JSON:
 * `{ events: [{ name, url, startDateTime, timeZone, location, venue, type, status, … }],
 *    totalCount, limit, offset }`. Each event's `url` is its outbound registration link, so
 * Luma-hosted events can be collected with a couple of paginated requests and no tab at all.
 * The tab-based scanner in cv-discovery.js remains the fallback if this endpoint changes.
 */
import { isValidEventSlug } from "./constants.js";

export const CV_API_BASE = "https://api.cerebralvalley.ai/v1/public/event/pull";
export const CV_API_PAGE_SIZE = 50;
export const CV_API_MAX_PAGES = 4;

export function buildCvApiUrl({ offset = 0, limit = CV_API_PAGE_SIZE, startDateTime, locations = "BAY_AREA" } = {}) {
  const start = startDateTime || startOfTodayIso();
  const params = new URLSearchParams({
    approved: "true",
    startDateTime: start,
    locations,
    limit: String(limit),
    offset: String(offset),
  });
  return `${CV_API_BASE}?${params}`;
}

function startOfTodayIso(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/** Canonical Luma slug for a direct lu.ma / luma.com event link, else null. */
export function lumaSlugFromUrl(href = "") {
  try {
    const u = new URL(String(href));
    const host = u.hostname.replace(/^www\./, "");
    if (host !== "lu.ma" && host !== "luma.com") return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length !== 1) return null;
    return isValidEventSlug(parts[0]) ? parts[0] : null;
  } catch {
    return null;
  }
}

export function classifyCvEventUrl(href = "") {
  try {
    const host = new URL(String(href)).hostname.replace(/^www\./, "");
    if (host === "lu.ma" || host === "luma.com") return "luma";
    if (host.endsWith("meetup.com")) return "meetup";
    if (host.endsWith("eventbrite.com") || host.endsWith("eventbrite.co")) return "eventbrite";
    if (host.endsWith("partiful.com")) return "partiful";
    if (host.endsWith("cerebralvalley.ai")) return "cv";
    return "other";
  } catch {
    return "other";
  }
}

/**
 * Turn one API page into Luma event records for the verifier, plus per-platform counts.
 * Non-Luma events are counted but not returned: the registration pipeline is Luma-only.
 */
export function parseCvApiEvents(payload = {}) {
  const list = Array.isArray(payload) ? payload : Array.isArray(payload?.events) ? payload.events : [];
  const events = [];
  const counts = { luma: 0, meetup: 0, eventbrite: 0, partiful: 0, cv: 0, other: 0 };
  const seen = new Set();

  for (const item of list) {
    const href = item?.url || "";
    const kind = classifyCvEventUrl(href);
    counts[kind] = (counts[kind] || 0) + 1;
    if (kind !== "luma") continue;
    const slug = lumaSlugFromUrl(href);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    events.push({
      url: `https://luma.com/${slug}`,
      slug,
      title: String(item.name || item.title || slug).replace(/\s+/g, " ").trim().slice(0, 160),
      startAt: item.startDateTime || item.start_at || null,
      timeZone: item.timeZone || null,
      source: "cerebralvalley",
    });
  }

  return { events, counts, total: Number(payload?.totalCount) || list.length, pageSize: list.length };
}

/**
 * Fetch up to `maxEvents` Luma events from the API, paging until the total is exhausted, a page
 * comes back short, or enough Luma links are in hand. Resolves `{ ok: false, error }` on any
 * failure so the caller can fall back to the tab scanner; never throws.
 */
export async function discoverCerebralValleyViaApi({
  fetchImpl = globalThis.fetch,
  maxEvents = 60,
  pageSize = CV_API_PAGE_SIZE,
  maxPages = CV_API_MAX_PAGES,
  startDateTime,
  onPage = null,
} = {}) {
  const events = [];
  const counts = { luma: 0, meetup: 0, eventbrite: 0, partiful: 0, cv: 0, other: 0 };
  const seen = new Set();
  let total = null;
  let pages = 0;

  try {
    for (let page = 0; page < maxPages; page++) {
      const offset = page * pageSize;
      if (total != null && offset >= total) break;

      const response = await fetchImpl(buildCvApiUrl({ offset, limit: pageSize, startDateTime }), {
        headers: { accept: "application/json" },
        credentials: "omit",
      });
      if (!response?.ok) return { ok: false, error: `Cerebral Valley API returned ${response?.status ?? "no response"}`, events, counts, pages };

      const parsed = parseCvApiEvents(await response.json());
      pages++;
      total = parsed.total;
      for (const key of Object.keys(counts)) counts[key] += parsed.counts[key] || 0;
      for (const event of parsed.events) {
        if (seen.has(event.slug)) continue;
        seen.add(event.slug);
        events.push(event);
      }
      if (typeof onPage === "function") {
        try {
          await onPage({ page, offset, total, lumaSoFar: events.length, pageSize: parsed.pageSize });
        } catch {
          /* reporting only */
        }
      }

      if (events.length >= maxEvents) break;
      if (parsed.pageSize < pageSize) break;
    }
  } catch (err) {
    return { ok: false, error: err?.message || String(err), events, counts, pages };
  }

  return { ok: true, events: events.slice(0, maxEvents), counts, total, pages };
}
