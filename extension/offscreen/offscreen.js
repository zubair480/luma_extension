/**
 * On-device SmolLM2-360M-Instruct via Transformers.js (runs in offscreen document).
 */
import { pipeline, env } from "@huggingface/transformers";
import {
  buildSystemPrompt,
  buildUserPrompt,
  buildChatPrompt,
  buildOptionSelectSystemPrompt,
  buildOptionSelectUserPrompt,
  parseOptionChoice,
  trimAnswer,
  ruleBasedFallback,
} from "../lib/prompt-utils.js";

const MODEL_ID = "onnx-community/SmolLM2-360M-Instruct";

env.useBrowserCache = true;
env.allowLocalModels = false;

let generator = null;
let loadPromise = null;
let modelState = "idle";
let loadError = null;
let loadProgress = "";

function formatError(err) {
  if (!err) return "Unknown error";
  if (typeof err === "string") return err;
  return err.message || err.toString?.() || "Unknown error";
}

/** MV3 extensions cannot load ONNX WASM from CDN — point at bundled vendor files. */
function configureExtensionOrt() {
  const base = chrome.runtime.getURL("vendor/ort/");
  const onnx = env.backends?.onnx;
  if (!onnx?.wasm) {
    throw new Error("ONNX WASM backend unavailable — reload the extension");
  }
  onnx.wasm.wasmPaths = base;
  onnx.wasm.numThreads = 1;
  onnx.wasm.proxy = false;
}

try {
  configureExtensionOrt();
} catch {
  /* backends may init after import — loadModel() will retry */
}

env.progressCallback = (progress) => {
  try {
    if (!progress || typeof progress !== "object") return;
    if (progress.status === "progress" && progress.total) {
      const loaded = progress.loaded ?? 0;
      const pct = Math.round((loaded / progress.total) * 100);
      loadProgress = `Downloading model… ${pct}%`;
      chrome.storage.local.set({ localLlmStatus: { state: "loading", progress: loadProgress } });
    } else if (progress.status === "done") {
      loadProgress = "Model ready";
    }
  } catch {
    /* ignore malformed progress payloads */
  }
};

async function loadModel() {
  if (generator) return generator;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    modelState = "loading";
    loadError = null;
    configureExtensionOrt();
    await chrome.storage.local.set({
      localLlmStatus: { state: "loading", model: MODEL_ID, progress: "Loading SmolLM2-360M…" },
    });

    try {
      generator = await pipeline("text-generation", MODEL_ID, {
        dtype: "q4",
        device: "wasm",
      });
      modelState = "ready";
      await chrome.storage.local.set({
        localLlmStatus: { state: "ready", model: MODEL_ID, progress: "" },
      });
      return generator;
    } catch (err) {
      modelState = "error";
      loadError = formatError(err);
      await chrome.storage.local.set({
        localLlmStatus: { state: "error", model: MODEL_ID, error: loadError },
      });
      loadPromise = null;
      throw err;
    }
  })();

  return loadPromise;
}

async function generateAnswer({ question, profile, eventTitle, fieldType, qType }) {
  const system = buildSystemPrompt(fieldType);
  const user = buildUserPrompt({ question, profile, eventTitle, fieldType });
  const prompt = buildChatPrompt(system, user);

  const pipe = await loadModel();
  const maxNew = fieldType === "textarea" ? 100 : 64;

  const outputs = await pipe(prompt, {
    max_new_tokens: maxNew,
    temperature: 0.35,
    top_p: 0.9,
    do_sample: true,
    return_full_text: false,
  });

  const raw =
    outputs?.[0]?.generated_text ??
    outputs?.generated_text ??
    (typeof outputs === "string" ? outputs : "");

  let answer = trimAnswer(raw, fieldType);
  if (!answer) {
    answer = ruleBasedFallback(profile, qType);
  }
  return answer;
}

/**
 * Constrained selection: pick one option from a fixed list.
 * Uses a short, greedy (deterministic) decode and validates the reply back to the list,
 * returning null when the model produces nothing usable.
 */
async function chooseOption({ question, options, profile, eventTitle }) {
  if (!Array.isArray(options) || !options.length) return null;

  const system = buildOptionSelectSystemPrompt();
  const user = buildOptionSelectUserPrompt({ question, options, profile, eventTitle });
  const prompt = buildChatPrompt(system, user);

  const pipe = await loadModel();
  const outputs = await pipe(prompt, {
    max_new_tokens: 8,
    temperature: 0.1,
    do_sample: false,
    return_full_text: false,
  });

  const raw =
    outputs?.[0]?.generated_text ??
    outputs?.generated_text ??
    (typeof outputs === "string" ? outputs : "");

  return parseOptionChoice(raw, options);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== "offscreen") return;

  if (message.type === "LOCAL_LLM_WARMUP") {
    loadModel()
      .then(() => sendResponse({ ok: true, state: modelState, model: MODEL_ID }))
      .catch((err) => sendResponse({ ok: false, error: formatError(err), state: modelState }));
    return true;
  }

  if (message.type === "LOCAL_LLM_STATUS") {
    sendResponse({
      state: modelState,
      model: MODEL_ID,
      progress: loadProgress,
      error: loadError,
    });
    return true;
  }

  if (message.type === "LOCAL_LLM_ANSWER") {
    // Constrained option-selection path (dropdowns / selects / radios). No text fallback —
    // the caller falls back to deterministic keyword matching when this returns null.
    if (Array.isArray(message.options) && message.options.length) {
      chooseOption(message)
        .then((answer) => sendResponse({ answer, source: "local-select", model: MODEL_ID }))
        .catch((err) => sendResponse({ answer: null, error: formatError(err) }));
      return true;
    }

    generateAnswer(message)
      .then((answer) => sendResponse({ answer, source: "local", model: MODEL_ID }))
      .catch((err) => {
        const fallback = ruleBasedFallback(message.profile, message.qType);
        if (fallback) {
          sendResponse({ answer: fallback, source: "rules", error: formatError(err) });
        } else {
          sendResponse({ answer: null, error: formatError(err) });
        }
      });
    return true;
  }
});
