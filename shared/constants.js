export const STORAGE_KEYS = {
  profile: "lumaProfile",
  settings: "lumaSettings",
  queue: "registrationQueue",
  history: "registrationHistory",
};

export const DEFAULT_SETTINGS = {
  cityFilter: "San Francisco",
  freeOnly: true,
  autoFillOnPage: true,
  autoSubmit: false,
  delayBetweenMs: 3000,
  aiAnswerQuestions: true,
  aiProvider: "auto",
  geminiApiKey: "",
  geminiModel: "gemini-2.0-flash",
};

export const SF_LOCATION_KEYWORDS = [
  "san francisco",
  "sf",
  "bay area",
  "soMa",
  "soma",
  "mission",
  "financial district",
  "fidi",
];

export const DISCOVER_SF_URL = "https://lu.ma/discover/sf";
