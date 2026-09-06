import { canSkipRunState, getCurrentRunEvent } from "./lib/run-control-state.js";

const runBtn = document.getElementById("runBtn");
const inviteBtn = document.getElementById("inviteBtn");

const runControls = document.getElementById("runControls");
const pauseBtn = document.getElementById("pauseBtn");
const pauseBtnLabel = document.getElementById("pauseBtnLabel");
const skipBtn = document.getElementById("skipBtn");
const stopBtn = document.getElementById("stopBtn");
const upcomingCard = document.getElementById("upcomingCard");
const upcomingList = document.getElementById("upcomingList");
const upcomingCount = document.getElementById("upcomingCount");
const statusEl = document.getElementById("status");
const statusPhase = document.getElementById("statusPhase");
const statusCount = document.getElementById("statusCount");
const progressFill = document.getElementById("progressFill");
const resultsList = document.getElementById("resultsList");
const currentEventCard = document.getElementById("currentEventCard");
const currentEventLink = document.getElementById("currentEventLink");
const openEventTabBtn = document.getElementById("openEventTabBtn");
const runLogList = document.getElementById("runLogList");
const copyLogsBtn = document.getElementById("copyLogsBtn");

const ACTIVE_PHASES = new Set(["discovering", "registering", "paused"]);
const FINISHED_PHASES = new Set(["done", "stopped", "error", "stopping"]);

const fields = {
  firstName: document.getElementById("firstName"),
  lastName: document.getElementById("lastName"),
  email: document.getElementById("email"),
  workEmail: document.getElementById("workEmail"),
  phone: document.getElementById("phone"),
  jobTitle: document.getElementById("jobTitle"),
  company: document.getElementById("company"),
  linkedin: document.getElementById("linkedin"),
  github: document.getElementById("github"),
};

const SKIP_UI_STATUSES = new Set([
  "already_registered",
  "on_waitlist",
  "pending_approval",
  "approved",
]);

function escapeHtml(text) {
  return (text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function statusClass(result) {
  if (result.skipped) return "result-skip";
  if (result.success) return "result-ok";
  if (SKIP_UI_STATUSES.has(result.status)) return "result-skip";
  if (result.status?.startsWith("skipped") || result.status === "sold_out") return "result-skip";
  return "result-fail";
}

function statusLabel(result) {
  if (result.skipped || (SKIP_UI_STATUSES.has(result.status) && !result.success)) {
    const labels = {
      already_registered: result.message?.includes("You're in")
        ? "You're in"
        : result.message?.includes("going")
          ? "Already going"
          : "Already registered",
      on_waitlist: "On waitlist",
      pending_approval: result.message?.includes("Pending")
        ? "Pending"
        : "Pending approval",
      approved: "Approved",
    };
    return labels[result.status] || result.message || "Skipped";
  }
  if (result.success && result.status === "waitlist_joined") return "Joined waitlist";
  if (result.success && result.status === "pending_approval") {
    return "Submitted (awaiting approval)";
  }
  if (result.status === "skipped_wallet") return "Wallet required";
  if (result.status === "skipped_paid") return "Paid — skipped";
  if (result.status === "skipped_women_only") return "Women-only — skipped";
  if (result.status === "skipped_virtual") return "Virtual — skipped";
  if (result.status === "navigated_away") return "Left event page";
  if (result.success) return result.status === "registered" ? "Registered" : "Done";
  return result.message || result.status || "Failed";
}

/** Both start buttons share one lifecycle: neither may launch while a run is in flight. */
function setStartButtonsDisabled(disabled) {
  runBtn.disabled = disabled;
  inviteBtn.disabled = disabled;
}

function setRunControls(state) {
  const active = state && ACTIVE_PHASES.has(state.phase);
  runControls.classList.toggle("hidden", !active && state?.phase !== "stopping");
  setStartButtonsDisabled(Boolean(active));

  if (!active) {
    pauseBtn.classList.remove("is-resume");
    pauseBtnLabel.textContent = "Pause";
    pauseBtn.querySelector(".control-icon").textContent = "⏸";
    stopBtn.disabled = true;
    pauseBtn.disabled = true;
    skipBtn.disabled = true;
    if (!state || FINISHED_PHASES.has(state.phase)) {
      setStartButtonsDisabled(false);
    }
    return;
  }

  stopBtn.disabled = state.phase === "stopping";
  pauseBtn.disabled = state.phase === "stopping";
  // Do not offer Skip during the registering transition before a current event exists.
  skipBtn.disabled = !canSkipRunState(state);

  if (state.phase === "paused") {
    pauseBtn.classList.add("is-resume");
    pauseBtnLabel.textContent = "Resume";
    pauseBtn.querySelector(".control-icon").textContent = "▶";
  } else {
    pauseBtn.classList.remove("is-resume");
    pauseBtnLabel.textContent = "Pause";
    pauseBtn.querySelector(".control-icon").textContent = "⏸";
  }
}

function formatLogTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "";
  }
}

function renderCurrentEvent(state) {
  const event = getCurrentRunEvent(state);
  const show =
    event?.title &&
    (state?.phase === "registering" || state?.phase === "stopping" || state?.phase === "paused");

  if (!show) {
    currentEventCard.classList.add("hidden");
    return;
  }

  currentEventCard.classList.remove("hidden");
  const url = (event.url || `https://luma.com/${event.slug || ""}`).replace("lu.ma", "luma.com");
  currentEventLink.textContent = event.title;
  currentEventLink.href = url;
  currentEventLink.title = url;
}

function renderUpcoming(state) {
  const upcoming = state?.upcoming || [];
  const show =
    upcoming.length > 0 &&
    (state?.phase === "registering" || state?.phase === "paused" || state?.phase === "discovering");

  if (!show) {
    upcomingCard.classList.add("hidden");
    return;
  }

  upcomingCard.classList.remove("hidden");
  upcomingCount.textContent = `(${upcoming.length})`;
  upcomingList.innerHTML = "";

  upcoming.slice(0, 50).forEach((event, i) => {
    const li = document.createElement("li");

    const index = document.createElement("span");
    index.className = "upcoming-index";
    index.textContent = `${i + 1}.`;
    li.appendChild(index);

    const url = (event.url || `https://luma.com/${event.slug || ""}`).replace("lu.ma", "luma.com");
    const title = document.createElement(event.url || event.slug ? "a" : "span");
    title.textContent = event.title || event.slug || "Event";
    title.title = event.title || url;
    if (event.url || event.slug) {
      title.href = url;
      title.target = "_blank";
      title.rel = "noopener";
    }
    li.appendChild(title);
    upcomingList.appendChild(li);
  });
}

function renderRunLogs(state) {
  const logs = state?.logs || [];
  runLogList.innerHTML = "";

  if (!logs.length) {
    const li = document.createElement("li");
    li.textContent = "Logs appear here as the agent works…";
    li.style.color = "#71717a";
    runLogList.appendChild(li);
    return;
  }

  for (const entry of logs.slice(-80)) {
    const li = document.createElement("li");
    const time = document.createElement("span");
    time.className = "log-time";
    time.textContent = formatLogTime(entry.ts);

    const step = document.createElement("span");
    step.className = "log-step";
    step.textContent = entry.step || "info";

    const msg = document.createElement("span");
    msg.className =
      entry.level === "error"
        ? "log-error"
        : entry.level === "warn"
          ? "log-warn"
          : entry.level === "success"
            ? "log-success"
            : "";
    const prefix = entry.eventTitle ? `[${entry.eventTitle.slice(0, 40)}${entry.eventTitle.length > 40 ? "…" : ""}] ` : "";
    let line = prefix + (entry.message || "");
    if (entry.target) line += ` → "${entry.target}"`;
    if (entry.href) line += ` (${entry.href})`;
    if (entry.url && !entry.message?.includes(entry.url)) {
      line += ` @ ${entry.url.replace(/^https?:\/\//, "")}`;
    }
    msg.textContent = line;

    li.appendChild(time);
    li.appendChild(step);
    li.appendChild(msg);
    runLogList.appendChild(li);
  }

  runLogList.scrollTop = runLogList.scrollHeight;
}

function renderState(state) {
  if (!state || state.phase === "idle") {
    setRunControls(null);
    currentEventCard.classList.add("hidden");
    upcomingCard.classList.add("hidden");
    return;
  }

  statusEl.classList.remove("hidden");
  setRunControls(state);
  renderCurrentEvent(state);
  renderUpcoming(state);
  renderRunLogs(state);

  if (state.phase === "discovering") {
    const disc = state.discovery;
    statusPhase.textContent = disc ? "Verifying events…" : "Scanning all 4 sources…";
    statusEl.classList.remove("is-paused");
    if (disc?.total) {
      statusCount.textContent = `${disc.verified}/${disc.total} checked · ${disc.ready} ready`;
      progressFill.style.width = `${10 + Math.round((disc.verified / disc.total) * 30)}%`;
    } else if (state.stats) {
      statusCount.textContent = `${state.stats.totalSF} found · ${state.stats.newRegisterable ?? state.stats.freeRegisterable} new`;
      progressFill.style.width = "10%";
    } else {
      statusCount.textContent = "";
      progressFill.style.width = "10%";
    }
  } else if (state.phase === "paused") {
    statusPhase.textContent = "Paused";
    statusEl.classList.add("is-paused");
    statusCount.textContent =
      state.resumePhase === "discovering" || !state.total
        ? "Click Resume to continue discovery"
        : `${state.current}/${state.total} · click Resume to continue`;
    if (state.total) {
      progressFill.style.width = `${(state.current / state.total) * 100}%`;
    }
  }

  if (state.phase === "registering") {
    statusPhase.textContent = "Registering…";
    statusEl.classList.remove("is-paused");
    const verifying = state.discovery && !state.discovery.done;
    statusCount.textContent = `${state.current}/${state.total}${verifying ? "+" : ""}`;
    progressFill.style.width = `${Math.min(100, (state.current / Math.max(1, state.total)) * 100)}%`;
    renderCurrentEvent(state);
  }

  if (state.phase === "stopping") {
    statusPhase.textContent = "Stopping…";
    statusEl.classList.remove("is-paused");
    statusCount.textContent = state.total
      ? `${state.current}/${state.total}`
      : "Finishing current step…";
    stopBtn.disabled = true;
    pauseBtn.disabled = true;
    setStartButtonsDisabled(false);
  }

  if (FINISHED_PHASES.has(state.phase) && state.phase !== "stopping") {
    const labels = {
      done: "Complete",
      stopped: "Stopped",
      error: "Error",
    };
    statusPhase.textContent = labels[state.phase] || "Done";
    statusEl.classList.remove("is-paused");
    statusCount.textContent = state.results?.length ? `${state.results.length} processed` : "";
    progressFill.style.width = "100%";
    setStartButtonsDisabled(false);
  }

  resultsList.innerHTML = "";
  for (const r of state.results || []) {
    const li = document.createElement("li");
    const title = document.createElement(r.event?.url ? "a" : "span");
    title.className = "result-title";
    title.title = r.event?.title || "";
    title.textContent = r.event?.title || "Event";
    if (r.event?.url) {
      title.href = r.event.url.replace("lu.ma", "luma.com");
      title.target = "_blank";
      title.rel = "noopener";
    }
    const status = document.createElement("span");
    status.className = statusClass(r);
    status.textContent = statusLabel(r);
    li.appendChild(title);
    li.appendChild(status);
    resultsList.appendChild(li);
  }

  if (state.error && !state.results?.length) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.className = "result-fail";
    span.textContent = state.error;
    li.appendChild(span);
    resultsList.appendChild(li);
  }
}

function loadProfile(profile) {
  if (!profile) return;
  fields.firstName.value = profile.first_name || "";
  fields.lastName.value = profile.last_name || "";
  fields.email.value = profile.email || "";
  fields.workEmail.value = profile.work_email || "";
  fields.phone.value = profile.phone || "";
  fields.jobTitle.value = profile.job_title || "";
  fields.company.value = profile.company || "";
  fields.linkedin.value = profile.linkedin || "";
  fields.github.value = profile.github || "";
  renderSavedAnswers(profile.default_answers || {});
}

function renderSavedAnswers(defaultAnswers) {
  const section = document.getElementById("savedAnswersSection");
  const list = document.getElementById("savedAnswersList");
  const entries = Object.entries(defaultAnswers);

  if (!entries.length) {
    section.classList.add("hidden");
    return;
  }

  section.classList.remove("hidden");
  list.innerHTML = "";
  for (const [question, answer] of entries) {
    const li = document.createElement("li");
    const strong = document.createElement("strong");
    strong.textContent = question;
    li.appendChild(strong);
    li.appendChild(document.createElement("br"));
    li.appendChild(document.createTextNode(answer));
    list.appendChild(li);
  }
}

function getProfileFromForm() {
  return {
    first_name: fields.firstName.value.trim(),
    last_name: fields.lastName.value.trim(),
    email: fields.email.value.trim(),
    work_email: fields.workEmail.value.trim() || fields.email.value.trim(),
    phone: fields.phone.value.trim(),
    location: "San Francisco, CA",
    job_title: fields.jobTitle.value.trim(),
    company: fields.company.value.trim(),
    default_persona: "engineer",
    personas: {
      founder: { job_title: "Founder", company: "Stealth Startup" },
      engineer: { job_title: "Software Engineer", company: "Eastern Illinois University" },
    },
    linkedin: fields.linkedin.value.trim(),
    instagram: "zubair1105",
    github: fields.github.value.trim(),
    website: fields.github.value.trim(),
    default_answers: {
      "What brings you to this event?":
        "I'm a Software Engineer interested in AI and tech community events in San Francisco.",
      "Why do you want to attend?":
        "I'm passionate about AI/tech and want to connect with the local developer community.",
      "Tell us about yourself": `Software Engineer at Eastern Illinois University. I build full-stack applications and follow AI/agent developments closely.`,
    },
  };
}

async function refreshState() {
  const data = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  if (!data) return;
  loadProfile(data.profile);
  loadLlmConfig(data.llmConfig);
  renderLocalAiStatus(data.localLlmStatus);
  if (data.runState) renderState(data.runState);
}

function renderLocalAiStatus(status) {
  const el = document.getElementById("localAiStatus");
  if (!status || status.state === "idle") {
    el.textContent = "Model not loaded — click “Download / warm up model” (one-time ~200MB download)";
    el.className = "local-ai-status";
    return;
  }
  el.className = "local-ai-status";
  if (status.state === "loading") {
    el.classList.add("is-loading");
    el.textContent = status.progress || "Downloading SmolLM2-360M…";
  } else if (status.state === "ready") {
    el.classList.add("is-ready");
    el.textContent = `Ready — ${status.model || "SmolLM2-360M"} (on-device, no API)`;
  } else if (status.state === "error") {
    el.classList.add("is-error");
    el.textContent = `Error: ${status.error || "Model failed to load"}`;
  }
}

function loadLlmConfig(config) {
  const c = config || {};
  document.getElementById("llmProvider").value = c.provider || "local";
  document.getElementById("openaiKey").value = c.openaiApiKey || "";
  document.getElementById("ollamaUrl").value = c.ollamaUrl || "http://127.0.0.1:11434";
  document.getElementById("ollamaModel").value = c.ollamaModel || "llama3.2";
}

function getLlmConfigFromForm() {
  return {
    enabled: true,
    provider: document.getElementById("llmProvider").value,
    openaiApiKey: document.getElementById("openaiKey").value.trim(),
    openaiModel: "gpt-4o-mini",
    ollamaUrl: document.getElementById("ollamaUrl").value.trim() || "http://127.0.0.1:11434",
    ollamaModel: document.getElementById("ollamaModel").value.trim() || "llama3.2",
  };
}

function showControlToast(text, isError = false) {
  const toast = document.createElement("div");
  toast.className = "saved-toast";
  if (isError) toast.style.background = "#ef4444";
  toast.textContent = text;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2000);
}

pauseBtn.addEventListener("click", async () => {
  const paused = pauseBtn.classList.contains("is-resume");
  pauseBtn.disabled = true;
  stopBtn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({
      type: paused ? "RESUME_RUN" : "PAUSE_RUN",
    });
    if (!res?.ok) {
      showControlToast(res?.error || "Could not pause/resume", true);
    } else {
      const data = await chrome.runtime.sendMessage({ type: "GET_STATE" });
      if (data.runState) renderState(data.runState);
    }
  } catch (err) {
    showControlToast(err.message || "Extension disconnected — retry", true);
  }
  pauseBtn.disabled = false;
  stopBtn.disabled = false;
});

skipBtn.addEventListener("click", async () => {
  skipBtn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: "SKIP_EVENT" });
    if (!res?.ok) {
      showControlToast(res?.error || "Nothing to skip", true);
    } else {
      showControlToast("Skipping current event…");
      const data = await chrome.runtime.sendMessage({ type: "GET_STATE" });
      if (data?.runState) renderState(data.runState);
    }
  } catch (err) {
    showControlToast(err?.message || "Extension disconnected — retry", true);
  }
});

stopBtn.addEventListener("click", async () => {
  stopBtn.disabled = true;
  pauseBtn.disabled = true;
  statusPhase.textContent = "Stopping…";
  try {
    const res = await chrome.runtime.sendMessage({ type: "STOP_RUN" });
    if (!res?.ok) {
      showControlToast(res?.error || "Could not stop run", true);
      const data = await chrome.runtime.sendMessage({ type: "GET_STATE" });
      if (data.runState) renderState(data.runState);
    }
  } catch (err) {
    showControlToast(err?.message || "Extension disconnected — retry", true);
    stopBtn.disabled = false;
    pauseBtn.disabled = false;
  }
});

openEventTabBtn.addEventListener("click", async () => {
  openEventTabBtn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: "OPEN_CURRENT_EVENT" });
    if (!res?.ok) showControlToast(res?.error || "Could not open event tab", true);
  } catch (err) {
    showControlToast(err.message || "Could not open event tab", true);
  }
  openEventTabBtn.disabled = false;
});

copyLogsBtn.addEventListener("click", async () => {
  copyLogsBtn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: "COPY_RUN_LOGS" });
    const text = res?.text || "";
    if (!text) {
      showControlToast("No logs to copy yet", true);
      copyLogsBtn.disabled = false;
      return;
    }
    await navigator.clipboard.writeText(text);
    showControlToast(`Copied ${(text.match(/\n/g) || []).length + 1} lines`);
  } catch (err) {
    showControlToast(err.message || "Copy failed — check clipboard permission", true);
  }
  copyLogsBtn.disabled = false;
});

async function startRunFromUi() {
  setStartButtonsDisabled(true);
  statusEl.classList.remove("hidden");
  runControls.classList.remove("hidden");
  statusPhase.textContent = "Starting…";
  progressFill.style.width = "5%";

  await chrome.runtime.sendMessage({
    type: "SAVE_PROFILE",
    profile: getProfileFromForm(),
  });

  try {
    const tab = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab[0]?.windowId) {
      await chrome.sidePanel.open({ windowId: tab[0].windowId });
    }
  } catch {
    /* side panel opens when run starts */
  }

  try {
    const res = await chrome.runtime.sendMessage({ type: "START_RUN", source: "all" });
    if (res?.ok === false) {
      showControlToast(res.error || "Could not start run", true);
      setStartButtonsDisabled(false);
      const data = await chrome.runtime.sendMessage({ type: "GET_STATE" });
      if (data?.runState) renderState(data.runState);
    }
  } catch (err) {
    showControlToast(err?.message || "Failed to start — reload extension", true);
    setStartButtonsDisabled(false);
  }
}

runBtn.addEventListener("click", startRunFromUi);

async function startInviteRunFromUi() {
  setStartButtonsDisabled(true);
  statusEl.classList.remove("hidden");
  runControls.classList.remove("hidden");
  statusPhase.textContent = "Checking invitations…";
  progressFill.style.width = "5%";

  await chrome.runtime.sendMessage({
    type: "SAVE_PROFILE",
    profile: getProfileFromForm(),
  });

  try {
    const tab = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab[0]?.windowId) {
      await chrome.sidePanel.open({ windowId: tab[0].windowId });
    }
  } catch {
    /* side panel opens when run starts */
  }

  try {
    const res = await chrome.runtime.sendMessage({ type: "START_INVITE_RUN" });
    if (res?.ok === false) {
      showControlToast(res.error || "Could not check invitations", true);
      setStartButtonsDisabled(false);
      const data = await chrome.runtime.sendMessage({ type: "GET_STATE" });
      if (data?.runState) renderState(data.runState);
    }
  } catch (err) {
    showControlToast(err?.message || "Failed to start — reload extension", true);
    setStartButtonsDisabled(false);
  }
}

inviteBtn.addEventListener("click", startInviteRunFromUi);

document.getElementById("warmupLlm").addEventListener("click", async () => {
  const btn = document.getElementById("warmupLlm");
  btn.disabled = true;
  renderLocalAiStatus({ state: "loading", progress: "Starting download…" });
  try {
    const res = await chrome.runtime.sendMessage({ type: "WARMUP_LOCAL_LLM" });
    if (res?.ok) {
      renderLocalAiStatus({
        state: res.state === "ready" ? "ready" : "loading",
        model: res.model,
        progress: res.progress || "Downloading SmolLM2-360M…",
      });
    } else {
      renderLocalAiStatus({ state: "error", error: res?.error || "Warmup failed" });
    }
  } catch (err) {
    renderLocalAiStatus({ state: "error", error: err?.message || String(err) });
  }
  btn.disabled = false;
});

document.getElementById("testLlm").addEventListener("click", async () => {
  const btn = document.getElementById("testLlm");
  const resultEl = document.getElementById("testLlmResult");
  btn.disabled = true;
  resultEl.classList.remove("hidden");
  resultEl.textContent = "Generating answer…";
  try {
    const res = await chrome.runtime.sendMessage({
      type: "TEST_LOCAL_LLM",
      question: "Why should we allow you to come to this event?",
    });
    resultEl.textContent = res?.answer || res?.error || "No answer returned";
  } catch (err) {
    resultEl.textContent = err.message;
  }
  btn.disabled = false;
});

document.getElementById("saveLlm").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({
    type: "SAVE_LLM_CONFIG",
    llmConfig: getLlmConfigFromForm(),
  });
  const toast = document.createElement("div");
  toast.className = "saved-toast";
  toast.textContent = "Cloud settings saved";
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 1500);
});

document.getElementById("saveProfile").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({
    type: "SAVE_PROFILE",
    profile: getProfileFromForm(),
  });
  const toast = document.createElement("div");
  toast.className = "saved-toast";
  toast.textContent = "Profile saved";
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 1500);
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.runState) renderState(changes.runState.newValue);
  if (changes.profile) loadProfile(changes.profile.newValue);
  if (changes.llmConfig) loadLlmConfig(changes.llmConfig.newValue);
  if (changes.localLlmStatus) renderLocalAiStatus(changes.localLlmStatus.newValue);
});

refreshState();
setInterval(refreshState, 2000);
