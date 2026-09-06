/**
 * Luma form intelligence — loaded before content.js (non-module).
 */

const NON_EVENT_PATH_SEGMENTS = new Set([
  "user", "calendar", "discover", "signin", "login", "home", "pricing", "help", "sf",
  "create", "app", "settings", "about",
]);

function safeCssEscape(value) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function isValidEventSlug(slug) {
  if (!slug || typeof slug !== "string") return false;
  const s = slug.trim();
  if (s.length < 2 || s.includes("/")) return false;
  if (s.startsWith("usr-") || s.startsWith("evt-") || s.startsWith("cal-")) return false;
  if (NON_EVENT_PATH_SEGMENTS.has(s.toLowerCase())) return false;
  return /^[\w-]+$/i.test(s);
}

function isValidEventHref(href) {
  try {
    const url = new URL(href, "https://luma.com");
    const host = url.hostname.replace(/^www\./, "");
    if (!host.endsWith("lu.ma") && host !== "luma.com") return false;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 1) return false;
    return isValidEventSlug(parts[0]);
  } catch {
    return false;
  }
}

function isNavigationalLink(el) {
  const link = el.closest("a[href]");
  if (!link) return false;
  return !isValidEventHref(link.href);
}

/** Block clicks that would leave the event registration flow (host/user/calendar links). */
function isUnsafeClickTarget(el, { checkFormScope = true } = {}) {
  if (!el) return true;
  if (isNavigationalLink(el)) return true;

  const href = el.getAttribute?.("href");
  if (href && href.startsWith("/") && !isValidEventHref(new URL(href, window.location.origin).href)) {
    return true;
  }

  if (checkFormScope && isRegistrationFormOpen()) {
    const formRoot = getFormRoot();
    if (!formRoot) return false;
    const inForm =
      formRoot.contains(el) ||
      isInsideDropdownOverlay(el) ||
      el.closest('[role="dialog"], [class*="modal" i]');
    if (!inForm) return true;
  }

  return false;
}

function hasVisibleDropdownTriggers(doc = document) {
  return findCustomDropdownTriggers(doc).length > 0;
}

function getLinkHref(el) {
  const link = el.closest("a[href]");
  return link?.href || el.getAttribute?.("href") || "";
}

function isWomenOnlyEventText(text) {
  const patterns = [
    /\bwomen in\b/i,
    /\bwomen's\b/i,
    /\bwomens\b/i,
    /\bwomen only\b/i,
    /\bwomen-only\b/i,
    /\bfor women\b/i,
    /\bfemale only\b/i,
    /\bwomentech\b/i,
    /\bwomen tech\b/i,
    /\bladies only\b/i,
    /\bwomen who code\b/i,
    /\bwomen in game\b/i,
    /\bwomen in ai\b/i,
    /\bwomen in tech\b/i,
    /\bwomen founders\b/i,
  ];
  return patterns.some((re) => re.test(text || ""));
}

function isWomenOnlyEventPage() {
  const title =
    document.querySelector("h1")?.textContent ||
    document.querySelector('[class*="title"] h1')?.textContent ||
    document.title ||
    "";
  return isWomenOnlyEventText(title);
}

function hasInPersonSignals(text) {
  const t = (text || "").toLowerCase();
  return (
    /\bin person\b/i.test(t) ||
    /\bin-person\b/i.test(t) ||
    /\battend in person\b/i.test(t)
  );
}

function hasLivestreamSignals(text) {
  const t = (text || "").toLowerCase();
  return /\blive\s*stream\b/i.test(t) || /\blivestream\b/i.test(t);
}

function hasPhysicalVenueInText(text) {
  const t = (text || "").toLowerCase();
  const cities = [
    "san francisco", "oakland", "berkeley", "palo alto", "mountain view",
    "sunnyvale", "san mateo", "redwood city", "fremont", "hayward",
  ];
  if (cities.some((c) => t.includes(c))) return true;
  if (
    /\b\d{1,5}\s+[\w\s.]{2,40}\b(st|street|ave|avenue|blvd|road|rd|way|dr|drive|ln|lane|market)\b/i.test(
      t
    )
  ) {
    return true;
  }
  return false;
}

function isHybridOrInPersonCapable(text) {
  if (hasInPersonSignals(text)) return true;
  if (hasPhysicalVenueInText(text) && !/\bonline only\b|\bvirtual only\b|\bremote only\b/i.test(text)) {
    return true;
  }
  if (hasInPersonSignals(text) && hasLivestreamSignals(text)) return true;
  return false;
}

function hasInPersonTicketOption(doc = document) {
  for (const el of doc.querySelectorAll("button, [role='button'], [role='radio'], label, div, span")) {
    if (!isVisible(el)) continue;
    const line = (el.textContent || "").trim().split(/\n/)[0].trim().toLowerCase();
    if (line === "in person" || line === "in-person" || line.startsWith("in person ")) return true;
  }
  return false;
}

function isVirtualEventText(text) {
  if (!text) return false;
  if (isHybridOrInPersonCapable(text)) return false;

  const virtualOnly = [
    /\bvirtual only\b/i,
    /\bonline only\b/i,
    /\bremote only\b/i,
    /\bstreaming only\b/i,
    /\bjoin via zoom\b/i,
    /\bvirtual event\b/i,
    /\bonline event\b/i,
  ];
  if (virtualOnly.some((re) => re.test(text))) return true;

  const platform = [
    /\bzoom\b/i,
    /\bzoom meeting\b/i,
    /\bjoin zoom\b/i,
    /\bon zoom\b/i,
    /\bvia zoom\b/i,
    /\bzoom\.us\b/i,
    /\bgoogle meet link\b/i,
    /\bon google meet\b/i,
    /\bmeet\.google/i,
    /\bhopin\b/i,
    /\bgather\.town\b/i,
    /\bwebex\b/i,
  ];
  if (platform.some((re) => re.test(text))) return true;

  const t = text.toLowerCase();
  if (/\bwebinar\b/i.test(t) && !hasInPersonSignals(t) && !hasPhysicalVenueInText(t)) return true;
  if (/\bvirtual\b/.test(t) && !/\bin person\b/.test(t) && !/\bhybrid\b/.test(t)) return true;
  if (/^online$/i.test(t.trim())) return true;
  return false;
}

function isVirtualEventPage() {
  const pageText = (document.body?.innerText || "").slice(0, 12000);
  if (isHybridOrInPersonCapable(pageText)) return false;
  if (hasInPersonTicketOption()) return false;
  if (hasPhysicalVenueInText(pageText) && hasLivestreamSignals(pageText)) return false;

  const title =
    document.querySelector("h1")?.textContent ||
    document.querySelector('[class*="title"] h1')?.textContent ||
    document.title ||
    "";
  if (isVirtualEventText(title)) return true;

  const regRoot = getRegistrationPanelRoot();
  const regText = (regRoot.innerText || regRoot.textContent || "").slice(0, 4000);
  if (regText && isVirtualEventText(regText)) {
    if (!hasInPersonTicketOption() && !hasInPersonSignals(regText)) return true;
  }

  for (const el of document.querySelectorAll(
    "[class*='location'], [class*='venue'], [class*='address'], [class*='where']"
  )) {
    if (!isVisible(el)) continue;
    const text = (el.textContent || "").trim();
    if (text && isVirtualEventText(text)) return true;
  }

  return false;
}

function detectYoureIn(doc = document) {
  const roots = getStatusRoots(doc);
  for (const root of roots) {
    for (const el of root.querySelectorAll("h1, h2, h3, h4, [role='status'], strong, button")) {
      if (!isVisible(el)) continue;
      const t = (el.textContent || "").trim().toLowerCase();
      if (t === "you're in" || t === "you are in" || t.startsWith("you're in")) {
        return { status: "already_registered", message: "You're in — skipped" };
      }
    }
  }
  return null;
}

function getStatusRoots(doc = document) {
  const roots = [
    doc.querySelector('[class*="registration"]'),
    doc.querySelector('[class*="sidebar"]'),
    doc.querySelector("form"),
    doc.querySelector("main")?.firstElementChild,
  ].filter(Boolean);
  return roots.length ? roots : [doc.body];
}

function detectUserRsvpBadge(doc = document) {
  for (const root of getStatusRoots(doc)) {
    for (const el of root.querySelectorAll(
      "span, div, button, [class*='badge'], [class*='status'], [class*='pill']"
    )) {
      if (!isVisible(el)) continue;
      if (el.closest('[class*="about"], [class*="description"], article')) continue;
      if (isInsideDropdownOverlay(el)) continue;
      if (el.children.length > 0) continue;

      const raw = (el.textContent || "").trim();
      const t = raw.toLowerCase();

      if (t === "going") {
        return { status: "already_registered", message: "Already going — skipped" };
      }
      if (t === "pending") {
        if (isRegistrationFormOpen(doc)) continue;
        return { status: "pending_approval", message: "Pending — skipped" };
      }
      if (t === "you're on the waitlist" || t === "on waitlist" || t === "waitlist") {
        if (doc.querySelector("button, a, [role='button']") &&
            [...doc.querySelectorAll("button, a, [role='button']")].some((b) =>
              /leave waitlist|cancel waitlist/i.test(b.textContent || "")
            )) {
          return { status: "on_waitlist", message: "On waitlist — skipped" };
        }
      }
    }
  }
  return null;
}

function classifyQuestion(label) {
  const l = (label || "").toLowerCase().replace(/\*/g, "").trim();
  if (!l) return "unknown";

  if (/how did you hear|how did you find|where did you hear|referral|discover this|hear about the event|hear about this event/.test(l)) {
    return "referral";
  }
  if (/currently reading|book you are|name and author|book.*author/.test(l)) {
    return "book";
  }
  if (/book/.test(l) && /author|currently|reading|title/.test(l)) {
    return "book";
  }
  if (/following.*instagram|follow.*on instagram|follow us on instagram|are you following @/.test(l)) {
    return "instagram_follow";
  }
  if (/instagram username|your instagram|ig handle|insta handle|@.*instagram/.test(l)) {
    return "instagram";
  }
  if (/newsletter|subscribe|receive.*email|email updates/.test(l)) return "newsletter";
  if (/dietary|food allerg|food restriction|food preference|meal preference|any allerg|allerg(y|ies)|what do you eat/.test(l)) {
    return "dietary";
  }
  if (/role and company|role & company|current role and company|title and company|company and (role|title)/.test(l)) {
    return "role_company";
  }
  if (/kind of role|role best describes|what role|best describes you|describes you best|describe your role/.test(l)) {
    return "role_category";
  }
  if (/categories best describe|which categories|category best/.test(l)) {
    return "role_category";
  }
  if (/company\/school|company or school|school or company|currently at|school are you|company are you/.test(l)) {
    return "company";
  }
  if (/gender|^sex$/.test(l) && !/gender pay|gender bias/.test(l)) return "gender";
  if (/first name|given name|fname/.test(l)) return "first_name";
  if (/last name|surname|family name|lname/.test(l)) return "last_name";
  if (/full name|^name$|your name/.test(l) && !/author|book|company|event|user|linkedin/.test(l)) {
    return "full_name";
  }
  if (/(work|business|company|corporate|professional|institutional|school|university|college|official|edu)\s*e-?mail/.test(l) || /e-?mail.*\b(work|business|company|corporate|professional|institutional|school|university|college)\b/.test(l)) {
    return "work_email";
  }
  if (/email|e-mail/.test(l)) return "email";
  if (/\b(phone|mobile|tel|telephone|cell|whatsapp)\b|\bphone number\b|\bcontact number\b/.test(l)) return "phone";
  if (/linkedin/.test(l)) return "linkedin";
  if (/github/.test(l)) return "github";
  if (/twitter|x\/twitter|x handle|x profile|x \(formerly/.test(l)) return "twitter";
  if (/company|organization|employer|school|university|institution/.test(l) && !/role|title|kind|website|\burl\b|link|portfolio/.test(l)) {
    return "company";
  }
  if (/job title|^title$|your title|position at/.test(l) && !/kind of role|best describes/.test(l)) {
    return "job_title";
  }
  if (/\bcity\b|\blocation\b|where are you based|which city|what city|based in|where do you live|where are you located/.test(l)) {
    return "location";
  }
  if (/member of.*community|part of.*community|community member|our community|join our community/.test(l)) {
    return "community_member";
  }
  if (/why should we allow|why allow you|why should we approve|reason we should|admit you to|allow you to (come|attend|join)/.test(l)) {
    return "admission";
  }
  if (/website|portfolio|personal site/.test(l)) return "website";
  // "Willing to pitch?" is a yes/no opt-in (even when it trails "...if so, what are you building?"),
  // so classify it as pitch BEFORE the building rule below.
  if (/willing to pitch|would you (be willing|like) to pitch|interested in pitching|want to pitch|selected to pitch|willing to (present|demo|showcase)/.test(l)) {
    return "pitch";
  }
  if (/what.*build|going to build|will you build|building (at|today|this)|what are you building|your project|project idea/.test(l)) {
    return "building";
  }
  if (/looking for a (new )?(role|job|opportunit)|open to (new )?(role|opportunit|work)|seeking a (new )?(role|job)|job search|are you (currently )?looking|\bnew role\b/.test(l)) {
    return "job_seeking";
  }
  if (/fundrais|funding round|funding stage|\bfunding\b|raising (a )?(round|money|capital)|currently raising|are you raising|seeking investment|series [a-e]\b|pre-?seed|\bseed round\b/.test(l)) {
    return "fundraising";
  }
  if (/\bwhy\b|what brings|tell us about|about yourself|\binterest|motivation|what do you hope/.test(l)) {
    return "motivation";
  }
  return "custom";
}

/**
 * Classify a control from its own attributes (type / autocomplete / inputmode / name / id).
 * These come from the form author and are far more reliable than nearby label text, so they
 * take precedence over label classification when present.
 */
function classifyByInputAttributes(el) {
  if (!el || typeof el.getAttribute !== "function") return null;
  const type = (el.getAttribute("type") || "").toLowerCase();
  const auto = (el.getAttribute("autocomplete") || "").toLowerCase();
  const mode = (el.getAttribute("inputmode") || "").toLowerCase();
  const nameId = `${el.getAttribute("name") || ""} ${el.getAttribute("id") || ""}`.toLowerCase();

  if (type === "tel" || mode === "tel" || /\btel\b|tel-national|tel-local/.test(auto)) return "phone";
  if (type === "email" || mode === "email" || auto === "email") return "email";
  if (auto === "given-name") return "first_name";
  if (auto === "family-name") return "last_name";
  if (auto === "name") return "full_name";
  if (auto === "organization") return "company";
  if (auto === "organization-title") return "job_title";
  if (auto === "address-level2") return "location";
  if (type === "url" || mode === "url" || auto === "url") {
    if (/linkedin/.test(nameId)) return "linkedin";
    if (/github/.test(nameId)) return "github";
    if (/twitter|x_handle|xhandle/.test(nameId)) return "twitter";
    return "website";
  }
  if (/\bphone\b|\bmobile\b|\btelephone\b/.test(nameId)) return "phone";
  if (/\bemail\b/.test(nameId)) return "email";
  if (/\bfirst_?name\b|\bfname\b/.test(nameId)) return "first_name";
  if (/\blast_?name\b|\blname\b|\bsurname\b/.test(nameId)) return "last_name";
  if (/\blinkedin\b/.test(nameId)) return "linkedin";
  if (/\bcompany\b|\borganization\b/.test(nameId)) return "company";
  return null;
}

/** True when an input belongs to a custom dropdown (combobox search box, read-only trigger). */
function isCustomSelectInput(el) {
  if (!el || typeof el.getAttribute !== "function") return false;
  const tag = el.tagName;
  if (tag !== "INPUT" && tag !== "TEXTAREA") return false;
  const type = (el.getAttribute("type") || "text").toLowerCase();
  const role = (el.getAttribute("role") || "").toLowerCase();
  if (el.readOnly) return true;
  if (role === "combobox" || role === "listbox" || role === "searchbox") return true;
  if (el.getAttribute("aria-autocomplete") || el.getAttribute("aria-haspopup")) return true;
  if (el.getAttribute("aria-expanded") != null) return true;
  const controls = el.getAttribute("aria-controls");
  if (controls && /listbox|menu|options|select/i.test(controls)) return true;
  if (type === "search" && el.closest?.('[role="combobox"], [role="listbox"], [aria-haspopup], [data-state]')) return true;
  if (
    el.closest?.(
      '[role="combobox"], [role="listbox"], [aria-haspopup="listbox"], [aria-haspopup="menu"], [class*="select__" i], [class*="react-select" i], [data-radix-select-trigger], [data-radix-select-content]'
    )
  ) {
    return true;
  }
  return false;
}

/** Shape check: never write a value the control's own type would reject or that is plainly wrong. */
function valueFitsInput(el, value) {
  if (!el || value == null) return false;
  const v = String(value).trim();
  if (!v) return false;
  const type = (el.getAttribute?.("type") || "text").toLowerCase();
  const mode = (el.getAttribute?.("inputmode") || "").toLowerCase();
  const maxLen = Number(el.getAttribute?.("maxlength") || 0);
  if (maxLen > 0 && v.length > maxLen) return false;
  if (type === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  if (type === "tel" || mode === "tel") return /^[+\d][\d\s().-]{5,}$/.test(v);
  if (type === "url") return /^(https?:\/\/)?[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(v);
  if (type === "number" || mode === "numeric" || mode === "decimal") return /^-?\d+([.,]\d+)?$/.test(v);
  // A phone number must not land in a field whose own attributes say it is something else.
  const looksLikePhone = /^[+\d][\d\s().-]{6,}$/.test(v) && (v.match(/\d/g) || []).length >= 7;
  if (looksLikePhone && type !== "tel" && mode !== "tel") {
    const hint = `${el.getAttribute?.("aria-label") || ""} ${el.getAttribute?.("placeholder") || ""} ${el.getAttribute?.("name") || ""}`.toLowerCase();
    if (!/phone|mobile|tel|cell|whatsapp|number/.test(hint)) return false;
  }
  return true;
}

/** Word-level overlap between a form label and a saved question key (0..1). */
function labelSimilarity(a, b) {
  const tok = (t) =>
    new Set(
      (t || "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !/^(the|and|for|you|your|are|what|which|this|that|with|from|our|please|any)$/.test(w))
    );
  const A = tok(a);
  const B = tok(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.max(A.size, B.size);
}

function answerForQuestion(label, profile, forcedType = null) {
  const type = forcedType || classifyQuestion(label);
  // A control with a strongly typed attribute (type=tel, autocomplete=email, …) answers only from
  // the matching profile field; saved free-text answers are never written into it.
  const defaults = forcedType ? {} : profile.default_answers || {};

  // Match a saved answer to the form label, but require a substantial overlap so short labels
  // (e.g. "title", "book") don't accidentally match a long saved question key as a substring.
  const lClean = label.toLowerCase().replace(/\*/g, "").trim();
  let bestSaved = null;
  let bestScore = 0;
  for (const [question, answer] of Object.entries(defaults)) {
    const q = question.toLowerCase().replace(/\*/g, "").trim();
    if (!q || !answer) continue;
    if (lClean === q) return answer;
    // Substring matches are only trusted when the saved key is a whole question, not a bare
    // word such as "company" that would also match "company website".
    const containment =
      (q.length >= 12 && lClean.includes(q)) || (lClean.length >= 12 && q.includes(lClean));
    const score = containment ? 0.95 : labelSimilarity(lClean, q);
    if (score > bestScore) {
      bestScore = score;
      bestSaved = answer;
    }
  }
  if (bestSaved && bestScore >= 0.6) return bestSaved;

  switch (type) {
    case "first_name": return profile.first_name;
    case "last_name": return profile.last_name;
    case "full_name": return `${profile.first_name} ${profile.last_name}`.trim();
    case "email": return profile.email;
    case "work_email": return profile.work_email || profile.email;
    case "gender": return (profile.gender || "male").charAt(0).toUpperCase() + (profile.gender || "male").slice(1).toLowerCase();
    case "phone": return profile.phone;
    case "location":
      return profile.location || "San Francisco, CA";
    case "job_title": return profile.job_title;
    case "company": return profile.company;
    case "linkedin": return profile.linkedin;
    case "instagram": return profile.instagram || "";
    case "github": return profile.github;
    case "twitter": {
      const handle =
        profile.twitter_handle ||
        String(profile.x || profile.twitter || "").replace(/\/+$/, "").split("/").pop();
      if (/handle|username|@/.test(lClean) && handle) {
        return handle.startsWith("@") ? handle : `@${handle}`;
      }
      return profile.x || profile.twitter || (handle ? `@${handle}` : null) || profile.instagram || null;
    }
    case "building":
      return (
        defaults["What are you building?"] ||
        defaults["What are you going to build?"] ||
        defaults.building ||
        profile.building ||
        "A practical AI/agent prototype — I'll scope it with my team at the event."
      );
    case "job_seeking":
      return (
        defaults["Are you looking for a new role?"] ||
        defaults.job_seeking ||
        profile.job_seeking ||
        "Open to new opportunities."
      );
    case "fundraising":
      return (
        defaults["Are you currently fundraising?"] ||
        defaults["Funding Round?"] ||
        defaults.fundraising ||
        profile.fundraising ||
        "Not currently fundraising."
      );
    case "dietary":
      return (
        profile.dietary ||
        defaults["Dietary Restrictions?"] ||
        defaults.dietary ||
        "Halal or vegan."
      );
    case "pitch":
      return (
        defaults["Would you be willing to pitch?"] ||
        defaults.pitch ||
        profile.willing_to_pitch ||
        "No, thank you."
      );
    case "role_company":
      return profile.company ? `${profile.job_title} at ${profile.company}` : profile.job_title;
    case "website": return profile.website || profile.github;
    case "book":
      return (
        defaults.current_book ||
        defaults["What is the book you are currently reading? Name and author :)"] ||
        "The Pragmatic Programmer by David Thomas and Andrew Hunt"
      );
    case "community_member":
      return (
        defaults.community_member ||
        "Yes — I'm active in the San Francisco tech community and look forward to participating."
      );
    case "admission":
      return (
        defaults.admission ||
        defaults["Why should we allow you to come to the event?"] ||
        null
      );
    case "motivation":
      return defaults["What brings you to this event?"] || null;
    case "referral":
      return null;
    default:
      return null;
  }
}

// Event-aware identity. The user presents as a founder at startup/pitch/investor events and as a
// software engineer at hiring/career events. Persona map comes from the profile when present;
// otherwise we synthesize one (founder override + the profile's own title/company as "engineer").
const DEFAULT_FOUNDER_PERSONA = { job_title: "Founder", company: "Stealth Startup" };

function personaMapFor(profile) {
  if (profile?.personas && Object.keys(profile.personas).length) return profile.personas;
  return {
    founder: DEFAULT_FOUNDER_PERSONA,
    engineer: { job_title: profile?.job_title, company: profile?.company },
  };
}

function selectEventPersona(profile, eventTitle = "", pageText = "") {
  if (!profile) return null;
  const personas = personaMapFor(profile);
  const text = `${eventTitle} ${pageText}`.toLowerCase();

  if (
    personas.founder &&
    /founder|co-?founder|startup|pitch|demo day|investor|\bvc\b|venture capital|accelerator|fundrais|pre-?seed|series [a-e]\b|angel invest|portfolio compan/.test(text)
  ) {
    return "founder";
  }
  if (
    personas.engineer &&
    /hiring|we[' ]?re hiring|careers|career fair|job fair|recruit|talent|open roles|internship|new grad/.test(text)
  ) {
    return "engineer";
  }

  // No founder/hiring signal → use the engineer identity. Founder @ Stealth is used only when the
  // event clearly signals a founders/startup event (matched above).
  const dflt = profile.default_persona || "engineer";
  return personas[dflt] ? dflt : null;
}

/** Return a shallow-cloned profile with job_title/company set for the event's persona. */
function applyEventPersona(profile, eventTitle = "", pageText = "") {
  if (!profile) return profile;
  const key = selectEventPersona(profile, eventTitle, pageText);
  if (!key) return profile;
  const persona = personaMapFor(profile)[key];
  if (!persona || !persona.job_title) return profile;
  return { ...profile, ...persona, active_persona: key };
}

const PLACEHOLDER_OPTIONS = [
  "select an option", "choose an option", "select one",
  "choose one", "pick an option", "please select",
  "select one or more", "select all that apply",
  "select...", "choose...", "pick one",
];

function isPlaceholderOption(text) {
  const t = (text || "").trim().toLowerCase();
  return !t || PLACEHOLDER_OPTIONS.some((p) => t.includes(p));
}

function isInRegistrationField(el, doc = document) {
  const modal = getRegistrationModalRoot(doc);
  if (modal) return modal.contains(el);
  return Boolean(el.closest('form, [class*="question" i], [class*="field" i]'));
}

function isEventBodyCopy(text) {
  const t = (text || "").toLowerCase().replace(/\s+/g, " ");
  if (t.length > 100) return true;
  return (
    /about (omni|crusoe|hpe|event|deep tech)|speakers:|join us for|infrastructure company|hewick packard|manufacturing tech vc|presented by|hosted by|199 going|register to see|approval required/i.test(
      t
    )
  );
}

function isFormQuestionLabel(text) {
  if (!text || isEventBodyCopy(text)) return false;
  const t = cleanLabel(text);
  if (t.length > 100) return false;
  if (t.includes("?") || t.includes("*")) return true;
  if (/^(which|what|name of|how did|why|select|choose)/i.test(t)) return true;
  if (/organization|categories|describe you|your info|company\/school/i.test(t)) return true;
  const type = classifyQuestion(t);
  return type !== "unknown";
}

function isHostOrSidebarElement(el) {
  if (isNavigationalLink(el)) return true;
  if (
    el.closest(
      '[class*="host" i]:not([role="dialog"] *), [class*="organizer" i]:not([role="dialog"] *), nav, header, footer, aside'
    ) &&
    !el.closest('[role="dialog"], [class*="modal" i]')
  ) {
    return true;
  }
  return false;
}

function isDropdownTriggerText(text, { allowEmpty = false } = {}) {
  const t = (text || "").trim();
  if (!t) return allowEmpty;
  if (t.length > 50) return false;
  return (
    isPlaceholderOption(t) ||
    /^select\b/i.test(t) ||
    /^choose\b/i.test(t) ||
    /^pick\b/i.test(t) ||
    t === "—" ||
    t === "-"
  );
}

function elementShowsPlaceholder(el) {
  const parts = (el.textContent || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return false;
  if (parts.some((p) => p.length > 80 || isEventBodyCopy(p))) return false;
  if (parts.some((p) => isDropdownTriggerText(p))) return true;
  const last = parts[parts.length - 1];
  return isDropdownTriggerText(last);
}

function looksLikeDropdownTrigger(el, doc = document) {
  if (!el || !isVisible(el) || isHostOrSidebarElement(el)) return false;
  if (!isInRegistrationField(el, doc)) return false;

  const tag = el.tagName;
  const role = el.getAttribute("role") || "";
  const hasPopup = el.getAttribute("aria-haspopup") || "";
  const questionLabel = getQuestionTextForElement(el, doc);
  const singleLine =
    (el.textContent || "").trim().split("\n").map((s) => s.trim()).filter(Boolean)[0] || "";

  if (isEventBodyCopy(singleLine) || isEventBodyCopy(questionLabel)) return false;

  if (role === "combobox" || hasPopup === "listbox" || hasPopup === "menu") {
    return elementShowsPlaceholder(el) || isFormQuestionLabel(questionLabel);
  }

  if (tag === "BUTTON") {
    if (/request to join|register|submit|payment|wallet/i.test(singleLine)) return false;
    return isDropdownTriggerText(singleLine) || (elementShowsPlaceholder(el) && isFormQuestionLabel(questionLabel));
  }

  if (tag === "INPUT" && (el.readOnly || role === "combobox")) {
    const hint = el.value || el.getAttribute("placeholder") || "";
    return isDropdownTriggerText(hint, { allowEmpty: !el.value?.trim() }) && isFormQuestionLabel(questionLabel);
  }

  if (tag === "DIV" || tag === "SPAN") {
    if (el.querySelector("input, textarea, select, button")) return false;
    if (!isFormQuestionLabel(questionLabel) && !isDropdownTriggerText(singleLine)) return false;
    const clickable =
      el.getAttribute("tabindex") != null ||
      role === "button" ||
      el.getAttribute("data-state") != null ||
      el.closest("[data-state]") ||
      hasPopup;
    if (!clickable && !elementShowsPlaceholder(el)) return false;
    return elementShowsPlaceholder(el) || isDropdownTriggerText(singleLine);
  }

  return false;
}

const MAX_DROPDOWN_TRIGGERS = 8;

/** Shared trigger finder — registration modal only (not event page body). */
function findCustomDropdownTriggers(doc = document) {
  const root = getRegistrationModalRoot(doc);
  if (!root) return [];

  const candidates = [];
  for (const el of root.querySelectorAll(
    "button, [role='combobox'], [aria-haspopup], input[readonly]"
  )) {
    if (!looksLikeDropdownTrigger(el, doc)) continue;
    candidates.push(el);
  }

  for (const el of root.querySelectorAll("div, span")) {
    if (!looksLikeDropdownTrigger(el, doc)) continue;
    candidates.push(el);
  }

  const leaf = candidates.filter(
    (el) => !candidates.some((other) => other !== el && el.contains(other))
  );

  return leaf.slice(0, MAX_DROPDOWN_TRIGGERS);
}

function describeUnfilledFields(doc = document) {
  const issues = [];
  const root = getFormRoot(doc);
  if (!root) return "registration modal not open";

  for (const field of root.querySelectorAll("input, textarea, select")) {
    if (!isVisible(field)) continue;
    const type = (field.getAttribute("type") || "text").toLowerCase();
    if (["hidden", "checkbox", "radio", "file", "submit", "button"].includes(type)) continue;
    if (field.required && !field.value?.trim()) {
      issues.push(getFieldLabel(field, doc) || "required input");
    }
  }

  const radioGroups = {};
  for (const r of root.querySelectorAll('input[type="radio"]')) {
    if (!isVisible(r)) continue;
    const name = r.getAttribute("name") || "__noname__";
    (radioGroups[name] = radioGroups[name] || []).push(r);
  }
  for (const group of Object.values(radioGroups)) {
    const checked = group.some((r) => r.checked);
    if (checked) continue;
    const required = group.some((r) => r.required || r.getAttribute("aria-required") === "true");
    if (!required) continue;
    issues.push(`choice: ${getQuestionTextForElement(group[0], doc) || getFieldLabel(group[0], doc) || "radio"}`);
  }

  for (const trigger of findCustomDropdownTriggers(doc)) {
    const label = getQuestionTextForElement(trigger, doc) || getFieldLabel(trigger, doc) || trigger.textContent.trim().slice(0, 40);
    issues.push(`dropdown: ${label}`);
  }

  return issues.length ? issues.join("; ") : "unknown field";
}

function profileCategoryPrefs(profile = {}) {
  const job = (profile.job_title || "").toLowerCase();
  const company = (profile.company || "").toLowerCase();
  const prefs = [];
  if (/engineer|developer|software|full.?stack|technical/.test(job)) {
    prefs.push("engineer", "developer", "software", "technical", "engineering");
  }
  if (/founder|ceo|startup/.test(job)) prefs.push("founder", "startup", "entrepreneur");
  if (/invest|partner|vc/.test(job)) prefs.push("investor", "venture", "capital");
  if (/product|design/.test(job)) prefs.push("product", "design");
  if (/robot|hardware|physical ai/.test(job + company)) {
    prefs.push("robotics", "hardware", "deep tech", "manufacturing");
  }
  prefs.push("ai", "machine learning", "deep tech", "technology", "other");
  return prefs;
}

/** Ordered keyword preferences for a select/dropdown question. */
function selectionPrefsFor(label, profile = null) {
  const l = (label || "").toLowerCase();

  if (l.includes("following") && l.includes("instagram")) {
    return ["yes", "already", "yep", "sure", "i am", "follow"];
  }
  if (l.includes("gender") || l === "sex") {
    return ["male", "man", "m", "he/him"];
  }
  if (
    l.includes("kind of role") ||
    l.includes("role best describes") ||
    l.includes("best describes you") ||
    l.includes("categories best describe") ||
    l.includes("which categories")
  ) {
    return profile ? profileCategoryPrefs(profile) : [
      "engineer", "developer", "software", "technical", "engineering",
      "robotics", "ai", "founder", "student", "designer", "product", "other",
    ];
  }
  if (l.includes("newsletter") || l.includes("subscribe")) {
    return ["yes", "sure", "sign me up", "please", "subscribe"];
  }
  if (l.includes("member") && l.includes("community")) {
    return ["yes", "yep", "i am", "already", "member", "active", "part of"];
  }
  if (l.includes("hear") || l.includes("find") || l.includes("referral")) {
    return ["luma", "instagram", "friend", "social", "twitter", "linkedin", "google", "search", "online", "other", "event", "deep tech"];
  }
  if (/willing|pitch/.test(l)) {
    return ["no", "not", "decline", "maybe later"];
  }
  if (/fundrais|raising|funding/.test(l)) {
    return ["not raising", "not currently", "not fundrais", "n/a", "not", "no"];
  }
  if (/looking for a (new )?(role|job)|open to|seeking a (role|job)|new role|job search/.test(l)) {
    return ["actively looking", "actively", "open to", "open", "yes", "looking"];
  }
  return ["yes", "other", "san francisco", "sf", "luma", "friend", "online"];
}

function escapeForRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Confident keyword match among options, or null when nothing matches (no blind first-option pick).
 * Within each preference we try a whole-word match before a loose substring so, e.g., a "male"
 * preference does not accidentally select "Female".
 */
function pickConfidentOption(options, label, profile = null) {
  const valid = options.filter((o) => !isPlaceholderOption(o.text));
  if (!valid.length) return null;
  for (const pref of selectionPrefsFor(label, profile)) {
    const word = new RegExp(`\\b${escapeForRegex(pref)}\\b`, "i");
    const boundary = valid.find((o) => word.test(o.text));
    if (boundary) return boundary;
    const loose = valid.find((o) => o.text.toLowerCase().includes(pref));
    if (loose) return loose;
  }
  return null;
}

function pickBestSelectOption(options, label, profile = null) {
  const valid = options.filter((o) => !isPlaceholderOption(o.text));
  if (!valid.length) return null;
  return pickConfidentOption(valid, label, profile) || valid[0];
}

function pickMultipleSelectOptions(options, label, profile = {}, max = 3) {
  if (!isMultiSelectLabel(label)) {
    const one = pickBestSelectOption(options, label, profile);
    return one ? [one] : [];
  }

  const valid = options.filter((o) => !isPlaceholderOption(o.text));
  if (!valid.length) return [];

  const prefs = profileCategoryPrefs(profile);
  const picked = [];
  for (const pref of prefs) {
    const match = valid.find(
      (o) =>
        o.text.toLowerCase().includes(pref) &&
        !picked.some((p) => p.text.toLowerCase() === o.text.toLowerCase())
    );
    if (match) picked.push(match);
    if (picked.length >= max) break;
  }
  if (!picked.length && valid.length) picked.push(pickBestSelectOption(valid, label, profile) || valid[0]);
  return picked;
}

function isMultiSelectLabel(label) {
  const l = (label || "").toLowerCase();
  return l.includes("one or more") || l.includes("select all that apply") || l.includes("select multiple");
}

function isInsideDropdownOverlay(el) {
  return Boolean(
    el.closest(
      '[role="listbox"], [role="menu"], [role="dialog"], [class*="dropdown"], [class*="popover"], [class*="menu-list"], [data-radix-popper-content-wrapper], [data-radix-select-content]'
    )
  );
}

function isElementInteractable(el) {
  if (!el || el.disabled) return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none") {
    return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function getQuestionFieldContainer(el, doc = document) {
  if (!el) return null;
  return (
    el.closest(
      '[class*="question" i], [class*="Question" i], [class*="field" i], [class*="Field" i], [data-question-id], fieldset, li'
    ) || el.parentElement
  );
}

function resolveDropdownActivator(trigger) {
  if (!trigger) return trigger;
  return (
    trigger.closest(
      'button[aria-haspopup], [role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="menu"], [aria-haspopup="true"], [aria-expanded]'
    ) ||
    trigger.closest("[data-state]") ||
    trigger
  );
}

function isLikelySelectOptionText(text, questionLabel = "") {
  const t = cleanLabel(text);
  if (!t || t.length < 2 || t.length > 80) return false;
  if (isPlaceholderOption(t)) return false;
  if (/^(select|choose|pick)\b/i.test(t)) return false;
  if (isEventBodyCopy(t)) return false;
  const ql = cleanLabel(questionLabel).toLowerCase();
  if (ql && t.toLowerCase() === ql) return false;
  if (ql && ql.length > 24 && t.toLowerCase().includes(ql.slice(0, 20))) return false;

  if (/categor|best describe|role|which.*you/i.test(ql)) {
    if (/^(engineer|developer|founder|investor|student|other|ai|robot|product|design|operator|researcher|executive|manager)/i.test(t)) {
      return true;
    }
    if (t.length <= 40 && !t.includes("?")) return true;
  }
  return true;
}

function findComboboxInput(trigger, doc = document) {
  if (!trigger) return null;
  const container = getQuestionFieldContainer(trigger, doc);
  const scopes = [container, trigger.closest('[role="combobox"]'), trigger.parentElement].filter(Boolean);
  for (const scope of scopes) {
    const input = scope.querySelector(
      'input[type="text"], input[type="search"], input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])'
    );
    if (input && isVisible(input)) return input;
  }
  return null;
}

function findNativeSelectForTrigger(trigger, doc = document) {
  const container = getQuestionFieldContainer(trigger, doc);
  const scopes = [container, getRegistrationModalRoot(doc)].filter(Boolean);
  for (const scope of scopes) {
    for (const select of scope.querySelectorAll("select")) {
      if (select.options && select.options.length > 1) return select;
    }
  }
  return null;
}

function simulatePointerClick(el) {
  if (!el) return;
  const opts = { bubbles: true, cancelable: true, view: window, pointerId: 1, pointerType: "mouse" };
  el.dispatchEvent(new PointerEvent("pointerdown", opts));
  el.dispatchEvent(new PointerEvent("pointerup", opts));
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  if (typeof el.click === "function") el.click();
}

function snapshotInteractiveTexts(doc = document) {
  const texts = new Set();
  for (const el of doc.querySelectorAll(
    "label, li, button, div, span, [role='option'], [role='menuitem'], [role='menuitemcheckbox']"
  )) {
    const t = cleanLabel(el.textContent);
    if (t && t.length >= 2 && t.length <= 80) texts.add(t.toLowerCase());
  }
  return texts;
}

function collectFloatingListOptions(trigger, doc = document, questionLabel = "") {
  const options = [];
  const seen = new Set();
  if (!trigger) return options;

  const triggerRect = trigger.getBoundingClientRect();
  const modal = getRegistrationModalRoot(doc);

  for (const el of doc.querySelectorAll(
    "[role='option'], [role='menuitem'], [role='menuitemcheckbox'], [role='checkbox'], li, label, button, div, span"
  )) {
    if (!el || el === trigger || trigger.contains(el)) continue;

    const rect = el.getBoundingClientRect();
    if (rect.width < 6 || rect.height < 6) continue;

    const style = window.getComputedStyle(el);
    const z = parseInt(style.zIndex, 10) || 0;
    const isFloating = style.position === "fixed" || style.position === "absolute" || z >= 50;
    const nearTrigger =
      rect.top >= triggerRect.top - 40 && rect.top <= triggerRect.bottom + 520;
    const inOverlay = isFloating || (modal && modal.contains(el));

    if (!nearTrigger && !isFloating) continue;
    if (!inOverlay && modal && !modal.contains(el)) continue;

    let text = cleanLabel(el.getAttribute("aria-label") || el.textContent);
    if (el.tagName === "INPUT" && el.type === "checkbox") {
      const labelEl = el.closest("label") || (el.id && doc.querySelector(`label[for="${safeCssEscape(el.id)}"]`));
      text = cleanLabel(labelEl?.textContent || text);
    }
    if (!isLikelySelectOptionText(text, questionLabel)) continue;

    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const clickEl =
      el.tagName === "INPUT" ? el.closest("label") || el : el.closest("label") || el;
    options.push({ el: clickEl, text });
  }
  return options;
}

function collectOptionsFromSnapshotDiff(beforeSet, doc, trigger, questionLabel = "") {
  const options = [];
  const seen = new Set();

  for (const el of doc.querySelectorAll(
    "label, li, button, div, span, [role='option'], [role='menuitem'], [role='menuitemcheckbox'], [role='checkbox']"
  )) {
    if (!el || trigger?.contains(el)) continue;
    const text = cleanLabel(el.getAttribute("aria-label") || el.textContent);
    if (!text || beforeSet.has(text.toLowerCase())) continue;
    if (!isLikelySelectOptionText(text, questionLabel)) continue;
    if (el.children.length > 6) continue;

    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    options.push({
      el: el.closest("label") || el,
      text,
    });
  }
  return options;
}

function findElementByOptionText(text, doc = document) {
  const want = text.toLowerCase();
  for (const el of doc.querySelectorAll(
    "label, li, button, div, span, [role='option'], [role='menuitem']"
  )) {
    const t = cleanLabel(el.textContent);
    if (t.toLowerCase() === want || t.toLowerCase().startsWith(want)) {
      if (isElementInteractable(el) || el.closest("label")) {
        return el.closest("label") || el;
      }
    }
  }
  return null;
}

function resolveOptionElement(text, activator, label, doc = document) {
  const want = text.toLowerCase();
  const options = collectDropdownOptions(activator, doc, null);
  let match =
    options.find((o) => o.text.toLowerCase() === want) ||
    options.find((o) => o.text.toLowerCase().includes(want) || want.includes(o.text.toLowerCase()));
  if (match) return match.el;

  const el = findElementByOptionText(text, doc);
  return el;
}

function dropdownHasVisibleOptions(activator, label, doc = document) {
  if (isDropdownOverlayOpen(doc)) return true;
  return collectFloatingListOptions(activator, doc, label).length > 1;
}

function multiSelectHasSelection(activator, doc = document) {
  const container = getQuestionFieldContainer(activator, doc);
  const text = (activator.textContent || activator.value || "").trim();
  if (text && !isDropdownTriggerText(text) && !isPlaceholderOption(text)) return true;

  if (!container) return false;
  if (container.querySelector('[aria-selected="true"], [data-state="checked"], input[type="checkbox"]:checked')) {
    return true;
  }
  for (const el of container.querySelectorAll("span, div")) {
    const t = (el.textContent || "").trim();
    if (t.length > 2 && t.length < 40 && !isPlaceholderOption(t) && !isDropdownTriggerText(t)) {
      if (el.closest('[class*="tag" i], [class*="chip" i], [class*="pill" i], [class*="badge" i]')) {
        return true;
      }
    }
  }
  return false;
}

function isDropdownOverlayOpen(doc = document) {
  for (const panel of doc.querySelectorAll(
    '[role="listbox"], [role="menu"], [data-radix-popper-content-wrapper], [data-radix-select-content], [class*="popover" i]'
  )) {
    if (isElementInteractable(panel)) return true;
  }

  const modal = getRegistrationModalRoot(doc);
  if (modal) {
    for (const el of modal.querySelectorAll('[aria-expanded="true"], [data-state="open"]')) {
      if (!isElementInteractable(el)) continue;
      if (el.matches('button, [role="combobox"], [aria-haspopup]')) continue;
      if (el.querySelector('[role="option"], [role="menuitem"], input[type="checkbox"], [role="checkbox"]')) {
        return true;
      }
    }
  }
  return false;
}

function isRegistrationFormOpen(doc = document) {
  const root = getRegistrationModalRoot(doc);
  if (!root) return false;
  for (const field of root.querySelectorAll("input, textarea, select, [role='combobox']")) {
    if (!isVisible(field)) continue;
    if (field.tagName === "INPUT") {
      const type = (field.getAttribute("type") || "text").toLowerCase();
      if (["hidden", "checkbox", "radio", "file", "submit", "button"].includes(type)) continue;
    }
    return true;
  }
  return hasVisibleDropdownTriggers(doc);
}

function hasUnfilledFormFields(doc = document) {
  const root = getFormRoot(doc);
  if (!root) return false;
  for (const field of root.querySelectorAll("input, textarea, select")) {
    if (!isVisible(field)) continue;
    const type = (field.getAttribute("type") || "text").toLowerCase();
    if (["hidden", "checkbox", "radio", "file", "submit", "button"].includes(type)) continue;

    if (field.required && !field.value?.trim()) return true;
    if (field.tagName === "SELECT") {
      const opt = field.options[field.selectedIndex];
      if (opt && isPlaceholderOption(opt.text) && (field.required || opt.value === "")) return true;
    }
  }

  const radioGroups = {};
  for (const r of root.querySelectorAll('input[type="radio"]')) {
    if (!isVisible(r)) continue;
    const name = r.getAttribute("name") || "__noname__";
    (radioGroups[name] = radioGroups[name] || []).push(r);
  }
  for (const group of Object.values(radioGroups)) {
    const required = group.some((r) => r.required || r.getAttribute("aria-required") === "true");
    const checked = group.some((r) => r.checked);
    if (required && !checked) return true;
  }

  return findCustomDropdownTriggers(doc).length > 0;
}

function isVisible(el) {
  if (!el || el.disabled) return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function getFieldLabel(el, doc = document) {
  const id = el.getAttribute("id");
  if (id) {
    const label = doc.querySelector(`label[for="${safeCssEscape(id)}"]`);
    if (label) return cleanLabel(label.textContent);
  }

  const aria = el.getAttribute("aria-label");
  if (aria) return cleanLabel(aria);

  const placeholder = el.getAttribute("placeholder");
  if (placeholder) return cleanLabel(placeholder);

  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy && typeof doc.getElementById === "function") {
    const parts = labelledBy
      .split(/\s+/)
      .map((lid) => doc.getElementById(lid)?.textContent?.trim())
      .filter(Boolean);
    if (parts.length) return cleanLabel(parts.join(" "));
  }

  const CONTROL_SEL = "input:not([type='hidden']), textarea, select, [role='combobox']";
  let parent = el.closest("label, [class*='question'], [class*='field'], fieldset, div");
  for (let i = 0; i < 6 && parent; i++) {
    const controls = [...parent.querySelectorAll(CONTROL_SEL)].filter(
      (c) => c !== el && !el.contains(c) && !c.contains(el)
    );
    const candidates = [...parent.querySelectorAll("label, legend, [class*='label'], p, span, h3, h4")].filter(
      (node) => node !== el && !el.contains(node) && !node.contains(el)
    );
    // Walk the candidates that PRECEDE the control, nearest first, and stop at the first one that
    // has another form control between it and ours — that label belongs to the other control.
    const FOLLOWING = 4; // Node.DOCUMENT_POSITION_FOLLOWING
    const before = (a, b) => Boolean(a.compareDocumentPosition(b) & FOLLOWING);
    for (let c = candidates.length - 1; c >= 0; c--) {
      const node = candidates[c];
      if (!before(node, el)) continue;
      const blocked = controls.some((ctrl) => before(node, ctrl) && before(ctrl, el));
      if (blocked) break;
      const text = cleanLabel(node.textContent);
      if (text.length > 3 && text.length < 300) return text;
    }
    // A container that already holds other controls is the form itself; going higher would only
    // find labels that belong to other fields.
    if (controls.length > 0) break;
    parent = parent.parentElement;
  }

  return cleanLabel(el.getAttribute("name") || "");
}

function cleanLabel(text) {
  return (text || "").replace(/\s+/g, " ").replace(/\*+/g, "").trim();
}

function getQuestionTextForElement(el, doc = document) {
  let node = el;
  for (let i = 0; i < 10 && node; i++) {
    const prev = node.previousElementSibling;
    if (prev) {
      const text = cleanLabel(prev.textContent);
      if (text.length >= 8 && text.length <= 300 && (text.includes("?") || text.includes("*"))) {
        return text;
      }
    }

    for (const candidate of node.querySelectorAll("label, legend, p, span, h3, h4, div")) {
      if (!isVisible(candidate) || candidate === el || el.contains(candidate)) continue;
      const text = cleanLabel(candidate.textContent);
      if (text.length < 8 || text.length > 300) continue;
      const type = classifyQuestion(text);
      if (type !== "unknown" && type !== "custom") return text;
      if (text.includes("?") || text.includes("*")) return text;
    }
    node = node.parentElement;
  }
  return getFieldLabel(el, doc);
}

function getRegistrationModalRoot(doc = document) {
  const dialogs = [...doc.querySelectorAll('[role="dialog"]')].filter(isVisible);
  if (dialogs.length) {
    const withForm = dialogs.find(
      (d) =>
        d.querySelector("input, textarea, select, [role='combobox'], [aria-haspopup]") ||
        /your info|request to join|registration/i.test(d.textContent || "")
    );
    return withForm || dialogs[dialogs.length - 1];
  }

  const modals = [...doc.querySelectorAll('[class*="modal" i]')].filter(isVisible);
  if (modals.length) {
    return modals.find((m) => m.querySelector("input, textarea, [role='combobox']")) || modals[modals.length - 1];
  }

  return null;
}

/** Event-page registration sidebar / ticket panel (before modal opens). Always returns a node. */
function getRegistrationPanelRoot(doc = document) {
  const modal = getRegistrationModalRoot(doc);
  if (modal) return modal;

  const candidates = [
    ...doc.querySelectorAll(
      '[class*="registration" i], [class*="Registration" i], [class*="checkout" i], [class*="ticket" i]'
    ),
  ].filter(isVisible);

  for (const el of candidates) {
    if (el.closest('[role="dialog"]')) continue;
    if (isEventBodyCopy((el.textContent || "").slice(0, 120))) continue;
    if (el.querySelector("button, [role='button']")) return el;
    if (/register|rsvp|ticket|request to join|waitlist|get ticket/i.test(el.textContent || "")) return el;
  }

  const main = doc.querySelector("main");
  if (main) {
    for (const block of main.querySelectorAll("section, aside, div")) {
      if (!isVisible(block)) continue;
      const t = (block.textContent || "").toLowerCase();
      if (
        (t.includes("register") ||
          t.includes("request to join") ||
          t.includes("get ticket") ||
          t.includes("join waitlist")) &&
        block.querySelector("button, [role='button']")
      ) {
        return block;
      }
    }
  }

  return doc.body;
}

function getFormRoot(doc = document) {
  return (
    getRegistrationModalRoot(doc) ||
    doc.querySelector("form") ||
    null
  );
}

/** Registration sidebar or modal — used for payment/ticket checks (never full page body). */
function getPaymentScanRoot(doc = document) {
  return getFormRoot(doc) || getRegistrationPanelRoot(doc);
}

function panelShowsFreeTier(doc = document) {
  const panel = getRegistrationPanelRoot(doc);
  const text = (panel.innerText || panel.textContent || "").toLowerCase();
  if (/\$0(?:\.00)?\b/.test(text)) return true;

  for (const el of panel.querySelectorAll("button, [role='radio'], [role='button'], label")) {
    if (!isVisible(el)) continue;
    const line = (el.textContent || "").trim().split("\n")[0].toLowerCase();
    if ((/\bfree\b/.test(line) || /\$0/.test(line)) && line.length < 80) return true;
  }
  return false;
}

function hasPaidCheckoutCta(doc = document) {
  const root = getPaymentScanRoot(doc);
  for (const btn of root.querySelectorAll("button, [role='button']")) {
    if (!isVisible(btn)) continue;
    const t = (btn.textContent || btn.getAttribute("aria-label") || "").toLowerCase();
    if (/pay now|complete purchase|pay with card|pay \$\d|purchase ticket|buy for \$/.test(t)) {
      return true;
    }
    if (/^pay(?:\s+now|\s+with|\s+\$)/.test(t)) return true;
  }
  return false;
}

function isExplicitlyFreeRegistration(doc = document) {
  const root = getPaymentScanRoot(doc);
  const text = (root.innerText || root.textContent || "").toLowerCase();

  if (/\$0(?:\.00)?\b/.test(text)) return true;
  if (panelShowsFreeTier(doc)) return true;

  if (/\bfree\b/.test(text) && !/\bfree trial\b/.test(text) && !hasVisibleCardFields(doc)) {
    if (!hasPaidCheckoutCta(doc)) return true;
  }
  return false;
}

function hasVisibleCardFields(doc = document) {
  const root = getPaymentScanRoot(doc);
  if (!root) return false;
  const cardSelectors = [
    'input[autocomplete="cc-number"]',
    'input[autocomplete="cc-name"]',
    'input[autocomplete="cc-exp"]',
    'input[name*="cardnumber" i]',
    'input[name*="card-number" i]',
    'input[name*="card_number" i]',
    'input[placeholder*="card number" i]',
    'input[placeholder*="credit card" i]',
    'input[placeholder*="debit card" i]',
    'input[id*="card-number" i]',
    'input[data-elements-stable-field-name*="cardNumber" i]',
    '[class*="CardNumber" i]',
    '[class*="PaymentElement" i]',
    '[class*="payment-element" i]',
  ];
  for (const sel of cardSelectors) {
    const el = root.querySelector(sel);
    if (el && isVisible(el)) return true;
  }
  for (const iframe of root.querySelectorAll('iframe[src*="stripe" i], iframe[src*="js.stripe.com" i]')) {
    if (isVisible(iframe)) return true;
  }
  return false;
}

/** True when checkout / card entry is required — never register for paid events. */
function isPaymentRequired(doc = document) {
  if (isExplicitlyFreeRegistration(doc) && !hasVisibleCardFields(doc)) return false;

  const root = getPaymentScanRoot(doc);
  const text = (root.innerText || root.textContent || "").toLowerCase();

  if (hasVisibleCardFields(doc)) return true;

  const paymentPhrases = [
    "credit card",
    "debit card",
    "card number",
    "card details",
    "enter your card",
    "add payment method",
    "cvv",
    "cvc",
    "expiration date",
    "expiry date",
  ];
  if (paymentPhrases.some((p) => text.includes(p))) return true;

  if (/\bpay now\b/.test(text) || /\bcomplete purchase\b/.test(text)) return true;

  for (const btn of root.querySelectorAll("button, a, [role='button']")) {
    if (!isVisible(btn)) continue;
    const t = (btn.textContent || btn.getAttribute("aria-label") || "").toLowerCase();
    if (/^pay(?:\s+now|\s+with|\s+\$)/.test(t)) return true;
    if (/complete purchase|pay \$\d|purchase ticket|buy for \$|pay with card/.test(t)) {
      return true;
    }
  }

  if (hasPaidCheckoutCta(doc)) return true;

  const prices = text.match(/\$\d+(?:\.\d{2})?/g) || [];
  const hasPaidPrice = prices.some((p) => p !== "$0" && p !== "$0.00");
  if (hasPaidPrice && hasPaidCheckoutCta(doc)) return true;

  return false;
}

function isPaidEventPage(doc = document) {
  if (isExplicitlyFreeRegistration(doc) && !hasVisibleCardFields(doc)) return false;
  if (isPaymentRequired(doc)) return true;

  const root = getPaymentScanRoot(doc);
  const text = (root.innerText || root.textContent || "").toLowerCase();

  if (/\bbuy ticket\b/.test(text) && !/\bfree\b/.test(text) && hasPaidCheckoutCta(doc)) return true;

  if (hasVisibleCardFields(doc)) return true;

  return false;
}

/** Discovery API says free — skip paid heuristics unless card fields visible. */
function isPaidEventPageWithTrust(doc = document, eventMeta = {}) {
  if (eventMeta.isFree === true && !hasVisibleCardFields(doc)) return false;
  return isPaidEventPage(doc);
}

function needsSmartAnswer(qType, label) {
  if (["custom", "motivation", "admission", "community_member"].includes(qType)) return true;
  const l = (label || "").toLowerCase();
  return l.includes("?") && l.length > 12;
}

function requiresWallet(doc = document) {
  const root = getFormRoot(doc) || doc.body;
  const pageText = (root.innerText || root.textContent || "").toLowerCase();

  if (
    pageText.includes("verify token ownership") ||
    pageText.includes("token ownership with your wallet") ||
    pageText.includes("connect your wallet")
  ) {
    return true;
  }

  for (const btn of root.querySelectorAll("button, a, [role='button']")) {
    if (!isVisible(btn)) continue;
    const t = (btn.textContent || btn.getAttribute("aria-label") || "").toLowerCase();
    if (
      t.includes("connect wallet") ||
      t.includes("verify wallet") ||
      t.includes("connect metamask") ||
      t.includes("sign with wallet") ||
      t.includes("link wallet")
    ) {
      return true;
    }
  }

  const walletField = root.querySelector(
    '[class*="wallet" i], [data-testid*="wallet" i], input[name*="wallet" i]'
  );
  if (walletField && isVisible(walletField)) return true;

  return false;
}

function getOpenDropdownTriggers(doc = document) {
  return findCustomDropdownTriggers(doc);
}

function getActiveDropdownPanels(doc = document, trigger = null) {
  const panels = [];
  const seen = new Set();

  const addPanel = (el) => {
    if (!el || seen.has(el)) return;
    if (!isElementInteractable(el) && !el.querySelector("[role='option'], input[type='checkbox']")) return;
    seen.add(el);
    panels.push(el);
  };

  for (const wrapper of doc.querySelectorAll(
    "[data-radix-popper-content-wrapper], [data-radix-select-content], [data-radix-menu-content]"
  )) {
    const inner =
      wrapper.querySelector(
        "[role='listbox'], [role='menu'], [data-radix-select-viewport], [data-radix-collection-item]"
      ) || wrapper.firstElementChild;
    addPanel(inner || wrapper);
  }

  for (const el of doc.querySelectorAll("[role='listbox'], [role='menu']")) {
    addPanel(el);
  }

  if (trigger) {
    const controlsId = trigger.getAttribute("aria-controls");
    if (controlsId) {
      const controlled = doc.getElementById(controlsId);
      if (controlled) addPanel(controlled);
    }

    const container = getQuestionFieldContainer(trigger, doc);
    if (container) {
      for (const el of container.querySelectorAll(
        '[aria-expanded="true"], [data-state="open"], [class*="expanded" i], [class*="options" i], [class*="choices" i]'
      )) {
        addPanel(el);
      }
      addPanel(container);
    }
  }

  if (panels.length) return panels;

  const formRoot = getRegistrationModalRoot(doc);
  if (!formRoot) return [];

  for (const el of formRoot.querySelectorAll(
    '[class*="popover" i], [class*="dropdown" i], [class*="menu" i][class*="open" i]'
  )) {
    addPanel(el);
  }

  return panels;
}

function collectFieldScopedOptions(trigger, doc = document) {
  const container = getQuestionFieldContainer(trigger, doc);
  if (!container) return [];

  const questionLabel = getQuestionTextForElement(trigger, doc);
  const options = [];
  const seen = new Set();

  const addOption = (el, textOverride = "") => {
    if (!el || el === trigger || trigger.contains(el)) return;
    if (!isElementInteractable(el) && el.tagName !== "INPUT") return;
    if (isNavigationalLink(el)) return;

    let text = cleanLabel(textOverride || el.getAttribute("aria-label") || el.textContent);
    if (el.tagName === "INPUT" && el.type === "checkbox") {
      const labelEl =
        (el.id && doc.querySelector(`label[for="${safeCssEscape(el.id)}"]`)) || el.closest("label");
      text = cleanLabel(labelEl?.textContent || text);
    }
    if (!isLikelySelectOptionText(text, questionLabel)) return;

    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);

    const clickEl =
      el.tagName === "INPUT" && el.type === "checkbox"
        ? el.closest("label") || el
        : el.closest("label") || el;
    options.push({ el: clickEl, text });
  };

  for (const cb of container.querySelectorAll('input[type="checkbox"]')) {
    addOption(cb);
  }

  for (const el of container.querySelectorAll(
    "[role='option'], [role='menuitem'], [role='menuitemcheckbox'], [role='radio'], [role='checkbox'], [aria-checked], [data-radix-collection-item]"
  )) {
    addOption(el);
  }

  for (const el of container.querySelectorAll("label, li, button, div[tabindex='0'], div[tabindex='-1']")) {
    if (el.querySelector("input[type='checkbox'], input[type='radio']")) continue;
    if (el.children.length > 4) continue;
    addOption(el);
  }

  return options;
}

function describeDropdownDiscovery(trigger, doc = document) {
  const panels = getActiveDropdownPanels(doc, trigger);
  const fieldOpts = trigger ? collectFieldScopedOptions(trigger, doc) : [];
  const floating = trigger ? collectFloatingListOptions(trigger, doc, getQuestionTextForElement(trigger, doc)) : [];
  const modal = getRegistrationModalRoot(doc);
  const modalOpts = modal
    ? modal.querySelectorAll("[role='option'], [role='menuitemcheckbox'], input[type='checkbox']").length
    : 0;
  const portaled = doc.querySelectorAll("[data-radix-popper-content-wrapper]").length;
  const listboxes = doc.querySelectorAll("[role='listbox']").length;
  const expanded = trigger?.getAttribute("aria-expanded") || trigger?.closest("[aria-expanded]")?.getAttribute("aria-expanded");
  const sample = (fieldOpts.length ? fieldOpts : floating)
    .slice(0, 4)
    .map((o) => o.text)
    .join(", ");
  return `panels=${panels.length}, field=${fieldOpts.length}, float=${floating.length}, modalOpts=${modalOpts}, portaled=${portaled}, listboxes=${listboxes}, expanded=${expanded || "?"}${sample ? `, sample=[${sample}]` : ""}`;
}

function collectDropdownOptions(trigger = null, doc = document, beforeSnapshot = null) {
  const options = [];
  const seen = new Set();
  const questionLabel = trigger ? getQuestionTextForElement(trigger, doc) : "";

  const addOption = (el, textOverride = "") => {
    if (!el || (trigger && (el === trigger || trigger.contains(el)))) return;

    let text = cleanLabel(textOverride || el.getAttribute("aria-label") || el.textContent);
    if (el.tagName === "INPUT" && el.type === "checkbox") {
      const labelEl =
        (el.id && doc.querySelector(`label[for="${safeCssEscape(el.id)}"]`)) || el.closest("label");
      text = cleanLabel(labelEl?.textContent || text);
    } else {
      text = (text || "").trim().split("\n")[0].trim();
    }

    if (!isLikelySelectOptionText(text, questionLabel)) return;
    const key = `${text.toLowerCase()}::${el.tagName}`;
    if (seen.has(key)) return;
    seen.add(key);

    const clickEl =
      el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio")
        ? el.closest("label") || el
        : el.closest("label") || el;
    options.push({ el: clickEl, text });
  };

  const optionSelectors =
    "[role='option'], [role='menuitem'], [role='menuitemcheckbox'], [role='radio'], [role='checkbox'], [data-radix-collection-item], [aria-checked], [cmdk-item], [data-value]";

  for (const panel of getActiveDropdownPanels(doc, trigger)) {
    for (const el of panel.querySelectorAll(optionSelectors)) {
      addOption(el);
    }
    if (!options.length) {
      for (const el of panel.querySelectorAll("label, li, button, div, span")) {
        if (el.children.length > 5) continue;
        addOption(el);
      }
    }
  }

  if (!options.length && trigger) {
    for (const opt of collectFloatingListOptions(trigger, doc, questionLabel)) {
      addOption(opt.el, opt.text);
    }
  }

  if (!options.length && beforeSnapshot) {
    for (const opt of collectOptionsFromSnapshotDiff(beforeSnapshot, doc, trigger, questionLabel)) {
      addOption(opt.el, opt.text);
    }
  }

  if (!options.length) {
    const modal = getRegistrationModalRoot(doc);
    if (modal) {
      for (const el of modal.querySelectorAll(optionSelectors)) {
        addOption(el);
      }
    }
  }

  if (!options.length && trigger) {
    for (const opt of collectFieldScopedOptions(trigger, doc)) {
      addOption(opt.el, opt.text);
    }
  }

  return options;
}
