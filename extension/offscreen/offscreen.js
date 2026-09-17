/**
 * On-device SmolLM2-360M-Instruct via Transformers.js (runs in offscreen document).
 */
import { pipeline, env } from "@huggingface/transformers";
import {
  buildSystemPrompt,
  buildUserPrompt,
  buildOptionSelectSystemPrompt,
  buildOptionSelectUserPrompt,
  parseOptionChoice,
  trimAnswer,
} from "../lib/prompt-utils.js";

/**
 * Two model tiers. With WebGPU, Qwen2.5-0.5B-Instruct (about 480 MB, q4f16) — noticeably better
 * at answering a form question in one grounded sentence. Without a GPU, SmolLM2-360M (q4, WASM)
 * keeps the feature working on any machine.
 */
const GPU_MODEL_ID = "onnx-community/Qwen2.5-0.5B-Instruct";
const CPU_MODEL_ID = "HuggingFaceTB/SmolLM2-360M-Instruct";
let MODEL_ID = CPU_MODEL_ID;

env.useBrowserCache = true;
env.allowLocalModels = false;

let generator = null;
let loadPromise = null;
let modelState = "idle";
let loadError = null;
let loadProgress = "";
let deviceUsed = null;

/** WebGPU when the offscreen document can get an adapter; otherwise single-threaded WASM. */
async function pickDevice() {
  try {
    if (navigator.gpu && (await navigator.gpu.requestAdapter())) return "webgpu";
  } catch {
    /* no adapter */
  }
  return "wasm";
}

/**
 * Offscreen documents get chrome.runtime only — no chrome.storage. Status goes to the background
 * as a message and is written to storage there. Never throws: status is best-effort.
 */
function reportStatus(status) {
  try {
    if (chrome.storage?.local?.set) {
      Promise.resolve(chrome.storage.local.set({ localLlmStatus: status })).catch(() => {});
      return;
    }
  } catch {
    /* fall through to messaging */
  }
  try {
    chrome.runtime.sendMessage({ type: "LOCAL_LLM_STATUS_UPDATE", status }, () => void chrome.runtime.lastError);
  } catch {
    /* background may be asleep; the next status will get through */
  }
}

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
      reportStatus({ state: "loading", model: MODEL_ID, progress: loadProgress });
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
    reportStatus({ state: "loading", model: MODEL_ID, progress: "Loading SmolLM2-360M…" });

    try {
      const preferred = await pickDevice();
      const attempts =
        preferred === "webgpu"
          ? [[GPU_MODEL_ID, "webgpu", "q4"], [CPU_MODEL_ID, "webgpu", "q4f16"], [CPU_MODEL_ID, "wasm", "q4"]]
          : [[CPU_MODEL_ID, "wasm", "q4"]];
      let lastErr = null;
      for (const [modelId, device, dtype] of attempts) {
        try {
          MODEL_ID = modelId;
          reportStatus({ state: "loading", model: modelId, progress: `Loading ${modelId.split("/")[1]} (${device})…` });
          generator = await pipeline("text-generation", modelId, { dtype, device });
          deviceUsed = device;
          break;
        } catch (err) {
          lastErr = err;
          generator = null;
        }
      }
      if (!generator) throw lastErr || new Error("Model failed to load");
      modelState = "ready";
      reportStatus({ state: "ready", model: MODEL_ID, progress: "", device: deviceUsed });
      return generator;
    } catch (err) {
      modelState = "error";
      loadError = formatError(err);
      reportStatus({ state: "error", model: MODEL_ID, error: loadError });
      loadPromise = null;
      throw err;
    }
  })();

  return loadPromise;
}

/** The pipeline returns a string, an array of messages, or a wrapper, depending on the input form. */
function extractGenerated(outputs) {
  const first = Array.isArray(outputs) ? outputs[0] : outputs;
  const generated = first?.generated_text ?? first;
  if (typeof generated === "string") return generated;
  if (Array.isArray(generated)) {
    const last = generated[generated.length - 1];
    return typeof last === "string" ? last : last?.content || "";
  }
  return typeof generated?.content === "string" ? generated.content : "";
}

async function generateAnswer({ question, profile, eventTitle, fieldType, qType }) {
  const system = buildSystemPrompt(fieldType);
  const user = buildUserPrompt({ question, profile, eventTitle, fieldType });
  const messages = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  const pipe = await loadModel();
  // Short and greedy with a light repetition penalty: one grounded sentence is what a
  // registration form wants, and sampling is where small models drift into invented topics.
  const maxNew = fieldType === "textarea" ? 80 : 48;

  const outputs = await pipe(messages, {
    max_new_tokens: maxNew,
    do_sample: false,
    repetition_penalty: 1.12,
    no_repeat_ngram_size: 3,
    return_full_text: false,
  });

  const raw = extractGenerated(outputs);

  // No stand-in here: an empty or garbled answer is reported as such so the caller can decide.
  const answer = trimAnswer(raw, fieldType);
  if (!answer || looksGarbled(answer, question)) return null;
  // A form answer is written as "I". Output that talks about the attendee by name has drifted
  // into the third person (and small models then invent titles for that name): discard it.
  const names = [profile?.first_name, profile?.last_name].map((n) => String(n || "").trim().toLowerCase()).filter((n) => n.length >= 3);
  const lower = answer.toLowerCase();
  if (names.some((n) => lower.includes(n))) return null;
  return answer;
}

/**
 * A small model on a misbehaving backend can emit token salad ("| | | |", "Probe probe probe",
 * echoes of the prompt). Such output must never reach a form.
 */
function looksGarbled(text, question = "") {
  const t = String(text || "").trim();
  if (t.length < 8) return true;
  const words = t.split(/\s+/);
  const alphaWords = words.filter((w) => /^[A-Za-z][A-Za-z'’-]*[.,!?;:)]?$/.test(w));
  if (alphaWords.length / words.length < 0.75) return true;
  const lower = alphaWords.map((w) => w.toLowerCase().replace(/[^a-z']/g, ""));
  const unique = new Set(lower);
  if (lower.length >= 8 && unique.size / lower.length < 0.55) return true;
  if (/^(question|event|attendee|profile|answer)\s*:/i.test(t)) return true;
  if (/[|#*_=]{2,}/.test(t)) return true;
  const firstQ = String(question || "").toLowerCase().slice(0, 40);
  if (firstQ && t.toLowerCase().startsWith(firstQ)) return true;
  return false;
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
  const messages = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  const pipe = await loadModel();
  const outputs = await pipe(messages, {
    max_new_tokens: 8,
    do_sample: false,
    return_full_text: false,
  });

  const raw = extractGenerated(outputs);

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
      device: deviceUsed,
    });
    return true;
  }

  if (message.type === "LOCAL_LLM_ENV") {
    (async () => ({
      gpu: Boolean(navigator.gpu),
      adapter: Boolean(navigator.gpu && (await navigator.gpu.requestAdapter().catch(() => null))),
      threads: navigator.hardwareConcurrency || null,
      crossOriginIsolated: Boolean(globalThis.crossOriginIsolated),
      device: deviceUsed,
    }))().then(sendResponse);
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
      .then((answer) => sendResponse({ answer, source: answer ? "local" : "none", model: MODEL_ID, device: deviceUsed }))
      .catch((err) => sendResponse({ answer: null, source: "none", error: formatError(err) }));
    return true;
  }
});
