/**
 * Run-control flags live in chrome.storage.session (service worker only).
 * Content scripts read the mirrored copy in chrome.storage.local.
 */

export async function initExtensionStorage() {
  try {
    if (chrome.storage.session?.setAccessLevel) {
      await chrome.storage.session.setAccessLevel({
        accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS",
      });
    }
  } catch (err) {
    console.warn("[Luma Agent] Could not widen session storage access:", err);
  }
}

export async function mirrorRunControlToLocal(overrides = {}) {
  let session = {};
  try {
    session = await chrome.storage.session.get([
      "runPaused",
      "runStopRequested",
      "runSkipRequested",
      "agentCursorActive",
      "runInProgress",
      "workTabId",
    ]);
  } catch {
    /* session may be unavailable during shutdown */
  }

  await chrome.storage.local.set({
    runControlMirror: {
      runPaused: Boolean(overrides.runPaused ?? session.runPaused),
      runStopRequested: Boolean(overrides.runStopRequested ?? session.runStopRequested),
      runSkipRequested: Boolean(overrides.runSkipRequested ?? session.runSkipRequested),
      agentCursorActive: Boolean(overrides.agentCursorActive ?? session.agentCursorActive),
      runInProgress: Boolean(overrides.runInProgress ?? session.runInProgress),
      workTabId: overrides.workTabId ?? session.workTabId ?? null,
      updatedAt: Date.now(),
    },
  });
}

export async function setSessionRunControl(patch) {
  await chrome.storage.session.set(patch);
  await mirrorRunControlToLocal();
}
