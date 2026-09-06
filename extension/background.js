import { discoverScrapedEventsWithStats, compareEligibleEvents } from "./lib/discovery.js";
import {
  discoverFoundersClubEvents,
  FOUNDERS_CLUB_HOME_URL,
} from "./lib/substack-discovery.js";
import {
  answerRegistrationQuestion,
  warmupLocalModel,
  getLocalModelStatus,
  getLlmConfig,
} from "./lib/llm-answer.js";
import {
  buildHistoryExcludeIds,
  shouldExcludeFromDiscoveryHistory,
  addToExcludeIndex,
  pruneExcludeIndex,
  excludeIdsFromIndex,
  findExcludeEntry,
  buildExcludeIndexFromHistory,
  EXCLUDE_INDEX_KEY,
} from "./lib/history.js";
import { createLogEntry, trimRunLogs, RUN_STEPS, formatRunLogsAsText } from "./lib/run-log.js";
import { canSkipRunState, getCurrentRunEvent } from "./lib/run-control-state.js";
import {
  initExtensionStorage,
  mirrorRunControlToLocal,
  setSessionRunControl,
} from "./lib/run-control-mirror.js";
import {
  DEFAULT_PROFILE,
  EXCLUDE_KEYWORDS,
  MAX_EVENTS,
  REGISTRATION_DELAY_MS,
  TAB_TIMEOUT_MS,
  isValidEventHref,
  isWomenOnlyEvent,
} from "./lib/constants.js";
import "./dev-reload.js";

initExtensionStorage().then(() => mirrorRunControlToLocal()).catch(() => {});

let activeRun = null;
let runSessionId = 0;
const SOURCE_TAB_STAGGER_MS = 1800;
const POST_DISCOVERY_COOLDOWN_MS = 2000;
// Registration starts once this many events are verified; the rest verify during the run.
const FIRST_BATCH_TO_START = 3;
const PAGE_RATE_LIMIT_COOLDOWN_MS = 60000;

const EVENT_SOURCES = {
  lumaSf: { key: "luma-sf", label: "Luma SF", url: "https://luma.com/sf" },
  bondAi: { key: "bond-ai", label: "Bond AI", url: "https://luma.com/genai-sf" },
  cerebralValley: {
    key: "cerebral-valley",
    label: "Cerebral Valley",
    url: "https://cerebralvalley.ai/events?locations=BAY_AREA",
  },
  // Feed-based source: read over HTTP in the background, so it opens no tab.
  foundersClub: {
    key: "founders-club",
    label: "Bay Area Founders Club",
    url: FOUNDERS_CLUB_HOME_URL,
    feedBased: true,
  },
};

const SOURCE_COUNT = Object.keys(EVENT_SOURCES).length;

/** Luma lists pending invitations on the signed-in home page; no other route exposes them. */
const INVITES_URL = "https://luma.com/home";

const runControl = {
  paused: false,
  stopRequested: false,
  skipRequested: false,
};

class StopRunError extends Error {
  constructor() {
    super("Run stopped by user");
    this.name = "StopRunError";
  }
}

const ACTIVE_RUN_PHASES = new Set(["discovering", "registering", "paused"]);
const STOPPABLE_PHASES = new Set(["discovering", "registering", "paused", "stopping"]);
const FINISHED_STORAGE_PHASES = new Set(["done", "stopped", "error"]);

function assertRunSession(sessionId) {
  if (sessionId !== runSessionId) throw new StopRunError();
}

async function refreshRunControlFlags() {
  const { runPaused, runStopRequested, runSkipRequested } = await chrome.storage.session.get([
    "runPaused",
    "runStopRequested",
    "runSkipRequested",
  ]);
  runControl.paused = Boolean(runPaused);
  runControl.stopRequested = Boolean(runStopRequested);
  runControl.skipRequested = Boolean(runSkipRequested);
}

async function hydrateActiveRun() {
  if (activeRun && ACTIVE_RUN_PHASES.has(activeRun.phase)) return activeRun;
  const { runState } = await chrome.storage.local.get("runState");
  if (runState && ACTIVE_RUN_PHASES.has(runState.phase)) {
    activeRun = runState;
  }
  return activeRun;
}

async function isRunActiveFromStorage() {
  await healStaleRunState();
  await hydrateActiveRun();
  if (activeRun && ACTIVE_RUN_PHASES.has(activeRun.phase)) return true;
  const { runInProgress } = await chrome.storage.session.get("runInProgress");
  return Boolean(runInProgress);
}

/** Clear session flags when a prior run ended without cleanup (e.g. after Stop). */
async function healStaleRunState() {
  const { runInProgress, workTabId } = await chrome.storage.session.get([
    "runInProgress",
    "workTabId",
  ]);
  const { runState } = await chrome.storage.local.get("runState");
  const phase = runState?.phase;
  const activePhase = ACTIVE_RUN_PHASES.has(phase);
  const stateAge = Date.now() - Number(runState?.updatedAt || 0);

  // A panel can retain an active-looking runState after the worker has already cleaned up. Heal
  // it after a short startup grace period so the Start button cannot remain disabled forever.
  if (!runInProgress) {
    if (activePhase && stateAge > 5000) {
      await saveRunState({
        ...runState,
        phase: "stopped",
        currentEvent: null,
        error: "Previous run disconnected — start a new run",
        finishedAt: new Date().toISOString(),
      });
      activeRun = null;
    }
    return;
  }

  let workTabMissing = false;
  if (activePhase) {
    if (!workTabId) {
      workTabMissing = true;
    } else {
      try {
        await chrome.tabs.get(workTabId);
      } catch {
        workTabMissing = true;
      }
    }
  }

  if (!phase || FINISHED_STORAGE_PHASES.has(phase) || phase === "stopping" || workTabMissing) {
    if (phase === "stopping") {
      await saveRunState({
        phase: "stopped",
        current: runState?.results?.length || 0,
        total: runState?.total || 0,
        results: runState?.results || [],
        finishedAt: new Date().toISOString(),
      });
    } else if (workTabMissing) {
      await saveRunState({
        ...runState,
        phase: "stopped",
        currentEvent: null,
        error: "Registration tab was closed — start a new run",
        finishedAt: new Date().toISOString(),
      });
    }
    await endAgentRun(workTabId || null);
    await resetRunControl();
    activeRun = null;
  }
}

function isRunActive() {
  return Boolean(activeRun && ACTIVE_RUN_PHASES.has(activeRun.phase));
}

async function resetRunControl() {
  runControl.paused = false;
  runControl.stopRequested = false;
  runControl.skipRequested = false;
  await setSessionRunControl({ runPaused: false, runStopRequested: false, runSkipRequested: false });
}

async function syncRunControlFromSession() {
  await refreshRunControlFlags();
}

function throwIfStopped() {
  if (runControl.stopRequested) throw new StopRunError();
}

async function throwIfStoppedAsync() {
  await refreshRunControlFlags();
  throwIfStopped();
}

async function interruptibleSleep(ms) {
  const step = 200;
  let elapsed = 0;
  while (elapsed < ms) {
    await throwIfStoppedAsync();
    await waitIfPaused();
    const chunk = Math.min(step, ms - elapsed);
    await sleep(chunk);
    elapsed += chunk;
  }
}

/** Reject with StopRunError if user stops while a long tab message is in flight. */
async function waitForStopWhile(promise, tabId = null) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      fn(value);
    };

    const poll = setInterval(async () => {
      try {
        await refreshRunControlFlags();
        if (runControl.stopRequested) {
          if (tabId) {
            chrome.tabs.sendMessage(tabId, { type: "ABORT_RUN" }).catch(() => {});
          }
          finish(reject, new StopRunError());
        }
      } catch {
        /* ignore poll errors */
      }
    }, 200);

    promise
      .then((value) => finish(resolve, value))
      .catch((err) => finish(reject, err));
  });
}

async function waitIfPaused() {
  await refreshRunControlFlags();
  if (!runControl.paused) return;

  await hydrateActiveRun();

  if (activeRun && activeRun.phase !== "paused") {
    const pausedState = { ...activeRun, phase: "paused", resumePhase: activeRun.phase };
    activeRun = pausedState;
    await saveRunState(pausedState);
  } else if (!activeRun) {
    const { runState } = await chrome.storage.local.get("runState");
    if (runState && runState.phase !== "paused") {
      activeRun = { ...runState, phase: "paused", resumePhase: runState.phase };
      await saveRunState(activeRun);
    }
  }

  const { workTabId } = await chrome.storage.session.get("workTabId");
  await setCursorOnTab(workTabId, "Paused — click Resume in panel");

  while (runControl.paused) {
    await refreshRunControlFlags();
    throwIfStopped();
    await sleep(250);
  }

  await hydrateActiveRun();
  if (activeRun?.phase === "paused") {
    activeRun = { ...activeRun, phase: activeRun.resumePhase || "registering" };
    await saveRunState(activeRun);
  }

  if (workTabId && activeRun?.event) {
    await setCursorOnTab(
      workTabId,
      `Event ${activeRun.current}/${activeRun.total}: ${activeRun.event.title}`
    );
  } else if (workTabId && activeRun?.phase === "discovering") {
    await setCursorOnTab(workTabId, "Discovering SF events…");
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getProfile() {
  const { profile } = await chrome.storage.local.get("profile");
  return profile || DEFAULT_PROFILE;
}

async function mergeProfileAnswers(newAnswers) {
  if (!newAnswers?.length) return;

  const current = await getProfile();
  const defaults = { ...(current.default_answers || {}) };
  let changed = false;

  for (const { question, answer } of newAnswers) {
    if (!question || !answer) continue;
    const exists = Object.keys(defaults).some(
      (k) => k.toLowerCase() === question.toLowerCase()
    );
    if (!exists) {
      defaults[question] = answer;
      changed = true;
    }
  }

  if (changed) {
    await chrome.storage.local.set({
      profile: { ...current, default_answers: defaults },
    });
  }
}

/**
 * Every run-state write goes through one chain. Verification progress, content-script log lines
 * and the registration loop all read-modify-write the same object; without serialization a
 * progress patch could overwrite a result that landed a few milliseconds earlier.
 */
let runStateChain = Promise.resolve();
function withRunStateLock(fn) {
  const run = runStateChain.then(fn, fn);
  runStateChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function writeRunState(state) {
  await chrome.storage.local.set({ runState: { ...state, updatedAt: Date.now() } });
}

async function saveRunState(state) {
  return withRunStateLock(() => writeRunState(state));
}

async function appendRunLog(entry, patch = {}) {
  return withRunStateLock(async () => {
    const { runState = {} } = await chrome.storage.local.get("runState");
    const logs = trimRunLogs([...(runState.logs || []), entry]);
    const next = { ...runState, ...patch, logs };
    if (activeRun) activeRun = { ...activeRun, ...patch, logs };
    console.log("[Luma Agent]", entry.step, entry.message, entry.url || entry.href || "");
    await writeRunState(next);
    return next;
  });
}

async function logRunStep(step, message, level = "info", meta = {}) {
  return appendRunLog(createLogEntry(step, message, level, meta));
}

/** Merge fields into the persisted run state without adding a log entry. */
async function patchRunState(patch = {}) {
  return withRunStateLock(async () => {
    const { runState = {} } = await chrome.storage.local.get("runState");
    const next = { ...runState, ...patch };
    if (activeRun) activeRun = { ...activeRun, ...patch };
    await writeRunState(next);
    return next;
  });
}

async function waitForTabComplete(tabId, timeout = TAB_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearInterval(poll);
      reject(new Error("Page load timeout"));
    }, timeout);

    const poll = setInterval(async () => {
      if (settled) return;
      try {
        await refreshRunControlFlags();
        if (runControl.stopRequested) {
          settled = true;
          clearTimeout(timer);
          clearInterval(poll);
          chrome.tabs.onUpdated.removeListener(listener);
          reject(new StopRunError());
        }
      } catch {
        /* ignore */
      }
    }, 300);

    function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(poll);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);

    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete" && !settled) {
        settled = true;
        clearTimeout(timer);
        clearInterval(poll);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }).catch(() => {});
  });
}

async function ensureContentScript(tabId) {
  const scripts = [
    "lib/run-control-content.js",
    "lib/form-intelligence.js",
    "lib/form-scanner.js",
    "lib/form-agent.js",
    "lib/visual-cursor.js",
    "content.js",
  ];

  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      const ping = await chrome.tabs.sendMessage(tabId, { type: "PING" });
      if (ping?.ok) return;
    } catch {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: scripts });
      } catch {
        /* may already be injected via manifest */
      }
    }
    await interruptibleSleep(500 + attempt * 250);
  }

  throw new Error("Could not connect to page. Reload the extension and try again.");
}

/**
 * Wait until the page can actually be talked to, rather than sleeping a fixed guess.
 *
 * navigateTab already waits for the tab to report "complete", so this only covers the gap until
 * the content script answers. It keeps a short floor so Luma's client-side render settles, and the
 * original fixed wait as the ceiling — a page that is ready in 400ms no longer costs 3s.
 */
async function waitForPageSettled(tabId, { minMs = 400, maxMs = 3000, stepMs = 200 } = {}) {
  const started = Date.now();
  await interruptibleSleep(minMs);

  while (Date.now() - started < maxMs) {
    await throwIfStoppedAsync();
    try {
      const ping = await chrome.tabs.sendMessage(tabId, { type: "PING" });
      if (ping?.ok) break;
    } catch {
      /* Content script not injected yet — ensureContentScript handles that next. */
    }
    await interruptibleSleep(stepMs);
  }

  return Date.now() - started;
}

async function registerInTab(tabId, profile, event = {}) {
  await waitForPageSettled(tabId);
  await throwIfStoppedAsync();
  await ensureContentScript(tabId);

  for (let rateLimitAttempt = 0; rateLimitAttempt < 2; rateLimitAttempt++) {
    const { agentCursorActive } = await chrome.storage.session.get("agentCursorActive");
    const result = await waitForStopWhile(
      chrome.tabs.sendMessage(tabId, {
        type: "REGISTER",
        profile,
        keepCursor: Boolean(agentCursorActive),
        event: {
          title: event.title,
          slug: event.slug,
          url: event.url,
          isFree: event.isFree,
          requireApproval: event.requireApproval,
        },
      }),
      tabId
    );
    await throwIfStoppedAsync();
    if (result?.status === "aborted") {
      // A skip aborts only the current event; a stop aborts the whole run.
      const { runSkipRequested } = await chrome.storage.session.get("runSkipRequested");
      if (runSkipRequested) {
        await setSessionRunControl({ runSkipRequested: false });
        runControl.skipRequested = false;
        return { success: true, skipped: true, status: "skipped_user", message: "Skipped by user" };
      }
      throw new StopRunError();
    }

    if (result?.status !== "rate_limited" || rateLimitAttempt === 1) {
      if (result?.newAnswers?.length) await mergeProfileAnswers(result.newAnswers);
      return result;
    }

    await logRunStep(
      RUN_STEPS.NAVIGATE,
      "Luma asked us to slow down — waiting 60 seconds before one safe retry…",
      "warn",
      { eventSlug: event.slug, eventTitle: event.title }
    );
    await interruptibleSleep(PAGE_RATE_LIMIT_COOLDOWN_MS);
    await waitIfPaused();
    await navigateTab(tabId, event.url.replace("lu.ma", "luma.com"), false);
    await waitForPageSettled(tabId);
    await ensureContentScript(tabId);
  }

  return { success: false, status: "rate_limited", message: "Luma rate limit remained active" };
}

/**
 * Warm the on-device model while discovery runs. Its cold start (model load, up to two minutes
 * on first use) then overlaps the source scans instead of stalling the first custom question.
 * Fire-and-forget: the run never waits on it, and answers still work if it fails (cloud provider
 * or rule-based fallback).
 */
let localWarmupInFlight = null;
function warmLocalModelForRun() {
  if (localWarmupInFlight) return localWarmupInFlight;
  localWarmupInFlight = (async () => {
    try {
      const config = await getLlmConfig();
      if (!config.enabled) return null;
      const startedAt = Date.now();
      const result = await warmupLocalModel();
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      // Only report into a run that is still going; a finished run should not grow new lines.
      if (activeRun) {
        await logRunStep(
          RUN_STEPS.DISCOVER,
          result.ok
            ? `On-device AI ready (warmed up in ${seconds}s during discovery)`
            : `On-device AI unavailable: ${result.error} — cloud or rule-based answers will be used`,
          result.ok ? "info" : "warn"
        );
      }
      return result;
    } catch {
      return null;
    } finally {
      localWarmupInFlight = null;
    }
  })();
  return localWarmupInFlight;
}

async function openSidePanel(windowId) {
  try {
    await chrome.sidePanel.open({ windowId });
  } catch {
    /* panel may already be open */
  }
}

async function beginAgentRun(workTab) {
  await setSessionRunControl({
    agentCursorActive: true,
    workTabId: workTab.id,
    runInProgress: true,
    runPaused: false,
    runStopRequested: false,
    currentRunEvent: null,
  });
  runControl.paused = false;
  runControl.stopRequested = false;
  await openSidePanel(workTab.windowId);
}

async function endAgentRun(tabId) {
  await setSessionRunControl({
    agentCursorActive: false,
    workTabId: null,
    runInProgress: false,
    runPaused: false,
    currentRunEvent: null,
  });
  if (!tabId) return;
  try {
    await ensureContentScript(tabId);
    await chrome.tabs.sendMessage(tabId, { type: "CURSOR", action: "disable" });
  } catch {
    /* tab may be closed */
  }
}

async function setCursorOnTab(tabId, message) {
  if (!tabId) return;
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "CURSOR",
      action: "enable",
      message: message || "Luma Agent working…",
    });
  } catch {
    /* page may be loading */
  }
}

async function shouldSkipFromHistory(event) {
  const { history = [] } = await chrome.storage.local.get("history");
  const prev = history.find(
    (h) =>
      h.event?.id === event.id ||
      h.event?.url === event.url ||
      h.event?.slug === event.slug
  );

  // Fall back to the durable index for verdicts older than the 100-entry display history.
  const verdict =
    prev && shouldExcludeFromDiscoveryHistory(prev)
      ? { status: prev.status, message: prev.message }
      : findExcludeEntry(await readExcludeIndex(), event);

  if (!verdict) return null;
  return {
    event,
    success: true,
    skipped: true,
    status: verdict.status,
    message: verdict.message || "Previously handled — skipped",
    timestamp: new Date().toISOString(),
  };
}

async function shouldSkipFromFeed(event) {
  const { discoverSkipUrls = {} } = await chrome.storage.local.get("discoverSkipUrls");
  const urls = [
    event.url,
    event.altUrl,
    `https://luma.com/${event.slug}`,
    `https://lu.ma/${event.slug}`,
    `slug:${event.slug}`,
  ];

  for (const url of urls) {
    const status = discoverSkipUrls[url];
    if (!status) continue;
    if (status === "already_registered") {
      return {
        event,
        success: true,
        skipped: true,
        status: "already_registered",
        message: "Already going — skipped",
        timestamp: new Date().toISOString(),
      };
    }
    if (status === "pending_approval") {
      return {
        event,
        success: true,
        skipped: true,
        status: "pending_approval",
        message: "Pending — skipped",
        timestamp: new Date().toISOString(),
      };
    }
  }

  if (event.userRsvpStatus === "going") {
    return {
      event,
      success: true,
      skipped: true,
      status: "already_registered",
      message: "Already going — skipped",
      timestamp: new Date().toISOString(),
    };
  }
  if (event.userRsvpStatus === "pending") {
    return {
      event,
      success: true,
      skipped: true,
      status: "pending_approval",
      message: "Pending — skipped",
      timestamp: new Date().toISOString(),
    };
  }

  return null;
}

async function navigateTab(tabId, url, active = false) {
  await chrome.tabs.update(tabId, { url, active });
  await waitForTabComplete(tabId);
}

async function scanLumaSource(tabId, source, sessionId) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.status !== "complete") await waitForTabComplete(tabId);
  await waitForPageSettled(tabId, { minMs: 800, maxMs: 2500 });
  await waitIfPaused();
  assertRunSession(sessionId);
  await throwIfStoppedAsync();
  await ensureContentScript(tabId);

  const feed = await waitForStopWhile(
    chrome.tabs.sendMessage(tabId, { type: "SCAN_FEED" }),
    tabId
  );
  assertRunSession(sessionId);
  await throwIfStoppedAsync();

  return {
    source,
    rateLimited: Boolean(feed?.rateLimited),
    skipUrls: feed?.skipUrls || {},
    prioritySlugs: feed?.prioritySlugs || [],
    events: (feed?.eventLinks || []).map((event) => ({ ...event, source: source.key })),
  };
}

/**
 * Registration queue. Verification pushes events in as Luma confirms them, so registering starts
 * after the first few instead of after the whole pass; the remaining lookups overlap the run.
 */
function createRunQueue() {
  return {
    pending: [],
    seen: new Set(),
    done: false,
    closed: false,
    rateLimitStopped: false,
    stats: null,
    progress: null,
    error: null,
    keepOrder: false,
  };
}

function queueFromArray(events = []) {
  const queue = createRunQueue();
  queue.keepOrder = true;
  for (const event of events) queuePush(queue, event);
  queue.done = true;
  return queue;
}

function queuePush(queue, event) {
  if (!event?.slug || queue.seen.has(event.slug)) return false;
  queue.seen.add(event.slug);
  queue.pending.push(event);
  if (!queue.keepOrder) queue.pending.sort(compareEligibleEvents);
  return true;
}

/** Take the next event. A page that is already preloaded wins; otherwise the best-ranked one. */
function queueTake(queue, preferSlug = null) {
  if (!queue.pending.length) return null;
  let index = preferSlug ? queue.pending.findIndex((e) => e.slug === preferSlug) : -1;
  if (index < 0) index = 0;
  return queue.pending.splice(index, 1)[0];
}

function snapshotUpcoming(queue) {
  return queue.pending.map((e) => ({ title: e.title, slug: e.slug, url: e.url }));
}

/**
 * Two tabs alternate. While one event registers and the run waits out the registration gap, the
 * next event's page loads in the other tab, so switching events is a tab switch rather than a
 * page load followed by a pause.
 */
const tabPool = { workTabId: null, prefetchTabId: null, prefetchUrl: null, prefetchSlug: null };

function resetTabPool() {
  tabPool.workTabId = null;
  tabPool.prefetchTabId = null;
  tabPool.prefetchUrl = null;
  tabPool.prefetchSlug = null;
}

function eventPageUrl(event) {
  return String(event?.url || "").replace("lu.ma", "luma.com");
}

async function prefetchEventPage(event) {
  const url = eventPageUrl(event);
  if (!url || tabPool.prefetchUrl === url) return;
  try {
    if (tabPool.prefetchTabId) {
      await chrome.tabs.update(tabPool.prefetchTabId, { url, active: false });
    } else {
      const tab = await chrome.tabs.create({ url, active: false });
      tabPool.prefetchTabId = tab.id;
    }
    tabPool.prefetchUrl = url;
    tabPool.prefetchSlug = event.slug;
  } catch {
    tabPool.prefetchTabId = null;
    tabPool.prefetchUrl = null;
    tabPool.prefetchSlug = null;
  }
}

/** Bring a preloaded tab forward as the work tab; the old work tab becomes the next preload slot. */
async function swapInPrefetchedTab(url) {
  if (!tabPool.prefetchTabId || tabPool.prefetchUrl !== url) return false;
  try {
    const tab = await chrome.tabs.get(tabPool.prefetchTabId);
    const current = String(tab.pendingUrl || tab.url || "").split(/[?#]/)[0];
    // A redirect (sign-in, rate-limit page) means the preload is not the event page.
    if (current && current !== url) return false;
    await chrome.tabs.update(tabPool.prefetchTabId, { active: true });
    const previousWork = tabPool.workTabId;
    tabPool.workTabId = tabPool.prefetchTabId;
    tabPool.prefetchTabId = previousWork;
    tabPool.prefetchUrl = null;
    tabPool.prefetchSlug = null;
    await setSessionRunControl({ workTabId: tabPool.workTabId });
    return true;
  } catch {
    tabPool.prefetchTabId = null;
    tabPool.prefetchUrl = null;
    tabPool.prefetchSlug = null;
    return false;
  }
}

/** The best pending event that will not be skipped without opening it. */
async function nextPrefetchCandidate(queue) {
  for (const event of queue.pending) {
    if (await shouldSkipFromHistory(event)) continue;
    if (await shouldSkipFromFeed(event)) continue;
    return event;
  }
  return null;
}

async function finishAgentTabs(fallbackTabId) {
  await endAgentRun(tabPool.workTabId || fallbackTabId);
  if (tabPool.prefetchTabId) await closeTabsSafely([tabPool.prefetchTabId]);
  resetTabPool();
}

async function processRun(source, profile, tabId, sessionId, { maxResults = MAX_EVENTS } = {}) {
  const queue = Array.isArray(source) ? queueFromArray(source) : source;
  tabPool.workTabId = tabId;
  const results = [];
  let currentProfile = profile;
  let navigated = false;
  let index = 0;
  let waitingLogged = false;
  let haltedByRateLimit = false;

  const recordSkip = async (event, skip, level = "info") => {
    results.push(skip);
    await appendRunLog(
      createLogEntry(RUN_STEPS.SKIP, skip.message || "Skipped", level, {
        eventSlug: event.slug,
        eventTitle: event.title,
      }),
      { currentEvent: null, skipRequested: false, results: [...results], upcoming: snapshotUpcoming(queue) }
    );
    await chrome.storage.session.set({ currentRunEvent: null });
  };

  try {
    while (true) {
      assertRunSession(sessionId);
      await throwIfStoppedAsync();
      await waitIfPaused();

      if (results.length >= maxResults) break;
      if (queue.rateLimitStopped) {
        haltedByRateLimit = true;
        break;
      }
      if (!queue.pending.length) {
        if (queue.done) break;
        if (!waitingLogged) {
          waitingLogged = true;
          await logRunStep(RUN_STEPS.NAVIGATE, "Waiting for the next verified event…", "info");
        }
        await interruptibleSleep(400);
        continue;
      }
      waitingLogged = false;

      // Clear any skip request left over from a previous event so a later Stop is never
      // mistaken for a skip.
      if (runControl.skipRequested) {
        runControl.skipRequested = false;
        await setSessionRunControl({ runSkipRequested: false });
      }

      const event = queueTake(queue, tabPool.prefetchSlug);
      index += 1;
      const knownTotal = results.length + 1 + queue.pending.length;
      await chrome.storage.session.set({ currentRunEvent: event });

      const afterNavLog = await appendRunLog(
        createLogEntry(
          RUN_STEPS.NAVIGATE,
          `Event ${index}${queue.done ? `/${knownTotal}` : ` of ${knownTotal}+`}: ${event.title}`,
          "info",
          { eventSlug: event.slug, eventTitle: event.title, eventUrl: event.url }
        ),
        {
          phase: "registering",
          current: index,
          total: knownTotal,
          currentEvent: event,
          results: [...results],
          upcoming: snapshotUpcoming(queue),
          discovery: queue.progress || null,
        }
      );

      activeRun = afterNavLog;
      chrome.action.setBadgeText({ text: String(index) });
      chrome.action.setBadgeBackgroundColor({ color: "#6366f1" });

      const historySkip = await shouldSkipFromHistory(event);
      if (historySkip) {
        await recordSkip(event, historySkip);
        await appendHistory(historySkip);
        continue;
      }

      const feedSkip = await shouldSkipFromFeed(event);
      if (feedSkip) {
        await recordSkip(event, feedSkip);
        await appendHistory(feedSkip);
        continue;
      }

      try {
        await throwIfStoppedAsync();
        const eventUrl = eventPageUrl(event);
        if (!isValidEventHref(eventUrl)) {
          await recordSkip(
            event,
            {
              event,
              success: false,
              status: "skipped_invalid",
              message: "Not an event page — skipped",
              timestamp: new Date().toISOString(),
            },
            "warn"
          );
          continue;
        }

        const preloaded = await swapInPrefetchedTab(eventUrl);
        if (preloaded) {
          await logRunStep(RUN_STEPS.NAVIGATE, `Opening preloaded page: ${event.url}`, "info", {
            eventSlug: event.slug,
            eventTitle: event.title,
            eventUrl: event.url,
          });
          await waitForTabComplete(tabPool.workTabId);
        } else {
          await setCursorOnTab(tabPool.workTabId, `Loading ${index}: ${event.title}`);
          await logRunStep(RUN_STEPS.NAVIGATE, `Navigating to ${event.url}`, "info", {
            eventSlug: event.slug,
            eventTitle: event.title,
            eventUrl: event.url,
          });
          await navigateTab(tabPool.workTabId, eventUrl, !navigated);
        }
        navigated = true;
        await throwIfStoppedAsync();
        await ensureContentScript(tabPool.workTabId);
        await setCursorOnTab(tabPool.workTabId, `Event ${index}: ${event.title}`);
        const result = await registerInTab(tabPool.workTabId, currentProfile, event);

        const entry = { event, ...result, timestamp: new Date().toISOString() };
        results.push(entry);

        const logLevel = entry.success ? (entry.skipped ? "info" : "success") : "error";
        await appendRunLog(
          createLogEntry(
            entry.skipped ? RUN_STEPS.SKIP : entry.success ? RUN_STEPS.DONE : RUN_STEPS.ERROR,
            entry.message || entry.status || "Finished",
            logLevel,
            { eventSlug: event.slug, eventTitle: event.title, status: entry.status }
          ),
          { currentEvent: null, skipRequested: false, results: [...results], upcoming: snapshotUpcoming(queue) }
        );

        await appendHistory(entry);
        currentProfile = await getProfile();

        if (entry.status === "rate_limited") {
          await chrome.storage.session.set({ currentRunEvent: null });
          queue.closed = true;
          const { runState: latestRateState = {} } = await chrome.storage.local.get("runState");
          const stopped = {
            phase: "stopped",
            current: results.length,
            total: results.length + queue.pending.length,
            results,
            stats: queue.stats || null,
            error:
              "Luma rate limit remained active after a 60-second retry. The run stopped safely; no additional event pages were opened.",
            logs: latestRateState.logs || [],
            finishedAt: new Date().toISOString(),
          };
          activeRun = null;
          await saveRunState(stopped);
          await logRunStep(RUN_STEPS.DONE, stopped.error, "warn");
          chrome.action.setBadgeText({ text: "■" });
          chrome.action.setBadgeBackgroundColor({ color: "#71717a" });
          return stopped;
        }
      } catch (err) {
        if (err instanceof StopRunError) throw err;
        const errEntry = {
          event,
          success: false,
          status: "error",
          message: err.message,
          timestamp: new Date().toISOString(),
        };
        results.push(errEntry);
        await appendRunLog(
          createLogEntry(RUN_STEPS.ERROR, err.message, "error", {
            eventSlug: event.slug,
            eventTitle: event.title,
          }),
          { currentEvent: null, skipRequested: false, results: [...results], upcoming: snapshotUpcoming(queue) }
        );
      }

      await chrome.storage.session.set({ currentRunEvent: null });

      const moreToCome = queue.pending.length > 0 || !queue.done;
      if (moreToCome && results.length < maxResults) {
        // Start loading the next page now so it is ready when the gap ends. Page loads keep the
        // same spacing as before: one per registration gap.
        const next = await nextPrefetchCandidate(queue);
        if (next) {
          await prefetchEventPage(next);
          await setCursorOnTab(tabPool.workTabId, `Done — preparing next: ${next.title}`);
        }
        await interruptibleSleep(REGISTRATION_DELAY_MS + Math.floor(Math.random() * 4000));
      }
    }
  } finally {
    queue.closed = true;
  }

  const stopped = runControl.stopRequested;
  const { runState: latest = {} } = await chrome.storage.local.get("runState");
  const finalState = {
    phase: stopped || haltedByRateLimit ? "stopped" : "done",
    current: results.length,
    total: results.length + queue.pending.length,
    results,
    stats: queue.stats || null,
    logs: latest.logs || [],
    finishedAt: new Date().toISOString(),
  };
  if (haltedByRateLimit) {
    finalState.error =
      "Luma rate limit is active. The run stopped safely without opening more event pages. Please try again later.";
  }

  activeRun = null;
  await saveRunState(finalState);
  await logRunStep(
    RUN_STEPS.DONE,
    finalState.error || (stopped ? "Run stopped" : `Run complete — ${results.length} events`),
    finalState.error ? "warn" : "info"
  );
  chrome.action.setBadgeText({ text: finalState.phase === "stopped" ? "■" : "✓" });
  chrome.action.setBadgeBackgroundColor({ color: finalState.phase === "stopped" ? "#71717a" : "#22c55e" });

  return finalState;
}

/**
 * Read the exclusion index, seeding it from the display history the first time so exclusions
 * recorded before this index existed are carried over rather than lost.
 */
async function readExcludeIndex() {
  const stored = await chrome.storage.local.get([EXCLUDE_INDEX_KEY, "history"]);
  const existing = stored?.[EXCLUDE_INDEX_KEY];
  if (existing && typeof existing === "object") return existing;

  const seeded = buildExcludeIndexFromHistory(stored?.history || []);
  await chrome.storage.local.set({ [EXCLUDE_INDEX_KEY]: seeded });
  return seeded;
}

/**
 * `history` stays a capped display list. The exclusion index is written alongside it and is not
 * capped at 100, so a verdict from twenty runs ago still prevents the event being reopened.
 */
async function appendHistory(entry) {
  const { history = [] } = await chrome.storage.local.get("history");
  history.unshift(entry);

  const index = await readExcludeIndex();
  addToExcludeIndex(index, entry);

  await chrome.storage.local.set({
    history: history.slice(0, 100),
    [EXCLUDE_INDEX_KEY]: pruneExcludeIndex(index),
  });
}

async function getHistoryExcludeIds() {
  const { history = [] } = await chrome.storage.local.get("history");
  const index = await readExcludeIndex();
  // Union so an entry recorded in this session is honoured even before the index is written.
  return new Set([...excludeIdsFromIndex(index), ...buildHistoryExcludeIds(history)]);
}

/** Ensure the Cerebral Valley harvester content script is live in the tab. */
async function ensureCvScript(tabId) {
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const ping = await chrome.tabs.sendMessage(tabId, { type: "PING" });
      if (ping?.cv) return;
    } catch {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ["lib/cv-discovery.js"] });
      } catch {
        /* may already be injected via manifest */
      }
    }
    await interruptibleSleep(400 + attempt * 200);
  }
  throw new Error("Could not load the Cerebral Valley scanner. Reload the extension and try again.");
}

/**
 * Discover Luma events from Cerebral Valley (Bay Area). Harvests direct Luma links from the events
 * list, then resolves CV /e/<slug> detail pages to their outbound Luma link (skipping Meetup /
 * Eventbrite events). Returns Luma event objects for the normal registration pipeline, which itself
 * skips anything already registered.
 */
async function discoverCerebralValleyEvents(tabId, sessionId) {
  const cvTab = await chrome.tabs.get(tabId).catch(() => null);
  if (cvTab && cvTab.status !== "complete") await waitForTabComplete(tabId);
  await interruptibleSleep(800);
  throwIfStopped();
  await ensureCvScript(tabId);

  let harvest = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    harvest = await waitForStopWhile(
      chrome.tabs.sendMessage(tabId, { type: "CV_HARVEST" }),
      tabId
    );
    const found = (harvest?.luma?.length || 0) + (harvest?.cvDetail?.length || 0);
    if (found > 0) break;
    if (attempt < 2) {
      await logRunStep(
        RUN_STEPS.DISCOVER,
        `Cerebral Valley returned no event links — retrying (${attempt + 2}/3)…`,
        "warn"
      );
      await interruptibleSleep(2500 + attempt * 1500);
      await waitIfPaused();
    }
  }
  assertRunSession(sessionId);
  await throwIfStoppedAsync();

  const counts = harvest?.counts || {};
  const lumaUrls = new Set(harvest?.luma || []);
  const titles = new Map();
  const cvDetail = harvest?.cvDetail || [];

  await logRunStep(
    RUN_STEPS.DISCOVER,
    `Cerebral Valley: ${lumaUrls.size} direct Luma · ${cvDetail.length} CV pages · ${counts.meetup || 0} Meetup · ${counts.eventbrite || 0} Eventbrite`,
    "info",
    { counts, cvDetail: cvDetail.length }
  );

  // Resolve CV detail pages to their Luma link. Each hop is a full page load, so this is the most
  // expensive part of discovery — and with four sources feeding the queue, Cerebral Valley only
  // needs to supply its fair share of the batch rather than fill it alone. Stopping at that share
  // cuts the hops roughly threefold without changing what the interleaved ranking picks.
  const cvTarget = Math.max(8, Math.ceil(MAX_EVENTS / SOURCE_COUNT));
  const detailCap = Math.min(cvDetail.length, cvTarget * 2);
  for (let i = 0; i < detailCap && lumaUrls.size < cvTarget; i++) {
    await throwIfStoppedAsync();
    await waitIfPaused();
    const d = cvDetail[i];
    try {
      await navigateTab(tabId, d.url, false);
      await waitForPageSettled(tabId, { minMs: 300, maxMs: 1800 });
      await ensureCvScript(tabId);
      const res = await chrome.tabs.sendMessage(tabId, { type: "CV_EXTRACT_LUMA" }).catch(() => null);
      if (res?.luma) {
        lumaUrls.add(res.luma);
        titles.set(res.luma, res.title || d.title);
        await logRunStep(RUN_STEPS.DISCOVER, `↳ Luma: ${d.title || d.slug}`, "info", { eventUrl: res.luma });
      } else {
        await logRunStep(
          RUN_STEPS.DISCOVER,
          `↳ ${res?.platform || "no Luma link"} — skipped: ${d.title || d.slug}`,
          "info"
        );
      }
    } catch {
      /* skip unreachable CV detail page */
    }
  }

  const events = [...lumaUrls].slice(0, MAX_EVENTS).map((url) => {
    const slug = url.split("/").filter(Boolean).pop();
    return { url, slug, title: titles.get(url) || slug, source: "cerebralvalley" };
  });

  return { events, counts, cvDetailCount: cvDetail.length };
}

/**
 * Discover Luma events from the Bay Area Founders Club weekly newsletter. Reads the publication's
 * public RSS feed directly — no tab, no content script — and returns the Luma links listed in the
 * most recent "Bay Area Events For The Week Of ..." post for the normal registration pipeline.
 */
async function scanFoundersClub(sessionId) {
  const source = EVENT_SOURCES.foundersClub;
  assertRunSession(sessionId);
  await throwIfStoppedAsync();
  await waitIfPaused();

  const result = await waitForStopWhile(discoverFoundersClubEvents());
  assertRunSession(sessionId);
  await throwIfStoppedAsync();

  if (!result.postTitle) {
    await logRunStep(
      RUN_STEPS.DISCOVER,
      `${source.label}: no weekly events post found in the feed (${result.feedItems} posts scanned)`,
      "warn"
    );
    return { source, rateLimited: false, skipUrls: {}, prioritySlugs: [], events: [] };
  }

  await logRunStep(
    RUN_STEPS.DISCOVER,
    `${source.label}: "${result.postTitle}"${result.cached ? " (cached)" : ""} — ${result.events.length} Luma link${result.events.length === 1 ? "" : "s"}`,
    "info",
    { postUrl: result.postUrl, pubDate: result.pubDate, ageDays: result.ageDays }
  );

  if (result.stale) {
    await logRunStep(
      RUN_STEPS.DISCOVER,
      `${source.label} post is ${result.ageDays} days old — past events are filtered during verification`,
      "warn"
    );
  }

  return {
    source,
    rateLimited: false,
    skipUrls: {},
    prioritySlugs: result.events.map((event) => event.slug),
    events: result.events.map((event) => ({ ...event, source: source.key })),
  };
}

async function closeTabsSafely(tabIds = []) {
  await Promise.all(
    tabIds.filter(Boolean).map((tabId) => chrome.tabs.remove(tabId).catch(() => {}))
  );
}

async function startRun() {
  await syncRunControlFromSession();
  await healStaleRunState();
  if (await isRunActiveFromStorage()) {
    return { ok: false, error: "A run is already in progress" };
  }

  const sessionId = ++runSessionId;
  await resetRunControl();
  let workTabId = null;
  let auxiliaryTabIds = [];

  activeRun = { phase: "discovering", current: 0, total: MAX_EVENTS, results: [], logs: [] };
  await saveRunState(activeRun);
  await logRunStep(
      RUN_STEPS.DISCOVER,
      `Scanning all ${SOURCE_COUNT} event sources together…`
    );
  chrome.action.setBadgeText({ text: "…" });
  warmLocalModelForRun();

  try {
    // Stagger the two Luma page loads, then scan all three pages concurrently once loaded.
    const workTab = await chrome.tabs.create({ url: EVENT_SOURCES.lumaSf.url, active: true });
    await interruptibleSleep(SOURCE_TAB_STAGGER_MS);
    const [bondTab, cvTab] = await Promise.all([
      chrome.tabs.create({ url: EVENT_SOURCES.bondAi.url, active: false }),
      chrome.tabs.create({ url: EVENT_SOURCES.cerebralValley.url, active: false }),
    ]);
    workTabId = workTab.id;
    auxiliaryTabIds = [bondTab.id, cvTab.id];
    await beginAgentRun(workTab);
    await throwIfStoppedAsync();
    await waitIfPaused();

    const profile = await getProfile();
    const scans = await Promise.allSettled([
      scanLumaSource(workTab.id, EVENT_SOURCES.lumaSf, sessionId),
      scanLumaSource(bondTab.id, EVENT_SOURCES.bondAi, sessionId),
      discoverCerebralValleyEvents(cvTab.id, sessionId),
      // Feed-based, so it runs alongside the tab scans without needing one of its own.
      scanFoundersClub(sessionId),
    ]);
    assertRunSession(sessionId);
    await throwIfStoppedAsync();
    await waitIfPaused();

    const scraped = [];
    const prioritySlugs = [];
    const combinedSkipUrls = {};
    let sourceRateLimited = false;
    const sourceCounts = {
      [EVENT_SOURCES.lumaSf.key]: 0,
      [EVENT_SOURCES.bondAi.key]: 0,
      [EVENT_SOURCES.cerebralValley.key]: 0,
      [EVENT_SOURCES.foundersClub.key]: 0,
    };
    // Index-aligned with the Promise.allSettled fan-out above.
    const orderedSources = [
      EVENT_SOURCES.lumaSf,
      EVENT_SOURCES.bondAi,
      EVENT_SOURCES.cerebralValley,
      EVENT_SOURCES.foundersClub,
    ];

    for (let i = 0; i < scans.length; i++) {
      const scan = scans[i];
      const sourceInfo = orderedSources[i];
      if (scan.status === "rejected") {
        await logRunStep(
          RUN_STEPS.DISCOVER,
          `${sourceInfo.label} scan failed: ${scan.reason?.message || "unknown error"}`,
          "warn"
        );
        continue;
      }

      const value = scan.value || {};
      if (value.rateLimited) {
        sourceRateLimited = true;
        await logRunStep(
          RUN_STEPS.DISCOVER,
          `${sourceInfo.label} returned a Luma rate-limit page — stopping safely`,
          "warn"
        );
        continue;
      }
      const sourceEvents = (value.events || []).map((event) => ({
        ...event,
        source: sourceInfo.key,
      }));
      sourceCounts[sourceInfo.key] = sourceEvents.length;
      scraped.push(...sourceEvents);
      Object.assign(combinedSkipUrls, value.skipUrls || {});
      for (const slug of value.prioritySlugs || sourceEvents.map((event) => event.slug)) {
        if (slug && !prioritySlugs.includes(slug)) prioritySlugs.push(slug);
      }

      await logRunStep(
        RUN_STEPS.DISCOVER,
        `${sourceInfo.label}: ${sourceEvents.length} Luma event link${sourceEvents.length === 1 ? "" : "s"}`,
        "info"
      );
    }

    const { discoverSkipUrls = {} } = await chrome.storage.local.get("discoverSkipUrls");
    await chrome.storage.local.set({
      discoverSkipUrls: { ...discoverSkipUrls, ...combinedSkipUrls },
      feedPrioritySlugs: prioritySlugs,
    });

    await closeTabsSafely(auxiliaryTabIds);
    auxiliaryTabIds = [];

    if (sourceRateLimited) {
      const msg =
        "Luma rate limit is already active on a source page. The run stopped without making verification requests or opening events.";
      const stopped = {
        phase: "stopped",
        current: 0,
        total: 0,
        results: [],
        error: msg,
        logs: (await chrome.storage.local.get("runState")).runState?.logs || [],
      };
      await saveRunState(stopped);
      await logRunStep(RUN_STEPS.DONE, msg, "warn");
      chrome.action.setBadgeText({ text: "■" });
      chrome.action.setBadgeBackgroundColor({ color: "#71717a" });
      return { ok: true, ...stopped };
    }

    const excludeIds = await getHistoryExcludeIds();
    const queue = createRunQueue();
    let lastProgressLogAt = 0;

    const perSource = orderedSources
      .map((source) => `${source.label} ${sourceCounts[source.key] || 0}`)
      .join(" · ");
    await logRunStep(RUN_STEPS.DISCOVER, `Sources synced (${SOURCE_COUNT}): ${perSource}`, "info", {
      sourceCounts,
    });

    // Verification streams into the queue. Registration starts after the first few confirmed
    // events instead of after the whole pass; the remaining lookups overlap the registration gaps.
    const verification = discoverScrapedEventsWithStats(scraped, MAX_EVENTS, excludeIds, {
      shouldStop: () => runControl.stopRequested || runSessionId !== sessionId || queue.closed,
      onEvent: (event) => {
        queuePush(queue, event);
      },
      onProgress: async ({ verified, total, ready, found }) => {
        queue.progress = { verified, total, ready, found, done: false };
        const now = Date.now();
        if (verified !== total && now - lastProgressLogAt < 1500) {
          await patchRunState({ discovery: queue.progress, upcoming: snapshotUpcoming(queue) });
          return;
        }
        lastProgressLogAt = now;
        await appendRunLog(
          createLogEntry(
            RUN_STEPS.DISCOVER,
            `Verifying ${verified}/${total} links · ${ready} ready to register`,
            "info"
          ),
          { discovery: queue.progress, upcoming: snapshotUpcoming(queue) }
        );
      },
    })
      .then(async (disc) => {
        queue.stats = { ...disc.stats, sourceCounts, source: "all" };
        queue.rateLimitStopped = Boolean(disc.stats.rateLimitStopped);
        queue.progress = { ...(queue.progress || {}), done: true };
        queue.done = true;
        await appendRunLog(
          createLogEntry(
            RUN_STEPS.DISCOVER,
            `Verification complete — ${disc.stats.totalScraped} unique links · ${disc.stats.hydrated} verified events · ${disc.stats.newRegisterable} registerable` +
              (disc.stats.cacheHits ? ` · ${disc.stats.cacheHits} from cache` : ""),
            "info",
            { stats: queue.stats }
          ),
          { stats: queue.stats, discovery: queue.progress }
        );
        if (disc.stats.rateLimitRetries > 0) {
          await logRunStep(
            RUN_STEPS.DISCOVER,
            `Luma rate limit handled safely (${disc.stats.rateLimitRetries} delayed retry${disc.stats.rateLimitRetries === 1 ? "" : "ies"})`,
            "warn"
          );
        }
        return disc;
      })
      .catch(async (err) => {
        queue.error = err;
        queue.done = true;
        await logRunStep(RUN_STEPS.DISCOVER, `Verification failed: ${err.message}`, "error");
        return null;
      });

    await logRunStep(
      RUN_STEPS.DISCOVER,
      `Verifying ${scraped.length} links with Luma — registration starts once ${FIRST_BATCH_TO_START} are confirmed…`
    );

    while (!queue.done && queue.pending.length < FIRST_BATCH_TO_START) {
      assertRunSession(sessionId);
      await throwIfStoppedAsync();
      await waitIfPaused();
      await interruptibleSleep(300);
    }
    assertRunSession(sessionId);
    await throwIfStoppedAsync();
    await waitIfPaused();

    if (queue.done && queue.error) throw queue.error;

    if (queue.done && !queue.pending.length) {
      const stats = queue.stats || {};
      const logs = (await chrome.storage.local.get("runState")).runState?.logs || [];
      if (stats.rateLimitStopped) {
        const msg =
          "Luma rate limit is still active. The run stopped safely without opening more event pages. Please try again later.";
        const stopped = { phase: "stopped", current: 0, total: 0, events: [], results: [], error: msg, stats, logs };
        await saveRunState(stopped);
        await logRunStep(RUN_STEPS.DONE, msg, "warn");
        chrome.action.setBadgeText({ text: "■" });
        chrome.action.setBadgeBackgroundColor({ color: "#71717a" });
        return { ok: true, ...stopped };
      }
      const msg =
        stats.lookupFailed > 0 && stats.hydrated === 0
          ? `Could not verify Luma events (${stats.lookupFailed} lookup failures) — please retry`
          : stats.newRegisterable === 0 && stats.freeRegisterable > 0
          ? `No new events (${stats.freeRegisterable} registerable on Luma — ${stats.totalSF} SF total; retryable skips are included again)`
          : stats.totalSF > 0
            ? `No registerable events after verification (${stats.rejectedNonEvents || 0} non-event pages and ${stats.rejectedIneligible || 0} ineligible events removed)`
            : "No registerable SF events found";
      const empty = { phase: "done", current: 0, total: 0, results: [], error: msg, stats, logs };
      await saveRunState(empty);
      chrome.action.setBadgeText({ text: "" });
      return { ok: true, ...empty };
    }

    const upcomingList = snapshotUpcoming(queue);
    await logRunStep(
      RUN_STEPS.DISCOVER,
      queue.done
        ? `Discovery complete — ${queue.pending.length} events queued, opening the first…`
        : `${queue.pending.length} events confirmed — opening the first while verification continues…`,
      "info"
    );
    await interruptibleSleep(POST_DISCOVERY_COOLDOWN_MS);
    await waitIfPaused();
    await throwIfStoppedAsync();

    const registering = {
      phase: "registering",
      current: 0,
      total: queue.pending.length,
      results: [],
      upcoming: upcomingList,
      stats: queue.stats || null,
      discovery: queue.progress || null,
      logs: (await chrome.storage.local.get("runState")).runState?.logs || [],
    };
    await saveRunState(registering);
    activeRun = { ...registering };

    const final = await processRun(queue, profile, workTab.id, sessionId);
    await verification;
    return { ok: true, ...final };
  } catch (err) {
    if (err instanceof StopRunError) {
      const { runState } = await chrome.storage.local.get("runState");
      const stopped = {
        phase: "stopped",
        current: runState?.results?.length || 0,
        total: runState?.total || 0,
        results: runState?.results || [],
        finishedAt: new Date().toISOString(),
      };
      activeRun = null;
      await saveRunState(stopped);
      chrome.action.setBadgeText({ text: "■" });
      chrome.action.setBadgeBackgroundColor({ color: "#71717a" });
      return { ok: true, ...stopped };
    }

    const errorState = { phase: "error", error: err.message, results: [] };
    await saveRunState(errorState);
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
    return { ok: false, error: err.message };
  } finally {
    await finishAgentTabs(workTabId);
    await resetRunControl();
    activeRun = null;
    await closeTabsSafely(auxiliaryTabIds);
  }
}

/**
 * Accept pending Luma invitations. Invitations are listed on luma.com/home; each one is opened and
 * handed to the same content-script pipeline that handles discovered events, so every filter the
 * user configured — paid, women-only, virtual, sold out, ended, excluded keywords, already
 * handled — is applied identically here. Anything that fails a check is left pending rather than
 * declined: the agent never turns an invitation down on the user's behalf.
 */
async function startInviteRun() {
  await syncRunControlFromSession();
  await healStaleRunState();
  if (await isRunActiveFromStorage()) {
    return { ok: false, error: "A run is already in progress" };
  }

  const sessionId = ++runSessionId;
  await resetRunControl();
  let workTabId = null;

  activeRun = { phase: "discovering", current: 0, total: 0, results: [], logs: [] };
  await saveRunState(activeRun);
  await logRunStep(RUN_STEPS.DISCOVER, "Checking Luma for pending invitations…");
  chrome.action.setBadgeText({ text: "…" });
  warmLocalModelForRun();

  try {
    const workTab = await chrome.tabs.create({ url: INVITES_URL, active: true });
    workTabId = workTab.id;
    await beginAgentRun(workTab);
    await waitForTabComplete(workTab.id);
    await interruptibleSleep(2500);
    await throwIfStoppedAsync();
    await waitIfPaused();
    await ensureContentScript(workTab.id);

    const scan = await waitForStopWhile(
      chrome.tabs.sendMessage(workTab.id, { type: "SCAN_INVITES" }),
      workTab.id
    );
    assertRunSession(sessionId);
    await throwIfStoppedAsync();

    if (scan?.rateLimited) {
      return await finishInviteRun(
        "Luma rate limit is active — stopped without opening any invitation.",
        "warn"
      );
    }

    if (scan?.loggedIn === false) {
      return await finishInviteRun("Please sign in to Luma first", "warn");
    }

    const { discoverSkipUrls = {} } = await chrome.storage.local.get("discoverSkipUrls");
    await chrome.storage.local.set({
      discoverSkipUrls: { ...discoverSkipUrls, ...(scan?.skipUrls || {}) },
    });

    const excludeIds = await getHistoryExcludeIds();
    const found = (scan?.invites || []).map((invite) => ({ ...invite, source: "invitations" }));
    // Drop invitations already handled in a previous run. processRun re-checks each event against
    // history too; this only avoids opening tabs we know will be skipped.
    //
    // Excluded-keyword and women-only checks run here as well as on the page: those two filters
    // live in the discovery layer, which invitations bypass, so applying them to the card title
    // means a clearly unwanted invitation is never even opened.
    const rejected = [];
    const invites = found
      .filter((invite) => !excludeIds.has(invite.slug) && !excludeIds.has(`slug:${invite.slug}`))
      .filter((invite) => {
        const title = String(invite.title || "").toLowerCase();
        const keyword = EXCLUDE_KEYWORDS.find((word) => title.includes(word));
        if (keyword) {
          rejected.push({ invite, reason: `excluded keyword "${keyword}"` });
          return false;
        }
        if (isWomenOnlyEvent({ title: invite.title })) {
          rejected.push({ invite, reason: "women-only event" });
          return false;
        }
        return true;
      })
      .slice(0, MAX_EVENTS);

    for (const { invite, reason } of rejected) {
      await logRunStep(RUN_STEPS.SKIP, `Left pending — ${reason}: ${invite.title}`, "info", {
        eventSlug: invite.slug,
        eventTitle: invite.title,
      });
    }

    await logRunStep(
      RUN_STEPS.DISCOVER,
      `Invitations: ${found.length} found · ${rejected.length} left pending · ${invites.length} to review`,
      "info",
      { found: found.length, queued: invites.length, rejected: rejected.length }
    );

    if (!invites.length) {
      return await finishInviteRun(
        found.length
          ? "All pending invitations were already handled"
          : "No pending invitations found",
        "info"
      );
    }

    const profile = await getProfile();
    const upcomingList = invites.map((e) => ({ title: e.title, slug: e.slug, url: e.url }));
    const stats = { source: "invitations", invitesFound: found.length, invitesQueued: invites.length };

    await interruptibleSleep(POST_DISCOVERY_COOLDOWN_MS);
    await waitIfPaused();
    await throwIfStoppedAsync();

    const registering = {
      phase: "registering",
      current: 0,
      total: invites.length,
      events: invites,
      results: [],
      upcoming: upcomingList,
      stats,
      logs: (await chrome.storage.local.get("runState")).runState?.logs || [],
    };
    await saveRunState(registering);
    activeRun = registering;

    const final = await processRun(invites, profile, workTab.id, sessionId);
    return { ok: true, ...final };
  } catch (err) {
    if (err instanceof StopRunError) {
      const { runState } = await chrome.storage.local.get("runState");
      const stopped = {
        phase: "stopped",
        current: runState?.results?.length || 0,
        total: runState?.total || 0,
        results: runState?.results || [],
        finishedAt: new Date().toISOString(),
      };
      activeRun = null;
      await saveRunState(stopped);
      chrome.action.setBadgeText({ text: "■" });
      chrome.action.setBadgeBackgroundColor({ color: "#71717a" });
      return { ok: true, ...stopped };
    }

    const errorState = { phase: "error", error: err.message, results: [] };
    await saveRunState(errorState);
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
    return { ok: false, error: err.message };
  } finally {
    await finishAgentTabs(workTabId);
    await resetRunControl();
    activeRun = null;
  }
}

/** Close out an invitation run that ended before any invitation was opened. */
async function finishInviteRun(message, level = "info") {
  const { runState } = await chrome.storage.local.get("runState");
  const done = {
    phase: "done",
    current: 0,
    total: 0,
    results: [],
    error: message,
    logs: runState?.logs || [],
    finishedAt: new Date().toISOString(),
  };
  await saveRunState(done);
  await logRunStep(RUN_STEPS.DONE, message, level);
  chrome.action.setBadgeText({ text: "" });
  return { ok: true, ...done };
}

async function pauseRun() {
  await refreshRunControlFlags();
  const active = await isRunActiveFromStorage();
  if (!active) return { ok: false, error: "No active run" };

  runControl.paused = true;
  await setSessionRunControl({ runPaused: true });

  await hydrateActiveRun();
  const { runState } = await chrome.storage.local.get("runState");
  const base = activeRun || runState;

  if (base && base.phase !== "paused") {
    activeRun = { ...base, phase: "paused", resumePhase: base.phase };
    await saveRunState(activeRun);
  }

  const { workTabId } = await chrome.storage.session.get("workTabId");
  await setCursorOnTab(workTabId, "Paused — click Resume in panel");
  return { ok: true };
}

async function resumeRun() {
  await refreshRunControlFlags();
  const { runPaused } = await chrome.storage.session.get("runPaused");
  if (!runPaused && !runControl.paused) {
    return { ok: false, error: "Run is not paused" };
  }

  runControl.paused = false;
  await setSessionRunControl({ runPaused: false });

  await hydrateActiveRun();
  if (activeRun?.phase === "paused") {
    activeRun = { ...activeRun, phase: activeRun.resumePhase || "registering" };
    await saveRunState(activeRun);
  } else {
    const { runState } = await chrome.storage.local.get("runState");
    if (runState?.phase === "paused") {
      activeRun = { ...runState, phase: runState.resumePhase || "registering" };
      await saveRunState(activeRun);
    }
  }

  return { ok: true };
}

async function stopRun() {
  await refreshRunControlFlags();
  const active = await isRunActiveFromStorage();
  const { runState } = await chrome.storage.local.get("runState");
  if (!active && !STOPPABLE_PHASES.has(runState?.phase)) {
    return { ok: false, error: "No active run" };
  }

  runSessionId++;
  runControl.stopRequested = true;
  runControl.paused = false;
  await setSessionRunControl({ runStopRequested: true, runPaused: false });

  await hydrateActiveRun();
  const base = activeRun || runState;
  if (base && STOPPABLE_PHASES.has(base.phase)) {
    activeRun = { ...base, phase: "stopping" };
    await saveRunState(activeRun);
  }

  const { workTabId } = await chrome.storage.session.get("workTabId");
  if (workTabId) {
    chrome.tabs.sendMessage(workTabId, { type: "ABORT_RUN", reason: "stop" }).catch(() => {});
  }

  return { ok: true };
}

/** Skip the event currently being registered and continue with the next one. */
async function skipCurrentEvent() {
  await refreshRunControlFlags();
  const active = await isRunActiveFromStorage();
  await hydrateActiveRun();
  const { runState } = await chrome.storage.local.get("runState");
  const { currentRunEvent, workTabId } = await chrome.storage.session.get([
    "currentRunEvent",
    "workTabId",
  ]);
  // Resolve the phase from persisted state; the session event below is authoritative while a
  // registration is in flight and survives ordinary MV3 service-worker suspension.
  const phase = runState?.phase || activeRun?.phase;

  if (!active && !STOPPABLE_PHASES.has(phase)) {
    return { ok: false, error: "No active run to skip" };
  }
  if (phase === "discovering") {
    return { ok: false, error: "Still finding events — nothing to skip yet" };
  }
  const resolvedEvent =
    currentRunEvent || getCurrentRunEvent(runState) || getCurrentRunEvent(activeRun);
  const state = {
    ...(activeRun || {}),
    ...(runState || {}),
    currentEvent: resolvedEvent || null,
  };
  if (!canSkipRunState(state)) {
    return {
      ok: false,
      error: state?.skipRequested
        ? "Skip already requested"
        : "No current event yet — wait for it to start",
    };
  }

  runControl.skipRequested = true;
  await setSessionRunControl({ runSkipRequested: true });
  await appendRunLog(
    createLogEntry(RUN_STEPS.SKIP, "Skip requested — moving to the next event…", "info", {
      eventSlug: resolvedEvent?.slug,
      eventTitle: resolvedEvent?.title,
      eventUrl: resolvedEvent?.url,
    }),
    { skipRequested: true }
  );

  // If paused, resume so the loop can advance past the skipped event.
  if (runControl.paused || phase === "paused") {
    runControl.paused = false;
    const base = activeRun || runState;
    if (base && base.phase === "paused") {
      activeRun = { ...base, phase: base.resumePhase || "registering" };
      await saveRunState(activeRun);
    }
    await setSessionRunControl({ runPaused: false });
  }

  if (workTabId) {
    await chrome.tabs
      .sendMessage(workTabId, { type: "ABORT_RUN", reason: "skip" })
      .catch(() => {});
  }
  return { ok: true, event: resolvedEvent };
}

chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.runPaused) runControl.paused = Boolean(changes.runPaused.newValue);
  if (changes.runStopRequested) runControl.stopRequested = Boolean(changes.runStopRequested.newValue);
  if (changes.runSkipRequested) runControl.skipRequested = Boolean(changes.runSkipRequested.newValue);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target === "offscreen") return false;

  if (message.type === "START_RUN") {
    startRun({ source: message.source }).then(sendResponse);
    return true;
  }

  if (message.type === "START_INVITE_RUN") {
    startInviteRun().then(sendResponse);
    return true;
  }

  if (message.type === "PAUSE_RUN") {
    pauseRun().then(sendResponse);
    return true;
  }

  if (message.type === "RESUME_RUN") {
    resumeRun().then(sendResponse);
    return true;
  }

  if (message.type === "STOP_RUN") {
    stopRun().then(sendResponse);
    return true;
  }

  if (message.type === "SKIP_EVENT") {
    skipCurrentEvent().then(sendResponse);
    return true;
  }

  if (message.type === "ANSWER_QUESTION") {
    answerRegistrationQuestion({
      question: message.question,
      profile: message.profile,
      eventTitle: message.eventTitle,
      fieldType: message.fieldType,
      qType: message.qType,
      options: message.options,
    })
      .then((answer) => sendResponse({ answer }))
      .catch((err) => sendResponse({ answer: null, error: err.message }));
    return true;
  }

  if (message.type === "SAVE_LLM_CONFIG") {
    chrome.storage.local
      .set({ llmConfig: message.llmConfig })
      .then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === "GET_STATE") {
    healStaleRunState()
      .then(() =>
        chrome.storage.local.get(["runState", "history", "profile", "llmConfig", "localLlmStatus"])
      )
      .then(sendResponse);
    return true;
  }

  if (message.type === "WARMUP_LOCAL_LLM") {
    warmupLocalModel()
      .then((res) => sendResponse(res || { ok: false, error: "No response from local AI" }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (message.type === "TEST_LOCAL_LLM") {
    getProfile()
      .then((profile) =>
        answerRegistrationQuestion({
          question: message.question || "Why should we allow you to attend this event?",
          profile,
          eventTitle: "Test event",
          fieldType: "textarea",
          qType: "admission",
        })
      )
      .then((answer) => sendResponse({ answer }))
      .catch((err) => sendResponse({ answer: null, error: err.message }));
    return true;
  }

  if (message.type === "LOCAL_LLM_STATUS") {
    getLocalModelStatus().then(sendResponse);
    return true;
  }

  if (message.type === "RUN_LOG") {
    if (message.entry) {
      appendRunLog(message.entry).then(() => sendResponse({ ok: true }));
    } else {
      sendResponse({ ok: false });
    }
    return true;
  }

  if (message.type === "OPEN_CURRENT_EVENT") {
    chrome.storage.local.get("runState").then(async ({ runState }) => {
      const event = runState?.currentEvent || runState?.event;
      const url = event?.url?.replace("lu.ma", "luma.com");
      if (!url) {
        sendResponse({ ok: false, error: "No current event" });
        return;
      }
      const { workTabId } = await chrome.storage.session.get("workTabId");
      if (workTabId) {
        try {
          await chrome.tabs.update(workTabId, { url, active: true });
          sendResponse({ ok: true, url });
          return;
        } catch {
          /* fall through */
        }
      }
      const tab = await chrome.tabs.create({ url, active: true });
      sendResponse({ ok: true, url, tabId: tab.id });
    });
    return true;
  }

  if (message.type === "COPY_RUN_LOGS") {
    chrome.storage.local.get("runState").then(({ runState = {} }) => {
      sendResponse({ ok: true, text: formatRunLogsAsText(runState) });
    });
    return true;
  }

  if (message.type === "SAVE_PROFILE") {
    getProfile()
      .then((current) => {
        const incoming = message.profile || {};
        return chrome.storage.local.set({
          profile: {
            ...current,
            ...incoming,
            personas: { ...(current.personas || {}), ...(incoming.personas || {}) },
            // Keep answers learned from forms when the visible profile fields are saved again.
            default_answers: {
              ...(current.default_answers || {}),
              ...(incoming.default_answers || {}),
            },
          },
        });
      })
      .then(() => sendResponse({ ok: true }));
    return true;
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  await initExtensionStorage();
  await mirrorRunControlToLocal();
  const { profile } = await chrome.storage.local.get("profile");
  if (!profile) {
    await chrome.storage.local.set({ profile: DEFAULT_PROFILE, history: [] });
  }
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch {
    /* older Chrome */
  }
  warmupLocalModel().catch(() => {});
});

chrome.runtime.onStartup.addListener(async () => {
  await initExtensionStorage();
  await mirrorRunControlToLocal();
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch {
    /* older Chrome */
  }
});
