/**
 * Read run-control flags mirrored to local storage (content scripts cannot use session storage).
 */
async function readRunControlMirror() {
  if (typeof chrome === "undefined" || !chrome.storage?.local) {
    return {
      runPaused: false,
      runStopRequested: false,
      runSkipRequested: false,
      agentCursorActive: false,
      runInProgress: false,
    };
  }

  try {
    const { runControlMirror = {} } = await chrome.storage.local.get("runControlMirror");
    return {
      runPaused: Boolean(runControlMirror.runPaused),
      runStopRequested: Boolean(runControlMirror.runStopRequested),
      runSkipRequested: Boolean(runControlMirror.runSkipRequested),
      agentCursorActive: Boolean(runControlMirror.agentCursorActive),
      runInProgress: Boolean(runControlMirror.runInProgress),
    };
  } catch {
    return {
      runPaused: false,
      runStopRequested: false,
      runSkipRequested: false,
      agentCursorActive: false,
      runInProgress: false,
    };
  }
}
