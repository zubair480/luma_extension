/**
 * Visual automation cursor — shows where the agent clicks and fills.
 */
let cursorRoot = null;
let cursorPointer = null;
let cursorRing = null;
let statusBar = null;
let fieldHighlight = null;
let cursorActive = false;
// Fast mode: the status bar and field highlight stay, the pointer animation and its waits go.
let cursorMotion = true;
let cursorX = window.innerWidth / 2;
let cursorY = window.innerHeight / 2;

function injectStyles() {
  if (document.getElementById("luma-agent-cursor-styles")) return;
  const style = document.createElement("style");
  style.id = "luma-agent-cursor-styles";
  style.textContent = `
    #luma-agent-cursor-root {
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 2147483646;
    }
    #luma-agent-cursor-pointer {
      position: fixed;
      left: 0;
      top: 0;
      width: 28px;
      height: 28px;
      margin: -4px 0 0 -4px;
      transform: translate(var(--lx, 0px), var(--ly, 0px));
      transition: transform 0.3s cubic-bezier(0.22, 1, 0.36, 1);
      filter: drop-shadow(0 2px 6px rgba(0,0,0,0.35));
      z-index: 2147483647;
    }
    #luma-agent-cursor-ring {
      position: fixed;
      left: 0;
      top: 0;
      width: 44px;
      height: 44px;
      margin: -22px 0 0 -22px;
      border: 2px solid #6366f1;
      border-radius: 50%;
      transform: translate(var(--lx, 0px), var(--ly, 0px)) scale(0.6);
      opacity: 0.85;
      transition: transform 0.3s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.2s;
      z-index: 2147483646;
    }
    #luma-agent-cursor-ring.luma-click {
      animation: luma-agent-click 0.35s ease-out;
    }
    @keyframes luma-agent-click {
      0% { transform: translate(var(--lx, 0px), var(--ly, 0px)) scale(0.6); opacity: 0.9; }
      50% { transform: translate(var(--lx, 0px), var(--ly, 0px)) scale(1.15); opacity: 0.5; }
      100% { transform: translate(var(--lx, 0px), var(--ly, 0px)) scale(0.6); opacity: 0.85; }
    }
    #luma-agent-status {
      position: fixed;
      top: 12px;
      left: 50%;
      transform: translateX(-50%);
      max-width: min(92vw, 520px);
      padding: 10px 16px;
      border-radius: 999px;
      background: rgba(15, 23, 42, 0.92);
      color: #f8fafc;
      font: 600 13px/1.3 system-ui, -apple-system, Segoe UI, sans-serif;
      box-shadow: 0 8px 24px rgba(0,0,0,0.25);
      border: 1px solid rgba(99, 102, 241, 0.55);
      z-index: 2147483647;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #luma-agent-field-highlight {
      position: fixed;
      border: 2px solid #6366f1;
      border-radius: 8px;
      background: rgba(99, 102, 241, 0.12);
      box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.15);
      transition: top 0.35s ease, left 0.35s ease, width 0.35s ease, height 0.35s ease, opacity 0.25s;
      opacity: 0;
      z-index: 2147483645;
    }
    #luma-agent-field-highlight.luma-visible {
      opacity: 1;
    }
  `;
  document.documentElement.appendChild(style);
}

function ensureCursorUi() {
  injectStyles();
  if (cursorRoot) return;

  cursorRoot = document.createElement("div");
  cursorRoot.id = "luma-agent-cursor-root";

  cursorRing = document.createElement("div");
  cursorRing.id = "luma-agent-cursor-ring";

  cursorPointer = document.createElement("div");
  cursorPointer.id = "luma-agent-cursor-pointer";
  cursorPointer.innerHTML = `
    <svg width="28" height="28" viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg">
      <path d="M4 2 L4 22 L10 16 L14 24 L17 23 L13 15 L20 15 Z" fill="#6366f1" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/>
    </svg>
  `;

  statusBar = document.createElement("div");
  statusBar.id = "luma-agent-status";
  statusBar.textContent = "Luma Agent";

  fieldHighlight = document.createElement("div");
  fieldHighlight.id = "luma-agent-field-highlight";

  cursorRoot.appendChild(fieldHighlight);
  cursorRoot.appendChild(cursorRing);
  cursorRoot.appendChild(cursorPointer);
  cursorRoot.appendChild(statusBar);
  document.documentElement.appendChild(cursorRoot);
  setCursorMotion(cursorMotion);
}

function setCursorMotion(on) {
  cursorMotion = Boolean(on);
  const display = cursorMotion ? "" : "none";
  if (cursorPointer) cursorPointer.style.display = display;
  if (cursorRing) cursorRing.style.display = display;
}

function setCursorPosition(x, y) {
  cursorX = x;
  cursorY = y;
  if (!cursorPointer || !cursorRing) return;
  const px = `${Math.round(x)}px`;
  const py = `${Math.round(y)}px`;
  cursorPointer.style.setProperty("--lx", px);
  cursorPointer.style.setProperty("--ly", py);
  cursorRing.style.setProperty("--lx", px);
  cursorRing.style.setProperty("--ly", py);
}

function elementCenter(el) {
  if (!el) return { x: cursorX, y: cursorY, rect: { width: 0, height: 0, left: 0, top: 0 } };
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 && rect.height <= 0) {
    return { x: cursorX, y: cursorY, rect };
  }
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    rect,
  };
}

function highlightElement(el) {
  if (!fieldHighlight || !el) return;
  const { rect } = elementCenter(el);
  fieldHighlight.style.left = `${rect.left - 4}px`;
  fieldHighlight.style.top = `${rect.top - 4}px`;
  fieldHighlight.style.width = `${rect.width + 8}px`;
  fieldHighlight.style.height = `${rect.height + 8}px`;
  fieldHighlight.classList.add("luma-visible");
}

function clearHighlight() {
  fieldHighlight?.classList.remove("luma-visible");
}

function enableAgentCursor(message = "Luma Agent running…") {
  ensureCursorUi();
  cursorActive = true;
  window.__lumaAgentCursorActive = true;
  cursorRoot.style.display = "block";
  setAgentStatus(message);
  setCursorPosition(cursorX, cursorY);
}

function disableAgentCursor() {
  cursorActive = false;
  window.__lumaAgentCursorActive = false;
  clearHighlight();
  if (cursorRoot) cursorRoot.style.display = "none";
}

function setAgentStatus(message) {
  if (!statusBar) return;
  statusBar.textContent = message || "Luma Agent";
}

async function moveCursorTo(el) {
  if (!el || !cursorActive) return;
  if (!cursorMotion) {
    el.scrollIntoView({ block: "center", inline: "nearest" });
    const { x, y } = elementCenter(el);
    setCursorPosition(x, y);
    return;
  }
  el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
  await new Promise((r) => setTimeout(r, 200));
  const { x, y } = elementCenter(el);
  setCursorPosition(x, y);
  await new Promise((r) => setTimeout(r, 300));
}

async function visualClick(el, message, opts = {}) {
  if (!el) return { ok: false, reason: "missing_element" };

  const checkFormScope = opts.checkFormScope !== false;
  if (
    typeof isUnsafeClickTarget === "function" &&
    isUnsafeClickTarget(el, { checkFormScope })
  ) {
    const href = typeof getLinkHref === "function" ? getLinkHref(el) : "";
    return { ok: false, reason: "unsafe_navigation", href, tag: el.tagName };
  }

  if (message) setAgentStatus(message);
  const quick = opts.quick || !cursorMotion;
  if (cursorActive) {
    if (quick) {
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
      const { x, y, rect } = elementCenter(el);
      if (rect.width > 0 || rect.height > 0) {
        setCursorPosition(x, y);
        highlightElement(el);
        await new Promise((r) => setTimeout(r, cursorMotion ? 100 : 30));
      }
    } else {
      await moveCursorTo(el);
      highlightElement(el);
      cursorRing.classList.remove("luma-click");
      void cursorRing.offsetWidth;
      cursorRing.classList.add("luma-click");
      await new Promise((r) => setTimeout(r, 140));
    }
  }

  const link = el.closest("a[href]");
  if (link && typeof isValidEventHref === "function" && !isValidEventHref(link.href)) {
    return { ok: false, reason: "unsafe_anchor", href: link.href, tag: el.tagName };
  }

  if (typeof simulatePointerClick === "function") simulatePointerClick(el);
  else if (typeof el.click === "function") el.click();
  await new Promise((r) => setTimeout(r, quick ? (cursorMotion ? 80 : 40) : 120));
  return { ok: true, tag: el.tagName, text: (el.textContent || el.value || "").trim().slice(0, 80) };
}

async function visualFillField(el, message) {
  if (!el) return;
  if (message) setAgentStatus(message);
  if (cursorActive) {
    await moveCursorTo(el);
    highlightElement(el);
    if (cursorMotion) await new Promise((r) => setTimeout(r, 120));
  }
}

function trimStatus(text, max = 48) {
  const t = (text || "").replace(/\*+/g, "").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function buildRunStatusMessage(runState) {
  if (!runState || runState.phase === "idle") return "Luma Agent working…";
  if (runState.phase === "discovering") return "Discovering SF events…";
  if (runState.phase === "registering" && runState.event) {
    return `Event ${runState.current}/${runState.total}: ${trimStatus(runState.event.title, 42)}`;
  }
  if (runState.phase === "done") return "Run complete";
  return "Luma Agent working…";
}

async function restoreCursorIfRunActive() {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return;
  const { runControlMirror = {}, runState } = await chrome.storage.local.get([
    "runControlMirror",
    "runState",
  ]);
  if (!runControlMirror.agentCursorActive) return;
  enableAgentCursor(buildRunStatusMessage(runState));
}
