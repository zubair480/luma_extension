/**
 * Which past run results should permanently exclude an event from discovery.
 * Skipped/failed attempts (virtual mis-detect, paid mis-detect, errors) are retryable.
 */
export const DISCOVERY_HISTORY_EXCLUDE_STATUSES = new Set([
  "registered",
  "waitlist_joined",
  "already_registered",
  "on_waitlist",
  "pending_approval",
  "approved",
  "skipped_women_only",
  "event_ended",
  "event_cancelled",
  "registration_closed",
  "skipped_non_event",
]);

export function shouldExcludeFromDiscoveryHistory(entry) {
  if (!entry?.event) return false;
  return DISCOVERY_HISTORY_EXCLUDE_STATUSES.has(entry.status);
}

export function buildHistoryExcludeIds(history = []) {
  const ids = new Set();
  for (const entry of history) {
    if (!shouldExcludeFromDiscoveryHistory(entry)) continue;
    if (entry.event?.id) ids.add(entry.event.id);
    if (entry.event?.slug) {
      ids.add(entry.event.slug);
      ids.add(`slug:${entry.event.slug}`);
    }
  }
  return ids;
}

/**
 * Durable exclusion index.
 *
 * `history` is a display list capped at 100 entries, but it was also the only source of
 * exclusions — so once the cap was reached the oldest decisions silently fell off and the agent
 * re-opened events it had already ruled out (women-only, ended, cancelled). The index below is
 * kept separately, keyed by slug, and holds only the verdicts that should exclude an event. It is
 * far larger than the display list and expires on age rather than on count.
 */
export const EXCLUDE_INDEX_KEY = "excludeIndex";
export const EXCLUDE_INDEX_MAX = 5000;
export const EXCLUDE_INDEX_TTL_MS = 180 * 24 * 60 * 60 * 1000;

/** Slug is the stable identifier across sources; the API id is kept as a secondary match. */
export function excludeKeyFor(event = {}) {
  return event?.slug || event?.id || null;
}

/** Record one history entry in the index, if its verdict is one that should exclude. */
export function addToExcludeIndex(index = {}, entry, now = Date.now()) {
  if (!shouldExcludeFromDiscoveryHistory(entry)) return index;
  const key = excludeKeyFor(entry.event);
  if (!key) return index;
  index[key] = {
    status: entry.status,
    message: entry.message || "",
    id: entry.event?.id || "",
    url: entry.event?.url || "",
    savedAt: now,
  };
  return index;
}

/** Drop entries past the TTL, then keep the newest EXCLUDE_INDEX_MAX. */
export function pruneExcludeIndex(index = {}, { max = EXCLUDE_INDEX_MAX, ttlMs = EXCLUDE_INDEX_TTL_MS, now = Date.now() } = {}) {
  const live = Object.entries(index).filter(
    ([, value]) => value && (!value.savedAt || now - value.savedAt < ttlMs)
  );
  live.sort((a, b) => (b[1].savedAt || 0) - (a[1].savedAt || 0));
  return Object.fromEntries(live.slice(0, max));
}

/** Every identifier form isExcludedFromHistory() checks against. */
export function excludeIdsFromIndex(index = {}) {
  const ids = new Set();
  for (const [key, value] of Object.entries(index)) {
    ids.add(key);
    ids.add(`slug:${key}`);
    if (value?.id) ids.add(value.id);
  }
  return ids;
}

/** Find a prior verdict for an event, matching the way shouldSkipFromHistory matched history. */
export function findExcludeEntry(index = {}, event = {}) {
  const key = excludeKeyFor(event);
  if (key && index[key]) return index[key];
  if (event?.slug && index[event.slug]) return index[event.slug];
  for (const [indexKey, value] of Object.entries(index)) {
    if (!value) continue;
    if (event?.id && value.id && value.id === event.id) return value;
    if (event?.url && value.url && value.url === event.url) return value;
    if (event?.slug && indexKey === event.slug) return value;
  }
  return null;
}

/** One-time seed so exclusions already in the display history are not lost on upgrade. */
export function buildExcludeIndexFromHistory(history = [], now = Date.now()) {
  const index = {};
  // Oldest first so the newest verdict for a slug wins.
  for (const entry of [...history].reverse()) addToExcludeIndex(index, entry, now);
  return index;
}
