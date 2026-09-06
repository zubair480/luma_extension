/**
 * Dev-only hot reload. Remove or leave disabled for production builds.
 *
 * 1. Run:  npm run dev   (from extension/ folder)
 * 2. Load the extension once in chrome://extensions
 * 3. Edit files — extension reloads automatically
 */
(function initDevHotReload() {
  const DEV_RELOAD = false; // set true only during local dev (npm run dev)

  if (!DEV_RELOAD) return;

  const WS_URL = "ws://127.0.0.1:9090";
  let socket;
  let retryDelay = 1000;

  function connect() {
    try {
      socket = new WebSocket(WS_URL);

      socket.onopen = () => {
        console.log("[Luma Agent] Dev hot-reload connected");
        retryDelay = 1000;
      };

      socket.onmessage = (event) => {
        if (event.data === "reload") {
          console.log("[Luma Agent] Reloading…");
          chrome.runtime.reload();
        }
      };

      socket.onclose = () => {
        setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 1.5, 10000);
      };

      socket.onerror = () => socket.close();
    } catch {
      setTimeout(connect, retryDelay);
    }
  }

  connect();
})();
