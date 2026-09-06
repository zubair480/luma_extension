/**
 * Cerebral Valley discovery — runs on cerebralvalley.ai. Harvests Luma event links from the
 * events list (and from /e/<slug> detail pages) so the existing Luma registration pipeline can
 * process them. Self-contained: does NOT depend on the Luma content-script stack (which only
 * loads on lu.ma / luma.com).
 *
 * Messages handled:
 *   PING            -> { ok:true, cv:true }
 *   CV_HARVEST      -> scroll-load the events list, return { luma:[urls], cvDetail:[{slug,url,title}], counts }
 *   CV_EXTRACT_LUMA -> on a /e/<slug> detail page, return { luma:url|null, platform, title }
 */
(function () {
  if (window.__cvDiscoveryLoaded) return;
  window.__cvDiscoveryLoaded = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const NON_EVENT = new Set([
    "user", "calendar", "discover", "signin", "login", "home", "pricing", "help", "sf",
    "create", "app", "settings", "about",
  ]);

  /** Return a canonical Luma slug if href is a direct lu.ma / luma.com event link, else null. */
  function lumaSlugFromHref(href) {
    try {
      const u = new URL(href, location.href);
      const host = u.hostname.replace(/^www\./, "");
      if (host !== "lu.ma" && host !== "luma.com") return null;
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts.length !== 1) return null;
      const slug = parts[0];
      if (slug.length < 2) return null;
      if (/^(usr|evt|cal)-/i.test(slug)) return null;
      if (NON_EVENT.has(slug.toLowerCase())) return null;
      if (!/^[\w-]+$/.test(slug)) return null;
      return slug;
    } catch {
      return null;
    }
  }

  function classifyHost(href) {
    try {
      const h = new URL(href, location.href).hostname.replace(/^www\./, "");
      if (h === "lu.ma" || h === "luma.com") return "luma";
      if (h.endsWith("meetup.com")) return "meetup";
      if (h.endsWith("eventbrite.com") || h.endsWith("eventbrite.co")) return "eventbrite";
      if (h.endsWith("partiful.com")) return "partiful";
      if (h === location.hostname.replace(/^www\./, "")) return "cv";
      return "other";
    } catch {
      return "other";
    }
  }

  /** Return the CV detail-page slug for cerebralvalley.ai/e/<slug> (or /events/<slug>), else null. */
  function cvEventSlug(href) {
    try {
      const u = new URL(href, location.href);
      if (u.hostname.replace(/^www\./, "") !== location.hostname.replace(/^www\./, "")) return null;
      const m = u.pathname.match(/^\/(?:e|events)\/([a-zA-Z0-9._-]+)\/?$/);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }

  async function scrollToLoadAll() {
    let stable = 0;
    let last = -1;
    for (let i = 0; i < 30 && stable < 3; i++) {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
      await sleep(700);
      const count = document.querySelectorAll("a[href]").length;
      if (count === last) stable++;
      else {
        stable = 0;
        last = count;
      }
    }
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  function collectLinks() {
    const luma = new Set();
    const cvDetail = new Map(); // slug -> { slug, url, title }
    const counts = { luma: 0, meetup: 0, eventbrite: 0, partiful: 0, cv: 0, other: 0 };

    for (const a of document.querySelectorAll("a[href]")) {
      const href = a.href;
      const kind = classifyHost(href);
      counts[kind] = (counts[kind] || 0) + 1;

      const slug = lumaSlugFromHref(href);
      if (slug) {
        luma.add(`https://luma.com/${slug}`);
        continue;
      }

      const cvSlug = cvEventSlug(href);
      if (cvSlug && !cvDetail.has(cvSlug)) {
        const title = (a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120);
        cvDetail.set(cvSlug, { slug: cvSlug, url: `${location.origin}/e/${cvSlug}`, title });
      }
    }

    return { luma: [...luma], cvDetail: [...cvDetail.values()], counts };
  }

  async function harvestList() {
    await scrollToLoadAll();
    return collectLinks();
  }

  function pageTitle() {
    return (document.querySelector("h1")?.textContent || document.title || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 140);
  }

  /** On a CV /e/<slug> detail page: find the outbound Luma link, or detect another platform. */
  function extractLumaFromDetail() {
    for (const a of document.querySelectorAll("a[href]")) {
      const slug = lumaSlugFromHref(a.href);
      if (slug) return { luma: `https://luma.com/${slug}`, platform: "luma", title: pageTitle() };
    }
    for (const a of document.querySelectorAll("a[href]")) {
      const k = classifyHost(a.href);
      if (k === "meetup" || k === "eventbrite" || k === "partiful") {
        return { luma: null, platform: k, title: pageTitle() };
      }
    }
    const text = document.body?.innerText || "";
    const m = text.match(/https?:\/\/(?:lu\.ma|luma\.com)\/[\w-]+/);
    if (m) {
      const s = lumaSlugFromHref(m[0]);
      if (s) return { luma: `https://luma.com/${s}`, platform: "luma", title: pageTitle() };
    }
    return { luma: null, platform: "unknown", title: pageTitle() };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== "string") return false;
    if (msg.type === "PING") {
      sendResponse({ ok: true, cv: true });
      return true;
    }
    if (msg.type === "CV_HARVEST") {
      harvestList()
        .then(sendResponse)
        .catch((e) => sendResponse({ luma: [], cvDetail: [], counts: {}, error: e.message }));
      return true;
    }
    if (msg.type === "CV_EXTRACT_LUMA") {
      try {
        sendResponse(extractLumaFromDetail());
      } catch (e) {
        sendResponse({ luma: null, platform: "error", error: e.message });
      }
      return true;
    }
    return false;
  });
})();
