import { STORAGE_KEYS, DEFAULT_SETTINGS, DISCOVER_SF_URL } from "../shared/constants.js";
import { normalizeProfile } from "../shared/profile.js";
import { answerRegistrationQuestions, checkAiAvailability } from "./gemini.js";

const LUMA_CONTENT_FILE = "content/luma-agent.js";

function isLumaUrl(url = "") {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "lu.ma" || host.endsWith(".lu.ma") || host === "luma.com" || host.endsWith(".luma.com");
  } catch {
    return false;
  }
}

async function ensureContentScript(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: "PING" });
    if (pong?.ok) return true;
  } catch {
    // inject below
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: [LUMA_CONTENT_FILE],
  });
  await sleep(400);
  return true;
}

async function fillActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !isLumaUrl(tab.url)) {
    return { ok: false, reason: "not_luma", filled: 0 };
  }

  await ensureContentScript(tab.id);
  return chrome.tabs.sendMessage(tab.id, { type: "FILL_NOW" });
}

const queueState = {
  running: false,
  tabId: null,
};

async function getSettings() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.settings);
  return { ...DEFAULT_SETTINGS, ...(data[STORAGE_KEYS.settings] || {}) };
}

async function appendHistory(entry) {
  const data = await chrome.storage.local.get(STORAGE_KEYS.history);
  const history = data[STORAGE_KEYS.history] || [];
  history.unshift({ ...entry, at: new Date().toISOString() });
  await chrome.storage.local.set({ [STORAGE_KEYS.history]: history.slice(0, 100) });
}

async function processNextInQueue() {
  if (!queueState.running) return;

  const data = await chrome.storage.local.get(STORAGE_KEYS.queue);
  const queue = data[STORAGE_KEYS.queue] || [];
  const next = queue.find((item) => item.status === "pending");

  if (!next) {
    queueState.running = false;
    chrome.runtime.sendMessage({ type: "QUEUE_DONE" }).catch(() => {});
    return;
  }

  const settings = await getSettings();
  next.status = "processing";
  await chrome.storage.local.set({ [STORAGE_KEYS.queue]: queue });

  let tabId = queueState.tabId;
  if (!tabId) {
    const tab = await chrome.tabs.create({ url: next.url, active: false });
    tabId = tab.id;
    queueState.tabId = tabId;
  } else {
    await chrome.tabs.update(tabId, { url: next.url, active: false });
  }

  await waitForTabLoad(tabId);
  await sleep(settings.delayBetweenMs);

  let result = { ok: false, reason: "timeout" };
  try {
    await ensureContentScript(tabId);
    result = await chrome.tabs.sendMessage(tabId, { type: "FILL_AND_REGISTER" });
  } catch (err) {
    result = { ok: false, reason: String(err) };
  }

  next.status = result.ok ? "done" : "skipped";
  next.result = result;
  await chrome.storage.local.set({ [STORAGE_KEYS.queue]: queue });
  await appendHistory({ url: next.url, title: next.title, ...result });

  await sleep(settings.delayBetweenMs);
  processNextInQueue();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, 15000);
    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 1200);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message.type === "START_SF_SCAN") {
      const tab = await chrome.tabs.create({ url: DISCOVER_SF_URL, active: true });
      await waitForTabLoad(tab.id);
      await sleep(2000);
      await ensureContentScript(tab.id);
      const scraped = await chrome.tabs.sendMessage(tab.id, { type: "SCRAPE_DISCOVER" });
      const events = (scraped?.events || []).map((e) => ({
        ...e,
        status: "pending",
      }));
      await chrome.storage.local.set({ [STORAGE_KEYS.queue]: events });
      sendResponse({ count: events.length, events });
      return;
    }

    if (message.type === "START_QUEUE") {
      queueState.running = true;
      queueState.tabId = message.tabId || null;
      processNextInQueue();
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "STOP_QUEUE") {
      queueState.running = false;
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "GET_QUEUE") {
      const data = await chrome.storage.local.get([STORAGE_KEYS.queue, STORAGE_KEYS.history]);
      sendResponse({
        queue: data[STORAGE_KEYS.queue] || [],
        history: data[STORAGE_KEYS.history] || [],
        running: queueState.running,
      });
      return;
    }

    if (message.type === "ANSWER_REGISTRATION_QUESTIONS") {
      const data = await chrome.storage.local.get([STORAGE_KEYS.profile, STORAGE_KEYS.settings]);
      const profile = normalizeProfile(data[STORAGE_KEYS.profile]);
      const settings = { ...DEFAULT_SETTINGS, ...(data[STORAGE_KEYS.settings] || {}) };
      const result = await answerRegistrationQuestions({
        profile,
        settings,
        eventContext: message.eventContext,
        questions: message.questions || [],
      });
      sendResponse(result);
      return;
    }

    if (message.type === "FILL_TAB") {
      sendResponse(await fillActiveTab());
      return;
    }

    if (message.type === "CHECK_AI") {
      const settings = await getSettings();
      sendResponse(await checkAiAvailability(settings));
      return;
    }

    sendResponse({ ok: false });
  })();
  return true;
});
