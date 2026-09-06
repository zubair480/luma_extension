/** Regression tests for pause/stop/skip state shared across extension contexts. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canSkipRunState, getCurrentRunEvent } from "../lib/run-control-state.js";
import { setSessionRunControl } from "../lib/run-control-mirror.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sessionState = {};
let localPatch = {};

globalThis.chrome = {
  storage: {
    session: {
      async get(keys) {
        return Object.fromEntries(keys.map((key) => [key, sessionState[key]]));
      },
      async set(patch) {
        Object.assign(sessionState, patch);
      },
    },
    local: {
      async get(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(list.map((key) => [key, localPatch[key]]));
      },
      async set(patch) {
        localPatch = { ...localPatch, ...patch };
      },
    },
  },
};

await setSessionRunControl({
  runInProgress: true,
  runPaused: false,
  runStopRequested: false,
  runSkipRequested: true,
});

assert.equal(localPatch.runControlMirror.runSkipRequested, true, "skip request must be mirrored");

const helperSource = fs.readFileSync(path.join(__dirname, "../lib/run-control-content.js"), "utf8");
const { readRunControlMirror } = new Function(
  "chrome",
  `${helperSource}\nreturn { readRunControlMirror };`
)(globalThis.chrome);
const contentControl = await readRunControlMirror();
assert.equal(contentControl.runSkipRequested, true, "event page must see a mirrored skip request");

const queuedState = {
  phase: "registering",
  current: 0,
  total: 2,
  upcoming: [{ title: "First" }, { title: "Second" }],
};
assert.equal(canSkipRunState(queuedState), false, "skip stays disabled before the first event starts");

const activeState = {
  ...queuedState,
  current: 1,
  currentEvent: { title: "First", slug: "first" },
};
assert.equal(canSkipRunState(activeState), true, "current event can be skipped");
assert.equal(getCurrentRunEvent(activeState).slug, "first");
assert.equal(
  canSkipRunState({ ...activeState, skipRequested: true }),
  false,
  "duplicate skip requests stay disabled"
);
assert.equal(
  canSkipRunState({ ...activeState, currentEvent: null }),
  false,
  "skip stays disabled between events"
);

const recoveredState = {
  phase: "registering",
  current: 1,
  total: 2,
  events: [
    { title: "First", slug: "first" },
    { title: "Second", slug: "second" },
  ],
};
assert.equal(
  getCurrentRunEvent(recoveredState)?.slug,
  "first",
  "missing currentEvent is recovered from the active run index"
);
assert.equal(canSkipRunState(recoveredState), true, "recovered current event can be skipped");
assert.equal(
  getCurrentRunEvent({ ...recoveredState, currentEvent: null }),
  null,
  "explicit null still marks the gap between events"
);

const contentSource = fs.readFileSync(path.join(__dirname, "../content.js"), "utf8");
assert.match(
  contentSource,
  /ctrl\.runStopRequested \|\| ctrl\.runSkipRequested/,
  "content registration must abort for either Stop or Skip"
);

console.log("Run-control regression tests passed");
