/**
 * Form question answering — on-device SmolLM2 first, optional cloud fallback.
 */
import {
  buildSystemPrompt,
  buildUserPrompt,
  buildOptionSelectSystemPrompt,
  buildOptionSelectUserPrompt,
  parseOptionChoice,
  trimAnswer,
  ruleBasedFallback,
} from "./prompt-utils.js";
import { askLocalModel, warmupLocalModel, getLocalModelStatus, LOCAL_MODEL_ID } from "./local-llm-bridge.js";

export { warmupLocalModel, getLocalModelStatus, LOCAL_MODEL_ID };

const DEFAULT_CONFIG = {
  enabled: true,
  provider: "local",
  openaiModel: "gpt-4o-mini",
  ollamaUrl: "http://127.0.0.1:11434",
  ollamaModel: "llama3.2",
};

function normalizeQuestion(question) {
  return (question || "").replace(/\*+/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

export async function getLlmConfig() {
  const { llmConfig = {} } = await chrome.storage.local.get("llmConfig");
  return { ...DEFAULT_CONFIG, ...llmConfig };
}

async function getAnswerCache() {
  const { answerCache = {} } = await chrome.storage.local.get("answerCache");
  return answerCache;
}

async function cacheAnswer(question, answer) {
  const key = normalizeQuestion(question);
  if (!key || !answer) return;
  const answerCache = await getAnswerCache();
  answerCache[key] = answer;
  const keys = Object.keys(answerCache);
  if (keys.length > 200) {
    for (const old of keys.slice(0, keys.length - 200)) delete answerCache[old];
  }
  await chrome.storage.local.set({ answerCache });
}

export async function getCachedAnswer(question) {
  const answerCache = await getAnswerCache();
  return answerCache[normalizeQuestion(question)] || null;
}

async function callOpenAI(prompt, profile, eventTitle, fieldType, config) {
  const apiKey = config.openaiApiKey?.trim();
  if (!apiKey) return null;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.openaiModel || "gpt-4o-mini",
      temperature: 0.4,
      max_tokens: fieldType === "textarea" ? 180 : 100,
      messages: [
        { role: "system", content: buildSystemPrompt(fieldType) },
        {
          role: "user",
          content: buildUserPrompt({ question: prompt, profile, eventTitle, fieldType }),
        },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text().catch(() => "");
    throw new Error(`OpenAI ${response.status}: ${err.slice(0, 120)}`);
  }

  const data = await response.json();
  return trimAnswer(data.choices?.[0]?.message?.content, fieldType);
}

async function callOllama(prompt, profile, eventTitle, fieldType, config) {
  const base = (config.ollamaUrl || "http://127.0.0.1:11434").replace(/\/$/, "");
  const response = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.ollamaModel || "llama3.2",
      stream: false,
      options: { temperature: 0.4 },
      messages: [
        { role: "system", content: buildSystemPrompt(fieldType) },
        {
          role: "user",
          content: buildUserPrompt({ question: prompt, profile, eventTitle, fieldType }),
        },
      ],
    }),
  });

  if (!response.ok) throw new Error(`Ollama ${response.status}`);
  const data = await response.json();
  return trimAnswer(data.message?.content, fieldType);
}

/**
 * The offscreen model runs one generation at a time on a single WASM pipeline. Callers may now
 * ask several questions at once (the form agent fires them in parallel), so local requests are
 * queued here while cloud providers run genuinely concurrently.
 */
let localLane = Promise.resolve();
function onLocalLane(fn) {
  const run = localLane.then(fn, fn);
  localLane = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function callLocalModel(question, profile, eventTitle, fieldType, qType) {
  return onLocalLane(() => callLocalModelNow(question, profile, eventTitle, fieldType, qType));
}

async function callLocalModelNow(question, profile, eventTitle, fieldType, qType) {
  const result = await askLocalModel({
    question,
    profile,
    eventTitle,
    fieldType,
    qType,
  });
  if (result?.answer) return trimAnswer(result.answer, fieldType);
  return null;
}

async function callLocalOption(question, options, profile, eventTitle) {
  return onLocalLane(() => callLocalOptionNow(question, options, profile, eventTitle));
}

async function callLocalOptionNow(question, options, profile, eventTitle) {
  const result = await askLocalModel({
    question,
    options,
    profile,
    eventTitle,
    fieldType: "select",
    qType: "__option_select__",
  });
  // Offscreen already validates the pick against the option list.
  return result?.answer || null;
}

async function callOpenAIOption(question, options, profile, eventTitle, config) {
  const apiKey = config.openaiApiKey?.trim();
  if (!apiKey) return null;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.openaiModel || "gpt-4o-mini",
      temperature: 0,
      max_tokens: 8,
      messages: [
        { role: "system", content: buildOptionSelectSystemPrompt() },
        { role: "user", content: buildOptionSelectUserPrompt({ question, options, profile, eventTitle }) },
      ],
    }),
  });

  if (!response.ok) throw new Error(`OpenAI ${response.status}`);
  const data = await response.json();
  return parseOptionChoice(data.choices?.[0]?.message?.content, options);
}

async function callOllamaOption(question, options, profile, eventTitle, config) {
  const base = (config.ollamaUrl || "http://127.0.0.1:11434").replace(/\/$/, "");
  const response = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.ollamaModel || "llama3.2",
      stream: false,
      options: { temperature: 0 },
      messages: [
        { role: "system", content: buildOptionSelectSystemPrompt() },
        { role: "user", content: buildOptionSelectUserPrompt({ question, options, profile, eventTitle }) },
      ],
    }),
  });

  if (!response.ok) throw new Error(`Ollama ${response.status}`);
  const data = await response.json();
  return parseOptionChoice(data.message?.content, options);
}

/**
 * Choose one option from a fixed list. Returns a real option string or null (caller
 * then falls back to deterministic keyword matching). Never fabricates a value.
 */
async function chooseRegistrationOption({ question, options, profile, eventTitle }) {
  const config = await getLlmConfig();
  if (!config.enabled) return null;
  const provider = config.provider || "local";

  try {
    if (provider === "openai" && config.openaiApiKey?.trim()) {
      const picked = await callOpenAIOption(question, options, profile, eventTitle, config);
      if (picked) return picked;
    } else if (provider === "ollama") {
      const picked = await callOllamaOption(question, options, profile, eventTitle, config);
      if (picked) return picked;
    }
  } catch {
    /* cloud failed — fall through to local */
  }

  try {
    return await callLocalOption(question, options, profile, eventTitle);
  } catch {
    return null;
  }
}

/**
 * Answer a registration question. Cache → local SmolLM2 → optional cloud → rules.
 */
export async function answerRegistrationQuestion({
  question,
  profile,
  eventTitle = "",
  fieldType = "text",
  qType = "custom",
  options = null,
}) {
  if (!question?.trim()) return null;

  // Constrained selection — pick from the given options; do not use the free-text cache
  // (option sets vary per event) and never fabricate a value.
  if (Array.isArray(options) && options.length) {
    return chooseRegistrationOption({ question, options, profile, eventTitle });
  }

  const cached = await getCachedAnswer(question);
  if (cached) return cached;

  const config = await getLlmConfig();
  let answer = null;

  if (config.enabled) {
    const provider = config.provider || "local";
    try {
      if (provider === "local") {
        answer = await callLocalModel(question, profile, eventTitle, fieldType, qType);
      } else if (provider === "ollama") {
        answer = await callOllama(question, profile, eventTitle, fieldType, config);
      } else if (provider === "openai" && config.openaiApiKey?.trim()) {
        answer = await callOpenAI(question, profile, eventTitle, fieldType, config);
      }
    } catch {
      answer = null;
    }

    if (!answer && provider !== "local") {
      try {
        answer = await callLocalModel(question, profile, eventTitle, fieldType, qType);
      } catch {
        /* local fallback failed */
      }
    }
  }

  if (!answer) {
    answer = ruleBasedFallback(profile, qType);
  }

  if (answer) await cacheAnswer(question, answer);
  return answer;
}
