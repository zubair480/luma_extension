(() => {
  const SCRIPT_VERSION = "1.5.0";
  if (globalThis.__lumaAgentVersion === SCRIPT_VERSION) return;
  globalThis.__lumaAgentCleanup?.();
  globalThis.__lumaAgentVersion = SCRIPT_VERSION;

  const STORAGE_KEYS = {
    profile: "lumaProfile",
    settings: "lumaSettings",
  };

  const DEFAULT_SETTINGS = {
    autoFillOnPage: true,
    autoSubmit: false,
    aiAnswerQuestions: true,
    freeOnly: true,
    cityFilter: "San Francisco",
    delayBetweenMs: 3000,
  };

  const SF_LOCATION_KEYWORDS = [
    "san francisco", "sf", "bay area", "soma", "mission", "financial district", "fidi",
  ];

  const FIELD_PATTERNS = [
    { keys: ["first name", "firstname", "given name"], profileKey: "firstName" },
    { keys: ["last name", "lastname", "family name", "surname"], profileKey: "lastName" },
    { keys: ["full name", "your name", "name"], profileKey: "name" },
    { keys: ["work email", "business email", "company email", "professional email", "corporate email"], profileKey: "workEmail" },
    { keys: ["email address", "your email", "e-mail", "email"], profileKey: "email" },
    { keys: ["how did you find", "mailing list", "wechat", "which friend", "referral", "heard about this event"], profileKey: "referralSource" },
    { keys: ["area of expertise", "your expertise", "expertise", "specialty", "specialization", "field of work"], profileKey: "title" },
    { keys: ["linkedin", "linked in"], profileKey: "linkedin" },
    { keys: ["company", "organization", "organisation", "employer", "org", "where do you work"], profileKey: "company" },
    { keys: ["job title", "title", "role", "position"], profileKey: "title" },
    { keys: ["phone", "mobile", "tel", "number"], profileKey: "phone" },
    { keys: ["website", "url", "portfolio", "personal site"], profileKey: "website" },
    { keys: ["about your background", "your background", "tell us a little about your background", "professional background"], profileKey: "background" },
    { keys: ["bio", "about you", "about yourself", "introduction"], profileKey: "bio" },
    { keys: ["why", "motivation", "reason", "working on"], profileKey: "whyAttend" },
  ];

  const TOAST_ID = "luma-agent-toast";
  const LOADER_ID = "luma-agent-loader";
  const filledControls = new WeakSet();
  const userEditedControls = new WeakSet();
  const filledFormSignatures = new Set();
  const filledChoiceGroups = new Set();
  const aiAnswerCache = new Map();
  let observerActive = false;
  let fillInProgress = false;
  let debounceTimer = null;
  let mutationObserver = null;
  const pendingFillTimers = [];

  function splitName(fullName = "") {
    const parts = fullName.trim().split(/\s+/).filter(Boolean);
    return { first: parts[0] || "", last: parts.slice(1).join(" ") };
  }

  function normalizeProfile(raw = {}) {
    return {
      name: raw.name || "",
      email: raw.email || "",
      workEmail: raw.workEmail || "",
      linkedin: raw.linkedin || "",
      company: raw.company || "",
      title: raw.title || "",
      phone: raw.phone || "",
      website: raw.website || "",
      bio: raw.bio || "",
      teamSize: raw.teamSize || "",
      techStack: raw.techStack || "",
      whyAttend:
        raw.whyAttend ||
        "I'm interested in connecting with the local community and learning from others in the space.",
      noQuestionsAnswer:
        raw.noQuestionsAnswer || "No questions at this time — looking forward to the event!",
      referralSource: raw.referralSource || "Found it while browsing events on Luma.",
      customFields: raw.customFields || {},
    };
  }

  function looksLikeOpenQuestion(label, control) {
    const lower = label.toLowerCase();
    const openPhrases = [
      "how did you find",
      "how did you hear",
      "mailing list",
      "wechat",
      "which friend",
      "biggest challenge",
      "excited to learn",
      "most excited",
      "are you currently",
      "do you currently",
      "why do you want",
      "tell us about",
      "about yourself",
    ];
    if (openPhrases.some((p) => lower.includes(p)) || lower.includes("?")) {
      const type = (control?.type || "").toLowerCase();
      if (type === "email") return false;
      if (type === "text" || type === "search" || control?.tagName === "TEXTAREA" || control?.getAttribute("role") === "textbox") {
        return true;
      }
    }
    return false;
  }

  function labelMatchesKeyword(label, keyword) {
    if (keyword === "mail") return /\bmail\b/i.test(label) && !label.includes("mailing");
    if (keyword.length <= 4) {
      return new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(label);
    }
    return label.includes(keyword);
  }

  function buildBackgroundAnswer(profile) {
    if (profile.bio?.trim()) return profile.bio.trim();

    const title = profile.title?.trim() || "Software Engineer";
    const parts = [`I'm a ${title}`];
    if (profile.company?.trim()) parts.push(`at ${profile.company.trim()}`);
    parts.push("excited to connect and build with others in the space.");
    return `${parts.join(" ")}`;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function textOf(el) {
    return (el?.textContent || el?.innerText || "").trim().toLowerCase();
  }

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isLumaHost() {
    const host = location.hostname.toLowerCase();
    return host === "lu.ma" || host.endsWith(".lu.ma") || host === "luma.com" || host.endsWith(".luma.com");
  }

  function matchProfileKey(labelText, control) {
    const label = labelText.toLowerCase();
    if (looksLikeOpenQuestion(label, control)) return null;

    for (const pattern of FIELD_PATTERNS) {
      if (!pattern.keys.some((k) => labelMatchesKeyword(label, k))) continue;
      if (pattern.profileKey === "name" && (label.includes("first") || label.includes("last"))) continue;
      if (pattern.profileKey === "email" && (label.includes("work") || label.includes("business") || label.includes("company") || label.includes("mailing"))) continue;
      return pattern.profileKey;
    }

    const type = (control?.type || "").toLowerCase();
    const name = (control?.name || control?.id || "").toLowerCase();
    const autocomplete = (control?.getAttribute("autocomplete") || "").toLowerCase();

    if (type === "email" || (name.includes("email") && !name.includes("referral")) || autocomplete === "email") {
      if (label.includes("work") || label.includes("business") || label.includes("company") || name.includes("work")) {
        return "workEmail";
      }
      return "email";
    }
    if (name.includes("firstname") || autocomplete === "given-name") return "firstName";
    if (name.includes("lastname") || autocomplete === "family-name") return "lastName";
    if (autocomplete === "name" || name === "name") return "name";
    if (autocomplete === "organization" || name.includes("company")) return "company";
    if (autocomplete === "organization-title" || name.includes("title")) return "title";
    if (type === "tel" || autocomplete.includes("tel")) return "phone";
    if (autocomplete === "url" || name.includes("website")) return "website";

    return null;
  }

  function profileValue(profile, key) {
    const { first, last } = splitName(profile.name);
    const map = {
      name: profile.name,
      firstName: first,
      lastName: last,
      email: profile.email,
      workEmail: profile.workEmail || profile.email,
      linkedin: profile.linkedin,
      company: profile.company,
      title: profile.title,
      phone: profile.phone,
      website: profile.website,
      bio: profile.bio,
      background: profile.bio?.trim() || buildBackgroundAnswer(profile),
      referralSource: profile.referralSource,
      whyAttend: profile.whyAttend,
    };
    return map[key] || profile.customFields?.[key] || "";
  }

  function setNativeValue(el, value) {
    if (el.isContentEditable || el.getAttribute("role") === "textbox") {
      el.textContent = value;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function controlIsEmpty(el) {
    if (el.isContentEditable || el.getAttribute("role") === "textbox") {
      return !el.textContent?.trim();
    }
    return !el.value?.trim();
  }

  async function fillControl(el, value) {
    if (!value || !el || el.disabled || el.readOnly) return false;
    if (userEditedControls.has(el) || filledControls.has(el)) return false;
    if (!controlIsEmpty(el)) return false;

    el.focus();
    await sleep(30);
    setNativeValue(el, value);

    if (controlIsEmpty(el)) {
      try {
        document.execCommand("selectAll", false, null);
        document.execCommand("insertText", false, value);
      } catch {
        // ignore
      }
    }

    await sleep(80);
    filledControls.add(el);
    // Count as filled if we set a value — Luma/React may not expose it synchronously
    return true;
  }

  function findLabelForControl(control) {
    if (control.id) {
      const byFor = document.querySelector(`label[for="${CSS.escape(control.id)}"]`);
      if (byFor) return textOf(byFor);
    }

    const parentLabel = control.closest("label");
    if (parentLabel) return textOf(parentLabel);

    const fieldWrapper = control.closest(
      "[class*='field'], [class*='question'], [class*='input'], [class*='Form'], [data-testid*='question']"
    );
    if (fieldWrapper) {
      for (const heading of fieldWrapper.querySelectorAll("label, legend, p, span, h2, h3, h4, div")) {
        if (heading === control || heading.contains(control)) continue;
        const t = textOf(heading);
        if (t.length > 4 && t.length < 300) return t;
      }
    }

    let prev = control.previousElementSibling;
    for (let i = 0; i < 4 && prev; i += 1) {
      const t = textOf(prev);
      if (t.length > 4) return t;
      prev = prev.previousElementSibling;
    }

    const labelledBy = control.getAttribute("aria-labelledby");
    if (labelledBy) {
      return labelledBy
        .split(/\s+/)
        .map((id) => textOf(document.getElementById(id)))
        .filter(Boolean)
        .join(" ");
    }

    return textOf(
      control.getAttribute("aria-label") ||
        control.getAttribute("placeholder") ||
        control.getAttribute("name") ||
        control.id
    );
  }

  function getRegistrationRoots() {
    const roots = [];
    const selectors = [
      '[role="dialog"]',
      '[aria-modal="true"]',
      '[class*="modal" i]',
      '[class*="Modal"]',
      '[class*="overlay" i]',
      '[class*="drawer" i]',
      '[class*="Drawer"]',
    ];

    selectors.forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => {
        if (el.querySelector("input, textarea, select, [role='combobox'], [role='textbox']")) {
          roots.push(el);
        }
      });
    });

    roots.push(document);
    return roots;
  }

  function shouldIncludeControl(el) {
    const type = (el.type || "").toLowerCase();
    if (["hidden", "submit", "button", "checkbox", "radio", "file"].includes(type)) return false;
    if (el.closest('[role="dialog"], [aria-modal="true"]')) return true;
    return isVisible(el);
  }

  function collectFormControls() {
    const controls = [];
    const seen = new Set();
    const selector = "input, textarea, select, [contenteditable='true'], [role='textbox']";

    for (const root of getRegistrationRoots()) {
      root.querySelectorAll(selector).forEach((el) => {
        if (seen.has(el) || !shouldIncludeControl(el)) return;
        seen.add(el);
        controls.push(el);
      });
    }

    return controls;
  }

  function getFormSignature() {
    const dialog = document.querySelector('[role="dialog"], [aria-modal="true"]');
    const controls = collectFormControls();
    const labels = controls.slice(0, 8).map((c) => findLabelForControl(c)).join("|");
    return `${location.href}::${dialog ? "modal" : "page"}::${controls.length}::${labels}`;
  }

  function hasVisibleFormFields() {
    return collectFormControls().length > 0;
  }

  function hasOpenRegistrationModal() {
    return Boolean(document.querySelector('[role="dialog"], [aria-modal="true"]'));
  }

  function getMatchTerms(profile, label = "") {
    const terms = new Set();
    const labelLower = label.toLowerCase();

    const addPhrase = (phrase) => {
      if (!phrase?.trim()) return;
      const lower = phrase.toLowerCase().trim();
      terms.add(lower);
      lower.split(/\s+/).forEach((word) => {
        if (word.length > 2) terms.add(word);
      });
    };

    addPhrase(profile.title);
    addPhrase(profile.company);
    if (profile.bio) addPhrase(profile.bio.slice(0, 100));

    const titleLower = (profile.title || "software engineer").toLowerCase();
    if (titleLower.includes("software") || titleLower.includes("engineer") || titleLower.includes("developer")) {
      [
        "software engineer",
        "software engineering",
        "engineer",
        "engineering",
        "developer",
        "software developer",
        "software",
        "tech",
        "technology",
      ].forEach((t) => terms.add(t));
    }

    if (labelLower.includes("background") || labelLower.includes("role") || labelLower.includes("occupation")) {
      addPhrase(profile.title || "Software Engineer");
    }

    if (
      labelLower.includes("expertise") ||
      labelLower.includes("area of") ||
      labelLower.includes("specialty") ||
      labelLower.includes("specialization") ||
      labelLower.includes("field of work") ||
      labelLower.includes("best describes") ||
      labelLower.includes("which describes") ||
      labelLower.includes("your role") ||
      labelLower.includes("i am a") ||
      labelLower.includes("occupation") ||
      labelLower.includes("industry") ||
      labelLower.includes("experience level")
    ) {
      addPhrase(profile.title || "Software Engineer");
      ["software engineer", "engineering", "software", "developer", "technology", "tech"].forEach((t) => terms.add(t));
    }

    return [...terms];
  }

  function findBestMatchingOption(elements, terms, profile) {
    let best = null;
    let bestScore = 0;

    for (const el of elements) {
      const score = scoreOptionText(el.textContent, terms);
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }

    if (best && bestScore > 0) return { best, bestScore };

    const fallbacks = ["software engineer", "engineering", "software", "developer", "tech", "technology"];
    const titleWords = (profile.title || "software engineer").toLowerCase().split(/\s+/);
    const searchTerms = [...fallbacks, ...titleWords];

    for (const el of elements) {
      const text = textOf(el.textContent);
      if (searchTerms.some((term) => term.length > 3 && text.includes(term))) {
        return { best: el, bestScore: 1 };
      }
    }

    return { best: null, bestScore: 0 };
  }

  function scoreOptionText(optionText, terms) {
    const lower = String(optionText || "").trim().toLowerCase();
    if (!lower || lower === "select" || lower === "choose one") return 0;

    let score = 0;
    for (const term of terms) {
      if (lower === term) score += 100;
      else if (lower.includes(term)) score += term.length * 3;
      else if (term.includes(lower) && lower.length > 4) score += lower.length * 2;
    }
    return score;
  }

  function getWrapperLabel(wrapper) {
    for (const el of wrapper.querySelectorAll("label, legend, p, span, h2, h3, h4, div")) {
      const t = textOf(el);
      if (t.length > 8 && t.length < 400) return t;
    }
    return "";
  }

  function selectLooksEmpty(select) {
    if (!select.value) return true;
    const opt = select.options[select.selectedIndex];
    const label = textOf(opt?.textContent);
    return !label || label.includes("select") || label.includes("choose") || label.includes("pick");
  }

  async function fillSelectElement(select, profile, label) {
    if (!select || select.tagName !== "SELECT" || !selectLooksEmpty(select)) return false;

    const terms = getMatchTerms(profile, label);
    const validOptions = [...select.options].filter((opt) => !opt.disabled && opt.value);
    const { best, bestScore } = findBestMatchingOption(validOptions, terms, profile);

    if (!best || bestScore <= 0) return false;

    select.value = best.value;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  async function fillRadioGroup(radios, profile, label) {
    if (radios.some((radio) => radio.checked)) return false;

    const groupKey = `radio:${radios[0]?.name || label}`;
    if (filledChoiceGroups.has(groupKey)) return false;

    const terms = getMatchTerms(profile, label);
    let bestRadio = null;
    let bestScore = 0;

    for (const radio of radios) {
      if (radio.checked || radio.disabled) continue;
      const lbl = radio.closest("label") || (radio.id ? document.querySelector(`label[for="${CSS.escape(radio.id)}"]`) : null);
      const score = scoreOptionText(lbl?.textContent || findLabelForControl(radio), terms);
      if (score > bestScore) {
        bestScore = score;
        bestRadio = radio;
      }
    }

    if (!bestRadio) {
      const fallbacks = ["software", "engineer", "developer", "tech", "engineering"];
      for (const radio of radios) {
        if (radio.checked || radio.disabled) continue;
        const lbl = textOf((radio.closest("label") || {}).textContent || findLabelForControl(radio));
        if (fallbacks.some((f) => lbl.includes(f))) {
          bestRadio = radio;
          break;
        }
      }
    }

    if (!bestRadio) return false;

    bestRadio.click();
    bestRadio.dispatchEvent(new Event("change", { bubbles: true }));
    filledChoiceGroups.add(groupKey);
    return true;
  }

  async function fillLumaDropdown(wrapper, profile, label) {
    const trigger = wrapper.querySelector('[role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="menu"]');
    if (!trigger || !isVisible(trigger) || !wrapper.contains(trigger)) return false;

    const current = textOf(trigger);
    const isPlaceholder =
      !current ||
      current.includes("select") ||
      current.includes("choose") ||
      current.includes("pick one") ||
      current === "...";

    if (!isPlaceholder) return false;

    try {
      trigger.click();
      await sleep(400);

      const options = [...document.querySelectorAll('[role="option"], [role="menuitem"], [role="menuitemradio"]')].filter(
        (el) => isVisible(el)
      );

      const scopedOptions = options.filter((el) => {
        const menu = el.closest('[role="listbox"], [role="menu"]');
        return menu && isVisible(menu);
      });

      const terms = getMatchTerms(profile, label);
      const { best, bestScore } = findBestMatchingOption(
        scopedOptions.length ? scopedOptions : options.slice(0, 40),
        terms,
        profile
      );

      if (best && bestScore > 0) {
        best.click();
        await sleep(150);
        return true;
      }

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    } catch {
      // ignore dropdown errors
    }

    return false;
  }

  async function fillClickableOptions(profile) {
    let filled = 0;

    for (const root of getRegistrationRoots()) {
      const wrappers = root.querySelectorAll(
        "[class*='field'], [class*='question'], [class*='Form'], fieldset, [role='radiogroup']"
      );

      for (const wrapper of wrappers) {
        const label = getWrapperLabel(wrapper);
        if (!label) continue;

        const labelLower = label.toLowerCase();
        const isChoiceField =
          labelLower.includes("expertise") ||
          labelLower.includes("area of") ||
          labelLower.includes("specialty") ||
          labelLower.includes("which best") ||
          labelLower.includes("best describes") ||
          labelLower.includes("your role") ||
          labelLower.includes("i am a") ||
          labelLower.includes("experience level") ||
          labelLower.includes("industry") ||
          labelLower.includes("select one") ||
          wrapper.matches("[role='radiogroup']") ||
          wrapper.querySelector('[role="radiogroup"], input[type="radio"], [role="radio"]');

        if (!isChoiceField) continue;

        const alreadySelected = wrapper.querySelector(
          'input[type="radio"]:checked, [role="radio"][aria-checked="true"], [aria-selected="true"]'
        );
        if (alreadySelected) continue;

        const terms = getMatchTerms(profile, label);
        const candidates = [
          ...wrapper.querySelectorAll('[role="radio"], [role="option"], button, label, li, div[class*="option" i]'),
        ].filter((el) => shouldIncludeControl(el) || el.closest('[role="dialog"]'));

        const { best, bestScore } = findBestMatchingOption(candidates, terms, profile);
        if (best && bestScore > 0) {
          best.click();
          filled += 1;
          await sleep(100);
        }
      }
    }

    return filled;
  }

  async function fillChoiceFields(profile) {
    let filled = 0;

    try {
      for (const root of getRegistrationRoots()) {
        for (const select of root.querySelectorAll("select")) {
          if (!shouldIncludeControl(select)) continue;
          const wrapper = select.closest("[class*='field'], [class*='question'], [class*='Form']") || select.parentElement;
          const label = findLabelForControl(select) || getWrapperLabel(wrapper);
          if (await fillSelectElement(select, profile, label)) filled += 1;
        }

        const radioNames = new Set();
        for (const radio of root.querySelectorAll('input[type="radio"]')) {
          if (!radio.name || radioNames.has(radio.name)) continue;
          radioNames.add(radio.name);
          let group;
          try {
            group = [...root.querySelectorAll(`input[type="radio"][name="${CSS.escape(radio.name)}"]`)];
          } catch {
            group = [...root.querySelectorAll(`input[type="radio"][name="${radio.name}"]`)];
          }
          const wrapper = radio.closest("[class*='field'], [class*='question'], [class*='Form']") || radio.parentElement;
          const label = getWrapperLabel(wrapper) || findLabelForControl(radio);
          if (await fillRadioGroup(group, profile, label)) filled += 1;
        }

        for (const wrapper of root.querySelectorAll("[class*='field'], [class*='question'], [class*='Form']")) {
          if (!wrapper.querySelector('[role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="menu"]')) continue;
          const label = getWrapperLabel(wrapper);
          if (!label) continue;
          if (await fillLumaDropdown(wrapper, profile, label)) filled += 1;
        }
      }

      filled += await fillClickableOptions(profile);
    } catch {
      // never block text auto-fill because of choice field errors
    }

    return filled;
  }

  async function fillRegistrationForm(profile) {
    const controls = collectFormControls();
    let filled = 0;

    for (const control of controls) {
      if (userEditedControls.has(control) || filledControls.has(control)) continue;
      const label = findLabelForControl(control);
      const profileKey = matchProfileKey(label, control);
      if (!profileKey) continue;
      const value = profileValue(profile, profileKey);
      if (!value) continue;
      const ok = await fillControl(control, value);
      if (ok) filled += 1;
    }

    return filled;
  }

  function isOpenQuestionField(control, label, profileKey) {
    if (profileKey) return false;
    if (!controlIsEmpty(control)) return false;

    const type = (control.type || "").toLowerCase();
    if (type === "email" || type === "tel" || type === "url" || type === "number") return false;

    if (control.tagName === "TEXTAREA" || control.isContentEditable || control.getAttribute("role") === "textbox") {
      return true;
    }

    const lower = label.toLowerCase();
    const openHints = [
      "why", "what", "how", "describe", "tell", "share", "interest", "about", "background", "?",
      "question", "anything else", "comments", "note", "additional", "related",
    ];
    if (openHints.some((hint) => lower.includes(hint))) return true;
    return type === "text" && lower.length > 8;
  }

  function collectOpenQuestions(profile) {
    const items = [];

    for (const control of collectFormControls()) {
      if (userEditedControls.has(control) || filledControls.has(control)) continue;
      const label = findLabelForControl(control);
      const profileKey = matchProfileKey(label, control);
      if (!isOpenQuestionField(control, label, profileKey)) continue;

      const cacheKey = `${location.pathname}::${label}`;
      items.push({ control, label, cacheKey });
    }

    return items;
  }

  function getEventContext() {
    const modal = document.querySelector('[role="dialog"]');
    const title =
      modal?.querySelector("h1, h2, h3, [class*='title']")?.textContent?.trim() ||
      document.querySelector("h1")?.textContent?.trim() ||
      document.querySelector('meta[property="og:title"]')?.content ||
      document.title;

    const description =
      modal?.querySelector("[class*='description'], p")?.textContent?.trim() ||
      document.querySelector('meta[name="description"]')?.content ||
      document.querySelector('meta[property="og:description"]')?.content ||
      [...document.querySelectorAll("article p, [class*='description'] p, main p")]
        .map((p) => p.textContent?.trim())
        .filter(Boolean)
        .slice(0, 3)
        .join(" ");

    return { title, description: description.slice(0, 900), url: location.href };
  }

  async function fillOpenQuestions(profile, settings) {
    const eventContext = getEventContext();
    const openQuestions = collectOpenQuestions(profile).filter((item) => controlIsEmpty(item.control));
    if (!openQuestions.length) return { aiFilled: 0, provider: "none" };

    const localAnswers = openQuestions.map((item) => pickAnswerForQuestion(item.label, profile, eventContext));
    let answers = localAnswers;
    let provider = "smart-rules-local";

    if (settings.aiAnswerQuestions !== false) {
      let usesSlowAi = false;
      try {
        const aiCheck = await chrome.runtime.sendMessage({ type: "CHECK_AI" });
        usesSlowAi =
          (aiCheck?.provider === "chrome-gemini-nano" && aiCheck?.status === "available") ||
          aiCheck?.provider === "gemini-api";
      } catch {
        usesSlowAi = false;
      }

      if (usesSlowAi) {
        showLoadingOverlay("Writing unique answers with Chrome AI…");
      }

      try {
        const response = await Promise.race([
          chrome.runtime.sendMessage({
            type: "ANSWER_REGISTRATION_QUESTIONS",
            eventContext,
            questions: openQuestions.map((item) => item.label),
          }),
          new Promise((resolve) => setTimeout(() => resolve(null), usesSlowAi ? 12000 : 600)),
        ]);

        if (response?.answers?.length) {
          answers = response.answers.map((answer, i) => answer || localAnswers[i]);
          provider = response.provider || "smart-rules";
        }
      } catch {
        // keep local smart-rule answers
      } finally {
        hideLoadingOverlay();
      }
    }

    let filled = 0;
    for (let i = 0; i < openQuestions.length; i += 1) {
      const answer = answers[i];
      if (!answer) continue;
      const ok = await fillControl(openQuestions[i].control, answer);
      if (ok) {
        filled += 1;
        aiAnswerCache.set(openQuestions[i].cacheKey, answer);
      }
    }

    return { aiFilled: filled, provider };
  }

  function pickAnswerForQuestion(question, profile, eventContext) {
    const lower = String(question || "").toLowerCase();
    const evt =
      eventContext?.title && !eventContext.title.toLowerCase().includes("luma")
        ? eventContext.title.slice(0, 80)
        : "this event";
    const title = profile.title?.trim() || "Software Engineer";
    const company = profile.company?.trim();
    const companyPart = company ? ` at ${company}` : "";

    if (lower.includes("how did you hear") || lower.includes("how did you find") || lower.includes("mailing list")) {
      return profile.referralSource;
    }
    if (
      lower.includes("team") ||
      lower.includes("headcount") ||
      lower.includes("how big") ||
      (lower.includes("size") && lower.includes("support"))
    ) {
      return profile.teamSize || "Small team — roughly 5–10 people on the engineering side, with support handled by a lean ops group.";
    }
    if (lower.includes("tech stack") || lower.includes("support platform") || lower.includes("what platform")) {
      return profile.techStack || "TypeScript, Python, React, Node.js, PostgreSQL, and AWS — plus standard ticketing/chat tools for support workflows.";
    }
    if (lower.includes("biggest challenge") || (lower.includes("challenge") && lower.includes("video"))) {
      return "Temporal consistency and controllable generation across longer clips are still the biggest challenges with video models today.";
    }
    if (lower.includes("excited to learn") || lower.includes("most excited")) {
      return `I'm most excited to learn practical workflows and hear what's working in production at ${evt}.`;
    }
    if (lower.includes("are you currently") && lower.includes("video")) {
      return "I'm exploring video generation models and looking to use them more hands-on in my work.";
    }
    if (lower.includes("background") || lower.includes("tell us a little about")) {
      return buildBackgroundAnswer(profile);
    }
    if (lower.includes("any question") && lower.includes("do you have")) {
      return profile.noQuestionsAnswer;
    }
    if (lower.includes("why do you want") || lower.includes("why attend") || lower.includes("why are you interested")) {
      return profile.whyAttend;
    }
    return `Relevant to my work as a ${title}${companyPart} — happy to discuss further at ${evt}.`;
  }

  function isFreeEvent() {
    const bodyText = textOf(document.body);
    if (bodyText.includes("sold out")) return false;
    if (/\$\s*[1-9]/.test(bodyText) || bodyText.includes("usd")) {
      const priceMatches = bodyText.match(/\$\s*(\d+(?:\.\d+)?)/g) || [];
      const hasPaid = priceMatches.some((p) => parseFloat(p.replace(/[^\d.]/g, "")) > 0);
      if (hasPaid) return false;
    }
    return bodyText.includes("free") || !bodyText.includes("$") || bodyText.includes("$0");
  }

  function isSfEvent() {
    const bodyText = textOf(document.body);
    return SF_LOCATION_KEYWORDS.some((kw) => bodyText.includes(kw.toLowerCase()));
  }

  function showLoadingOverlay(message = "Generating tailored answers…") {
    let loader = document.getElementById(LOADER_ID);
    if (!loader) {
      loader = document.createElement("div");
      loader.id = LOADER_ID;
      loader.innerHTML = `
        <style>
          @keyframes luma-agent-spin { to { transform: rotate(360deg); } }
          #${LOADER_ID} .luma-agent-spinner {
            width: 22px; height: 22px; border: 3px solid rgba(255,255,255,.35);
            border-top-color: #fff; border-radius: 50%;
            animation: luma-agent-spin .75s linear infinite;
          }
        </style>
        <div class="luma-agent-spinner"></div>
        <span class="luma-agent-loader-text"></span>
      `;
      loader.style.cssText = `
        position: fixed; bottom: 24px; right: 24px; z-index: 2147483647;
        display: flex; align-items: center; gap: 12px;
        padding: 14px 18px; border-radius: 12px;
        font: 600 13px/1.4 system-ui, sans-serif; color: white;
        background: linear-gradient(135deg, #2563eb, #7c3aed);
        box-shadow: 0 10px 30px rgba(37,99,235,.35);
        opacity: 0; transition: opacity .25s ease;
      `;
      document.body.appendChild(loader);
    }
    loader.querySelector(".luma-agent-loader-text").textContent = message;
    requestAnimationFrame(() => {
      loader.style.opacity = "1";
    });
  }

  function hideLoadingOverlay() {
    const loader = document.getElementById(LOADER_ID);
    if (!loader) return;
    loader.style.opacity = "0";
    setTimeout(() => loader.remove(), 280);
  }

  function showToast(message, tone = "success") {
    hideLoadingOverlay();
    let toast = document.getElementById(TOAST_ID);
    if (!toast) {
      toast = document.createElement("div");
      toast.id = TOAST_ID;
      toast.style.cssText = `
        position: fixed; bottom: 24px; right: 24px; z-index: 2147483647;
        padding: 12px 16px; border-radius: 10px; font: 600 13px/1.4 system-ui, sans-serif;
        color: white; box-shadow: 0 8px 24px rgba(0,0,0,.18); transition: opacity .3s;
      `;
      document.body.appendChild(toast);
    }
    toast.style.background =
      tone === "success" ? "#7c3aed" : tone === "warn" ? "#d97706" : tone === "info" ? "#2563eb" : "#374151";
    toast.textContent = message;
    toast.style.opacity = "1";
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => {
      toast.style.opacity = "0";
    }, 3200);
  }

  function scrapeDiscoverEvents() {
    const links = new Map();
    document.querySelectorAll('a[href*="/"]').forEach((a) => {
      const href = a.href;
      if (!href.includes("lu.ma/") && !href.includes("luma.com/")) return;
      if (href.includes("/discover") || href.includes("/home") || href.includes("/signin")) return;
      const path = new URL(href).pathname.replace(/^\//, "");
      if (!path || path.includes("/")) return;
      const title = textOf(a.querySelector("h2, h3, h4")) || path;
      links.set(href.split("?")[0], { url: href.split("?")[0], title, cardText: textOf(a.closest("article, li, div") || a) });
    });
    return [...links.values()];
  }

  async function getState() {
    const data = await chrome.storage.local.get([STORAGE_KEYS.profile, STORAGE_KEYS.settings]);
    return {
      profile: normalizeProfile(data[STORAGE_KEYS.profile]),
      settings: { ...DEFAULT_SETTINGS, ...(data[STORAGE_KEYS.settings] || {}) },
    };
  }

  async function autoFillPage({ manual = false } = {}) {
    if (fillInProgress) return { ok: true, filled: 0, reason: "in_progress" };

    const signature = getFormSignature();
    if (!manual && filledFormSignatures.has(signature)) {
      return { ok: true, filled: 0, reason: "already_filled" };
    }

    fillInProgress = true;
    try {
      const { profile, settings } = await getState();

      if (!profile.email || !profile.name) {
        showToast("Save your profile in the Luma SF Agent extension first.", "warn");
        return { ok: false, reason: "missing_profile", filled: 0 };
      }

      if (!hasVisibleFormFields() && !hasOpenRegistrationModal()) {
        return { ok: true, filled: 0, reason: "no_fields" };
      }

      const filled = await fillRegistrationForm(profile);
      const choiceFilled = await fillChoiceFields(profile);
      const aiResult = await fillOpenQuestions(profile, settings);
      const totalFilled = filled + choiceFilled + aiResult.aiFilled;

      if (totalFilled > 0) {
        const aiNote =
          aiResult.aiFilled > 0
            ? ` (+${aiResult.aiFilled} custom answer${aiResult.aiFilled === 1 ? "" : "s"})`
            : "";
        showToast(`Filled ${totalFilled} field${totalFilled === 1 ? "" : "s"}${aiNote}`);
      }

      if (!manual && (hasVisibleFormFields() || hasOpenRegistrationModal())) {
        filledFormSignatures.add(signature);
      }

      return {
        ok: true,
        filled: totalFilled,
        aiFilled: aiResult.aiFilled,
        aiProvider: aiResult.provider,
        reason: totalFilled ? "filled" : "no_fields",
      };
    } catch (err) {
      console.error("[Luma Agent] autoFillPage error:", err);
      return { ok: false, reason: "error", filled: 0 };
    } finally {
      fillInProgress = false;
    }
  }

  async function runQueueFill() {
    const { profile, settings } = await getState();
    if (!profile.email || !profile.name) return { ok: false, reason: "missing_profile" };
    if (settings.freeOnly && !isFreeEvent()) return { ok: false, reason: "not_free" };
    if (settings.cityFilter && !isSfEvent()) return { ok: false, reason: "not_sf" };

    return autoFillPage();
  }

  function queueFillAttempts() {
    pendingFillTimers.forEach(clearTimeout);
    pendingFillTimers.length = 0;

    const signature = getFormSignature();
    if (filledFormSignatures.has(signature)) return;

    pendingFillTimers.push(
      setTimeout(() => {
        runScheduledFill(true);
      }, 1200)
    );
  }

  async function runScheduledFill(fromInteraction = false) {
    try {
      const signature = getFormSignature();
      if (filledFormSignatures.has(signature)) return;

      const { settings } = await getState();
      if (!settings.autoFillOnPage || !isLumaHost()) return;

      const hasForm = hasVisibleFormFields() || hasOpenRegistrationModal();
      if (!hasForm && !fromInteraction) return;

      await autoFillPage();
    } catch (err) {
      console.error("[Luma Agent] runScheduledFill error:", err);
    }
  }

  function installUserEditGuard() {
    document.addEventListener(
      "input",
      (event) => {
        const target = event.target;
        if (
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target?.isContentEditable
        ) {
          userEditedControls.add(target);
        }
      },
      true
    );

    document.addEventListener(
      "change",
      (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
        userEditedControls.add(target);
        if (target.name) filledChoiceGroups.add(`radio:${target.name}`);
      },
      true
    );
  }

  function startAutoFillWatcher() {
    if (observerActive) return;
    observerActive = true;
    installUserEditGuard();

    const scheduleFill = () => {
      const signature = getFormSignature();
      if (filledFormSignatures.has(signature)) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => runScheduledFill(false), 400);
    };

    mutationObserver = new MutationObserver(scheduleFill);
    mutationObserver.observe(document.documentElement, { childList: true, subtree: true });

    document.addEventListener(
      "click",
      () => {
        if (!filledFormSignatures.has(getFormSignature())) {
          queueFillAttempts();
        }
      },
      true
    );

    globalThis.__lumaAgentCleanup = () => {
      mutationObserver?.disconnect();
      clearTimeout(debounceTimer);
      pendingFillTimers.forEach(clearTimeout);
      observerActive = false;
    };

    scheduleFill();
    queueFillAttempts();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
      if (message.type === "PING") {
        sendResponse({ ok: true });
        return;
      }
      if (message.type === "SCRAPE_DISCOVER") {
        sendResponse({ events: scrapeDiscoverEvents() });
        return;
      }
      if (message.type === "CHECK_EVENT_PAGE") {
        sendResponse({
          isRegistration: hasVisibleFormFields(),
          isFree: isFreeEvent(),
          isSf: isSfEvent(),
          url: location.href,
        });
        return;
      }
      if (message.type === "FILL_NOW") {
        sendResponse(await autoFillPage({ manual: true }));
        return;
      }
      if (message.type === "FILL_AND_REGISTER") {
        sendResponse(await runQueueFill());
        return;
      }
      sendResponse({ ok: false, reason: "unknown_message" });
    })();
    return true;
  });

  (async () => {
    if (!isLumaHost()) return;
    const { settings } = await getState();
    if (!settings.autoFillOnPage) return;
    startAutoFillWatcher();
  })();
})();
