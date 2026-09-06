/**
 * Bridge from the service worker to the offscreen on-device model.
 */

const OFFSCREEN_PATH = "offscreen/offscreen.html";

export const LOCAL_MODEL_ID = "onnx-community/SmolLM2-360M-Instruct";

export async function hasOffscreenDocument() {
  if (!chrome.offscreen) return false;
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  return contexts.some((c) => c.documentUrl?.includes("offscreen/offscreen.html"));
}

export async function ensureOffscreenDocument() {
  if (!chrome.offscreen) {
    throw new Error("Offscreen API unavailable — update Chrome to 109+");
  }
  if (await hasOffscreenDocument()) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["WORKERS"],
    justification: "Run SmolLM2-360M on-device for registration form answers (no cloud API)",
  });

  await sleep(300);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function sendToOffscreen(message, timeoutMs = 120000) {
  await ensureOffscreenDocument();

  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ target: "offscreen", ...message }, (res) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(res);
        });
      });
      if (response == null) {
        throw new Error("Offscreen AI did not respond — reload the extension at chrome://extensions");
      }
      return response;
    } catch (err) {
      lastError = err;
      if (!/receiving end does not exist|could not establish connection/i.test(err.message)) {
        throw err;
      }
      await sleep(400);
    }
  }

  throw lastError || new Error("Local AI timed out — model may still be downloading");
}

export async function warmupLocalModel() {
  try {
    const result = await sendToOffscreen({ type: "LOCAL_LLM_WARMUP" }, 180000);
    return result?.ok === false
      ? { ok: false, error: result.error || "Model warmup failed", state: result.state }
      : { ok: true, state: result?.state || "ready", model: result?.model || LOCAL_MODEL_ID };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

export async function askLocalModel(payload) {
  const response = await sendToOffscreen({
    type: "LOCAL_LLM_ANSWER",
    ...payload,
  });
  if (response?.error) throw new Error(response.error);
  return response;
}

export async function getLocalModelStatus() {
  try {
    return await sendToOffscreen({ type: "LOCAL_LLM_STATUS" }, 5000);
  } catch (err) {
    return { state: "error", error: err.message };
  }
}
