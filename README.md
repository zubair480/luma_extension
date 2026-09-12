# Luma Agent

Auto-discovers and registers for free in-person AI/Tech events in the Bay Area on
[Luma](https://lu.ma).

## Install for yourself or a friend

1. Download this repository as a ZIP (green **Code** button → **Download ZIP**) and unzip it, or
   clone it. No Node, no build step: the on-device model runner is included.
2. Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked** → choose the
   `extension/` folder. On Windows you can double-click `extension/install.bat` instead, which
   creates a desktop shortcut that opens Chrome with the extension loaded.
3. Click the Luma Agent icon. The panel asks for your profile before anything can run: name,
   email, job title and company are required; the rest is used only when a form asks for it.
4. Sign in at lu.ma in that Chrome, then **Scan all 4 & get started**.

The first custom-question answer downloads the on-device model (about 200 MB, once). Answers are
generated locally; nothing is sent to a cloud service unless you configure one in the panel.

**Please read before sharing or running:** this tool automates registration on your own Luma
account. Automated use may fall outside Luma's terms of service, and every registration it makes
is one you are personally committing to. It never pays, never declines an invitation, and skips
online, paid and sold-out events, but you are responsible for what it signs you up for. Use at
your own risk. Licensed under the MIT License (see `LICENSE`).

## Chrome Extension (this is the one to use)

Runs in your logged-in Chrome session — no Playwright or CDP setup needed. It scans four sources,
answers custom registration questions with an in-browser LLM, and streams progress into a side
panel you can pause, resume, skip, or stop.

```text
1. Open chrome://extensions
2. Enable Developer mode
3. Load unpacked → select the `extension/` folder
4. Sign in at lu.ma
5. Open the side panel → "Scan all 4 & get started"
```

### Two actions

- **Scan all 4 & get started** — discover public events across the four sources and register.
- **Accept my invitations** — accept pending Luma invitations that pass the same filters. Never
  declines: anything that fails a check is left pending for you.

### Sources

- [Luma San Francisco](https://luma.com/sf) — citywide feed
- [Bond AI](https://luma.com/genai-sf) — SF & Bay Area AI calendar
- [Cerebral Valley](https://cerebralvalley.ai/events?locations=BAY_AREA) — Luma links only
- [Bay Area Founders Club](https://bayareafoundersclub.substack.com/) — weekly newsletter, read
  from its public RSS feed

See [extension/README.md](extension/README.md) for details.

## Tests

```bash
cd extension && npm run test:all
```

## Python CLI (legacy)

The Python agent requires Chrome remote debugging. Use the extension instead.
