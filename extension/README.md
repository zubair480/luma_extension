# Luma Agent — Chrome Extension

One click scans **four curated Bay Area event sources**, dedupes and verifies what it finds against
the Luma API, then auto-registers you for the free in-person ones using your saved profile.

## Sources

| Source | How it is read | Notes |
|--------|----------------|-------|
| [Luma San Francisco](https://luma.com/sf) | Tab + content script | Citywide feed |
| [Bond AI](https://luma.com/genai-sf) | Tab + content script | SF & Bay Area AI calendar |
| [Cerebral Valley](https://cerebralvalley.ai/events?locations=BAY_AREA) | Tab + content script | Keeps outbound Luma links only |
| [Bay Area Founders Club](https://bayareafoundersclub.substack.com/) | RSS feed, no tab | Weekly "Bay Area Events For The Week Of …" post, ~60 Luma links |

The Founders Club newsletter publishes Saturday evening PT. Its post body arrives complete inside
the public RSS feed, so the extension reads it with a single background fetch — no tab, no scroll,
no login. The parsed result is cached against the post's `pubDate`, so repeat runs in the same week
skip the download.

Links from every source are canonicalized (`lu.ma` → `luma.com`), deduped by slug, then verified
one at a time against the Luma API. Verification is interleaved round-robin across sources and
ranked on that interleaved position, so a source contributing 60 links cannot crowd out one
contributing 5.

## Install (automatic)

**Double-click `install.bat`** in this folder, or run:

```powershell
cd extension
.\install.ps1 -Launch
```

This creates a desktop shortcut **"Chrome with Luma Agent"** that opens Chrome with the extension already loaded — no need to visit `chrome://extensions` or click Load unpacked.

> If Chrome is already open, close it first, then use the new shortcut (Chrome only loads extensions from `--load-extension` on startup).

### Manual install (alternative)

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select this `extension/` folder

## Install (2 minutes)

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select this folder: `extension/`
5. Pin the **Luma Agent** icon to your toolbar

## Accepting invitations

Click **Accept my invitations**. The agent opens `luma.com/home`, collects every event you have a
pending invitation to, and opens each one through the *same* pipeline that handles discovered
events — so an invitation is only accepted if it passes every filter:

- free (paid events and paid checkouts are skipped)
- in person, in the Bay Area (online/virtual events are skipped)
- not women-only
- not sold out, ended, cancelled, or closed
- not already registered, pending, or waitlisted
- clear of the excluded keywords in your profile

**The agent never declines anything.** An invitation that fails a check is left pending so you can
decide yourself. Decline controls are filtered out of every clickable lookup in the content script,
so no code path can click one — there is a regression test for exactly this.

Invitations already handled in a previous run are skipped without reopening the tab.

## How a run flows

A run is a three-stage pipeline, and every stage starts as soon as it has input:

```text
sources ──links──▶ verifier ──confirmed events──▶ registrar
 (4, parallel)      (serial, 1.2s gap)             (one tab registers, one preloads)
```

1. **Sources.** The four scans run in parallel and each pushes its Luma links into the verifier
   the moment it has them. The Founders Club feed lands in about a second, the two Luma feeds in
   a few seconds, and Cerebral Valley's direct links arrive before its detail pages are resolved.
2. **Verifier.** Takes links round-robin across sources, checks each against the Luma API on the
   shared rate-limited lane, and hands every registerable event to the registrar the moment it is
   confirmed. It stops early once there is enough verified inventory for the batch.
3. **Registrar.** Starts immediately and opens the first event as soon as one is confirmed —
   typically 10–20 seconds into the run, while the other sources are still scanning. Source tabs
   are reused as the work tab and the preload tab when they free up.

The panel shows the whole pipeline live: `sources 2/4 · 12/40 checked · 6 ready` while scanning,
then `3/9+ · 6 ready · 31/58 checked` while registering (the `+` means verification is still
adding events).

## Performance

| Cost | Handling |
|------|----------|
| Verifying scraped links against the Luma API (serialized, 1.2s minimum gap) | Overlapped with the source scans and the registration gaps rather than run as a blocking pass. Verdicts are cached per slug for 6 hours, so repeat runs and cross-source overlap skip both the request and its gap. Transient failures are never cached. |
| Loading the next event page | Two tabs alternate. While the run waits out the gap after one event, the next event's page loads in the other tab, so moving on is a tab switch instead of a load followed by a pause. Page loads keep their one-per-gap spacing. |
| Waiting for the page and the registration modal | Polled until the content script answers (400ms floor, 3s ceiling), and the modal / sign-in prompt / result text is polled every 100–250ms instead of fixed 1.2s and 1.8s sleeps. |
| Cerebral Valley detail pages | Resolved four at a time with background requests to the page HTML; only pages whose HTML lacks the link fall back to a tab load, and those are capped. Bounded to that source's fair share of the batch. |
| On-device model cold start (up to two minutes) | Warm-up begins the moment a run starts, so it overlaps discovery instead of the first custom question. |

The gap between registrations (`REGISTRATION_DELAY_MS`, 12s) is deliberate and is **not** tuned
down: Luma rate limits end a run, and the recovery costs far more than the delay saves.

## Field filling

Which profile value goes into which control is decided in this order:

1. The control's own attributes (`type=tel`, `autocomplete=email`, `inputmode`, `name`). These win
   over any nearby text, and a control typed this way never receives a saved free-text answer.
2. The label, found as the nearest text that *precedes* the control without another control in
   between, so a shared parent never lends the first question's label to every field.
3. Saved answers, matched by whole-question overlap rather than substring, so a saved "Company"
   does not fill "Company website".
4. The LLM, only for free-text questions the profile cannot answer.

Search boxes and read-only triggers inside custom dropdowns are never treated as text fields, and
every value is shape-checked against the control before it is written (a phone number cannot land
in an email or free-text field). `npm run test:fields` covers these cases.

## Use

1. **Sign in to [lu.ma](https://lu.ma)** in Chrome (if not already)
2. Click the **Luma Agent** extension icon
3. Click **Scan all 4 & get started**

The extension will:
- Scan all four sources concurrently and dedupe the results
- Open each event in a new tab
- Auto-fill your profile and submit registration
- Show live progress in the popup

## Your profile

Pre-loaded with your details. Edit anytime via **Your profile** in the popup.

## Notes

- Only **free** events are registered (paid events are skipped)
- Events requiring host approval are skipped
- ~6 second delay between registrations to be polite
- Keep the popup open to watch progress, or check the badge on the extension icon

## Auto-reload during development

Chrome does **not** auto-update unpacked extensions when you edit files. Two options:

### Option A — Hot reload (recommended)

```bash
cd extension
npm install
npm run dev
```

Leave that terminal running. Load the extension **once** in `chrome://extensions`, then edit any file — Chrome reloads the extension automatically within ~1 second.

How it works: a local file watcher sends a reload signal over WebSocket; `dev-reload.js` calls `chrome.runtime.reload()`.

Before publishing to the Chrome Web Store, set `DEV_RELOAD = false` in `dev-reload.js`.

### Option B — Keyboard shortcut

Install the [Extensions Reloader](https://chromewebstore.google.com/detail/extensions-reloader/fimgfedafeadlieiabdeeaodndnlbhid) extension and assign a hotkey (e.g. Ctrl+Shift+R). Press it after each code change.

---

## Auto-update in production (without manual reload)

| Method | How it works | Best for |
|--------|--------------|----------|
| **Chrome Web Store (unlisted)** | Upload a new `.zip` when you change version in `manifest.json`. Chrome auto-updates all installs within hours. | Easiest real auto-update |
| **Self-hosted `update_url`** | Host a CRX + `updates.xml` on your server. Requires enterprise policy or special install flow — not practical for personal use. | Teams / enterprise |
| **Dev hot reload (`npm run dev`)** | Instant reload while coding. Only for your machine. | Development |

For personal use, the practical combo is:

1. **While building** → `npm run dev` (instant reload)
2. **When sharing** → publish unlisted on Chrome Web Store (users get automatic updates when you bump `"version"` in `manifest.json`)

You only load unpacked **once**. After that, dev reload or Web Store updates handle the rest.


| Issue | Fix |
|-------|-----|
| "Please sign in to Luma first" | Log in at lu.ma, then run again |
| "No free events found" | Try again later — event availability changes |
| Registration failed on one event | Check the open tab; some events have custom forms |

## Files

```
extension/
  manifest.json      Extension config
  background.js      Event discovery + batch orchestration
  content.js         Auto-fill & register on lu.ma pages
  popup.html/js/css  One-click UI
  lib/               Discovery API + constants
```
