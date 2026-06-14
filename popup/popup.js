import { STORAGE_KEYS, DEFAULT_SETTINGS } from "../shared/constants.js";
import { profileFieldHints, normalizeProfile } from "../shared/profile.js";

const profileForm = document.getElementById("profile-form");
const settingsForm = document.getElementById("settings-form");
const queueList = document.getElementById("queue-list");
const queueStatus = document.getElementById("queue-status");

function renderProfileForm(profile) {
  profileForm.innerHTML = profileFieldHints()
    .map(
      ({ key, label, type, required }) => `
      <label>
        ${label}${required ? " *" : ""}
        ${type === "textarea"
          ? `<textarea name="${key}" ${required ? "required" : ""}>${profile[key] || ""}</textarea>`
          : `<input type="${type}" name="${key}" value="${profile[key] || ""}" ${required ? "required" : ""} />`}
      </label>`
    )
    .join("");
}

function readProfileForm() {
  const data = new FormData(profileForm);
  const profile = normalizeProfile(Object.fromEntries(data.entries()));
  return profile;
}

function readSettingsForm() {
  const data = new FormData(settingsForm);
  return {
    ...DEFAULT_SETTINGS,
    freeOnly: data.get("freeOnly") === "on",
    autoFillOnPage: data.get("autoFillOnPage") === "on",
    aiAnswerQuestions: data.get("aiAnswerQuestions") === "on",
    geminiApiKey: String(data.get("geminiApiKey") || "").trim(),
    geminiModel: data.get("geminiModel") || DEFAULT_SETTINGS.geminiModel,
    delayBetweenMs: Number(data.get("delayBetweenMs") || DEFAULT_SETTINGS.delayBetweenMs),
  };
}

function applySettingsToForm(settings) {
  settingsForm.freeOnly.checked = settings.freeOnly;
  settingsForm.autoFillOnPage.checked = settings.autoFillOnPage;
  settingsForm.aiAnswerQuestions.checked = settings.aiAnswerQuestions !== false;
  settingsForm.geminiApiKey.value = settings.geminiApiKey || "";
  settingsForm.geminiModel.value = settings.geminiModel || DEFAULT_SETTINGS.geminiModel;
  settingsForm.delayBetweenMs.value = settings.delayBetweenMs;
}

async function loadState() {
  const data = await chrome.storage.local.get([STORAGE_KEYS.profile, STORAGE_KEYS.settings]);
  renderProfileForm(normalizeProfile(data[STORAGE_KEYS.profile]));
  applySettingsToForm({ ...DEFAULT_SETTINGS, ...(data[STORAGE_KEYS.settings] || {}) });
  refreshQueue();
}

function renderQueue(queue, running) {
  queueStatus.textContent = running
    ? "Registering queued events..."
    : queue.length
      ? `${queue.length} events in queue`
      : "No events queued. Click Scan SF events.";

  queueList.innerHTML = queue
    .slice(0, 20)
    .map(
      (item) => `
      <li>
        <strong>${item.title || "Event"}</strong>
        <div class="meta">${item.status}${item.result?.reason ? ` · ${item.result.reason}` : ""}</div>
      </li>`
    )
    .join("");
}

async function refreshQueue() {
  const response = await chrome.runtime.sendMessage({ type: "GET_QUEUE" });
  renderQueue(response.queue || [], response.running);
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(`${tab.dataset.tab}-panel`).classList.add("active");
  });
});

const fillStatus = document.getElementById("fill-status");

profileForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const profile = readProfileForm();
  await chrome.storage.local.set({ [STORAGE_KEYS.profile]: profile });
  fillStatus.textContent = "Profile saved.";
});

document.getElementById("fill-now").addEventListener("click", async () => {
  fillStatus.textContent = "Filling current tab...";
  try {
    const result = await chrome.runtime.sendMessage({ type: "FILL_TAB" });
    if (result?.filled > 0) {
      fillStatus.textContent = `Filled ${result.filled} field${result.filled === 1 ? "" : "s"}.`;
    } else if (result?.reason === "missing_profile") {
      fillStatus.textContent = "Save your profile first.";
    } else if (result?.reason === "not_luma") {
      fillStatus.textContent = "Switch to a lu.ma or luma.com tab first.";
    } else {
      fillStatus.textContent = "No registration form found. Click Register on the event page first.";
    }
  } catch (err) {
    fillStatus.textContent = `Error: ${err?.message || "Could not fill this page."}`;
  }
});

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const settings = readSettingsForm();
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings });
  document.getElementById("ai-status").textContent = "Settings saved.";
});

document.getElementById("check-ai").addEventListener("click", async () => {
  const aiStatus = document.getElementById("ai-status");
  aiStatus.textContent = "Checking...";
  try {
    const result = await chrome.runtime.sendMessage({ type: "CHECK_AI" });
    if (result.available && result.provider === "chrome-gemini-nano") {
      aiStatus.textContent = `Chrome SLM ready (${result.status}) — unique answers per question.`;
    } else if (result.available && result.provider === "gemini-api") {
      aiStatus.textContent = "Gemini API key set (cloud backup for SLM).";
    } else if (result.provider === "smart-rules") {
      aiStatus.textContent = "Smart rule-based answers active (different answer per question type). Enable Chrome SLM flag for AI answers.";
    } else {
      aiStatus.textContent =
        "Chrome Gemini not available. Enable chrome://flags/#prompt-api-for-gemini-nano or add an API key.";
    }
  } catch {
    aiStatus.textContent = "Could not check AI status.";
  }
});

document.getElementById("scan-sf").addEventListener("click", async () => {
  queueStatus.textContent = "Scanning lu.ma/discover/sf...";
  const result = await chrome.runtime.sendMessage({ type: "START_SF_SCAN" });
  queueStatus.textContent = `Found ${result.count} SF event links.`;
  refreshQueue();
});

document.getElementById("start-queue").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "START_QUEUE" });
  refreshQueue();
});

document.getElementById("stop-queue").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "STOP_QUEUE" });
  refreshQueue();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "QUEUE_DONE") refreshQueue();
});

loadState();
setInterval(refreshQueue, 3000);
