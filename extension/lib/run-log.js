/** Run log entries persisted in chrome.storage.local runState.logs */

export const MAX_RUN_LOGS = 500;

export const RUN_STEPS = {
  DISCOVER: "discover",
  NAVIGATE: "navigate",
  PREFLIGHT: "preflight",
  TICKET: "ticket",
  OPEN_FORM: "open_form",
  FILL: "fill",
  VALIDATE: "validate",
  SUBMIT: "submit",
  VERIFY: "verify",
  SKIP: "skip",
  DONE: "done",
  ERROR: "error",
};

export function createLogEntry(step, message, level = "info", meta = {}) {
  return {
    ts: new Date().toISOString(),
    step,
    level,
    message,
    ...meta,
  };
}

export function trimRunLogs(logs = [], max = MAX_RUN_LOGS) {
  return logs.length > max ? logs.slice(-max) : logs;
}

export function formatRunLogsAsText(runState = {}) {
  const lines = [];
  const phase = runState.phase || "unknown";
  lines.push(`Luma Agent run log — phase: ${phase}`);
  if (runState.currentEvent?.title) {
    lines.push(`Current event: ${runState.currentEvent.title}`);
    lines.push(`URL: ${runState.currentEvent.url || ""}`);
  }
  if (runState.current && runState.total) {
    lines.push(`Progress: ${runState.current}/${runState.total}`);
  }
  lines.push("---");

  for (const entry of runState.logs || []) {
    const time = entry.ts ? new Date(entry.ts).toISOString() : "";
    const event = entry.eventTitle ? `[${entry.eventTitle}] ` : "";
    const url = entry.url ? ` @ ${entry.url}` : "";
    const detail = entry.href ? ` href=${entry.href}` : entry.target ? ` target="${entry.target}"` : "";
    lines.push(`${time} [${entry.step || "info"}] ${entry.level || "info"} ${event}${entry.message || ""}${url}${detail}`);
  }

  if (runState.results?.length) {
    lines.push("---");
    lines.push("Results:");
    for (const r of runState.results) {
      lines.push(`- ${r.event?.title || "?"}: ${r.message || r.status || (r.success ? "ok" : "fail")}`);
    }
  }

  if (runState.error) {
    lines.push("---");
    lines.push(`Error: ${runState.error}`);
  }

  return lines.join("\n");
}
