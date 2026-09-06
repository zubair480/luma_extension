/** Shared run-state checks used by the side panel and service worker. */

export function getCurrentRunEvent(state) {
  if (!state) return null;

  // An explicit null means the previous event finished and the run is between events.
  if (Object.prototype.hasOwnProperty.call(state, "currentEvent")) {
    return state.currentEvent || null;
  }
  if (state.event) return state.event;

  // Recover an active event from the 1-based run index when an older/stale state snapshot omitted
  // currentEvent. This also keeps the popup and MV3 background worker on the same event.
  const current = Number(state.current);
  if (
    current > 0 &&
    Array.isArray(state.events) &&
    state.events[current - 1] &&
    (state.phase === "registering" || state.phase === "paused")
  ) {
    return state.events[current - 1];
  }

  return null;
}

export function canSkipRunState(state) {
  if (!state || state.skipRequested) return false;
  const eventInProgress = state.phase === "registering" || state.phase === "paused";
  return eventInProgress && Boolean(getCurrentRunEvent(state));
}
