export const SF_PLACE_ID = "discplace-BDj7GNbGlsF7Cka";

const NON_EVENT_PATH_SEGMENTS = new Set([
  "user", "calendar", "discover", "signin", "login", "home", "pricing", "help", "sf",
  "create", "app", "settings", "about",
]);

export function isValidEventSlug(slug) {
  if (!slug || typeof slug !== "string") return false;
  const s = slug.trim();
  if (s.length < 2 || s.includes("/")) return false;
  if (s.startsWith("usr-") || s.startsWith("evt-") || s.startsWith("cal-")) return false;
  if (NON_EVENT_PATH_SEGMENTS.has(s.toLowerCase())) return false;
  return /^[\w-]+$/i.test(s);
}

export function isValidEventHref(href) {
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

export const SEARCH_QUERIES = [
  "AI",
  "artificial intelligence",
  "machine learning",
  "LLM",
  "GPT",
  "agent",
  "agentic",
  "tech",
  "technology",
  "startup",
  "founder",
  "developer",
  "engineering",
  "software",
  "data",
  "hackathon",
  "meetup",
  "summit",
  "workshop",
  "networking",
  "product",
  "design",
  "research",
  "robotics",
  "automation",
  "cloud",
  "dev",
  "devrel",
  "open source",
  "VC",
  "community",
  "config",
  "inference",
  "neural",
  "deep learning",
  "Bay Area",
];

/** Extra API passes using Luma category filter (same place, different ranking) */
export const DISCOVER_CATEGORIES = ["ai", "tech"];

export const SF_REGION_CITIES = [
  "san francisco",
  "oakland",
  "berkeley",
  "palo alto",
  "mountain view",
  "sunnyvale",
  "san mateo",
  "redwood city",
  "fremont",
  "hayward",
  "millbrae",
  "south san francisco",
  "burlingame",
];

export const TECH_KEYWORDS = [
  "ai",
  "artificial intelligence",
  "machine learning",
  "ml",
  "llm",
  "agent",
  "agentic",
  "tech",
  "technology",
  "startup",
  "developer",
  "engineering",
  "software",
  "data",
  "neural",
  "deep learning",
  "open source",
  "summit",
  "inference",
  "hackathon",
  "meetup",
  "dev",
  "cloud",
  "api",
  "robotics",
  "automation",
];

export const EXCLUDE_KEYWORDS = [
  "yoga",
  "fitness",
  "wine",
  "cooking",
  "dating",
  "singles",
  "real estate",
];

/** Skip women-only / women-centric events (profile gender: male) */
export const WOMEN_ONLY_TITLE_PATTERNS = [
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

export function isWomenOnlyEventText(text) {
  return WOMEN_ONLY_TITLE_PATTERNS.some((re) => re.test(text || ""));
}

export function isWomenOnlyEvent(event) {
  const text = [event?.title, event?.organizer].filter(Boolean).join(" ");
  return isWomenOnlyEventText(text);
}

export function hasInPersonSignals(text) {
  const t = (text || "").toLowerCase();
  return (
    /\bin person\b/i.test(t) ||
    /\bin-person\b/i.test(t) ||
    /\battend in person\b/i.test(t)
  );
}

export function hasLivestreamSignals(text) {
  const t = (text || "").toLowerCase();
  return /\blive\s*stream\b/i.test(t) || /\blivestream\b/i.test(t);
}

export function hasPhysicalVenueInText(text) {
  const t = (text || "").toLowerCase();
  if (SF_REGION_CITIES.some((c) => t.includes(c))) return true;
  if (/\bsan francisco\b/i.test(t)) return true;
  if (
    /\b\d{1,5}\s+[\w\s.]{2,40}\b(st|street|ave|avenue|blvd|road|rd|way|dr|drive|ln|lane|market)\b/i.test(
      t
    )
  ) {
    return true;
  }
  return false;
}

/** Hybrid or in-person-capable — do not treat as virtual-only. */
export function isHybridOrInPersonCapable(text, geo = null) {
  if (geo && hasPhysicalGeo(geo)) return true;
  if (hasInPersonSignals(text)) return true;
  if (hasPhysicalVenueInText(text) && !/\bonline only\b|\bvirtual only\b|\bremote only\b/i.test(text)) {
    return true;
  }
  if (hasInPersonSignals(text) && hasLivestreamSignals(text)) return true;
  return false;
}

/** Skip online-only events — in-person SF registration only */
export const VIRTUAL_ONLY_PATTERNS = [
  /\bvirtual only\b/i,
  /\bonline only\b/i,
  /\bremote only\b/i,
  /\bstreaming only\b/i,
  /\bjoin via zoom\b/i,
  /\bzoom only\b/i,
  /\bvirtual event\b/i,
  /\bvirtual meetup\b/i,
  /\bonline event\b/i,
  /\bwebinar only\b/i,
];

/** Strong virtual platform signals when there is no in-person option */
export const VIRTUAL_PLATFORM_PATTERNS = [
  /\bzoom\b/i,
  /\bzoom meeting\b/i,
  /\bjoin zoom\b/i,
  /\bon zoom\b/i,
  /\bvia zoom\b/i,
  /\bzoom\.us\b/i,
  /\bgoogle meet link\b/i,
  /\bon google meet\b/i,
  /\bmeet\.google/i,
  /\bmicrosoft teams meeting\b/i,
  /\bteams\.microsoft\b/i,
  /\bhopin\b/i,
  /\bgather\.town\b/i,
  /\btwitch\.tv\b/i,
  /\bwebex\b/i,
  /\bstreamyard\b/i,
  /\bwhereby\b/i,
  /\baround\.co\b/i,
  /\bremo\.co\b/i,
  /\bbigmarker\b/i,
  /\bgotomeeting\b/i,
  /\bbluejeans\b/i,
  /\briverside\.fm\b/i,
  /\bluma\.com\/live\b/i,
];

/** @deprecated use VIRTUAL_ONLY_PATTERNS / VIRTUAL_PLATFORM_PATTERNS */
export const VIRTUAL_EVENT_PATTERNS = [
  ...VIRTUAL_ONLY_PATTERNS,
  ...VIRTUAL_PLATFORM_PATTERNS,
  /\bwebinar\b/i,
];

export const VIRTUAL_URL_PATTERNS = [
  /zoom\.us/i,
  /meet\.google\.com/i,
  /teams\.microsoft/i,
  /youtube\.com/i,
  /youtu\.be/i,
  /hopin\.com/i,
  /gather\.town/i,
  /twitch\.tv/i,
  /webex\.com/i,
];

export function isVirtualEventText(text) {
  const t = (text || "").toLowerCase();
  if (!t) return false;
  if (isHybridOrInPersonCapable(text)) return false;

  if (VIRTUAL_ONLY_PATTERNS.some((re) => re.test(t))) return true;
  if (VIRTUAL_PLATFORM_PATTERNS.some((re) => re.test(t))) return true;

  if (/\bwebinar\b/i.test(t) && !hasInPersonSignals(t) && !hasPhysicalVenueInText(t)) return true;

  if (/\bvirtual\b/.test(t) && !/\bin person\b/.test(t) && !/\bhybrid\b/.test(t)) return true;
  if (/\bonline\b/.test(t) && !/\bin person\b/.test(t) && !/\bhybrid\b/.test(t)) {
    if (/\bonline event\b/.test(t) || /\bevent online\b/.test(t) || /^online$/.test(t.trim())) {
      return true;
    }
  }
  return false;
}

export function hasPhysicalGeo(geo = {}) {
  return Boolean(
    (geo.city && String(geo.city).trim()) ||
      (geo.city_state && String(geo.city_state).trim()) ||
      (geo.address && String(geo.address).trim()) ||
      (geo.full_address && String(geo.full_address).trim()) ||
      geo.latitude != null ||
      geo.longitude != null
  );
}

/** Detect virtual-only events from Luma API payload — never default empty geo to SF */
export function isVirtualEventFromApi(event = {}, geo = {}) {
  const textBlob = [
    event.name,
    event.description,
    event.location,
    event.address,
    geo.address,
    geo.full_address,
    geo.city,
    geo.city_state,
    geo.description,
  ]
    .filter(Boolean)
    .join(" ");

  if (isHybridOrInPersonCapable(textBlob, geo)) return false;

  const locationType = String(
    event.location_type || event.event_type || geo.type || geo.location_type || ""
  ).toLowerCase();

  if (hasPhysicalGeo(geo)) {
    if (["online", "virtual", "remote"].includes(locationType)) return true;
    if (geo.mode === "online" || geo.is_online === true) return true;
    if (VIRTUAL_ONLY_PATTERNS.some((re) => re.test(textBlob))) return true;
    return false;
  }

  if (["online", "virtual", "remote", "digital"].includes(locationType)) return true;
  if (geo.mode === "online" || geo.is_online === true) return true;
  if (isVirtualEventText(textBlob)) return true;
  if (!hasPhysicalGeo(geo)) return true;

  return false;
}

export function isVirtualEvent(event) {
  if (event?.isVirtual) return true;
  const text = [event?.title, event?.city, event?.location, event?.address, event?.organizer]
    .filter(Boolean)
    .join(" ");
  return isVirtualEventText(text);
}

export const MIN_RELEVANCE_SCORE = 20;
export const MAX_EVENTS = 50;
export const MAX_DISCOVERY_PAGES = 20;
export const QUERY_MAX_PAGES = 5;
// Leave breathing room between Luma page navigations. Form work usually adds more time, while this
// floor protects fast skip/already-registered paths from turning into a navigation burst.
export const REGISTRATION_DELAY_MS = 12000;
export const TAB_TIMEOUT_MS = 45000;

export const DEFAULT_PROFILE = {
  first_name: "Zubair",
  last_name: "Zafar",
  email: "zubairzafar480@gmail.com",
  work_email: "",
  phone: "",
  location: "San Francisco, CA",
  gender: "male",
  job_title: "Software Engineer",
  company: "Eastern Illinois University",
  // Event-aware identity: founder-flavored events (startup/pitch/investor) present as Founder @
  // Stealth Startup; everything else presents as the engineer identity.
  default_persona: "engineer",
  personas: {
    founder: { job_title: "Founder", company: "Stealth Startup" },
    engineer: { job_title: "Software Engineer", company: "Eastern Illinois University" },
  },
  linkedin: "https://www.linkedin.com/in/zubair480",
  instagram: "zubair1105",
  x: "https://x.com/zubair_1105",
  twitter: "https://x.com/zubair_1105",
  twitter_handle: "zubair_1105",
  github: "https://github.com/zubair480",
  website: "https://github.com/zubair480",
  dietary: "Halal or vegan",
  willing_to_pitch: "No, thank you.",
  default_answers: {
    "What brings you to this event?":
      "I'm a Software Engineer & Full Stack Developer interested in AI and tech community events in San Francisco.",
    "Why do you want to attend?":
      "I'm passionate about AI/tech and want to connect with the local developer community.",
    "Tell us about yourself":
      "Software Engineer & Full Stack Developer at Eastern Illinois University. I build full-stack applications and follow AI/agent developments closely.",
    "What is the book you are currently reading? Name and author :)":
      "The Pragmatic Programmer by David Thomas and Andrew Hunt",
    current_book: "The Pragmatic Programmer by David Thomas and Andrew Hunt",
    "Company / Organization": "Eastern Illinois University",
    "What company/school are you currently at?": "Eastern Illinois University",
    "What is your LinkedIn profile?": "https://www.linkedin.com/in/zubair480",
    "Personal Website or Portfolio Link": "https://github.com/zubair480",
    "How did you hear about the event?": "Luma",
    "Are you following @designmeetup on Instagram?": "Yes",
    "Are you looking for a new role?": "Open to new opportunities.",
    "Are you currently fundraising?": "Not currently fundraising.",
    "Funding Round?": "Not currently fundraising.",
    "What are you going to build?": "A practical AI/agent prototype — I'll scope it with my team at the event.",
    "Dietary Restrictions?": "Halal or vegan",
    "Would you be willing to pitch?": "No, thank you.",
    "Job Title": "Software Engineer & Full Stack Developer",
    LinkedIn: "https://www.linkedin.com/in/zubair480",
    Website: "https://github.com/zubair480",
  },
};

export const LUMA_HEADERS = {
  Origin: "https://luma.com",
  Referer: "https://luma.com/sf",
  Accept: "application/json",
};

export const SUCCESS_PHRASES = [
  "you're going",
  "you're registered",
  "registration confirmed",
  "you're on the list",
  "you're on the waitlist",
  "joined the waitlist",
  "added to the waitlist",
  "request submitted",
  "application received",
  "application submitted",
  "your request has been sent",
  "pending approval",
  "already registered",
];

export const REQUEST_LABELS = [
  "request to join",
  "request to attend",
  "send request",
  "submit request",
  "request access",
];

export const REGISTER_LABELS = [
  "register",
  "rsvp",
  "get tickets",
  "complete registration",
  "submit",
  "confirm",
];
