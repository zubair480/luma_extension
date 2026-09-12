# Luma Agent — Chrome Extension

One click scans **four curated Bay Area event sources**, dedupes and verifies what it finds against
the Luma API, then auto-registers you for the free in-person ones using your saved profile.

## Sources

| Source | How it is read | Notes |
|--------|----------------|-------|
| [Luma San Francisco](https://luma.com/sf) | Tab + content script | Citywide feed |
| [Bond AI](https://luma.com/genai-sf) | Tab + content script | SF & Bay Area AI calendar |
| [Cerebral Valley](https://cerebralvalley.ai/events?locations=BAY_AREA) | Public JSON API, no tab | Keeps outbound Luma links only; falls back to a tab scan if the API is unavailable |
| [Bay Area Founders Club](https://bayareafoundersclub.substack.com/) | RSS feed, no tab | Weekly "Bay Area Events For The Week Of …" post, ~60 Luma links |

The Founders Club newsletter publishes Saturday evening PT. Its post body arrives complete inside
the public RSS feed, so the extension reads it with a single background fetch — no tab, no scroll,
no login. The parsed result is cached against the post's `pubDate`, so repeat runs in the same week
skip the download.

Only today's and upcoming events are queued. An event is dropped once it has ended; an event with
no end time is dropped once its start date is before today, so something that started this
morning is still registerable this afternoon. The check runs on every path (API lookup, feed page
data, cached verdicts) and once more right before a page is opened.

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
   the moment it has them. The Founders Club feed and the Cerebral Valley API land in about a
   second each, and the two Luma feeds in a few seconds — with their first page of cards already
   verified from page data.
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
| Cerebral Valley | Read from `api.cerebralvalley.ai/v1/public/event/pull`, the same endpoint the events page renders from: two or three GET requests return every listed event with its outbound link, so no tab, scroll loop, or detail-page hop is needed. If the endpoint fails, the tab-based scanner runs exactly as before. |
| Luma feed pages | The first page of cards on `luma.com/sf` and `luma.com/genai-sf` ships as full API entries in the page data. Those are verified straight from the page with no request, so the first events are ready the moment the feed scan finishes; only scrolled-in cards need a lookup. |
| On-device model cold start (up to two minutes) | Warm-up begins the moment a run starts, so it overlaps discovery instead of the first custom question. |
| Free-text questions answered by the model | Every model-answered question on a form is fired at once when the form is scanned, so answers are produced while the typed fields are filled. Local-model requests are queued on one lane (the WASM pipeline is single-threaded); cloud providers run in parallel. |
| Lookups for events already handled | Slugs in the history exclusion index, and feed cards already marked Going or Pending, are dropped before verification instead of after a 1.2s lookup. |
| Cursor animation (about half a second per field) | **Fast mode** in the panel keeps the status bar and field highlight but skips the pointer motion and its waits. Applies from the next event. |

### Pacing

Luma rate-limits page loads, so spacing is measured **between page loads** rather than as a fixed
pause after each registration. `REGISTRATION_DELAY_MS` (12s) is the minimum spacing; the next
event's page is preloaded in the second tab as soon as that spacing has elapsed — usually while the
current registration is still running — and the loop moves on the moment the current one finishes.
A registration that takes longer than the spacing therefore costs no extra wait at all. The first
time Luma asks us to slow down, the spacing doubles (up to 60s) for the rest of the run.

A 30-second keep-alive alarm runs for the duration of a run so Manifest V3 does not suspend the
background worker mid-batch.

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

### Luma's form, as measured

These facts were established against live Luma registration forms (see the `probe:*` scripts,
which open a real form anonymously, run the fill pipeline, and never submit) and the code depends
on them:

- The form is not a `role="dialog"`. It is a `<form class="registration-form-container">` inside a
  glass overlay, and `<body>` gains a `…modal-open` class. The container lookup never returns
  the page root; matching `[class*="modal"]` on the body was the root cause of dropdown option
  discovery scanning the whole form and mistaking other questions' labels for options.
- Labels contain zero-width spaces (`Email​`); `cleanLabel` strips them so texts compare.
- A single-select is `<input role="combobox" aria-haspopup="listbox" aria-controls="…">` whose
  `value` becomes the chosen option. A multi-select is a `<div role="combobox">` whose text gains
  the chosen options. Both name their listbox with `aria-controls`; that listbox is the only
  source of options.
- The closed listbox stays mounted and interactable. Whether a list is open is read from the
  combobox's `aria-expanded`, never from the listbox's presence.
- Options select on pointer events or a plain click. A synthetic `mousedown` cancels the
  selection, so the click helper sends none.
- Calling `.focus()` on the combobox input from script dismisses the entire overlay. Nothing in
  the fill pipeline focuses a control programmatically.
- Escape closes an open list when sent to the combobox (or listbox); sent to `document` it
  reaches the overlay's own handler and closes the form instead.
- A question about other people ("who else should we invite… share their email") is free text,
  never the user's own email; a `type=url` field takes its kind (LinkedIn / GitHub / X / website)
  from its label.

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

Empty on first install. The panel refuses to start a run until first name, last name, email, job
title and company are set; open **Your profile** to fill them in. Location, LinkedIn, GitHub,
website, X and Instagram handles, dietary needs and gender are optional and only used when a form
asks. **Saved form answers** are used word for word when a form repeats a question; the agent adds
to them as it answers custom questions, and you can edit or remove any of them.

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
