const EXISTING_CHECKS = [
  {
    status: "already_registered",
    phrases: [
      "you're in", "you are in", "you're going", "you are going",
      "you're registered", "registration confirmed", "you're on the list",
      "already registered", "see you there",
    ],
    buttons: ["cancel registration", "cancel rsvp", "unregister", "view ticket", "manage registration"],
    message: "Already registered — skipped",
  },
  {
    status: "on_waitlist",
    phrases: [],
    buttons: ["leave waitlist", "cancel waitlist"],
    message: "On waitlist — skipped",
  },
  {
    status: "pending_approval",
    phrases: [],
    buttons: ["pending approval", "awaiting approval"],
    message: "Pending approval — skipped",
  },
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sendRunLog(step, message, level = "info", meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    step,
    level,
    message,
    url: window.location.href.split(/[?#]/)[0],
    ...meta,
  };
  console.log(`[Luma Agent][${step}]`, message, meta.url || entry.url, meta);
  try {
    chrome.runtime.sendMessage({ type: "RUN_LOG", entry });
  } catch {
    /* extension context gone */
  }
}

class EventNavigationError extends Error {
  constructor(message, url = "") {
    super(message);
    this.name = "EventNavigationError";
    this.url = url;
  }
}

function getStablePageUrl() {
  return window.location.href.split(/[?#]/)[0];
}

function checkEventPageContext(expectedUrl) {
  const current = getStablePageUrl();
  if (!isValidEventHref(current)) {
    return {
      ok: false,
      message: `Left event page → ${current}`,
      url: current,
    };
  }
  if (expectedUrl && current !== expectedUrl) {
    return {
      ok: false,
      message: `URL changed (${expectedUrl} → ${current})`,
      url: current,
    };
  }
  return { ok: true, url: current };
}

async function agentClick(el, message, log, step = "fill", opts = {}) {
  if (!el) {
    log(step, "Click skipped — no element", "warn");
    return false;
  }

  const targetText = (el.textContent || el.value || el.getAttribute("aria-label") || "")
    .trim()
    .slice(0, 80);
  const href = typeof getLinkHref === "function" ? getLinkHref(el) : "";
  log(step, `Click: ${message}`, "info", {
    target: targetText,
    tag: el.tagName,
    href: href || undefined,
  });

  const result = await visualClick(el, message, opts);
  if (result && result.ok === false) {
    log(step, `Blocked unsafe click (${result.reason})${result.href ? `: ${result.href}` : ""}`, "warn", {
      reason: result.reason,
      href: result.href,
      tag: result.tag,
    });
    return false;
  }

  return true;
}

async function guardEventPage(expectedUrl, log, step = "navigate") {
  let ctx = checkEventPageContext(expectedUrl);
  if (ctx.ok) return;

  log(step, `${ctx.message} — attempting browser back`, "warn", { url: ctx.url });
  window.history.back();
  await runAwareSleep(1800);
  ctx = checkEventPageContext(expectedUrl);
  if (ctx.ok) {
    log(step, "Recovered event page via browser back", "info");
    return;
  }

  log(step, ctx.message, "error", { url: ctx.url, expectedUrl });
  throw new EventNavigationError(ctx.message, ctx.url);
}

let abortRunRequested = false;

class RunAbortedError extends Error {
  constructor() {
    super("Run stopped by user");
    this.name = "RunAbortedError";
  }
}

function resetAbortFlag() {
  abortRunRequested = false;
}

async function refreshAbortFromSession() {
  if (abortRunRequested) return true;
  const ctrl = await readRunControlMirror();
  if (ctrl.runStopRequested || ctrl.runSkipRequested) abortRunRequested = true;
  return abortRunRequested;
}

async function throwIfAborted() {
  if (await refreshAbortFromSession()) throw new RunAbortedError();
}

async function waitWhilePausedInContent() {
  let ctrl = await readRunControlMirror();
  while (ctrl.runPaused) {
    setAgentStatus("Paused — click Resume in panel");
    await throwIfAborted();
    await sleep(250);
    ctrl = await readRunControlMirror();
  }
}

async function runAwareSleep(ms) {
  const step = 200;
  let elapsed = 0;
  while (elapsed < ms) {
    await throwIfAborted();
    await waitWhilePausedInContent();
    const chunk = Math.min(step, ms - elapsed);
    await sleep(chunk);
    elapsed += chunk;
  }
}

async function sendMessageWithAbort(message) {
  let settled = false;
  let response;
  const pending = chrome.runtime.sendMessage(message).then(
    (res) => {
      response = res;
      settled = true;
    },
    (err) => {
      response = { error: err?.message || String(err) };
      settled = true;
    }
  );

  while (!settled) {
    await throwIfAborted();
    await sleep(200);
  }
  await pending;
  return response;
}

function abortedResult() {
  return { success: false, status: "aborted", message: "Run stopped by user" };
}

function pageText() {
  return (document.body?.innerText || "").toLowerCase();
}

function skipResult(status, message) {
  return { success: true, skipped: true, status, message };
}

function detectExistingRegistration(beforeSubmit = true) {
  const formOpen = isRegistrationFormOpen();

  const youreIn = detectYoureIn();
  if (youreIn) return skipResult(youreIn.status, youreIn.message);

  if (!formOpen) {
    const rsvpBadge = detectUserRsvpBadge();
    if (rsvpBadge) return skipResult(rsvpBadge.status, rsvpBadge.message);
  }

  const text = pageText();
  const buttons = [...document.querySelectorAll("button, a, [role='button']")]
    .filter(isVisible)
    .map((el) => (el.textContent || "").trim().toLowerCase());

  for (const check of EXISTING_CHECKS) {
    if (check.status === "pending_approval" && !beforeSubmit) continue;
    if (check.buttons?.some((p) => buttons.some((b) => b.includes(p)))) {
      return skipResult(check.status, check.message);
    }
  }

  if (!formOpen && !findClickable(ALL_ACTION_LABELS)) {
    if (findClickable(["cancel registration", "unregister", "leave waitlist", "view ticket"])) {
      return skipResult("already_registered", "Already registered — skipped");
    }
  }

  return null;
}

const WAITLIST_LABELS = [
  "join waitlist",
  "join the waitlist",
  "get on the waitlist",
  "add me to the waitlist",
];

const REQUEST_LABELS = [
  "request to join",
  "request to attend",
  "send request",
  "submit request",
  "submit application",
  "request access",
  "apply to join",
];

const REGISTER_LABELS = [
  "register",
  "register now",
  "rsvp",
  "get ticket",
  "get tickets",
  "reserve spot",
  "reserve a spot",
  "sign up",
  "attend event",
  "apply",
  "apply now",
  "complete registration",
  "confirm registration",
  "confirm",
  "submit",
];

/**
 * Invitation acceptance. Luma phrases the accept control differently from a normal register
 * button, so these are matched first when the page is an invitation.
 */
const INVITE_LABELS = [
  "accept invitation",
  "accept invite",
  "accept & register",
  "accept and register",
  "accept and rsvp",
  "accept",
  "confirm attendance",
  "confirm invitation",
  "yes, i'll attend",
  "yes, i will attend",
  "going",
  "i'm going",
];

/**
 * Never clicked. The agent only ever accepts an invitation — anything it decides against is left
 * pending for a human, because declining is not reversible from the guest side.
 */
const DECLINE_LABELS = [
  "decline",
  "decline invitation",
  "decline invite",
  "reject invitation",
  "not going",
  "can't go",
  "cannot go",
  "can't attend",
  "cannot attend",
  "no thanks",
  "no, thanks",
  "maybe",
  "remove me",
  "unsubscribe",
];

/** Badge text Luma renders on a card or event page when the user has an open invitation. */
const INVITE_BADGE_PHRASES = [
  "you're invited",
  "you are invited",
  "you have been invited",
  "you've been invited",
  "invitation pending",
  "pending invitation",
  "invited you to",
  "accept your invitation",
];

const ALL_ACTION_LABELS = [...REQUEST_LABELS, ...REGISTER_LABELS, ...WAITLIST_LABELS];

function elementLabel(el) {
  return (el.textContent || el.value || el.getAttribute("aria-label") || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function actionLabelMatches(text, label) {
  if (text === label) return true;
  if (["register", "rsvp", "apply", "confirm", "submit"].includes(label)) return false;
  return (
    text.startsWith(`${label} `) ||
    text.endsWith(` ${label}`) ||
    text.startsWith(`${label} —`) ||
    text.startsWith(`${label} -`)
  );
}

/**
 * True for any control that would turn an invitation down. Guarded globally rather than per-call
 * so no code path can ever click one, however the labels are matched.
 */
function isDeclineControl(el) {
  const text = elementLabel(el);
  if (!text) return false;
  return DECLINE_LABELS.some((label) => text === label || actionLabelMatches(text, label));
}

function findClickable(labelTexts, { checkFormScope = true, root = document } = {}) {
  const candidates = [
    ...root.querySelectorAll("button, [role='button'], input[type='submit'], a[href]"),
  ]
    .filter(isVisible)
    .filter((el) => !isUnsafeClickTarget(el, { checkFormScope }))
    .filter((el) => !isDeclineControl(el));

  for (const label of labelTexts) {
    for (const el of candidates) {
      const text = elementLabel(el);
      if (actionLabelMatches(text, label)) return el;
    }
  }
  return null;
}

function visibleActionLabels() {
  return [...document.querySelectorAll("button, [role='button'], input[type='submit'], a[href]")]
    .filter(isVisible)
    .map(elementLabel)
    .filter(Boolean)
    .filter((label, index, all) => all.indexOf(label) === index)
    .slice(0, 14);
}

function isWaitlistOnlyEvent() {
  const opts = { checkFormScope: false };
  const hasWaitlistBtn = Boolean(findClickable(WAITLIST_LABELS, opts));
  const hasRegisterBtn = Boolean(
    findClickable(["register", "rsvp", "get ticket", "get tickets", ...REQUEST_LABELS], opts)
  );
  const text = pageText();
  const waitlistContext =
    /\bevent full\b|\bjoin the waitlist\b|\bjoin waitlist\b|\bon the waitlist\b/.test(text);

  if (hasWaitlistBtn && !hasRegisterBtn) return true;
  if (hasWaitlistBtn && waitlistContext) return true;
  return false;
}

function isApprovalRequestEvent() {
  const opts = { checkFormScope: false };
  const hasRequestBtn = Boolean(findClickable(REQUEST_LABELS, opts));
  if (!hasRequestBtn) return false;

  const text = pageText();
  const approvalContext =
    /\bapproval required\b|\bsubject to host approval\b|\brequest to attend\b|\brequest to join\b|\bhost approval\b/.test(
      text
    );
  const hasPlainRegister = Boolean(
    findClickable(["register", "rsvp", "get ticket", "get tickets"], opts)
  );

  if (approvalContext) return true;
  return !hasPlainRegister;
}

/**
 * True when this event page is showing the user an open invitation. Detected from the accept
 * control plus invitation wording, so a normal event that happens to have an "Accept" button
 * somewhere (cookie banners, terms) is not mistaken for one.
 */
function isInvitedEvent() {
  const opts = { checkFormScope: false };
  const text = pageText();
  const hasInviteWording = INVITE_BADGE_PHRASES.some((phrase) => text.includes(phrase));
  const hasAcceptControl = Boolean(findClickable(INVITE_LABELS, opts));
  const hasDeclineControl = [
    ...document.querySelectorAll("button, [role='button'], input[type='submit'], a[href]"),
  ]
    .filter(isVisible)
    .some(isDeclineControl);

  if (!hasAcceptControl) return false;
  // An accept paired with a decline is the invitation control pair; wording alone also qualifies.
  return hasInviteWording || hasDeclineControl;
}

function getRegistrationMode() {
  if (isInvitedEvent()) return "invite";
  if (isWaitlistOnlyEvent()) return "waitlist";
  if (isApprovalRequestEvent()) return "request";
  return "standard";
}

function labelsForMode(mode, phase = "open") {
  if (mode === "invite") {
    // Accept first, then the normal registration labels: accepting often opens a regular
    // registration form that still has to be filled in and submitted.
    return [...INVITE_LABELS, ...REGISTER_LABELS, ...REQUEST_LABELS];
  }
  if (mode === "waitlist") {
    return phase === "submit"
      ? [...WAITLIST_LABELS, ...REQUEST_LABELS, ...REGISTER_LABELS]
      : [...WAITLIST_LABELS, ...REQUEST_LABELS, ...REGISTER_LABELS];
  }
  if (mode === "request") {
    return phase === "submit"
      ? [...REQUEST_LABELS, "submit", "confirm", ...REGISTER_LABELS, ...WAITLIST_LABELS]
      : [...REQUEST_LABELS, ...REGISTER_LABELS, ...WAITLIST_LABELS];
  }
  return phase === "submit"
    ? [...REGISTER_LABELS, ...REQUEST_LABELS, ...WAITLIST_LABELS]
    : [...REGISTER_LABELS, ...REQUEST_LABELS, ...WAITLIST_LABELS];
}

function canJoinDespiteCapacity() {
  return Boolean(
    findClickable([...INVITE_LABELS, ...WAITLIST_LABELS, ...REQUEST_LABELS, ...REGISTER_LABELS], {
      checkFormScope: false,
    })
  );
}

function isBlockedByCapacity() {
  const text = pageText();
  const capacityIssue = /\bsold out\b|\bevent full\b|\bnear capacity\b/.test(text);
  if (!capacityIssue) return false;
  return !canJoinDespiteCapacity();
}

function detectRegistrationUnavailable() {
  const text = pageText();
  if (/\bevent (?:has )?(?:ended|is over)\b|\bthis event is over\b/.test(text)) {
    return { status: "event_ended", message: "Event has ended — skipped" };
  }
  if (/\bevent (?:is )?cancelled\b|\bevent (?:is )?canceled\b/.test(text)) {
    return { status: "event_cancelled", message: "Event cancelled — skipped" };
  }
  if (
    /\bregistration (?:is |has )?closed\b|\bregistrations? (?:are |have )?closed\b|\bno longer accepting registrations?\b/.test(
      text
    )
  ) {
    return { status: "registration_closed", message: "Registration closed — skipped" };
  }
  return null;
}

function isRateLimitPage() {
  const text = `${document.title || ""} ${pageText()}`.toLowerCase();
  return (
    /\brate limit hit\b/.test(text) ||
    /\byou (?:have )?run into a rate limit\b/.test(text) ||
    /\btoo many requests\b/.test(text) ||
    /\bplease slow down and try again\b/.test(text)
  );
}

function isCalendarOrSystemPage() {
  if (!isValidEventHref(window.location.href)) return true;
  const headings = [...document.querySelectorAll("h1, h2")]
    .filter(isVisible)
    .map((heading) => (heading.textContent || "").trim().toLowerCase());
  const actions = visibleActionLabels();
  const hasCalendarAdmin = actions.includes("submit event") || actions.includes("follow");
  const hasEventsHeading = headings.includes("events");
  const hasRegistrationAction = Boolean(
    findClickable(ALL_ACTION_LABELS, { checkFormScope: false })
  );
  return hasCalendarAdmin && hasEventsHeading && !hasRegistrationAction;
}

function ticketHeading(el) {
  return (el.textContent || "")
    .trim()
    .split(/\n/)[0]
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim();
}

function isOnlineTicketHeading(heading) {
  return (
    heading === "livestream" ||
    heading === "live stream" ||
    heading.startsWith("livestream ") ||
    heading.startsWith("live stream ") ||
    heading === "online" ||
    heading === "online only" ||
    heading === "virtual" ||
    heading === "remote"
  );
}

async function selectTicketType(profile, log = () => {}) {
  const root = getRegistrationPanelRoot();
  const scope =
    root === document.body ? "page body" : root.getAttribute("class")?.split(/\s+/)[0] || "registration panel";
  log("ticket", `Scanning ticket options (${scope})…`, "info");

  const candidates = [
    ...root.querySelectorAll("button, [role='button'], [role='radio'], label"),
  ]
    .filter(isVisible)
    .filter((el) => !isUnsafeClickTarget(el));

  log("ticket", `Found ${candidates.length} ticket control(s)`, "info");
  if (!candidates.length) {
    log("ticket", "No ticket buttons in registration panel — may be single-ticket event", "info");
    return false;
  }

  const inPersonPrefs = ["in person", "in-person", "inperson", "attend in person"];
  for (const pref of inPersonPrefs) {
    for (const el of candidates) {
      const heading = ticketHeading(el);
      if (!heading) continue;
      if (heading === pref || heading.startsWith(`${pref} `)) {
        log("ticket", `Selecting in-person ticket (${heading})`);
        await agentClick(el, "Selecting in-person ticket…", log, "ticket");
        await runAwareSleep(800);
        return true;
      }
    }
  }

  const job = (profile.job_title || "").toLowerCase();
  let prefs = ["operators", "operator", "engineer", "general", "attendee", "guest"];
  if (job.includes("founder") || job.includes("ceo")) {
    prefs = ["founders", "founder", ...prefs];
  } else if (job.includes("invest") || job.includes("partner")) {
    prefs = ["investors", "investor", ...prefs];
  }

  for (const pref of prefs) {
    for (const el of candidates) {
      const heading = ticketHeading(el);
      if (!heading || isOnlineTicketHeading(heading)) continue;
      if (heading === pref || heading.startsWith(`${pref} `)) {
        log("ticket", `Selecting ticket type (${heading})`);
        await agentClick(el, "Selecting ticket type…", log, "ticket");
        await runAwareSleep(800);
        return true;
      }
    }
  }

  return false;
}

function isPaidEvent(eventMeta = {}) {
  return isPaidEventPageWithTrust(document, eventMeta);
}

function skipPaidResult() {
  return { success: false, status: "skipped_paid", message: "Paid event — payment required, skipped" };
}

function getEventTitle() {
  return (
    document.querySelector("h1")?.textContent?.trim() ||
    document.querySelector('[class*="title"] h1')?.textContent?.trim() ||
    document.title?.split("|")[0]?.trim() ||
    ""
  );
}

function assertNotPaid(stage, eventMeta = {}) {
  if (eventMeta.isFree === true && !hasVisibleCardFields()) return null;
  if (isPaymentRequired()) {
    setAgentStatus(`Paid event — ${stage || "payment detected"}, skipped`);
    return skipPaidResult();
  }
  return null;
}

async function resolveSmartAnswer(label, profile, fieldType = "text") {
  await throwIfAborted();
  const qType = classifyQuestion(label);
  let value = answerForQuestion(label, profile);
  if (value) return { value, qType, fromLlm: false };

  if (!needsSmartAnswer(qType, label)) return { value: null, qType, fromLlm: false };

  try {
    const response = await sendMessageWithAbort({
      type: "ANSWER_QUESTION",
      question: label,
      profile,
      eventTitle: getEventTitle(),
      fieldType,
      qType,
    });
    if (response?.answer) {
      return { value: response.answer, qType, fromLlm: true };
    }
  } catch (err) {
    if (err instanceof RunAbortedError) throw err;
    /* background unavailable */
  }

  return { value: null, qType, fromLlm: false };
}

function isLoginRequired() {
  if (pageText().includes("sign in") && window.location.pathname.includes("sign")) return true;
  const modal = getRegistrationModalRoot();
  if (!modal) return false;
  const text = (modal.innerText || modal.textContent || "").toLowerCase();
  return (
    /\bsign in\b|\blog in\b|\bcontinue with (?:google|email)\b/.test(text) &&
    Boolean(modal.querySelector('input[type="email"], input[type="password"], button'))
  );
}

function setNativeValue(el, value) {
  const proto =
    el.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

async function setNativeValueVisual(el, value, hint) {
  await visualFillField(el, hint ? `Filling: ${trimStatus(hint)}` : "Filling field…");
  setNativeValue(el, value);
  await runAwareSleep(150);
}

async function fillNativeSelect(select, label, profile) {
  const options = [...select.options].map((o) => ({
    el: o,
    text: o.textContent.trim(),
    value: o.value,
  }));

  const type = classifyQuestion(label);
  let answer = answerForQuestion(label, profile);

  if (
    type === "referral" ||
    type === "newsletter" ||
    type === "role_category" ||
    type === "instagram_follow" ||
    type === "gender" ||
    isPlaceholderOption(select.options[select.selectedIndex]?.text)
  ) {
    const pick = pickBestSelectOption(options, label, profile);
    if (pick) {
      await visualClick(select, trimStatus(label) || "Selecting option…");
      select.value = pick.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return { filled: true, answer: pick.text, isNew: type === "referral" || type === "role_category" || type === "instagram_follow" };
    }
  }

  if (answer) {
    const match = options.find(
      (o) =>
        o.text.toLowerCase().includes(answer.toLowerCase()) ||
        o.value.toLowerCase().includes(answer.toLowerCase())
    );
    if (match) {
      select.value = match.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return { filled: true, answer: match.text, isNew: false };
    }
  }

  const fallback = pickBestSelectOption(options, label, profile);
  if (fallback) {
    select.value = fallback.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return { filled: true, answer: fallback.text, isNew: true };
  }

  return { filled: false };
}

async function fillCustomDropdowns(profile, newAnswers, log = () => {}) {
  let filled = 0;
  const triggers = findCustomDropdownTriggers();
  const handled = new Set();

  log("fill", `Custom dropdowns: ${triggers.length} trigger(s) in registration modal`, "info");
  if (!triggers.length) {
    const modal = getRegistrationModalRoot();
    if (!modal) log("fill", "Registration modal not detected — waiting for form drawer", "warn");
    return 0;
  }

  log("fill", `Fields to fill: ${describeUnfilledFields()}`, "info");

  for (const trigger of triggers) {
    if (handled.has(trigger)) continue;
    const label = getQuestionTextForElement(trigger);
    if (isEventBodyCopy(label)) continue;

    const multi = isMultiSelectLabel(label) || isMultiSelectLabel(trigger.textContent);
    const activator = resolveDropdownActivator(trigger);
    log("fill", `Opening: ${trimStatus(label, 60) || "dropdown"}${multi ? " (multi-select)" : ""}`, "info");

    let options = [];
    if (multi) {
      options = collectFieldScopedOptions(activator);
      if (options.length) {
        log("fill", `Found ${options.length} inline option(s) without opening`, "info", {
          sample: options
            .slice(0, 4)
            .map((o) => o.text)
            .join(", "),
        });
      }
    }

    if (!options.length) {
      activator.scrollIntoView({ block: "center" });
      const beforeSnap = snapshotInteractiveTexts();
      await openDropdownRobust(activator, log);

      for (let wait = 0; wait < 10; wait++) {
        await runAwareSleep(wait === 0 ? 600 : 450);
        options = collectDropdownOptions(activator, document, beforeSnap);
        if (options.length) break;
        log("fill", `Waiting for options (${wait + 1}/10)…`, "info", {
          discovery: describeDropdownDiscovery(activator),
        });
      }
    }

    log("fill", `"${trimStatus(label, 40) || "field"}": ${options.length} option(s)`, "info", {
      discovery: describeDropdownDiscovery(activator),
    });
    const picks = pickMultipleSelectOptions(options, label, profile, multi ? 3 : 1);

    if (multi && picks.length) {
      log("fill", `Profile pick(s): ${picks.map((p) => p.text).join(", ")}`, "info");
      const answers = await fillMultiSelectSequential(activator, label, profile, log);
      for (const a of answers) {
        filled++;
        if (label) newAnswers.push({ question: label, answer: a });
      }
      handled.add(trigger);
    } else if (picks.length) {
      log("fill", `Profile pick(s): ${picks.map((p) => p.text).join(", ")}`, "info");
      for (let i = 0; i < picks.length; i++) {
        const pick = picks[i];
        if (i > 0 && !dropdownHasVisibleOptions(activator, label)) {
          await openDropdownRobust(activator, log);
          await runAwareSleep(350);
        }
        const el = resolveOptionElement(pick.text, activator, label) || pick.el;
        const picked = await agentClick(el, `Choosing: ${trimStatus(pick.text, 32)}`, log, "fill", { quick: true });
        if (picked) {
          filled++;
          if (label) newAnswers.push({ question: label, answer: pick.text });
        }
        await runAwareSleep(250);
      }
      await closeDropdown(activator, log);
      handled.add(trigger);
    } else if (options.length) {
      log("fill", `No confident profile match among ${options.length} option(s) — asking AI to choose`, "info", {
        options: options
          .slice(0, 8)
          .map((o) => o.text)
          .join(", "),
      });
      const chosen = (await chooseOptionSmart(options, label, profile, getEventTitle(), log)) || options[0];
      const el = resolveOptionElement(chosen.text, activator, label) || chosen.el;
      const picked = await agentClick(
        el,
        `Choosing: ${trimStatus(chosen.text, 32)}`,
        log,
        "fill"
      );
      if (picked) {
        filled++;
        if (label) newAnswers.push({ question: label, answer: chosen.text });
      }
      handled.add(trigger);
    } else if (isDropdownOverlayOpen() || multi) {
      const kbPicked = await fillMultiSelectKeyboard(activator, label, profile, multi, log);
      if (kbPicked.length) {
        for (const t of kbPicked) {
          filled++;
          if (label) newAnswers.push({ question: label, answer: t });
        }
      } else {
        log("fill", `Keyboard fallback for "${trimStatus(label, 40) || "dropdown"}"`, "warn", {
          discovery: describeDropdownDiscovery(activator),
        });
      }
      handled.add(trigger);
    } else {
      log("fill", `No options for "${trimStatus(label, 40) || "dropdown"}"`, "warn", {
        discovery: describeDropdownDiscovery(activator),
      });
    }

    if (isDropdownOverlayOpen()) {
      await closeDropdown(activator, log);
    }
  }

  return filled;
}

async function fillFieldsByLabelScan(profile, newAnswers) {
  const root = getFormRoot();
  if (!root) return 0;
  let filled = 0;

  for (const labelEl of root.querySelectorAll("label, p, span, div, legend")) {
    const text = getFieldLabel(labelEl) || cleanLabel(labelEl.textContent);
    if (!text || text.length < 8 || text.length > 250) continue;

    const container =
      labelEl.closest("[class*='question'], [class*='field'], fieldset, form, div") || labelEl.parentElement;
    if (!container) continue;

    for (const input of container.querySelectorAll("input, textarea")) {
      const type = (input.getAttribute("type") || "text").toLowerCase();
      if (["hidden", "checkbox", "radio", "file", "submit", "button"].includes(type)) continue;
      if (!isVisible(input) || input.value?.trim()) continue;

      const fieldType = input.tagName === "TEXTAREA" ? "textarea" : "text";
      const { value, fromLlm } = await resolveSmartAnswer(text, profile, fieldType);
      if (!value) continue;

      await setNativeValueVisual(input, value, text);
      filled++;
      newAnswers.push({ question: text, answer: value, fromLlm });
    }
  }

  return filled;
}

async function fillForm(profile) {
  const root = getFormRoot();
  if (!root) return { filled: 0, newAnswers: [] };
  let filled = 0;
  const newAnswers = [];

  for (const field of root.querySelectorAll("input, textarea, select")) {
    const type = (field.getAttribute("type") || "text").toLowerCase();
    if (["hidden", "checkbox", "radio", "file", "submit", "button"].includes(type)) continue;
    if (!isVisible(field)) continue;
    if (field.value?.trim()) continue;

    const label = getFieldLabel(field);
    const qType = classifyQuestion(label);

    if (field.tagName === "SELECT") {
      const result = await fillNativeSelect(field, label, profile);
      if (result.filled) {
        filled++;
        if (result.isNew && label) {
          newAnswers.push({ question: label, answer: result.answer });
        }
      }
      continue;
    }

    let value = answerForQuestion(label, profile);
    let isNew = false;
    let fromLlm = false;

    if (!value) {
      const fieldType = field.tagName === "TEXTAREA" ? "textarea" : "text";
      const resolved = await resolveSmartAnswer(label, profile, fieldType);
      value = resolved.value;
      fromLlm = resolved.fromLlm;
      isNew = Boolean(value && (resolved.qType === "custom" || fromLlm));
    }

    if (!value) continue;

    await setNativeValueVisual(field, value, label || qType);
    filled++;
    if (isNew && label) newAnswers.push({ question: label, answer: value });
  }

  return { filled, newAnswers };
}

async function fillConsentCheckboxes(log = () => {}) {
  const root = getFormRoot();
  if (!root) return 0;
  let filled = 0;

  for (const cb of root.querySelectorAll('input[type="checkbox"]')) {
    if (!isVisible(cb) || cb.checked || cb.disabled) continue;

    const labelText = [
      getFieldLabel(cb),
      getQuestionTextForElement(cb),
      cb.closest("label")?.textContent,
      cb.getAttribute("aria-label"),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    if (!labelText) continue;

    // Accept only what's required to register. Optional data-sharing / third-party / sponsor /
    // marketing / photo / recording consents are deliberately left unchecked.
    const isRequiredConsent =
      /terms|conditions|code of conduct|rules|liability|waiver|privacy policy|\bpolicy\b|agree|accept|consent/i.test(
        labelText
      );
    const isOptional =
      /third.?part|sponsor|\bshare\b|data.?shar|marketing|newsletter|promo|updates|subscribe|photo|recording|opt.?in|contact info/i.test(
        labelText
      );

    if (isRequiredConsent && !isOptional) {
      log("fill", `Accepting consent: ${labelText.slice(0, 60)}`, "info");
      await agentClick(cb, "Accepting terms…", log, "fill");
      cb.checked = true;
      cb.dispatchEvent(new Event("change", { bubbles: true }));
      filled++;
    } else if (isOptional) {
      log("fill", `Left optional consent unchecked: ${labelText.slice(0, 60)}`, "info");
    }
  }

  return filled;
}

async function fillAllFields(profile, log = () => {}, eventTitle = "") {
  setAgentStatus("Filling registration form…");
  const agentResult = await runFormAgent(profile, eventTitle || getEventTitle(), log);
  const saved = agentResult.newAnswers || [];
  if (agentResult.filled) {
    log("fill", `Form agent filled ${agentResult.filled} field(s)`, "info");
  }

  // Legacy pass for anything the scanner missed
  for (let pass = 0; pass < 2; pass++) {
    await fillConsentCheckboxes(log);
    const batch = await fillForm(profile);
    mergeNewAnswers(saved, batch.newAnswers);
    await fillFieldsByLabelScan(profile, saved);
    await fillCustomDropdowns(profile, saved, log);
    await runAwareSleep(300);
  }

  clearHighlight();
  return saved;
}

function mergeNewAnswers(collected, batch) {
  for (const item of batch) {
    if (!item.question) continue;
    const exists = collected.some(
      (c) => c.question.toLowerCase() === item.question.toLowerCase()
    );
    if (!exists) collected.push(item);
  }
}

function hasEmptyRequiredFields() {
  return hasUnfilledFormFields();
}

function findSubmitButton(mode = "standard") {
  if (isDropdownOverlayOpen()) return null;
  if (hasUnfilledFormFields()) return null;

  const strict =
    mode === "waitlist"
      ? ["join waitlist", "join the waitlist", "complete registration", "submit"]
      : mode === "request"
        ? ["send request", "submit request", "request to join", "complete registration", "submit"]
        : ["complete registration", "submit registration", "submit", "register"];

  const strictBtn = findClickable(strict);
  if (strictBtn && !strictBtn.disabled) return strictBtn;

  const btn = findClickable(labelsForMode(mode, "submit"));
  if (!btn || btn.disabled) return null;
  return btn;
}

function isWaitlistSuccess() {
  const text = pageText();
  if (
    /\byou(?:'re| are) on the waitlist\b/.test(text) ||
    /\badded to (?:the )?waitlist\b/.test(text) ||
    /\bjoined the waitlist\b/.test(text) ||
    /\byou(?:'ve| have) joined the waitlist\b/.test(text)
  ) {
    return true;
  }
  return Boolean(findClickable(["leave waitlist", "cancel waitlist"]));
}

function isNewRegistrationSuccess(mode = "standard") {
  if (isRegistrationFormOpen() || isDropdownOverlayOpen()) return null;
  if (hasUnfilledFormFields()) return null;

  const text = pageText();

  if (detectYoureIn() || detectUserRsvpBadge()?.status === "already_registered") {
    return mode === "invite"
      ? { success: true, status: "invitation_accepted", message: "Invitation accepted" }
      : { success: true, status: "registered", message: "Registration complete" };
  }

  if (isWaitlistSuccess()) {
    return {
      success: true,
      status: mode === "waitlist" ? "waitlist_joined" : "registered",
      message: mode === "waitlist" ? "Joined waitlist" : "Added to waitlist",
    };
  }

  if (
    /\byour request (?:has been )?sent\b/.test(text) ||
    /\byour request (?:has been )?submitted\b/.test(text) ||
    text.includes("request submitted") ||
    text.includes("application received") ||
    text.includes("application submitted") ||
    text.includes("subject to host approval") ||
    text.includes("registration is subject to host approval")
  ) {
    return {
      success: true,
      status: "pending_approval",
      message: "Request to join submitted — pending approval",
    };
  }

  if (
    (text.includes("you're going") || text.includes("you're registered") || text.includes("you're in")) &&
    !findClickable(labelsForMode(mode, "open"))
  ) {
    return { success: true, status: "registered", message: "Registration complete" };
  }

  return null;
}

async function clickPrimaryAction(mode = "standard", log = () => {}) {
  // The registration modal does not exist yet, so page-level CTA buttons must not be rejected by
  // form-scope safety checks. Navigation-link safety still remains enabled.
  const btn = findClickable(labelsForMode(mode, "open"), { checkFormScope: false });
  if (!btn) {
    const labels = visibleActionLabels();
    log(
      "open_form",
      `Primary action button not found${labels.length ? ` · visible: ${labels.join(" | ")}` : ""}`,
      "warn"
    );
    return false;
  }
  const labels = {
    waitlist: "Joining waitlist…",
    request: "Request to join…",
    standard: "Opening registration…",
  };
  const clicked = await agentClick(
    btn,
    labels[mode] || "Opening registration…",
    log,
    "open_form",
    { checkFormScope: false }
  );
  if (!clicked) return false;
  await runAwareSleep(1200);
  return true;
}

async function clickSubmit(mode = "standard", log = () => {}) {
  const btn = findSubmitButton(mode);
  if (!btn) {
    log("submit", "Submit button not available (form incomplete or dropdown open)", "warn");
    return false;
  }
  const labels = {
    waitlist: "Submitting waitlist…",
    request: "Submitting request…",
    standard: "Submitting registration…",
  };
  const clicked = await agentClick(btn, labels[mode] || "Submitting…", log, "submit");
  if (!clicked) return false;
  await runAwareSleep(1600);
  return true;
}

async function prepareRegistrationForm(profile, savedAnswers, log, expectedEventUrl, eventTitle = "") {
  for (let pass = 0; pass < 4; pass++) {
    await throwIfAborted();
    await guardEventPage(expectedEventUrl, log, "fill");
    mergeNewAnswers(savedAnswers, await fillAllFields(profile, log, eventTitle));
    await runAwareSleep(500);
    await guardEventPage(expectedEventUrl, log, "fill");

    if (!hasUnfilledFormFields() && !isDropdownOverlayOpen()) {
      log("validate", `Form ready after ${pass + 1} pass(es)`);
      return true;
    }

    log("fill", `Form pass ${pass + 1} — filling dropdowns & required fields…`, "info");
  }

  const ready = !hasUnfilledFormFields() && !isDropdownOverlayOpen();
  if (!ready) {
    log("validate", `Required fields or dropdowns still unfilled: ${describeUnfilledFields()}`, "warn");
  }
  return ready;
}

async function registerOnPage(profile, keepCursor = false, eventMeta = {}) {
  resetAbortFlag();
  let runPhase = "init";
  const savedAnswers = [];

  const log = (step, message, level = "info", meta = {}) => {
    runPhase = step;
    sendRunLog(step, message, level, {
      eventSlug: eventMeta.slug,
      eventTitle: eventMeta.title,
      phase: runPhase,
      ...meta,
    });
  };

  enableAgentCursor("Starting registration…");
  const expectedEventUrl = getStablePageUrl();
  log("preflight", `Starting: ${eventMeta.title || "event"}`, "info", { url: expectedEventUrl });

  try {
  await runAwareSleep(800);
  await guardEventPage(expectedEventUrl, log, "preflight");

  if (await refreshAbortFromSession()) return abortedResult();

  if (isRateLimitPage()) {
    log("preflight", "Luma rate limit page detected — no actions taken", "warn");
    return {
      success: false,
      status: "rate_limited",
      message: "Luma rate limit detected — waiting before retry",
    };
  }

  if (isCalendarOrSystemPage()) {
    log("skip", "Not an individual Luma event page", "warn");
    return skipResult("skipped_non_event", "Calendar/system page — skipped");
  }

  if (isLoginRequired()) {
    log("preflight", "Login required", "warn");
    return { success: false, status: "login_required", message: "Please sign in to Luma first" };
  }

  // Pick the identity to present based on the event (founder vs engineer). Applied before ticket
  // selection + form filling so category/ticket prefs and answers all use the same persona.
  const personaPageText = (document.body?.innerText || "").slice(0, 5000);
  profile = applyEventPersona(profile, eventMeta.title || getEventTitle(), personaPageText);
  if (profile.active_persona) {
    log("preflight", `Persona: ${profile.active_persona} — ${profile.job_title} @ ${profile.company}`, "info");
  }

  log("preflight", "Checking existing registration state…", "info");
  const existing = detectExistingRegistration(true);
  if (existing) {
    log("skip", existing.message || "Already handled", "info");
    setAgentStatus(existing.message || "Already handled");
    return existing;
  }

  const unavailable = detectRegistrationUnavailable();
  if (unavailable) {
    log("skip", unavailable.message, "info");
    return { success: true, skipped: true, ...unavailable };
  }

  if (isWomenOnlyEventPage()) {
    log("skip", "Women-only event", "info");
    setAgentStatus("Women-only event — skipped");
    return skipResult("skipped_women_only", "Women-only event — skipped");
  }

  log("preflight", "Checking virtual vs in-person…", "info");
  if (isVirtualEventPage()) {
    log("skip", "Virtual/online event", "info");
    setAgentStatus("Virtual/online event — skipped");
    return skipResult("skipped_virtual", "Virtual/online event — skipped");
  }

  log("preflight", "Checking capacity…", "info");
  if (isBlockedByCapacity()) {
    log("skip", "Sold out", "warn");
    return { success: false, status: "sold_out", message: "Event sold out" };
  }

  log("ticket", "Selecting ticket type…");
  setAgentStatus("Checking ticket options…");
  await selectTicketType(profile, log);
  await guardEventPage(expectedEventUrl, log, "ticket");

  log("preflight", "Checking payment required…", "info", {
    apiFree: eventMeta.isFree,
    apiApproval: eventMeta.requireApproval,
  });
  if (isPaidEvent(eventMeta)) {
    log("skip", "Paid event — payment required", "info", {
      cardFields: hasVisibleCardFields(),
      freeTier: panelShowsFreeTier(),
    });
    return skipPaidResult();
  }

  let mode = getRegistrationMode();
  if (mode === "waitlist" || mode === "request") await runAwareSleep(600);

  log("open_form", `Opening registration (${mode})…`);
  let opened = await clickPrimaryAction(mode, log);
  await guardEventPage(expectedEventUrl, log, "open_form");
  if (!opened && !document.querySelector("input, textarea, select, [role='combobox']")) {
    if (mode === "waitlist" || mode === "request") {
      await selectTicketType(profile, log);
      await runAwareSleep(500);
      mode = getRegistrationMode();
      opened = await clickPrimaryAction(mode, log);
      await guardEventPage(expectedEventUrl, log, "open_form");
    }
    if (!opened) {
      const after = detectExistingRegistration(true);
      if (after) {
        log("skip", after.message || "Already handled after open", "info");
        return after;
      }
      const msg =
        mode === "invite"
          ? "Accept Invitation button not found"
          : mode === "waitlist"
            ? "Join Waitlist button not found"
            : mode === "request"
              ? "Request to Join button not found"
              : "Register button not found";
      log("open_form", msg, "error");
      return { success: false, status: "no_button", message: msg };
    }
  }

  await runAwareSleep(1200);

  if (isLoginRequired()) {
    log("preflight", "Sign-in prompt opened", "warn");
    return { success: false, status: "login_required", message: "Please sign in to Luma first" };
  }

  const paidAfterOpen = assertNotPaid("card checkout detected", eventMeta);
  if (paidAfterOpen) {
    log("skip", "Paid checkout detected", "warn");
    return paidAfterOpen;
  }

  const existingAfter = detectExistingRegistration(true);
  if (existingAfter) {
    log("skip", existingAfter.message || "Already registered", "info");
    return existingAfter;
  }

  if (requiresWallet()) {
    log("preflight", "Wallet/token verification required at submit — will fill form then skip if blocked", "warn");
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    await throwIfAborted();
    const paidMid = assertNotPaid("payment form detected", eventMeta);
    if (paidMid) {
      log("skip", "Payment form detected", "warn");
      return paidMid;
    }

    log("fill", `Filling form (attempt ${attempt + 1}/5)…`);
    const ready = await prepareRegistrationForm(profile, savedAnswers, log, expectedEventUrl, eventMeta.title);
    if (!ready) {
      await runAwareSleep(600);
      continue;
    }

    const paidBeforeSubmit = assertNotPaid("payment required before submit", eventMeta);
    if (paidBeforeSubmit) {
      log("skip", "Payment required before submit", "warn");
      return paidBeforeSubmit;
    }

    log("submit", "Submitting registration…");
    await guardEventPage(expectedEventUrl, log, "submit");
    const submitted = await clickSubmit(mode, log);
    await guardEventPage(expectedEventUrl, log, "submit");
    if (!submitted) {
      log("submit", "Submit not available — dropdown may still be open", "warn");
      await runAwareSleep(800);
      continue;
    }

    await runAwareSleep(1800);

    log("verify", "Checking registration result…");
    const success = isNewRegistrationSuccess(mode);
    if (success) {
      log("done", success.message || "Registration complete", "success");
      setAgentStatus(success.message || "Done!");
      return { ...success, newAnswers: savedAnswers };
    }

    if (requiresWallet()) {
      log("skip", "Wallet connect required", "warn");
      return {
        success: false,
        status: "skipped_wallet",
        message: "Wallet connect required to complete — skipped",
        newAnswers: savedAnswers,
      };
    }

    const mid = detectExistingRegistration(false);
    if (mid) {
      log("verify", mid.message || "Registration state detected", "info");
      return { ...mid, newAnswers: savedAnswers };
    }

    log("verify", `Attempt ${attempt + 1} — registration not confirmed yet`, "warn");
  }

  const failMsg = hasUnfilledFormFields()
    ? "Required fields not filled (check dropdowns)"
    : "Could not confirm registration";
  log("error", failMsg + (hasUnfilledFormFields() ? `: ${describeUnfilledFields()}` : ""), "error");
  return {
    success: false,
    status: "failed",
    message: failMsg,
    newAnswers: savedAnswers,
  };
  } catch (err) {
    if (err instanceof RunAbortedError) return abortedResult();
    if (err instanceof EventNavigationError) {
      log("error", err.message, "error", { url: err.url, expectedUrl: expectedEventUrl });
      return {
        success: false,
        status: "navigated_away",
        message: err.message,
        newAnswers: savedAnswers,
      };
    }
    const message = err?.message || String(err) || "Registration error";
    const stackHint = err?.stack ? err.stack.split("\n").slice(1, 4).join(" ← ") : "";
    log("error", `${message} [phase=${runPhase}]`, "error", {
      phase: runPhase,
      errorName: err?.name || "Error",
      stack: stackHint,
      url: window.location.href,
      modalOpen: Boolean(getRegistrationModalRoot()),
      formRoot: Boolean(getFormRoot()),
      panelRoot: getRegistrationPanelRoot() !== document.body,
    });
    setAgentStatus(message.slice(0, 120));
    return { success: false, status: "error", message: `${message} (phase: ${runPhase})` };
  } finally {
    if (keepCursor) {
      setAgentStatus("Preparing next event…");
    } else {
      await runAwareSleep(600);
      disableAgentCursor();
    }
  }
}

if (window.__lumaAgentLoaded) {
  /* already active */
} else {
  window.__lumaAgentLoaded = true;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "SCAN_INVITES") {
    scanInvitationsWithScroll()
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ invites: [], skipUrls: {}, error: err.message }));
    return true;
  }
  if (message.type === "REGISTER") {
    resetAbortFlag();
    registerOnPage(message.profile, Boolean(message.keepCursor), message.event || {})
      .then((result) => sendResponse(result))
      .catch((err) =>
        sendResponse(
          err instanceof RunAbortedError
            ? abortedResult()
            : { success: false, status: "error", message: err.message }
        )
      );
    return true;
  }
  if (message.type === "ABORT_RUN") {
    abortRunRequested = true;
    setAgentStatus(message.reason === "skip" ? "Skipping current event…" : "Stopping…");
    sendResponse({ ok: true });
    return true;
  }
  if (message.type === "CURSOR") {
    if (message.action === "enable") enableAgentCursor(message.message);
    else if (message.action === "status") setAgentStatus(message.message);
    else if (message.action === "disable") disableAgentCursor();
    sendResponse({ ok: true });
    return true;
  }
  if (message.type === "PING") {
    sendResponse({ ok: true });
    return true;
  }
  if (message.type === "CHECK_STATUS") {
    sendResponse(detectExistingRegistration(true) || { status: "not_registered" });
    return true;
  }
  if (message.type === "INSPECT_REGISTRATION_ACTION") {
    const mode = getRegistrationMode();
    const action = findClickable(labelsForMode(mode, "open"), { checkFormScope: false });
    sendResponse({
      ok: true,
      mode,
      action: action ? elementLabel(action) : null,
      visibleActions: visibleActionLabels(),
      formOpen: isRegistrationFormOpen(),
    });
    return true;
  }
  if (message.type === "SCAN_FEED") {
    scanDiscoverPageFeedWithScroll().then(sendResponse);
    return true;
  }
});

restoreCursorIfRunActive();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;

  const control = changes.runControlMirror?.newValue;
  if (control?.runStopRequested || control?.runSkipRequested) {
    abortRunRequested = true;
    setAgentStatus(control.runSkipRequested ? "Skipping current event…" : "Stopping…");
  }

  if (changes.runState?.newValue) {
    readRunControlMirror().then((ctrl) => {
      if (ctrl.agentCursorActive) {
        enableAgentCursor(buildRunStatusMessage(changes.runState.newValue));
      }
    });
  }
});

} // end __lumaAgentLoaded guard

/** Scan luma.com/sf feed for skip statuses and priority event order */
function scanDiscoverPageFeed() {
  const skipUrls = {};
  const prioritySlugs = [];
  const eventLinks = [];
  // Luma renders most calendar cards with relative href attributes (for example /hacksprint-sf).
  // Read every anchor and validate its resolved absolute `href` below.
  const cards = document.querySelectorAll("a[href]");

  for (const card of cards) {
    const href = card.href.split("?")[0];
    if (!isValidEventHref(href)) continue;

    // Calendar pages such as /genai-sf look like a one-segment event URL. Never return the
    // source calendar itself as one of its events.
    try {
      const target = new URL(href);
      if (target.hostname === location.hostname && target.pathname.replace(/\/$/, "") === location.pathname.replace(/\/$/, "")) {
        continue;
      }
    } catch {
      continue;
    }

    const slug = href.split("/").filter(Boolean).pop();
    if (!slug) continue;

    const container = card.closest("article, li, [class*='card'], div") || card;
    if (!prioritySlugs.includes(slug)) {
      prioritySlugs.push(slug);
      const title = (
        card.getAttribute("aria-label") ||
        card.textContent ||
        container.querySelector("h1, h2, h3, h4")?.textContent ||
        container.innerText ||
        slug
      )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160);
      eventLinks.push({ slug, url: `https://luma.com/${slug}`, title: title || slug });
    }

    const hasUserGoing = [...container.querySelectorAll("*")].some(
      (el) => el.childElementCount === 0 && el.textContent.trim() === "Going"
    );
    if (hasUserGoing) {
      skipUrls[href] = "already_registered";
      if (slug) skipUrls[`slug:${slug}`] = "already_registered";
      continue;
    }

    const hasPending = [...container.querySelectorAll("*")].some(
      (el) => el.childElementCount === 0 && el.textContent.trim() === "Pending"
    );
    if (hasPending) {
      skipUrls[href] = "pending_approval";
      if (slug) skipUrls[`slug:${slug}`] = "pending_approval";
    }
  }

  return { skipUrls, prioritySlugs, eventLinks };
}

/**
 * Collect open invitations from luma.com/home. A card counts as an invitation when it carries
 * invitation wording or an accept/decline control pair — cards already marked Going or Pending
 * are recorded as skips so the run never re-opens them.
 */
function scanInvitationCards() {
  if (isRateLimitPage()) {
    return { invites: [], skipUrls: {}, rateLimited: true };
  }

  const invites = [];
  const skipUrls = {};
  const seen = new Set();

  for (const card of document.querySelectorAll("a[href]")) {
    const href = card.href.split("?")[0];
    if (!isValidEventHref(href)) continue;

    const slug = href.split("/").filter(Boolean).pop();
    if (!slug || seen.has(slug)) continue;

    const container = card.closest("article, li, [class*='card'], div") || card;
    const containerText = (container.innerText || "").replace(/\s+/g, " ").trim().toLowerCase();

    const badge = (label) =>
      [...container.querySelectorAll("*")].some(
        (el) => el.childElementCount === 0 && el.textContent.trim().toLowerCase() === label
      );

    if (badge("going")) {
      skipUrls[href] = "already_registered";
      skipUrls[`slug:${slug}`] = "already_registered";
      continue;
    }
    if (badge("pending")) {
      skipUrls[href] = "pending_approval";
      skipUrls[`slug:${slug}`] = "pending_approval";
      continue;
    }

    const hasInviteWording =
      badge("invited") ||
      INVITE_BADGE_PHRASES.some((phrase) => containerText.includes(phrase)) ||
      containerText.includes("invited you");
    const hasAcceptControl = Boolean(
      findClickable(INVITE_LABELS, { checkFormScope: false, root: container })
    );
    if (!hasInviteWording && !hasAcceptControl) continue;

    seen.add(slug);
    const title = (
      card.getAttribute("aria-label") ||
      container.querySelector("h1, h2, h3, h4")?.textContent ||
      card.textContent ||
      slug
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);

    invites.push({ slug, url: `https://luma.com/${slug}`, title: title || slug, invited: true });
  }

  return { invites, skipUrls, rateLimited: false };
}

/** Scroll the home page so lazily-rendered invitation cards are all present, then collect them. */
async function scanInvitationsWithScroll() {
  const invites = [];
  const skipUrls = {};
  const seen = new Set();

  const merge = (batch) => {
    Object.assign(skipUrls, batch.skipUrls || {});
    for (const invite of batch.invites || []) {
      if (seen.has(invite.slug)) continue;
      seen.add(invite.slug);
      invites.push(invite);
    }
  };

  const first = scanInvitationCards();
  if (first.rateLimited) return { invites: [], skipUrls: {}, rateLimited: true };
  merge(first);

  let stableRounds = 0;
  let lastCount = invites.length;

  for (let i = 0; i < 15; i++) {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
    await sleep(700);
    const batch = scanInvitationCards();
    if (batch.rateLimited) {
      window.scrollTo({ top: 0, behavior: "instant" });
      return { invites: [], skipUrls: {}, rateLimited: true };
    }
    merge(batch);

    if (invites.length === lastCount) {
      stableRounds++;
      if (stableRounds >= 2) break;
    } else {
      stableRounds = 0;
      lastCount = invites.length;
    }
  }

  window.scrollTo({ top: 0, behavior: "instant" });
  return { invites, skipUrls, rateLimited: false, loggedIn: !isLoginRequired() };
}

/** Scroll SF feed to load lazy cards, then collect slugs in page order. */
async function scanDiscoverPageFeedWithScroll() {
  if (isRateLimitPage()) {
    return { skipUrls: {}, prioritySlugs: [], eventLinks: [], rateLimited: true };
  }
  const skipUrls = {};
  const prioritySlugs = [];
  const eventLinks = [];
  const seenLinks = new Set();
  const merge = ({ skipUrls: moreSkip = {}, prioritySlugs: moreSlugs = [], eventLinks: moreLinks = [] }) => {
    Object.assign(skipUrls, moreSkip);
    for (const slug of moreSlugs) {
      if (!prioritySlugs.includes(slug)) prioritySlugs.push(slug);
    }
    for (const event of moreLinks) {
      if (!event?.slug || seenLinks.has(event.slug)) continue;
      seenLinks.add(event.slug);
      eventLinks.push(event);
    }
  };

  merge(scanDiscoverPageFeed());

  let stableRounds = 0;
  let lastCount = prioritySlugs.length;

  for (let i = 0; i < 15; i++) {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
    await sleep(700);
    if (isRateLimitPage()) {
      window.scrollTo({ top: 0, behavior: "instant" });
      return { skipUrls: {}, prioritySlugs: [], eventLinks: [], rateLimited: true };
    }
    merge(scanDiscoverPageFeed());

    if (prioritySlugs.length === lastCount) {
      stableRounds++;
      if (stableRounds >= 2) break;
    } else {
      stableRounds = 0;
      lastCount = prioritySlugs.length;
    }
  }

  window.scrollTo({ top: 0, behavior: "instant" });
  return { skipUrls, prioritySlugs, eventLinks, rateLimited: false };
}

function scanDiscoverPageStatuses() {
  return scanDiscoverPageFeed().skipUrls;
}

if (window.location.pathname.match(/^\/sf\/?$/) || window.location.pathname.includes("/discover")) {
  const updates = scanDiscoverPageStatuses();
  if (Object.keys(updates).length) {
    chrome.storage.local.get("discoverSkipUrls", ({ discoverSkipUrls = {} }) => {
      chrome.storage.local.set({ discoverSkipUrls: { ...discoverSkipUrls, ...updates } });
    });
  }
}
